/*
 * DSH on the Clocktower（血染钟鱼）
 * Copyright (C) 2026 TAOQILA
 *
 * 本项目以 GNU Affero General Public License v3.0（AGPL-3.0-only）发布。
 * 完整条款见项目根目录的 LICENSE 文件，或 <https://www.gnu.org/licenses/agpl-3.0.txt>。
 *
 * This program is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License as published by the Free Software
 * Foundation, version 3 of the License. There is NO WARRANTY, to the extent permitted
 * by law. See the LICENSE file for details.
 */
'use strict';
/*
 * 血染钟鱼 - Agent 驱动器
 * 职责：构建「视角快照」（严格按座位过滤）、拼提示词、调模型、解析结构化回包、串行推进。
 * 铁律：任何发给模型的文本都来自 viewFor() / viewForStoryteller()，绝不把整个 GameState 交给模型。
 *
 * 模型调用优先级：
 *   1. setLlmCall(fn)   —— 宿主端插件注入，使用 DSH 已配置的模型（推荐，零配置）
 *   2. AGENT_ENDPOINT   —— 外部 HTTP {system,prompt} -> {text}
 *   3. 都没有            —— mock 占位文本
 */
const fs = require('fs');
const path = require('path');
const E = require('./engine.cjs');

const ROOT = __dirname;
const MAX_MSGS_IN_PROMPT = 40;
/* 私聊不再限制次数：上限只是防模型一次刷屏的兜底 */
const MAX_DM_PER_DAY = 99;
const CALL_TIMEOUT_MS = 90000;
const FENCE = String.fromCharCode(96, 96, 96);

let LLM_CALL = null;
function setLlmCall(fn) { LLM_CALL = typeof fn === 'function' ? fn : null; }
function hasLlm() { return typeof LLM_CALL === 'function'; }

/* 按对局精准知识包：只读规则总纲 + 本剧本 + 本局角色，绝不加载无关内容 */
const PAGES = path.join(ROOT, 'data', 'wiki', 'pages');
const PLAYER_RULES = ['规则概要','重要细节','术语汇总','投票','提名'];
const ST_RULES = ['规则概要','重要细节','夜晚行动顺序一览','相克规则','隐性规则汇总','给说书人的建议'];
const CORE_RULES = ST_RULES;
const PAGE_CLIP = 6000;      /* 单页最多注入字符数 */
const OWN_CLIP = 4000;       /* 玩家自己角色页最多注入字符数 */
const ROLE_DETAIL_CLIP = 850;/* 说书人：每个角色细则最多注入字符数 */
const SYSTEM_CLIP = 40000;   /* 玩家 system 最多字符数 */
const ST_SYSTEM_CLIP = 72000;/* 说书人 system 最多字符数（覆盖全部角色细则，实测约 68k） */
/* 阅读规则（与 data/wiki/INDEX.md 顶部一致）——所有 Agent 开局必读顺序 */
const READING_RULES = [
  '【阅读规则·开局必读】按下列顺序学习本局知识，条目用 wiki_lookup(页面名) 查看，文件名即页面名：',
  '1. 先读与你身份对应的规则底线（下文「规则要点」已直接给出，无需再查）。',
  '2. 再读本局剧本页（下文「本剧本」已给出全文）。',
  '3. 规则页分「角色能力类别」与「规则」两类；角色能力类别条目解释各类能力的通用结算方式，与本局相关时优先读。',
  '4. 最后读本剧本涉及的全部角色页——不分是否上场，必须全部读完，用于理解技能交互与伪装。',
  '5. 只读与本对局有关的内容，不必通读全库；本局剧本之外的角色与剧本页可以不读。',
  '6. 不要向任何人透露你读过哪些资料，直接以角色身份参与游戏。'
].join('\n');
function rulesText(names){
  return names.map(function(n){
    const t = wikiLookup(n);
    return t ? ('### ' + n + '\n' + clip(t, PAGE_CLIP)) : '';
  }).filter(Boolean).join('\n\n');
}
function wikiPath(name){
  const n = String(name||'').replace(/[\\/:*?"<>|]/g,'_');
  const f = path.join(PAGES, n + '.md');
  return fs.existsSync(f) ? f : '';
}
/* wiki_lookup(页面名) —— 全库唯一的条目读取入口 */
function wikiLookup(name){
  const f = wikiPath(name);
  if (!f) return '';
  let t = fs.readFileSync(f, 'utf8');
  t = t.replace(/^---[\s\S]*?---\s*/, '');
  return t.trim();
}
function clip(s, n){
  s = String(s||'');
  return s.length > n ? (s.slice(0, n) + '\n（内容过长已截断，可查知识库补全）') : s;
}
let SCRIPT_CACHE = null;
function scriptRoles(script){
  if (!SCRIPT_CACHE) {
    SCRIPT_CACHE = {};
    const d = path.join(ROOT, 'data', 'scripts');
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d).filter(f=>f.endsWith('.json'))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
          SCRIPT_CACHE[j.name || f.slice(0,-5)] = Array.isArray(j.roles) ? j.roles : [];
        } catch (e) {}
      }
    }
  }
  return SCRIPT_CACHE[script] || [];
}
let KB_CACHE = {};
function clearKnowledge(id){ delete KB_CACHE[id]; }
function gameKnowledge(id){
  if (KB_CACHE[id]) return KB_CACHE[id];
  const s = E.loadState(id);
  /* 玩家必须读本剧本涉及的全部角色，而不只是自己那张 */
  const rinfo = scriptRoles(s.script).map(function(n){ return roleInfo(n); }).filter(Boolean);
  const ruleText = rulesText(ST_RULES);
  const playerRuleText = rulesText(PLAYER_RULES);
  const scriptText = clip(wikiLookup(s.script), PAGE_CLIP);
  /* 角色总览：一行一个，全员可读 */
  const roleBrief = rinfo.map(function(r){
    return '- ' + r.name + '（' + (r.faction_zh||r.faction||'') + '）：' + (r.ability||'');
  }).join('\n');
  /* 角色详情：仅说书人注入，逐页截断 */
  const roleDetail = rinfo.map(function(r){
    return '### ' + r.name + '（' + (r.faction_zh||r.faction||'') + '）\n' + clip(wikiLookup(r.name) || r.ability, ROLE_DETAIL_CLIP);
  }).join('\n\n');
  const kb = { ruleText, playerRuleText, scriptText, roleBrief, roleDetail, roles: rinfo.map(function(r){ return r.name; }) };
  KB_CACHE[id] = kb;
  return kb;
}
function playerSystem(id, seat){
  const s = E.loadState(id);
  const kb = gameKnowledge(id);
  const role = s.roles[seat];
  const ri = roleInfo(role);
  const own = ri ? clip(wikiLookup(ri.name), OWN_CLIP) : '';
  return clip(RULES + '\n\n' + READING_RULES + '\n\n【本局知识】\n规则要点：\n' + kb.playerRuleText
    + '\n\n本剧本：' + (s.script||'')
    + (kb.scriptText ? ('\n' + kb.scriptText) : '')
    + '\n\n本剧本全部角色能力（务必全部读完，不只是你自己）：\n' + kb.roleBrief
    + '\n\n你的角色：' + (role||'未分配')
    + (ri ? ('\n阵营：' + (ri.faction_zh||ri.faction) + '\n能力原文：' + ri.ability) : '')
    + (own ? ('\n你的角色详情：\n' + own) : ''), SYSTEM_CLIP);
}
/* 天平系统：说书人的核心职责之一。写进 system，每一夜/每一天都生效。 */
const BALANCE_RULES = [
  '【天平系统 · 说书人的最高职责之一】',
  '你不只是在执行规则，你也是这一局的平衡者。每一夜、每一天开始前，先在心里称一次天平：善良方和邪恶方，现在谁更弱？',
  '天平的两端不是人数，而是「离胜利还有多远」：善良方弱＝好人接连被冤杀、关键信息被浪费、恶魔几乎没人怀疑；邪恶方弱＝爪牙被拔、恶魔被锁定、邪恶方几乎没有翻盘空间。',
  '你要用规则允许你裁量的部分去扶弱：凡是能力描述里带「可能」「由你决定」「你可以」「选择」这类裁量空间的，都优先向弱势的一方倾斜。',
  '例如：信息类能力可以给出更清晰、更有指向性的线索给弱势方；干扰类能力（中毒、醉酒、错误信息）可以少用或不用在已经领先的一方身上；死亡与复活的裁定可以给弱势方留一口气。',
  '绝对不能做的事：直接说出谁是什么角色；凭空捏造规则不允许的信息；因为偏爱某一方而违反角色能力的明文描述。天平只能在规则给的裁量空间里倾斜。',
  '开局时通常邪恶方是弱势的（人少、信息少、要隐藏），所以第一夜的处理一般应当对邪恶方稍微宽松一点，给它们留出表演空间；但一旦邪恶方开始滚雪球，就要立刻反向倾斜。',
  '每一夜/每一天的 think 里，先用一句话写清「当前天平偏向哪一方、为什么」，再写你的裁定。'
].join('\n');

function storytellerSystem(id){
  const kb = gameKnowledge(id);
  return clip(RULES + '\n\n' + READING_RULES + '\n\n' + BALANCE_RULES + '\n\n【本局说书人知识（仅本局相关）】\n规则要点：\n' + kb.ruleText
    + '\n\n本剧本：' + (kb.scriptText||'')
    + '\n\n本剧本全部角色能力原文：\n' + kb.roleDetail, ST_SYSTEM_CLIP);
}

let ROLES_CACHE = null;
function allRoles() {
  if (!ROLES_CACHE) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'roles.json'), 'utf8'));
    ROLES_CACHE = Array.isArray(raw) ? raw : (raw.roles || []);
  }
  return ROLES_CACHE;
}
function roleInfo(name) {
  if (!name) return null;
  return allRoles().find(function (r) { return r.name === name || r.id === name; }) || null;
}

/* ---------- 视角快照 ---------- */
function viewFor(id, seat) {
  const s = E.loadState(id);
  const me = s.seats[seat] || {};
  let myRole = s.roles[seat] || null;
  if (!myRole) {
    const said = (s.info[seat] || []).map(function (x) { return String(x.text || ''); }).join('\n');
    const m = said.match(/你的角色是[【\[]([^】\]]+)[】\]]/);
    if (m && m[1]) myRole = m[1].trim();
    if (!myRole) {
      const m2 = said.match(/你是(?:镇民|外来者|爪牙|恶魔|旅行者)?角色[:：]\s*([^。，,\s]+)/);
      if (m2 && m2[1]) myRole = m2[1].trim();
    }
    if (!myRole) {
      const m3 = said.match(/你的角色[:：]?\s*是?\s*[【\[]?([^【】\[\]。，,\s]+)[】\]]?/);
      if (m3 && m3[1]) myRole = m3[1].trim();
    }
  }
  const info = roleInfo(myRole);
  const msgs = E.messages(id, seat, false).slice(-MAX_MSGS_IN_PROMPT);
  const aliveList = [], deadList = [];
  s.seats.forEach(function (x, i) {
    (s.alive[i] ? aliveList : deadList).push(i + ':' + x.name);
  });
  const dmSent = msgs.filter(function (m) {
    return m.channel === 'private' && m.from === seat;
  }).length;
  return {
    game: id, script: s.script, phase: s.phase, night: s.night, day: s.day,
    seat: seat, name: me.name || ('座位' + seat),
    role: myRole,
    faction: info ? info.faction : null,
    ability: info ? info.ability : null,
    alive: !!s.alive[seat],
    aliveList: aliveList, deadList: deadList,
    privateInfo: (s.info[seat] || []).map(function (x) { return x.text; }),
    /* 本夜刚拿到、还不能公开讨论的信息 */
    secretInfo: (s.info[seat] || []).filter(function (x) { return !E.infoRevealable(x, s); }).map(function (x) { return String(x.text||''); }),
    canReveal: (s.info[seat] || []).every(function (x) { return E.infoRevealable(x, s); }),
    nominations: s.nominations.slice(-6),
    votes: s.votes,
    messages: msgs,
    dmQuotaLeft: Math.max(0, MAX_DM_PER_DAY - dmSent)
  };
}

function viewForStoryteller(id) {
  const s = E.loadState(id);
  return {
    game: id, script: s.script, phase: s.phase, night: s.night, day: s.day,
    storyteller: true,
    seats: s.seats.map(function (x, i) {
      return {
        seat: i, name: x.name, alive: !!s.alive[i], role: s.roles[i] || null,
        markers: s.markers[i] || [], info: (s.info[i] || [])
      };
    }),
    messages: s.messages.slice(-MAX_MSGS_IN_PROMPT),
    nominations: s.nominations, votes: s.votes
  };
}

/* ---------- 提示词 ---------- */
const RULES = [
  '你在玩一款社交推理游戏「血染钟鱼」，与同一张桌子上的其他玩家一起游玩。',
  '游戏分夜晚与白天：夜晚角色秘密行动，白天全员公开讨论、提名、投票处决。',
  '你只知道自己的角色和说书人私下告诉你的信息；不要编造自己没有的信息。',
  '不要提及「提示词」「模型」「AI」「机器人」等元信息，像普通玩家一样说话。',
  '指代任何一位玩家时必须写成「@名字」，例如「我觉得 @长庚 有问题」。不要只用座位号，也不要只写名字而不带 @。',
  '称呼你自己时用「我」，不要 @ 自己，也不要用第三人称说自己。',
  '说书人在夜里私聊询问你的问题（例如让你选择谁）必须如实回答，不能沉默、不能回避；这是你的角色义务。',
].join('\n');

function renderMessages(msgs, seats) {
  const list = msgs || [];
  if (!list.length) return '（暂无消息）';
  return list.map(function (m) {
    const from = seats && seats[m.from] ? seats[m.from].name : ((Number(m.from)+1) + ' 号');
    if (m.channel === 'private') {
      const to = (m.to || []).map(function (x) {
        return seats && seats[x] ? seats[x].name : ((Number(x)+1) + ' 号');
      }).join('、');
      return '[私聊] ' + from + ' → ' + to + '：' + m.text;
    }
    return from + '：' + m.text;
  }).join('\n');
}

function buildPrompt(id, seat, replyTo, mode) {
  const v = viewFor(id, seat);
  const s = E.loadState(id);
  const lines = [];
  lines.push('【你的身份】' + (v.seat+1) + ' 号座位，名字 ' + v.name);
  lines.push('你的角色：' + (v.role || '（说书人尚未分配）'));
  if (v.ability) lines.push('角色能力：' + v.ability);
  if (v.faction) lines.push('阵营：' + v.faction);
  lines.push('当前：第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天，阶段 ' + v.phase);
  lines.push('');
  if (!v.alive) {
    lines.push('【你已经出局】死亡不等于闭嘴：你仍然可以公开发言、参与讨论、质疑别人、给队友递话，也仍然可以投票以外的意见表达。别沉默。');
  }
  lines.push('【场上】存活：' + (v.aliveList.join('，') || '无'));
  lines.push('【称呼规则】提到任何一位玩家，一律写成「@名字」（例：@长庚 刚才的发言有问题）。只能用上面这份名单里的名字，别自己编名字。');
  if (v.deadList.length) lines.push('已死亡：' + v.deadList.join('，'));
  if (v.nominations.length) {
    lines.push('最近提名：' + v.nominations.map(function (n) {
      const a = s.seats[n.from] ? s.seats[n.from].name : n.from;
      const b = s.seats[n.target] ? s.seats[n.target].name : n.target;
      return a + ' 提名 ' + b;
    }).join('；'));
  }
  lines.push('');
  if (v.privateInfo.length) {
    lines.push('【说书人私下告诉你的信息】');
    v.privateInfo.forEach(function (t) {
      const secret = (v.secretInfo || []).indexOf(String(t)) >= 0;
      lines.push('- ' + t + (secret ? '　← 【本夜刚得知，天亮了才能说】' : ''));
    });
    lines.push('');
  }
  if ((v.secretInfo || []).length) {
    lines.push('');
    lines.push('【保密规则 · 必须遵守】');
    lines.push('你今夜刚拿到的信息，在进入下一个白天之前绝对不能说出来、也不能暗示。');
    lines.push('夜里你可以照常聊天、试探、怀疑别人、为自己辩护，但只能用白天已有的信息。');
    lines.push('一旦天亮（阶段变成 day），这些信息就可以公开讨论了。');
    lines.push('违反这条会毁掉整局游戏。');
    lines.push('');
  }
  lines.push('【你能看到的对话】');
  lines.push(renderMessages(v.messages, s.seats));
  lines.push('');
  lines.push('【你这一轮要做什么】');
  if (replyTo !== undefined && replyTo !== null && replyTo !== '') {
    lines.push('说书人（或另一位玩家）刚刚私聊了你（见上方对话最后几条私聊），这是在向你提问。请把回答直接写在 say 字段里，系统会私下转达给对方，不会公开。');
    lines.push('say 必须非空：必须给出一句真实的回答（说书人的提问尤其必须回答，例如你要选择的目标），不能留空。whisper 留空数组即可。');
  } else if (mode === 'react') {
    lines.push('刚才场上有人公开发言（见上方对话最后几条）。');
    lines.push('先判断这条消息和你有没有关系：被 @ 到、被点名、被怀疑、被问到，或者你手上有跟它直接相关的信息 —— 那必须接话。');
    lines.push('如果和你没什么关系，多数时候不用接：say 写空字符串 "" 就好。一条消息不需要一群人都来回应。');
    lines.push('要接的话只说一句：表明态度、提出怀疑、附议别人、给出你的信息，或为自己辩护。');
    lines.push('不要复述别人刚说过的话；不要长篇大论。');
    if (v.phase === 'night') lines.push('现在是夜晚：可以公开发言（不能私聊）。夜里大家也在广场上低声交谈，别因为天黑了就闭口不谈。');
    else lines.push('想单独问谁就私聊谁（whisper），不限次数；但别刷屏，一两句说清楚。');
  } else {
    lines.push('公开发言一句（可以质疑、辩护、给信息、拉票），想单独问谁就私聊谁（whisper），不限次数。');
  }
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的真实推理（不公开）","say":"你的公开发言","whisper":[{"to":[座位号（从 1 开始）],"text":"私聊内容"}]}');
  lines.push('如果不想私聊，whisper 给空数组。');
  return { prompt: lines.join('\n'), view: v };
}

function buildStorytellerNightPrompt(id) {
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push('你是「血染钟鱼」的说书人（Storyteller），本局由你全权主持。');
  lines.push('重要：本程序中角色能力没有任何执行代码，全部由你依据游戏规则判断并落实。你决定夜里唤醒谁、他们看到什么、谁死亡、谁中毒或醉酒。');
  lines.push('你必须公正：不泄露玩家不该知道的信息，给出的信息必须准确且符合能力描述。');
  lines.push('但公正不等于机械：你是这一局的天平。每一夜先称一次天平，判断善良方与邪恶方谁更弱，再用能力描述里留给你的裁量空间（「可能」「由你决定」「你可以选择」）去扶弱的一方。开局时邪恶方通常更弱。');
  lines.push('绝不允许替当事人做选择：凡是角色能力要求某位玩家自己选择目标（例如占卜师选人、杀手选人、间谍看谁），必须由你先主动私聊询问该玩家「你想选择谁」，等 ta 回复后再按 ta 的选择结算；你不能自己替他挑，也不能让玩家未经询问就自己报目标。');
  lines.push('');
  lines.push('【剧本】' + v.script + '　【阶段】第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天（' + v.phase + '）');
  const stt = E.loadState(id);
  const mins = stt && stt.dayStarted ? Math.max(0, Math.round((Date.now() - new Date(stt.dayStarted).getTime()) / 60000)) : 0;
  lines.push('【白天已经过去】' + mins + ' 分钟');
  if (stt && stt.vote) {
    lines.push('【当前投票】目标 ' + (stt.vote.target + 1) + ' 号 ' + (stt.seats[stt.vote.target] || {}).name
      + (stt.vote.open ? '（进行中：赞成 ' + stt.vote.yes.length + ' / 反对 ' + stt.vote.no.length + '）'
                       : '（已结束：' + (stt.vote.passed ? '通过' : '未通过') + '，赞成 ' + (stt.vote.yesCount || 0) + ' / 反对 ' + (stt.vote.noCount || 0) + '）'));
  } else {
    lines.push('【当前投票】没有进行中的投票');
  }
  lines.push('【关于提名处决】你不必急着投票。先听大家讨论：当有人提出了值得表决的指控、讨论已经充分、或者白天拖得太久（比如超过 10 分钟）没人推进，你就发起对某人的处决投票（见输出字段 voteTarget）。投票要按规则来：只有存活玩家有票，赞成必须多于反对且赞成票达到存活人数的一半才算通过。公告结果时如实说明票数与是否处决。');
  lines.push('');
  lines.push('【全场座位与真相】（座位号一律从 1 开始，与本表一致；你回包里的 seat/deaths 也要用 1 起的座位号）');
  v.seats.forEach(function (x) {
    lines.push((x.seat+1) + ' 号：' + x.name
      + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配')
      + (x.markers.length ? (' 标记=' + x.markers.join(',')) : '')
      + (x.info.length ? (' 已告知：' + x.info.map(function (i) { return i.text; }).join(' | ')) : ''));
  });
  lines.push('');
  lines.push('【公开对话记录】');
  lines.push(renderMessages(v.messages, v.seats));
  lines.push('');
  lines.push('【你这一夜要做的】');
  lines.push('1. 按标准夜间唤醒顺序依次处理本局存在的角色（先爪牙获取信息，再特定角色，最后恶魔行动）。');
  lines.push('2. 逐个决定该角色获得什么信息；如果某个能力需要该玩家自己选目标，先用 info 里对该座位发一条「请告诉我你想选择谁」的私聊，本轮先不结算这个角色，等 ta 回复后再结算。');
  lines.push('3. 把需要私下告知的内容写出来。');
  lines.push('4. 处理死亡与状态变化（中毒、醉酒、被保护、被杀害等），并按天平系统决定这次的裁量往哪边偏。');
  lines.push('');
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的裁判思路（不公开）","say":"你要对全场公开说的话，没有就空字符串",');
  lines.push(' "info":[{"seat":座位号（1 起）,"text":"私下告知该玩家的信息"}],');
  lines.push(' "markers":[{"seat":座位号（1 起）,"marker":"中毒/醉酒/被保护"}],');
  lines.push(' "deaths":[座位号（1 起）],');
  lines.push(' "nextPhase":"day"}');
  lines.push('公开说话（say 字段）的用词：夜里按顺序处理角色叫「唤醒」，不要说「递纸条」「发纸条」「送纸条」之类；例如「我现在唤醒占卜师」「我依次唤醒镇民」。');
  lines.push('需要玩家自己选目标时，是「由你主动私聊询问、等回复后再结算」，绝不要写成「需要自己挑目标的角色请先私聊告诉我」这种让玩家主动报名的说法——主动权在你，不在玩家。');
  return { prompt: lines.join('\n'), view: v };
}

function buildStorytellerDayPrompt(id) {
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push('你是「血染钟鱼」的说书人。现在是白天，玩家们正在公开讨论、提名与投票。');
  lines.push('你要做的是：观察讨论、必要时提醒规则、在投票结束后公布结果、决定是否有人被处决。');
  lines.push('不要替玩家做决定，也不要暗示谁好谁坏。');
  lines.push('但记得天平：白天如果你要行使裁量权（是否处决、给什么提示、如何描述死亡），先判断哪一方更弱，把空间留给弱势方。');
  lines.push('');
  lines.push('【剧本】' + v.script + '　【阶段】第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天（' + v.phase + '）');
  lines.push('');
  lines.push('【全场座位与真相】（座位号从 1 开始）');
  v.seats.forEach(function (x) {
    lines.push((x.seat+1) + ' 号：' + x.name + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配'));
  });
  lines.push('');
  lines.push('【公开对话记录】');
  lines.push(renderMessages(v.messages, v.seats));
  lines.push('');
  lines.push('严格只输出一个 JSON 对象：');
  lines.push('{"think":"你的裁判思路","say":"你要对全场说的话（可为空）","info":[],"markers":[],"deaths":[],"nextPhase":"","voteTarget":0,"resolveVote":false}');
  lines.push('voteTarget：要发起处决投票的目标座位号（从 1 开始）；不发起就填 0。resolveVote：为 true 表示现在结算当前这轮投票。');
  return { prompt: lines.join('\n'), view: v };
}

/* ---------- 每个座位自己的模型 ---------- */
function routeFor(id, seat) {
  const s = E.loadState(id);
  const target = (seat === 'storyteller' || seat === 'story') ? s.storyteller : s.seats[seat];
  if (!target) return { provider: '', model: '' };
  return { provider: target.provider || '', model: target.model || '' };
}

/* ---------- 调用模型 ---------- */
async function callModel(payload) {
  const system = payload.system || RULES;
  if (LLM_CALL) {
    try {
      const text = await LLM_CALL({
        system: system,
        prompt: payload.prompt,
        seat: payload.seat,
        game: payload.game,
        provider: payload.provider || '',
        model: payload.model || ''
      });
      const flat = (text && typeof text === 'object') ? (text.text != null ? text.text : (text.content != null ? text.content : '')) : text;
      return { text: String(flat == null ? '' : flat) };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  }
  const endpoint = process.env.AGENT_ENDPOINT;
  if (!endpoint) {
    return {
      mocked: true, text: JSON.stringify({
        think: '（mock 模式：未接入模型）',
        say: '我是 ' + (Number(payload.seat)+1) + ' 号，先听听大家怎么说。',
        whisper: []
      })
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, CALL_TIMEOUT_MS);
  try {
    const r = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: system, prompt: payload.prompt }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('endpoint ' + r.status);
    const j = await r.json();
    return { text: typeof j === 'string' ? j : (j.text || j.content || '') };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* 括号配平扫描，抓第一个完整 JSON 对象 */
function extractObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* 容错解析：去代码块、抓第一个平衡 JSON、失败则整段当发言 */
function parseReply(raw) {
  let text = String(raw == null ? '' : raw).trim();
  const empty = { think: '', say: '', whisper: [], info: [], markers: [], deaths: [], nextPhase: '' };
  if (!text) return empty;
  const fenceRe = new RegExp(FENCE + '(?:json)?\\s*([\\s\\S]*?)' + FENCE, 'i');
  const fence = text.match(fenceRe);
  if (fence) text = fence[1].trim();
  const obj = extractObject(text);
  if (!obj) { empty.say = text; return empty; }
  const whisper = Array.isArray(obj.whisper) ? obj.whisper.filter(function (w) {
    return w && Array.isArray(w.to) && w.to.length && w.text;
  }).map(function (w) {
    return { to: w.to.map(Number).filter(function (n) { return !isNaN(n); }), text: String(w.text) };
  }) : [];
  return {
    think: String(obj.think || ''),
    say: String(obj.say || ''),
    whisper: whisper,
    info: Array.isArray(obj.info) ? obj.info.filter(function (x) { return x && x.seat !== undefined && x.text; })
      .map(function (x) { return { seat: Number(x.seat), text: String(x.text) }; }) : [],
    markers: Array.isArray(obj.markers) ? obj.markers.filter(function (x) { return x && x.seat !== undefined && x.marker; })
      .map(function (x) { return { seat: Number(x.seat), marker: String(x.marker) }; }) : [],
    deaths: Array.isArray(obj.deaths) ? obj.deaths.map(Number).filter(function (n) { return !isNaN(n); }) : [],
    nextPhase: obj.nextPhase ? String(obj.nextPhase) : ''
  };
}

/* 从回包里取「要发出去的那句话」：私聊时 say 与 whisper 都算数 */
function dialectText(parsed) {
  const say = (parsed && parsed.say) ? String(parsed.say).trim() : '';
  if (say) return say;
  const w = (parsed && parsed.whisper && parsed.whisper.length) ? String(parsed.whisper[0].text || '').trim() : '';
  return w;
}

/* ---------- 玩家 Agent 一轮（并发模型调用 / 串行落库） ---------- */
const RUNNING = new Map();
const STORY_RUNNING = new Map();

function status(id) {
  const r = RUNNING.get(id);
  if (!r) return { running: false, done: 0, total: 0, current: null, results: [] };
  return { running: r.running, done: r.done, total: r.total, current: r.current, waiting: r.waiting || [], results: r.results, error: r.error || null };
}
function storyStatus(id) {
  const r = STORY_RUNNING.get(id);
  if (!r) return { running: false, done: false, result: null };
  return { running: r.running, done: r.done, result: r.result || null, error: r.error || null };
}

/* 处理一位 Agent 的回复：落 think、发公聊 / 私聊、记进本轮结果。
   单独成函数，是为了让 runRound 能「一位说完再轮到下一位」。 */
async function applyOne(id, seat, out, opts, run){
  const st = E.loadState(id);
  const parsed = out.error
    ? { think: '', say: '', whisper: [], error: out.error }
    : parseReply(out.text);
  if (parsed.think) E.think(id, seat, parsed.think);
  const dmReplyTo = (opts.replyTo === 'storyteller') ? 'storyteller' : ((opts.replyTo !== undefined && opts.replyTo !== null && opts.replyTo !== '') ? Number(opts.replyTo) : -1);
  const isDm = (dmReplyTo === 'storyteller' || dmReplyTo >= 0);
  const nightNow = (st.phase === 'night');
  if (isDm) {
    /* 私聊回复模式：把话私下回给发件人（说书人侧也能看到），不占公开发言 */
    let back = dialectText(parsed);
    if (!back && !out.error) {
      /* 模型没答上来时补一次强指令，私聊必须有回音 */
      try {
        const built2 = buildPrompt(id, seat, dmReplyTo, opts.mode);
        const route2 = routeFor(id, seat);
        const out2 = await callModel({
          game: id, seat: seat,
          prompt: built2.prompt + '\n\n【再强调一次】对方在等你回话。say 字段必须填写一句真实的回复，不能空。',
          system: playerSystem(id, seat), provider: route2.provider, model: route2.model
        });
        const p2 = parseReply(out2.text);
        back = dialectText(p2);
        /* 把重试结果合进 parsed，保证结果面板与落库一致 */
        if (back) { parsed.say = back; parsed.think = parsed.think || p2.think; }
      } catch (e) { /* 重试失败就作罢 */ }
    }
    if (back) E.say(id, seat, back, 'private', [dmReplyTo]);
  } else if (parsed.say && String(parsed.say).trim()) {
    E.say(id, seat, String(parsed.say).trim(), 'town');
  }
  (isDm || nightNow ? [] : (parsed.whisper || []).slice(0, MAX_DM_PER_DAY)).forEach(function (w) {
    /* 模型给的座位号是 1 起，落库用 0 起 */
    const to = (w.to || []).map(function (n) { return Number(n) - 1; })
      .filter(function (n) { return n >= 0 && n < st.seats.length && n !== seat; });
    if (to.length) E.say(id, seat, w.text, 'private', to);
  });
  const dmBackFinal = (isDm) ? dialectText(parsed) : '';
  run.results.push({
    seat: seat,
    say: (isDm) ? dmBackFinal : parsed.say,
    whispers: (parsed.whisper || []).length,
    think: parsed.think,
    error: out.error || ((isDm && !dmBackFinal) ? '私聊没有产生回复' : null)
  });
}

/* ---------- 发言节奏：给玩家留出插嘴的空隙 ----------
   问题：AI 一位接一位连着说，玩家根本插不进话。
   做法：
   1) 每位 Agent 说完之后强制停顿 SPEAK_GAP_MS；
   2) 如果这一轮开始后玩家（真人座位）说过话，就先停下来等玩家安静下来
      （连续 QUIET_MS 没新消息）再让下一位开口，最多等 HUMAN_WAIT_MAX_MS；
   3) 一次「接话」最多 REACT_MAX_SPEAKERS 位先响应，避免一条消息引来全体轰炸。
   这样玩家不需要手动触发，也能随时把话头抢回来。 */
const SPEAK_GAP_MS = 4500;
const QUIET_MS = 9000;
const HUMAN_WAIT_MAX_MS = 60000;
const REACT_MAX_SPEAKERS = 3;
const REACT_EXTRA_SPEAKERS = 1;
/* 一轮结束后强制静默一段时间，把话头还给玩家；这期间不自动开新一轮 */
const ROUND_COOLDOWN_MS = 12000;
let ROUND_LAST_AT = new Map();

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function lastHumanMsgAt(id) {
  const s = E.loadState(id);
  const list = Array.isArray(s.messages) ? s.messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const seat = typeof m.from === 'number' ? s.seats[m.from] : null;
    if (seat && seat.type === 'human') return Date.parse(m.t) || 0;
  }
  return 0;
}

/* 最近一条真人公开发言里 @ 到 / 点名到的座位（0 起下标） */
function mentionedSeats(id) {
  const s = E.loadState(id);
  const list = Array.isArray(s.messages) ? s.messages : [];
  let last = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const seat = typeof m.from === 'number' ? s.seats[m.from] : null;
    if (seat && seat.type === 'human') { last = m; break; }
  }
  if (!last) return [];
  let txt = String(last.text || '');
  const hits = [];
  /* 长名字优先：先把「长庚二号」认走，免得它又被当成「长庚」；
     认走的名字在文本里挖掉，短名字就不会再误命中。 */
  s.seats.map(function (x, i) { return { name: (x && x.name) ? x.name : '', i: i }; })
    .filter(function (x) { return x.name.length >= 2; })
    .sort(function (a, b) { return b.name.length - a.name.length; })
    .forEach(function (x) {
      if (txt.indexOf(x.name) < 0) return;
      hits.push(x.i);
      txt = txt.split(x.name).join('\u0000');
    });
  return hits.sort(function (a, b) { return a - b; });
}

/* 玩家刚说过话就让路：轮询直到玩家安静 QUIET_MS，或总等待超过上限 */
async function yieldToHuman(id, startedAt) {
  const t0 = Date.now();
  for (;;) {
    const last = lastHumanMsgAt(id);
    if (last <= startedAt) return;              /* 这一轮里玩家还没说话，不用让 */
    const quietFor = Date.now() - last;
    if (quietFor >= QUIET_MS) return;            /* 玩家已经安静够久，可以继续 */
    if (Date.now() - t0 >= HUMAN_WAIT_MAX_MS) return;
    await sleep(400);
  }
}

/* 一次完整的「思考 -> 说话」。关键点：模型思考的这段时间里如果又有人插话，
   出来的回答就已经过时了 —— 所以比对消息数，只要有新消息就一直带着新消息重新思考，
   直到「一整轮思考期间没有任何人插话」为止 —— 不设次数上限，只要还有人在他思考时
   插话就一直重想，保证最终说出口的话一定建立在场上最新信息之上。 */
async function thinkAndSpeak(id, seat, opts) {
  const msgCount = function () {
    const st = E.loadState(id);
    return Array.isArray(st.messages) ? st.messages.length : 0;
  };
  const route = routeFor(id, seat);
  const system = playerSystem(id, seat);
  let out = null;
  let round = 0;
  let lastN = msgCount();
  for (;;) {
    round++;
    const built = buildPrompt(id, seat, opts.replyTo, opts.mode);
    const prompt = (round === 1)
      ? built.prompt
      : built.prompt + '\n\n【重要】你上一次思考时，场上又出现了新消息（见上方对话中最新几条）。'
        + '你之前的想法可能已经不成立了，请结合这些新消息重新判断，再给出你这一轮的回答。';
    let cur;
    try {
      cur = await callModel({ game: id, seat: seat, prompt: prompt, system: system, provider: route.provider, model: route.model });
    } catch (e) {
      if (out) break;
      return { error: String((e && e.message) || e) };
    }
    if (!cur || cur.error) {
      if (out) break;
      return cur;
    }
    out = cur;
    const nowN = msgCount();
    if (nowN <= lastN) break;
    lastN = nowN;
    E.think(id, seat, '（思考期间场上又有新消息，第 ' + round + ' 次结合新消息重新判断）');
  }
  return out;
}

async function runRound(id, opts) {
  opts = opts || {};
  const cur = RUNNING.get(id);
  if (cur && cur.running) return { ok: false, error: '这一局正在跑一轮，请等它结束' };
  const s = E.loadState(id);
  const order = [];
  s.seats.forEach(function (x, i) {
    /* 已出局的玩家仍然可以说话（规则如此），所以这里不按 alive 过滤 */
    if (x.type === 'agent' && i !== s.storytellerSeat) order.push(i);
  });
  if (!order.length) return { ok: false, error: '没有可驱动的 Agent 座位' };
  /* limit>0 时只唤醒前 limit 位，用于「让最近说话的几位先接一句」；seats 传入时只唤醒指定座位（私聊回复） */
  let pool;
  if (Array.isArray(opts.seats) && opts.seats.length) {
    pool = opts.seats.map(Number).filter(function (n) { return order.indexOf(n) >= 0; });
    if (!pool.length) return { ok: false, error: '指定的座位不可唤醒' };
  } else if (opts.mode === 'react') {
    /* 一条消息不该引来全场回应。优先唤醒「这条消息和它有关」的人：
       被 @ 到 / 被点名的座位必须接话；其余座位最多补 1 位，凑够两三位即可。
       这样一条消息通常只换回一两句，玩家有的是插话空间。 */
    const mentioned = mentionedSeats(id);
    const lead = order.filter(function (n) { return mentioned.indexOf(n) >= 0; });
    const rest = order.filter(function (n) { return mentioned.indexOf(n) < 0; });
    /* 上一轮刚结束没多久又被触发时，只让被点到的人回应，避免连珠炮 */
    const lastAt = ROUND_LAST_AT.get(id) || 0;
    const extra = (Date.now() - lastAt < ROUND_COOLDOWN_MS) ? 0 : REACT_EXTRA_SPEAKERS;
    const cap = Math.min(order.length, lead.length + extra);
    pool = lead.concat(rest).slice(0, opts.limit > 0 ? Math.min(opts.limit, cap) : cap);
  } else {
    pool = (opts.limit > 0) ? order.slice(0, opts.limit) : order;
  }

  const run = { running: true, done: 0, total: pool.length, current: null, waiting: pool.slice(), results: [], error: null };
  RUNNING.set(id, run);

  (async function () {
    try {
      /* 严格按座位顺序，一位说完再轮到下一位：每个人的提示词都在上一位落库之后才构建，
         所以后发言的人能看到先发言的人说了什么，信息才能真正互相影响。
         （并发虽然快，但所有人同一时刻只拿到同一份旧记录，等于各说各的。） */
      const outs = [];
      const roundStart = Date.now();
      for (let idx = 0; idx < pool.length; idx++) {
        const seat = pool[idx];
        /* 上一位说完先停一下，给玩家插话的机会；玩家真说话了就等到他安静下来 */
        if (idx > 0) {
          await sleep(SPEAK_GAP_MS);
          await yieldToHuman(id, roundStart);
          if (!RUNNING.get(id) || !RUNNING.get(id).running) break;
        }
        run.current = seat;
        let out;
        try {
          out = await thinkAndSpeak(id, seat, opts);
        } catch (err) {
          out = { error: String((err && err.message) || err) };
        }
        outs.push({ seat: seat, out: out });
        await applyOne(id, seat, out, opts, run);
        run.done++;
        run.waiting = run.waiting.filter(function (n) { return n !== seat; });
      }
      E.log(id, '系统', '本轮 Agent 发言结束（' + pool.length + ' 位依次发言）');
    } catch (err) {
      run.error = String((err && err.message) || err);
    } finally {
      run.running = false;
      run.current = null;
      run.waiting = [];
      ROUND_LAST_AT.set(id, Date.now());
    }
  })();

  return { ok: true, started: true, total: pool.length, order: pool };
}

/* ---------- 说书人 Agent 主持一夜 / 一天 ---------- */
async function runStoryteller(id, opts) {
  opts = opts || {};
  const cur = STORY_RUNNING.get(id);
  if (cur && cur.running) return { ok: false, error: '说书人正在处理中' };
  const s = E.loadState(id);
  const isNight = s.phase === 'night' || s.phase === 'setup';

  const run = { running: true, done: false, result: null, error: null };
  STORY_RUNNING.set(id, run);

  (async function () {
    try {
      const route = routeFor(id, 'storyteller');
      /* 说书人思考期间如果有人在广场上插话，也要把这些话纳入判断 */
      const msgN = function () {
        const st = E.loadState(id);
        return Array.isArray(st.messages) ? st.messages.length : 0;
      };
      /* 说书人同理：只要有人在它思考期间插话，就带着新消息重想，直到一整轮无人插话 */
      let out = null, stRound = 0, stLastN = msgN();
      for (;;) {
        stRound++;
        const cur = isNight ? buildStorytellerNightPrompt(id) : buildStorytellerDayPrompt(id);
        const stPrompt = (stRound === 1)
          ? cur.prompt
          : cur.prompt + '\n\n【重要】你上一次思考时，广场上又出现了新消息（见上方对话）。'
            + '请把玩家这些新的发言纳入你的判断，再给出这一阶段的裁定。';
        let o;
        try {
          o = await callModel({
            game: id, seat: 'storyteller', prompt: stPrompt,
            provider: route.provider, model: route.model,
            system: storytellerSystem(id)
          });
        } catch (e) {
          if (out) break;
          throw e;
        }
        if (!o || o.error) {
          if (out) break;
          throw new Error((o && o.error) || '说书人调用失败');
        }
        out = o;
        const nowSt = msgN();
        if (nowSt <= stLastN) break;
        stLastN = nowSt;
      }
      if (!out) throw new Error('说书人没有返回结果');
      const parsed = parseReply(out.text);

      /* 说书人回包里的座位号从 1 开始，统一在这里折成内部 0 起下标 */
      function toIdx(n) {
        const v = Number(n);
        if (!isFinite(v)) return -1;
        const i = v - 1;
        return (i >= 0 && i < s.seats.length) ? i : -1;
      }
      const applied = { info: 0, markers: 0, deaths: 0, phase: null, vote: null, win: null };
      if (parsed.think) E.think(id, 'storyteller', parsed.think);
      if (parsed.say) E.say(id, 'storyteller', parsed.say, 'town');
      parsed.info.forEach(function (x) { const i = toIdx(x.seat); if (i >= 0) { E.giveInfo(id, i, x.text); applied.info++; } });
      /* 说书人夜里私聊询问的问题，AI 必须回答：问句类的 info 落库后立刻驱动该座位私下回话 */
      const askSeats = [];
      parsed.info.forEach(function (x) {
        const i = toIdx(x.seat);
        const t = String(x.text || '');
        if (i >= 0 && /[?？]|请告诉|你想选|选谁|选择谁|告诉我/.test(t)) askSeats.push(i);
      });
      if (askSeats.length) {
        setTimeout(function () {
          try { runRound(id, { seats: askSeats, replyTo: 'storyteller' }); } catch (e) { /* ignore */ }
        }, 400);
      }
      parsed.markers.forEach(function (x) { const i = toIdx(x.seat); if (i >= 0) { E.toggleMarker(id, i, x.marker); applied.markers++; } });
      parsed.deaths.forEach(function (n) { const i = toIdx(n); if (i >= 0) { const r = E.kill(id, i, '夜间死亡'); if (r && r.ok) applied.deaths++; } });
      /* 白天：说书人自己判断何时发起 / 结算处决投票 */
      if (parsed.voteTarget) {
        const vt = toIdx(parsed.voteTarget);
        if (vt >= 0) { const r = E.openVote(id, vt); if (r && r.ok) applied.vote = 'open:' + (vt + 1); }
      }
      if (parsed.resolveVote) {
        const r = E.resolveVote(id);
        if (r && r.ok) applied.vote = (r.executed === false ? 'failed' : 'executed') + ':' + (r.yes != null ? (r.yes + '/' + r.no) : '');
        if (r && r.win && r.win.over) applied.win = r.win.side;
      }
      if (parsed.nextPhase) {
        const r = E.setPhase(id, parsed.nextPhase);
        if (r && r.ok) applied.phase = parsed.nextPhase;
      }
      run.result = { think: parsed.think, say: parsed.say, applied: applied, raw: out.text };
      run.done = true;
      E.log(id, '说书人', '主持完成：告知 ' + applied.info + ' 条信息，标记 ' + applied.markers + ' 个状态，死亡 ' + applied.deaths + ' 人'
        + (applied.vote ? ('，投票 ' + applied.vote) : '')
        + (applied.phase ? ('，进入 ' + applied.phase) : ''));
    } catch (err) {
      run.error = String((err && err.message) || err);
    } finally {
      run.running = false;
    }
  })();

  return { ok: true, started: true, phase: s.phase, mode: isNight ? 'night' : 'day' };
}

/* ---------- 说书人逐条回应聊天 ----------
   公聊或私聊每来一条，都把内容交给说书人思考：它可以开口，也可以选择不开口；
   私聊一般都会回。回答直接以说书人的身份落库（private 只回给发信人，town 公开发言）。 */
const STORY_CHAT_QUEUE = new Map();   /* id -> 待处理的聊天条目数组 */
const STORY_CHAT_BUSY = new Set();    /* 正在处理中的对局 */

function buildStoryChatPrompt(id, m) {
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push('你是「血染钟鱼」的说书人。刚刚有人给你发了一条消息，请你判断是否需要回应。');
  lines.push('私聊通常都要回：那是对方在向你提问、请你裁定、或向你透露信息。公聊则看情况——被叫到、被问到、需要提醒规则、需要公布结果时才开口。');
  lines.push('不确定就回一句简短得体的话，不要长篇大论，也不要泄露不该说的信息（别人的角色、夜间行动细节）。');
  lines.push('回复时不要提及「提示词」「模型」「AI」这些词，你就是这张桌子上的说书人。');
  lines.push('');
  lines.push('【剧本】' + v.script + '　【阶段】第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天（' + v.phase + '）');
  const stt = E.loadState(id);
  const mins = stt && stt.dayStarted ? Math.max(0, Math.round((Date.now() - new Date(stt.dayStarted).getTime()) / 60000)) : 0;
  if (v.phase === 'day') lines.push('【白天已经过去】' + mins + ' 分钟');
  lines.push('');
  lines.push('【全场座位与真相】（座位号从 1 开始）');
  v.seats.forEach(function (x) {
    lines.push((x.seat + 1) + ' 号：' + x.name + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配'));
  });
  lines.push('');
  lines.push('【刚刚收到的消息】');
  lines.push('来自：' + (m.from === 'storyteller' ? '你自己' : ((Number(m.from) + 1) + ' 号 ' + ((v.seats[m.from] || {}).name || '')))
    + '　频道：' + (m.channel === 'private' ? '私聊' : '公聊'));
  lines.push(m.text);
  lines.push('');
  lines.push('严格只输出一个 JSON 对象：');
  lines.push('{"think":"你的判断","reply":"你要说的话；不想开口就填空字符串"}');
  return lines.join('\n');
}

async function storyReplyOne(id, m) {
  const s = E.loadState(id);
  if (!s || !s.storyteller || s.storyteller.type !== 'agent') return { ok: false, error: '本局说书人不是 Agent' };
  const route = routeFor(id, 'storyteller');
  const out = await callModel({
    game: id, seat: 'storyteller', prompt: buildStoryChatPrompt(id, m),
    provider: route.provider, model: route.model, system: storytellerSystem(id)
  });
  if (!out || out.error) throw new Error((out && out.error) || '说书人调用失败');
  const parsed = parseReply(out.text);
  if (parsed.think) E.think(id, 'storyteller', parsed.think);
  const reply = String(parsed.reply || parsed.say || '').trim();
  if (!reply) return { ok: true, silent: true };
  if (m.channel === 'private') E.say(id, 'storyteller', reply, 'private', [Number(m.from)]);
  else E.say(id, 'storyteller', reply, 'town');
  return { ok: true, silent: false, reply: reply };
}

/* 外部入口：把一条聊天塞进队列，串行交给说书人处理，返回是否接受 */
function storyReply(id, m) {
  if (!m || m.from === 'storyteller') return { ok: false, error: '自己的消息不需要回应' };
  const q = STORY_CHAT_QUEUE.get(id) || [];
  q.push(m);
  STORY_CHAT_QUEUE.set(id, q);
  drainStoryChat(id);
  return { ok: true, queued: q.length };
}

async function drainStoryChat(id) {
  if (STORY_CHAT_BUSY.has(id)) return;
  STORY_CHAT_BUSY.add(id);
  try {
    for (;;) {
      const q = STORY_CHAT_QUEUE.get(id) || [];
      if (!q.length) break;
      const m = q.shift();
      STORY_CHAT_QUEUE.set(id, q);
      try { await storyReplyOne(id, m); } catch (e) { /* 单条失败不影响后续 */ }
    }
  } finally {
    STORY_CHAT_BUSY.delete(id);
  }
}

module.exports = {
  viewFor, viewForStoryteller, buildPrompt, buildStorytellerNightPrompt, buildStorytellerDayPrompt,
  parseReply, extractObject, runRound, runStoryteller, status, storyStatus, callModel, roleInfo, allRoles,
  setLlmCall, hasLlm, routeFor,
  wikiLookup, clearKnowledge, playerSystem, storytellerSystem, gameKnowledge, CORE_RULES, BALANCE_RULES,
  storyReply, buildStoryChatPrompt
};