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
const ST_SYSTEM_CLIP = 24000;/* 说书人 system 最多字符数：只带核心规则和精简角色能力，避免超长 prompt 拖慢响应 */
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
  return clip(RULES + '\n\n' + stylePrompt(id) + '\n\n' + ST_TONE + '\n\n' + READING_RULES + '\n\n【本局知识】\n规则要点：\n' + kb.playerRuleText
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

/* 说书人的语气：不做裁判式说教，不居高临下 */
const ST_TONE = [
  '【语气要求】你是这张桌子上的主持人，不是老师也不是裁判。说话平实、简短、对等：不居高临下地说教，不教训玩家该怎么玩，不评判谁的发言方式好不好。',
  '禁止这类说法：「我就提醒一句」「不是一句话就能定的」「你得先…才行」「谁都可以提名，你不懂吗」——它们听起来像在训人。',
  '有人问你规则就直说规则，有人做出非法操作就平静指出，没人问就闭嘴；不要主动点评局势、不要替玩家分析、不要总结大家的发言。',
  '避免「得看…」「要看…才行」这种把玩家当小孩的口气；同样的内容用中性说法说完就停，不要加一句评论。',
].join('\n');

function storytellerSystem(id){
  const kb = gameKnowledge(id);
  return clip(RULES + '\n\n' + stylePrompt(id) + '\n\n' + READING_RULES + '\n\n' + BALANCE_RULES + '\n\n【本局说书人知识（仅本局相关）】\n规则要点：\n' + kb.ruleText
    + '\n\n本剧本：' + (kb.scriptText||'')
    + '\n\n本剧本全部角色能力速览：\n' + kb.roleBrief
    + '\n\n本剧本角色细则：\n' + kb.roleDetail, ST_SYSTEM_CLIP);
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

/* ---------- 投票相关的角色能力速查（注入说书人提示词） ----------
   这些能力里有相当一部分已由程序机械执行（票权、管家限制、秘密计票、军团无效），
   说书人只需要处理好程序管不到的部分（例如每夜询问管家选谁当主人）。 */
const VOTE_ROLE_RULES = {
  '管家': '每夜必须选一名主人（除自己以外）。白天只有主人投票时你才能投票。你每夜都要私聊问 ta「今晚想选谁当主人」，收到答复后用 toggleMarker 给 ta 加「主人:N」。',
  '官员': 'ta 的投票算三票（程序已自动按三票计）。',
  '窃贼': 'ta 的投票算负数（程序已自动按 −1 计）。',
  '狂热者': '存活≥5 时 ta 必须在所有提名中投票（程序会强制）。',
  '街头风琴手': 'ta 在场且清醒时，所有投票闭眼秘密统计：不要公布票数、不要公布是否上处决台，只在最后宣布谁被处决。',
  '摆渡人': '游戏最后一天，所有死者重新获得投票标记（需要时你用 toggleMarker 处理）。',
  '报丧女妖': '若恶魔杀死了 ta，所有玩家都会得知；此后 ta 每天可发起两次提名，每次投票可投两票。',
  '魔像': 'ta 每局只能发起一次提名；提名时若被提名者不是恶魔，被提名者死亡。',
  '法官': '每局限一次：别人发起提名时，ta 可以要求直接处决或让投票无效。',
  '巫毒师': '只有 ta 和死者可以投票，且忽略「票数需过半」的要求。',
  '主教': '只有说书人可以发起提名，且每个白天说书人至少提名一名与 ta 对立阵营的玩家。',
  '屠夫': '每个白天首次处决后，ta 可以再次发起提名。',
  '讷神': '场上有一顶讷帽，戴帽者只能说单音节词、投票算两票。',
  '首席律师': '被提名者要选一名玩家，在投票前只有该玩家可以发言。'
};
function voteRolesBrief(id){
  const s = E.loadState(id);
  const seen = {};
  const out = [];
  (s.seats || []).forEach(function (x, i) {
    if (!s.alive[i]) return;
    const r = (s.roles || {})[i];
    if (!r || seen[r]) return;
    if (!VOTE_ROLE_RULES[r]) return;
    seen[r] = true;
    out.push('- ' + (i + 1) + ' 号 ' + x.name + '（' + r + '）：' + VOTE_ROLE_RULES[r]);
  });
  return out.join('\n');
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

/* ---------- 说话风格（设置页可调，默认轻度娱乐） ---------- */
const AI_STYLES = {
  super_serious: { name: '极端严肃', prompt: '【说话风格 · 极端严肃】措辞极为克制、正式、冷静。不使用玩笑、调侃、夸张或网络用语；每句话都围绕推理与证据，不闲聊，不渲染情绪。' },
  serious: { name: '严肃', prompt: '【说话风格 · 严肃】保持认真、理性的语气，以推理为主；可以简短表态，但不打趣、不插科打诨。' },
  mild_serious: { name: '轻度严肃', prompt: '【说话风格 · 轻度严肃】以推理为主，语气平和认真；偶尔可以轻松一句，但整体保持专注。' },
  neutral: { name: '不干预', prompt: '【说话风格 · 不干预】保持中性、就事论事，不刻意渲染情绪，也不刻意活跃气氛；按你自己的判断自然说话。' },
  mild_fun: { name: '轻度娱乐', prompt: '【说话风格 · 轻度娱乐】语气自然放松：这是推理游戏，不是吵架，不必句句审问、咬着谁不放；但也不要刻意搞笑或硬凑热闹。' },
  fun: { name: '娱乐', prompt: '【说话风格 · 娱乐】气氛轻松，可以适度开玩笑、互相打趣、用俏皮的说法表达怀疑；但推理信息仍要清楚，别让玩笑盖过关键信息。' },
  super_fun: { name: '极端娱乐', prompt: '【说话风格 · 极端娱乐】全程轻松搞怪，善用夸张比喻、双关和玩梗，把发言当成朋友间的热闹闲聊；即便指控别人也带点戏谑，但仍要把关键信息说清楚。' }
};
function styleKey(id){
  try { const s = E.loadState(id); return (s && s.aiStyle) || 'mild_fun'; } catch(e){ return 'mild_fun'; }
}
function stylePrompt(id){ return (AI_STYLES[styleKey(id)] || AI_STYLES.mild_fun).prompt; }
/* 开口倾向：越偏娱乐越愿意接话，越偏严肃越惜字如金（0=最沉默, 6=最健谈） */
const STYLE_ORDER = ['super_serious','serious','mild_serious','neutral','mild_fun','fun','super_fun'];
function talkLevel(id){
  const i = STYLE_ORDER.indexOf(styleKey(id));
  return i < 0 ? 4 : i;
}
function talkBiasText(id){
  const lv = talkLevel(id);
  if (lv <= 1) return '【开口倾向】你话不多：只有被 @、被点名、被怀疑、被问到，或手里有直接相关的关键信息时才开口；其余情况 say 写空字符串。';
  if (lv === 2) return '【开口倾向】你偏谨慎：闲聊一般不接，有实质观点或相关信息时才说一句。';
  if (lv === 3) return '【开口倾向】按需开口：有话就说，没话就沉默。';
  if (lv === 4) return '【开口倾向】你比较愿意聊：场面冷下来时主动接一句，也乐于回应别人的怀疑。';
  if (lv === 5) return '【开口倾向】你挺健谈：几乎每条消息都可以接一句，闲聊、打趣、表态都行，别让场面冷着。';
  return '【开口倾向】你非常健谈：只要不是明显没意义，就开口说一句，主动挑起话题、回应别人、抛观点，让广场一直热闹。';
}

/* ---------- 提示词 ---------- */
const RULES = [
  '你在玩一款社交推理游戏「血染钟鱼」，与同一张桌子上的其他玩家一起游玩。说话时严格遵守下面给出的「说话风格」设定。',
  '游戏分夜晚与白天：夜晚角色秘密行动，白天全员公开讨论、提名、投票处决。',
  '你只知道自己的角色和说书人私下告诉你的信息；不要编造自己没有的信息。',
  '不要提及「提示词」「模型」「AI」「机器人」等元信息，像普通玩家一样说话。',
  '指代任何一位玩家时必须写成「@名字」，例如「我觉得 @长庚 有问题」。不要只用座位号，也不要只写名字而不带 @。',
  '使用公开能力、或需要说书人裁定/公布结果时，要在发言里 @说书人 并说明你要做什么（例如「@说书人 我要公开查验结果」）；玩家可以不这么做，但你作为 AI 要养成这个习惯，否则说书人可能收不到你的请求。',
  '称呼你自己时用「我」，不要 @ 自己，也不要用第三人称说自己。',
  '说书人在夜里私聊询问你的问题（例如让你选择谁）必须如实回答，不能沉默、不能回避；这是你的角色义务。',
  '如果你是善良阵营：不要一味抗拒被处决。当你的角色能力已经用完、或者再留着也帮不上好人时，被投出去反而能给好人一张「死得干净」的身份证明、把票位让给更需要的人，这对好人是有利的；判断该不该为自己辩护时请把这层算进去。',
].join('\n');

function whoLabel(who, seats) {
  if (who === 'storyteller') return '说书人';
  if (who === 'admin') return '管理员';
  if (seats && seats[who]) return seats[who].name;
  const n = Number(who);
  return isNaN(n) ? String(who) : ((n + 1) + ' 号');
}
function renderMessages(msgs, seats) {
  const list = msgs || [];
  if (!list.length) return '（暂无消息）';
  return list.map(function (m) {
    const from = whoLabel(m.from, seats);
    if (m.channel === 'private') {
      const to = (m.to || []).map(function (x) {
        return whoLabel(x, seats);
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
    lines.push('【回答要明确】如果对方问的是「你要选谁 / 你要看谁 / 你要毒谁 / 谁是你要保护的人」这类问题，回答里必须点出明确的座位或名字（例："我选择 3 号 @长庚"）。不要只说「我想想」「再看看」「听天由命」这种没有指向的话，也不要反问对方。你的能力在夜里只能通过这句回答生效。');
  } else if (mode === 'react') {
    lines.push('现在轮到你思考：刚才场上有人公开发言（见上方对话最后几条）。');
    /* 数一下这条消息之后已经有几位 AI 接了话：后面的人看到前面人的发言，接话概率应递减 */
    const townMsgs = (v.messages || []).filter(function(m){ return !m.channel || m.channel === 'town'; });
    let lastSeed = -1;
    townMsgs.forEach(function(m, i){
      const f = (m.from === 'storyteller') ? 'storyteller' : Number(m.from);
      const seed = (f === 'storyteller') || (s.seats[f] && s.seats[f].type === 'human');
      if (seed) lastSeed = i;
    });
    const answered = {};
    townMsgs.slice(lastSeed + 1).forEach(function(m){
      const f = Number(m.from);
      if (f >= 0 && s.seats[f] && s.seats[f].type === 'agent') answered[f] = 1;
    });
    const reactedCount = Object.keys(answered).length;
    lines.push('【接话热度】这条消息之后，已经有 ' + reactedCount + ' 位玩家接了话。');
    lines.push(talkBiasText(id));
    if (reactedCount >= 2) {
      lines.push('已经不少人说过了：除非你被 @ 到、被点名、被怀疑、被问到，或手里有直接相关的信息，否则大概率不必再说，say 写空字符串 ""。闲聊寒暄两三个人接就够了，不要人人都回。');
    } else if (reactedCount === 1) {
      lines.push('已经有一人接话：如果只是闲聊附和，你可以沉默；有不同观点或相关信息才说一句。');
    } else {
      lines.push('还没有人接话，你可以接一句。');
    }
    lines.push(stylePrompt(id));
    lines.push('被 @ 到、被点名、被怀疑、被问到，或者你手上有跟它直接相关的信息 —— 那一定要说一句（但也可以用玩笑的方式说）。');
    lines.push('确实无话可说时，say 才写空字符串 ""。要接的话只说一句，不要复述别人刚说过的话，不要长篇大论。');
    if (v.phase === 'night') lines.push('现在是夜晚：可以公开发言（不能私聊）。夜里大家也在广场上低声交谈，别因为天黑了就闭口不谈。');
    else lines.push('想单独问谁就私聊谁（whisper），不限次数；但别刷屏，一两句说清楚。');
  } else {
    lines.push(stylePrompt(id));
    lines.push('公开发言一句（按上面的风格说话，可以闲聊、给点信息或拉票），想单独问谁就私聊谁（whisper），不限次数。');
  }
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的真实推理（不公开）","say":"你的公开发言","whisper":[{"to":[座位号（从 1 开始）],"text":"私聊内容"}]}');
  lines.push('如果不想私聊，whisper 给空数组。');
  return { prompt: lines.join('\n'), view: v };
}

/* ---------- 夜间行动顺序：从 data/nightorder.json 取标准顺序，按本局实际角色裁剪 ----------
   说书人必须按这个顺序逐个处理角色，不能跳着来、也不能一次把所有人的信息混在一起发。 */
let NIGHT_ORDER_CACHE = null;
function nightOrderData(){
  if (NIGHT_ORDER_CACHE) return NIGHT_ORDER_CACHE;
  try {
    const p = path.join(ROOT, 'data', 'nightorder.json');
    NIGHT_ORDER_CACHE = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { NIGHT_ORDER_CACHE = { first: [], other: [] }; }
  return NIGHT_ORDER_CACHE;
}
function nightOrderFor(id){
  const s = E.loadState(id);
  const d = nightOrderData();
  const seq = (Number(s.night || 1) <= 1 ? d.first : d.other) || [];
  const present = {};
  Object.keys(s.roles || {}).forEach(function (k) { present[String(s.roles[k] || '').trim()] = true; });
  const out = [];
  seq.forEach(function (name) {
    if (present[name] && out.indexOf(name) < 0) out.push(name);
  });
  return out;
}
function buildStorytellerNightPrompt(id) {
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push(ST_TONE);
  lines.push('你是「血染钟鱼」的说书人（Storyteller），本局由你全权主持。');
  lines.push('重要：本程序中角色能力没有任何执行代码，全部由你依据游戏规则判断并落实。你决定夜里唤醒谁、他们看到什么、谁死亡、谁中毒或醉酒。');
  lines.push(stylePrompt(id));
  lines.push('你必须公正：不泄露玩家不该知道的信息，给出的信息必须准确且符合能力描述。');
  lines.push('但公正不等于机械：你是这一局的天平。每一夜先称一次天平，判断善良方与邪恶方谁更弱，再用能力描述里留给你的裁量空间（「可能」「由你决定」「你可以选择」）去扶弱的一方。开局时邪恶方通常更弱。');
  lines.push('【保密铁律 · 违反即毁掉整局】绝不能在公聊里说出你夜里唤醒了谁、给了谁什么信息、谁夜里做了什么、谁是什么角色。夜里公开说的只能是气氛性的、全桌都能听的话（例如「天黑了，大家闭眼」）。夜间行动的具体对象与结果一律只能私下发给当事人。');
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
  const vrb = voteRolesBrief(id);
  if (vrb) { lines.push(''); lines.push('【本局投票相关角色 · 需要你在主持时照顾】'); lines.push(vrb); }
  lines.push('【关于提名处决】你不必急着投票。先听大家讨论：当有人提出了值得表决的指控、讨论已经充分、或者白天拖得太久（比如超过 10 分钟）没人推进，你就发起对某人的处决投票（见输出字段 voteTarget）。投票要按规则来：只有存活玩家有票，赞成必须多于反对且赞成票达到存活人数的一半才算通过。公告结果时如实说明票数与是否处决。');
  lines.push('');
  lines.push('【全场座位与真相】（座位号一律从 1 开始，与本表一致；你回包里的 seat/deaths 也要用 1 起的座位号）');
  v.seats.forEach(function (x) {
    const ri = x.role ? roleInfo(x.role) : null;
    const ab = ri && ri.ability ? (' 能力=' + String(ri.ability).replace(/\s+/g, ' ').slice(0, 220)) : '';
    lines.push((x.seat+1) + ' 号：' + x.name
      + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配') + ab
      + (x.markers.length ? (' 标记=' + x.markers.join(',')) : '')
      + (x.info.length ? (' 已告知：' + x.info.map(function (i) { return i.text; }).join(' | ')) : ''));
  });
  lines.push('');
  lines.push('【公开对话记录】');
  lines.push(renderMessages(v.messages, v.seats));
  lines.push('');
  lines.push('【你这一夜要做的】');
  const mode0 = (stt && stt.roleMode) || 'program';
  if (mode0 === 'program') {
    lines.push('【角色已由程序发好】本局所有座位都已有角色（见上表），玩家已经收到各自的「你的角色是【X】」私聊。你不必再分配角色，也不要重复发送角色信息——重复发送会让一个人收到两个角色。');
  } else {
    lines.push('【最高优先级 · 必须先做】本局角色表是空的（全部显示「未分配」）时，你这一轮的第一件事是在 info 里给每位存活座位写下「你的角色是【角色名】」，把所有人的角色分配好；这是玩家拿到自己身份的唯一途径。不能跳过。');
  }
  const orderNow = nightOrderFor(id);
  lines.push('【本夜行动顺序 · 必须严格按这个顺序，一个角色一个角色地处理】');
  lines.push(orderNow.length ? orderNow.map(function (n, i) {
    const ri = roleInfo(n);
    const ab = ri && ri.ability ? ('（' + String(ri.ability).replace(/\s+/g, ' ').slice(0, 130) + '）') : '';
    return (i + 1) + '. ' + n + ab;
  }).join('\n') : '（本局没有需要夜间行动的角色）');
  lines.push('处理方式（严格按顺序，不许跳、不许乱序）：');
  lines.push('每一项都要照上面括号里的能力原文执行：读清楚「谁选目标」「得到什么信息」「有什么附带效果（中毒/醉酒/死亡/标记）」，不要凭印象简化，也不要漏掉附带效果。能力里写「由你决定」「可能」的地方是你的裁量空间，其余部分不得改动。');
  lines.push('1. 找出**第一个还没有结算**的角色。判断依据：看上面「已告知」里有没有针对该座位的信息；已发过、且不需要玩家再选择的，就算结算过了，直接跳过看下一个。');
  lines.push('2. 不需要玩家自己选目标的角色，可以按顺序连着结算（一个角色一条 info，不要合并成一条），但必须依照上表的先后，不许乱序。');
  lines.push('3. 一旦遇到需要该玩家自己选目标的角色（例如占卜师、管家、投毒者、恶魔），**立刻停下**：只发一条「请告诉我你想选择谁」的私聊提问，nextPhase 留空，等 ta 回复后再结算这一个，然后继续往下。');
  lines.push('4. 顺序表上所有角色都结算完，才写 nextPhase="day"。');
  lines.push('【已由程序自动完成】顺序表里的「爪牙信息」「恶魔信息」两步由系统机械下发（爪牙会得知谁是恶魔；恶魔会得知爪牙是谁，以及 3 个可用的伪装身份）。你不需要再发这两条，也不要重复告诉他们。');
  lines.push('【硬性要求】你打算「问某个玩家」这件事，必须真的写进 info 数组，不能在 think 里想一想就算了。只要 think 里出现「我先问」「等 ta 回复」之类的话，info 就必须至少有一条对应的提问；否则这一轮等于什么都没发生，主持会判定为空转。');
  lines.push('4. 把需要私下告知的内容写出来：给每个今夜真正获得信息的角色发一条 info（写明他看到了什么）。角色已由程序发好，不需要重复发角色名；这一夜没有任何角色获得信息时，info 可以是空数组。');
  lines.push('5. 处理死亡与状态变化（中毒、醉酒、被保护、被杀害等），并按天平系统决定这次的裁量往哪边偏。');
  lines.push('【不许空转】info 为空、markers 为空、deaths 为空、nextPhase 也为空 —— 这种「什么都没做」的回包是不允许的。你至少要做成一件：给出信息、提出问题、裁定死亡/状态、或推进到白天。');
  lines.push('');
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的裁判思路（不公开）","say":"你要对全场公开说的话，没有就空字符串",');
  lines.push(' "info":[{"seat":座位号（1 起）,"text":"私下告知该玩家的信息"}],');
  lines.push(' "markers":[{"seat":座位号（1 起）,"marker":"中毒/醉酒/被保护"}],');
  lines.push(' "deaths":[座位号（1 起）],');
  lines.push(' "nextPhase":""}');
  lines.push('重要：这一夜如果还有任何需要玩家自己选择目标、但你还没收到 ta 回复并结算的角色（例如占卜师选人、管家选主人、投毒者选人、恶魔选人），nextPhase 必须留空字符串 \"\"，不能写 \"day\"。等所有选择都结算完，下一轮主持再写 day。只说一句「天黑了」却没给任何人角色或信息，绝对不允许进入白天。');
  lines.push('【很重要】当这一夜该做的事都做完了（该发的信息发完、该问的选择都收到回复并结算、死亡已裁定），nextPhase 必须写 "day"，把游戏推进到白天。不要一直停在夜里。');
  lines.push('公开说话（say 字段）要克制：只有第一次入夜这种确有必要的播报才写一句话（例如「天黑了，所有人闭眼」），其余轮次 say 一律留空字符串——不要每轮都说话，不要闲聊、不要评论玩家。绝不要说出你要唤醒哪些角色、也不要按角色名逐个念——那等于把角色表公开了。');
  lines.push('需要玩家自己选目标时，是「由你主动私聊询问、等回复后再结算」，绝不要写成「需要自己挑目标的角色请先私聊告诉我」这种让玩家主动报名的说法——主动权在你，不在玩家。');
  return { prompt: lines.join('\n'), view: v };
}

function buildStorytellerDayPrompt(id) {
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push('你是「血染钟鱼」的说书人。现在是白天，玩家们正在公开讨论、提名与投票。');
  lines.push(ST_TONE);
  lines.push('你要做的是：观察讨论、必要时提醒规则、在投票结束后公布结果、决定是否有人被处决。');
  lines.push('不要替玩家做决定，也不要暗示谁好谁坏。');
  lines.push('公聊要克制：没有人问你、也没有必须公布的结果（天亮、死亡、投票结果）时就不要说话，say 留空字符串。不要评论每个玩家的发言、不要替大家主持讨论、不要刷存在感。');
  lines.push('但记得天平：白天如果你要行使裁量权（是否处决、给什么提示、如何描述死亡），先判断哪一方更弱，把空间留给弱势方。');
  lines.push('');
  lines.push('【剧本】' + v.script + '　【阶段】第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天（' + v.phase + '）');
  lines.push('');
  lines.push('【全场座位与真相】（座位号从 1 开始）');
  v.seats.forEach(function (x) {
    const ri = x.role ? roleInfo(x.role) : null;
    const ab = ri && ri.ability ? (' 能力=' + String(ri.ability).replace(/\s+/g, ' ').slice(0, 220)) : '';
    lines.push((x.seat+1) + ' 号：' + x.name + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配') + ab);
  });
  lines.push('');
  lines.push('【公开对话记录】');
  lines.push(renderMessages(v.messages, v.seats));
  lines.push('');
  lines.push('严格只输出一个 JSON 对象：');
  lines.push('{"think":"你的裁判思路","say":"你要对全场说的话（可为空）","info":[],"markers":[],"deaths":[],"nextPhase":"","voteTarget":0,"resolveVote":false,"enterNomination":false}');
  lines.push('voteTarget：要发起处决投票的目标座位号（从 1 开始）；不发起就填 0。resolveVote：为 true 表示现在结算当前这轮投票。');
  /* 提名时机闸门：由说书人结合公共消息条数自行判断何时进入提名阶段 */
  try {
    const gate = E.nomGate(id);
    const cfg = gate.cfg || { min: 15, softMax: 45, hardMax: 80, unanimous: true };
    lines.push('');
    lines.push('【提名时机 · 由你判断】今天公聊里已有 ' + gate.count + ' 条公开消息（存活 ' + gate.alive + ' 人）。');
    lines.push('· 少于 ' + cfg.min + ' 条：除非有人明确要求，否则不要进入提名阶段。');
    lines.push('· ' + cfg.min + ' ~ ' + cfg.softMax + ' 条：时机由你根据局势判断——讨论是否聊开、有没有比较明确的怀疑对象。');
    lines.push('· 达到 ' + cfg.softMax + ' 条：通常就应该进入提名阶段了，不要无限拖延。');
    lines.push('· 达到 ' + cfg.hardMax + ' 条：必须立刻进入提名阶段，没有例外。');
    if (cfg.unanimous) lines.push('· 若所有存活玩家都公开表示同意进入提名，可以提前进入。');
    lines.push('当前判定：' + ({ early: '还早', window: '窗口期（由你裁量）', overdue: '应当进入', hard: '必须进入', unanimous: '全员同意，可以进入' }[gate.stage] || gate.stage) + '。');
    lines.push('若要现在进入提名阶段，在回包里写 "enterNomination":true；否则写 false。进入提名后由程序自动主持提名与投票流程，你不需要自己逐票统计。');
  } catch (e) {}
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
  const empty = { think: '', say: '', whisper: [], info: [], markers: [], deaths: [], nextPhase: '', reply: '' };
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
    nextPhase: obj.nextPhase ? String(obj.nextPhase) : '',
    /* 说书人聊天回包用的是 reply 字段，这里显式保留，否则回复会被当成「选择沉默」 */
    reply: String(obj.reply == null ? '' : obj.reply),
    /* 白天主持时：说书人自己判断现在是否该进入提名阶段 */
    enterNomination: obj.enterNomination === true
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
const SPEAK_GAP_MS = 0;  /* 不再逐人固定间隔，避免整轮被拖慢 */
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
    /* 每条公开消息都让「所有」AI 依次思考要不要接话：一位思考完再轮下一位。
       是否被 @ / 被点名只影响它说出口的内容，不影响它是否获得思考机会。
       是否开口由每位 AI 自己判断（say 留空即沉默）。 */
    /* 随机顺序接话：不是按座位号一个一个来 */
    pool = order.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
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
          if (SPEAK_GAP_MS > 0) await sleep(SPEAK_GAP_MS);
          if (opts.mode !== 'react') await yieldToHuman(id, roundStart);
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
      /* 说书人回包座位号从 1 起，先定义折回 0 起下标的工具（重想判定也要用） */
      function toIdx(n) {
        const v = Number(n);
        if (!isFinite(v)) return -1;
        const i = v - 1;
        return (i >= 0 && i < s.seats.length) ? i : -1;
      }
      /* 取消旧的 ST_MAX_ROUNDS 硬上限：说书人必须把信息想完、问完、结算完，不能被
         「只思考了一轮」强行打断。只有当被它问过的玩家真的回答时才继续下一轮，
         并提示它接着上一轮往下做（结算已答的选择、再问未答的、不重复播报）。
         SAFETY_CAP 只是极高的防死循环安全阀，正常对局远达不到。 */
      const ST_SAFETY_CAP = 24;
      /* 等玩家回答说书人提问的最长时间：说书人必须先问、玩家答完才能结算 */
      const WAIT_ANSWER_MS = 45000;
      let out = null, stRound = 0, stLastN = msgN(), askedSeats = [], stallN = 0, sayFirst = '', askDriven = false;
      /* 逐轮累积的落库结果：每一轮都要立刻生效，不能等循环结束 */
      const applied = { info: 0, markers: 0, deaths: 0, phase: null, vote: null, win: null };
      for (;;) {
        stRound++;
        const cur = isNight ? buildStorytellerNightPrompt(id) : buildStorytellerDayPrompt(id);
        let stPrompt = cur.prompt;
        if (stRound > 1) {
          stPrompt += '\n\n【继续上一轮未完成的裁定】你上一轮已经说过话、也可能给玩家下过信息；广场上随后出现了玩家回答你的提问（见上方对话）。请接着往下做：①先把已回答的选择结算成 info（写明角色与结算结果）；②还没回答的角色再私聊问一次；③这一轮 say 留空，不要重复公开播报；④不要重复问已经答过的问题；⑤只有本阶段所有需玩家选择的角色都结算完才写 nextPhase=day，否则留空。';
        }
        if (stallN > 0) {
          stPrompt += '\n\n【必须推进 · 上一轮没有任何实际动作】你上一轮既没有给任何人 info，也没有标记、死亡或推进阶段，等于什么都没做。这一轮必须至少完成其中一件：①在 info 里逐个写下今夜的私聊内容（哪怕只是「你今晚没有获得信息」也要写，不能留空数组）；②需要玩家选目标就立刻在 info 里向该座位提问；③本夜确实全部结算完毕，就写 nextPhase="day"。不允许再空转一轮。';
        }
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
        /* 每一轮的完整思考都立刻落库，绝不让说书人的思考被截断或吞掉 */
        let rp = null;
        try { rp = parseReply(out.text); if (rp && rp.think) E.think(id, 'storyteller', rp.think); } catch (e2) {}
        const pre = { info: applied.info, markers: applied.markers, deaths: applied.deaths, phase: applied.phase };
        if (stRound === 1 && rp && rp.say) sayFirst = String(rp.say);
        /* 每一轮的结果必须立刻落库：否则玩家在广场上根本看不到说书人的提问，也就永远不会回答 */
        if (rp && rp.say && !(stRound > 1 && sayFirst && String(rp.say) === sayFirst)) {
          E.say(id, 'storyteller', rp.say, 'town');
        }
        let newlyAsked = [];
        if (rp && Array.isArray(rp.info) && rp.info.length) {
          const roleModeNow = (E.loadState(id).roleMode || 'program');
          rp.info.forEach(function (x) {
            const i = toIdx(x.seat); if (i < 0) return;
            const t = String(x.text || '');
            /* 程序已发好牌时，绝不允许说书人再改角色或重复发角色：只放行非角色类信息 */
            if (roleModeNow === 'program') {
              const m = t.match(/你的角色是[【\[]([^】\]]+)[】\]]/);
              if (m) { E.log(id, '系统', '已忽略说书人重复分配角色的尝试（第 ' + (i + 1) + ' 号 → ' + m[1] + '）', true); return; }
            }
            const r = E.giveInfo(id, i, t);
            if (r && r.skipped) return;
            applied.info++;
            if (/[?？]|请告诉|你想选|选谁|选择谁|告诉我/.test(t) && askedSeats.indexOf(i) < 0) { askedSeats.push(i); newlyAsked.push(i); }
          });
        }
        if (rp && Array.isArray(rp.markers)) rp.markers.forEach(function (x) { const i = toIdx(x.seat); if (i >= 0) { E.toggleMarker(id, i, x.marker); applied.markers++; } });
        if (rp && Array.isArray(rp.deaths)) rp.deaths.forEach(function (n) { const i = toIdx(n); if (i >= 0) { const r = E.kill(id, i, '夜间死亡'); if (r && r.ok) applied.deaths++; } });
        if (rp && rp.voteTarget) {
          const vt = toIdx(rp.voteTarget);
          if (vt >= 0) { const r = E.openVote(id, vt); if (r && r.ok) applied.vote = 'open:' + (vt + 1); }
        }
        if (rp && rp.resolveVote) {
          const r = E.resolveVote(id);
          if (r && r.ok) applied.vote = (r.executed === false ? 'failed' : 'executed') + ':' + (r.yes != null ? (r.yes + '/' + r.no) : '');
          if (r && r.win && r.win.over) applied.win = r.win.side;
        }
        if (rp && rp.nextPhase) {
          const r = E.setPhase(id, rp.nextPhase);
          if (r && r.ok) applied.phase = rp.nextPhase;
        }
        /* 白天：说书人（或硬性闸门）要求进入提名阶段 → 交给提名驱动，不在主持循环里耗着 */
        if (!isNight && rp) {
          const gateNow = E.nomGate(id);
          const wantNom = (rp.enterNomination === true) || (gateNow && gateNow.mustEnter === true);
          if (wantNom && (gateNow.phase === 'day' || gateNow.phase === 'nomination')) {
            if (gateNow.phase === 'day') { try { E.setPhase(id, 'nomination'); } catch (e) {} }
            applied.phase = 'nomination';
            E.log(id, '系统', '说书人决定进入提名阶段（今日公共消息 ' + gateNow.count + ' 条，判定 ' + gateNow.stage + '）', true);
            setTimeout(function () {
              try { runNomination(id, {}); } catch (e) { E.log(id, '系统', '自动进入提名失败：' + String((e && e.message) || e), true); }
            }, 30);
            break;
          }
        }
        const didAct = (applied.info > pre.info) || (applied.markers > pre.markers) || (applied.deaths > pre.deaths) || (applied.phase && applied.phase !== pre.phase);
        stallN = didAct ? 0 : (stallN + 1);
        if (applied.phase) break;   /* 阶段已经推进，本阶段主持结束 */
        if (stRound >= ST_SAFETY_CAP) break;
        /* 这一轮向玩家提了问：先驱动他们私下回答，再等回答落库，不能问完就收工 */
        if (newlyAsked.length) {
          askDriven = true;
          try { runRound(id, { seats: newlyAsked, replyTo: 'storyteller' }); } catch (e) { /* ignore */ }
        }
        if (askedSeats.length) {
          const t0 = Date.now();
          let answered = false;
          for (;;) {
            const stNow = E.loadState(id);
            const fresh = (stNow.messages || []).slice(stLastN);
            answered = fresh.some(function (m) {
              return m.from !== 'storyteller' && askedSeats.indexOf(Number(m.from)) >= 0;
            });
            if (answered) break;
            if (Date.now() - t0 >= WAIT_ANSWER_MS) break;
            await sleep(600);
          }
          stLastN = msgN();
          if (!answered) break;
          continue;
        }
        /* 没问人：做了事且没有新消息就可以收工；空转则再来一轮，最多两轮空转 */
        const nowSt = msgN();
        if (didAct && nowSt <= stLastN) break;
        if (stallN >= 2) break;
        stLastN = nowSt;
      }
      /* 兜底：整段主持结束时仍未宣布推进，且本阶段没有任何待回答的提问 → 自动进入白天，
         绝不能让整局永远停在夜里（这是之前「主持完成却不到白天」的根因之一）。 */
      if (isNight && applied.phase === null && !askedSeats.length) {
        const stAfter = E.loadState(id);
        if (stAfter.phase === 'night') {
          const r = E.setPhase(id, 'day');
          if (r && r.ok) { applied.phase = 'day'; E.log(id, '系统', '说书人没有宣布推进，系统自动进入白天', true); }
        }
      }
      if (!out) throw new Error('说书人没有返回结果');
      const parsed = parseReply(out.text);
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

/* ==================== 提名阶段驱动（m08944 / m08974 / m08987） ==================== */
/* 一次 runNomination 走完整个提名阶段：
   1) 逐个询问还有提名权的存活玩家要不要提名谁；
   2) 队列里的提名按先后顺序逐个处理：提名理由 → 被提名发言 → 投票（AI 各自决定举手）→ 时钟轮转锁定 → 结算；
   3) 队列空了再问一轮「还有没有人提名」，所有有提名权的人都表态过才收尾；
   4) 宣布处决结果（在处决台上票最高者）并进入夜晚。 */
const NOM_RUNNING = new Map();
const NOM_ASK_WAIT_MS = 45000;   /* 等真人表态的最长时间 */
const NOM_TICK_MS = 620;         /* 时钟每转一格 */

function nomStatus(id){
  const r = NOM_RUNNING.get(id);
  if (!r) return { running:false, stage:'idle', log:[] };
  return { running:r.running, stage:r.stage, log:r.log.slice(-40), error:r.error || null, cur:r.cur || null };
}

function nomSay(id, text){
  if (!text) return;
  E.say(id, 'storyteller', String(text), 'town');
}

/* 提名相关的专用提示词：让模型只判断「要不要提名 / 怎么辩护 / 举不举手」 */
function buildNomPrompt(id, seat, kind, extra){
  const v = viewFor(id, seat);
  const s = E.loadState(id);
  const lines = [];
  lines.push('【局面】第 ' + (s.day||1) + ' 天白天，提名与投票阶段。存活 ' + v.aliveList.join('、') + '；已出局 ' + (v.deadList.join('、') || '无') + '。');
  lines.push('【你的身份】你是 ' + (seat+1) + ' 号 ' + v.name + '，角色 ' + (v.role || '未知') + (v.ability ? ('（' + v.ability + '）') : '') + '。');
  if (v.privateInfo && v.privateInfo.length) lines.push('【你掌握的私下信息】\n' + v.privateInfo.join('\n'));
  lines.push('【最近的公开对话】\n' + renderMessages(v.messages, s.seats));
  lines.push(stylePrompt(id));
  if (kind === 'propose') {
    lines.push('【现在】轮到你表态：今天要不要发起提名？');
    lines.push('规则：每位存活玩家每天只有 1 次提名权；同一时间只能有一项提名；可以提名自己。');
    lines.push('想提名就把 nominate 写 true，并在 target 写被提名者的座位号（从 1 开始），reason 写你要公开说的提名理由（一两句，直接对全桌说，不要写「我要提名」以外的客套）。');
    lines.push('不想提名就 nominate 写 false，target 写 0，reason 留空。不要为了凑热闹乱提名。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","nominate":true或false,"target":座位号,"reason":"提名理由"}');
  } else if (kind === 'defense') {
    lines.push('【现在】你被 ' + extra.from + ' 号 ' + extra.fromName + ' 提名了，理由：「' + (extra.reason||'（没有说明）') + '」。');
    lines.push('请做被提名发言：为自己辩护、说明你的身份与信息、或者指出提名者的破绽。一两句话，直接对全桌说。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","say":"你的被提名发言"}');
  } else {
    lines.push('【现在】正在对 ' + extra.target + ' 号 ' + extra.targetName + ' 投票（被提名理由：「' + (extra.reason||'无') + '」）。');
    lines.push('请决定你要不要举手赞成处决他。举手就是公开支持今天处决这个人。');
    lines.push('判断依据：你信不信他的身份、他的死对哪一方有利、你自己会不会因此暴露。想清楚再举手，别随大流。');
    if (extra.dead) lines.push('注意：你已经出局，这一票是你的死亡票，投出去就没有了（除非你复活）。');
    lines.push('【举手方式】举手只由 hand 字段决定，圆桌上会用 ✋ 显示，不需要也不允许用发言说出「我举手 / 我投票」这类话——投票阶段没有公开发言的环节。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","hand":true或false,"say":"留空字符串即可"}');
  }
  return { prompt: lines.join('\n'), view: v };
}

async function askSeat(id, seat, kind, extra){
  const built = buildNomPrompt(id, seat, kind, extra || {});
  const route = routeFor(id, seat);
  const out = await callModel({ game:id, seat:seat, prompt:built.prompt, system:playerSystem(id, seat), provider:route.provider, model:route.model });
  if (out && out.error) return { error: out.error };
  const p = parseReply(out.text);
  if (p.think) E.think(id, seat, p.think);
  const obj = extractObject(String(out.text || ''));
  return { parsed:p, obj:obj || {} };
}

function seatType(s, i){ return (s.seats[i] && s.seats[i].type === 'player') ? 'player' : 'agent'; }

/* 等真人把某个动作做完（看完 stage 变了或超时） */
async function waitStage(id, want, capMs){
  const t0 = Date.now();
  for (;;) {
    const st = E.nomState(id);
    if (!st.ok) return false;
    if (st.nom.stage === want) return true;
    if (st.nom.stage === 'result' || st.nom.stage === 'done' || !st.nom.cur) return false;
    if (Date.now() - t0 > (capMs || NOM_ASK_WAIT_MS)) return false;
    await sleep(500);
  }
}

async function runNomination(id, opts){
  opts = opts || {};
  const curRun = NOM_RUNNING.get(id);
  if (curRun && curRun.running) return { ok:false, error:'提名阶段正在处理中' };
  const s0 = E.loadState(id);
  if (s0.phase !== 'day' && s0.phase !== 'nomination' && s0.phase !== 'vote') {
    return { ok:false, error:'现在不是白天的提名阶段' };
  }
  const run = { running:true, stage:'ask', log:[], error:null, cur:null };
  NOM_RUNNING.set(id, run);
  const log = function(t){ run.log.push({ t:new Date().toISOString(), text:String(t) }); };
  const setStage = function(k){ run.stage = k; E.nomSetStage(id, k); };

  (async function(){
    try {
      if (s0.phase === 'day') E.setPhase(id, 'nomination');
      /* ---- 第一轮询问：谁要提名 ---- */
      const passes = [0, 1];
      for (let pi = 0; pi < passes.length; pi++) {
        let anyNom = false;
        /* 每一轮重新问一遍：上一轮的表态记录要清掉，否则第二轮永远问不到人 */
        E.nomClearAsked(id);
        const st = E.nomState(id);
        const s = E.loadState(id);
        /* 所有还有提名权、本轮还没表态过的存活玩家 */
        const askList = [];
        s.seats.forEach(function (x, i) {
          if (!s.alive[i]) return;
          if (st.nom.usedNom[i]) return;
          askList.push(i);
        });
        if (!askList.length) break;
        setStage('ask');
        nomSay(id, pi === 0 ? '现在进入提名阶段。想发起提名的人请说出你要提名谁、理由是什么。' : '还有没有人要发起提名？');
        log('询问第 ' + (pi+1) + ' 轮：' + askList.length + ' 位玩家需要表态');
        for (const seat of askList) {
          const sNow = E.loadState(id);
          if (sNow.nom && sNow.nom.asked[seat]) continue;
          if (seatType(sNow, seat) === 'player') {
            /* 真人：等他点「提名」或「不提名」（前端调 nomPropose / nomSkip），超时才自动跳过 */
            const t0 = Date.now();
            for (;;) {
              const stW = E.nomState(id);
              if (!stW.ok || stW.nom.asked[seat]) break;
              if (Date.now() - t0 > NOM_ASK_WAIT_MS) { E.nomMarkAsked(id, seat); break; }
              await sleep(500);
            }
            continue;
          }
          const r = await askSeat(id, seat, 'propose', {});
          E.nomMarkAsked(id, seat);
          if (r.error) { log((seat+1) + ' 号提名表态失败：' + r.error); continue; }
          const want = (r.obj && r.obj.nominate === true);
          const tgt = Number((r.obj && r.obj.target) || 0);
          const reason = String((r.obj && r.obj.reason) || '').trim();
          if (!want || !(tgt >= 1 && tgt <= sNow.seats.length)) continue;
          if (tgt - 1 === seat) { /* 可以提名自己 */ }
          const pr = E.nomPropose(id, seat, tgt - 1, reason);
          if (!pr.ok) { log((seat+1) + ' 号提名未生效：' + pr.error); continue; }
          anyNom = true;
          log((seat+1) + ' 号提名了 ' + tgt + ' 号：' + reason);
          /* 提名理由由提名者自己公开说出来 */
          if (reason) E.say(id, seat, reason, 'town');
        }
        /* ---- 处理队列（真人在提问阶段也可能自己提名，所以以队列是否有货为准）---- */
        for (;;) {
          const stQ = E.nomState(id);
          if (!stQ.ok || !stQ.nom.queue.length) break;
          const nx = E.nomNext(id);
          if (!nx.ok) break;
          anyNom = true;
          const c = nx.cur;
          run.cur = { from:c.from, target:c.target };
          setStage('defense');
          const sC = E.loadState(id);
          if (c.reason) nomSay(id, (c.from+1) + ' 号 ' + sC.seats[c.from].name + ' 提名了 ' + (c.target+1) + ' 号 ' + sC.seats[c.target].name + '。');
          /* 被提名发言 */
          if (seatType(sC, c.target) === 'player') {
            await waitStage(id, 'vote', NOM_ASK_WAIT_MS);
          } else {
            const d = await askSeat(id, c.target, 'defense', { from:c.from+1, fromName:sC.seats[c.from].name, reason:c.reason });
            const txt = (d.parsed && d.parsed.say) ? String(d.parsed.say).trim() : '';
            if (txt) { E.say(id, c.target, txt, 'town'); }
            E.nomSpeech(id, 'defense', txt || '（没有为自己辩护）');
          }
          /* 投票：AI 逐个决定，真人用前端按钮 */
          setStage('vote');
          const sV = E.loadState(id);
          const alive = sV.alive;
          const aiSeats = [];
          const humanSeats = [];
          sV.seats.forEach(function (x, i) {
            if (seatType(sV, i) === 'player') humanSeats.push(i); else aiSeats.push(i);
          });
          const outs = await Promise.all(aiSeats.map(function (i) {
            return askSeat(id, i, 'vote', { target:c.target+1, targetName:sV.seats[c.target].name, reason:c.reason, dead:!alive[i] }).catch(function (e) { return { error:String(e && e.message || e) }; });
          }));
          aiSeats.forEach(function (i, k) {
            const r = outs[k];
            if (!r || r.error) return;
            const hand = !!(r.obj && r.obj.hand === true);
            E.nomHand(id, i, hand);
            /* 举手只在圆桌上用 ✋ 表示，不占用公聊发言：投票阶段其他人也不能公开发言 */
          });
          if (humanSeats.length) {
            /* 等真人点完举手（前端 nomHand），最多 NOM_ASK_WAIT_MS */
            const t0 = Date.now();
            for (;;) {
              const sH = E.loadState(id);
              const curH = sH.nom && sH.nom.cur;
              if (!curH || sH.nom.stage !== 'vote') break;
              const missing = humanSeats.filter(function (i) { return curH.hands[i] === undefined; });
              if (!missing.length) break;
              if (Date.now() - t0 > NOM_ASK_WAIT_MS) break;
              await sleep(500);
            }
          }
          /* 时钟轮转：一格一格锁定 */
          E.nomClockBegin(id);
          setStage('clock');
          for (;;) {
            const tk = E.nomTick(id);
            if (!tk.ok) break;
            if (tk.stage === 'result') break;
            await sleep(NOM_TICK_MS);
          }
          setStage('result');
          const rs = E.nomState(id);
          const last = rs.ok && rs.nom.results.length ? rs.nom.results[rs.nom.results.length-1] : null;
          if (last) log('投票结果：' + (last.target+1) + ' 号 ' + last.votes + '/' + last.aliveCount + ' 票，' + (last.passed ? '上处决台' : '未上处决台'));
          E.nomClose(id);
          run.cur = null;
        }
        if (!anyNom) break;
      }
      /* ---- 收尾：处决并入夜 ---- */
      setStage('finish');
      const fin = E.nomFinish(id);
      if (fin.executed) {
        log('处决 ' + (fin.target+1) + ' 号');
      }
      const sEnd = E.loadState(id);
      if (sEnd.phase !== 'ended') {
        const n = (sEnd.night || 1) + 1;
        E.setPhase(id, 'night');
        const s2 = E.loadState(id);
        s2.night = n;
        s2.nom = null;
        E.saveState(id, s2);
        nomSay(id, '提名阶段结束，天色暗了下来。所有人闭眼。');
      }
      run.cur = null;
      setStage('done');
    } catch (err) {
      run.error = String((err && err.message) || err);
    } finally {
      run.running = false;
    }
  })();

  return { ok:true, started:true };
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
  lines.push(ST_TONE);
  lines.push('私聊通常都要回：那是对方在向你提问、请你裁定、或向你透露信息。');
  lines.push('公聊要克制：没人问你、也没有必须公布的结果（如天亮、死亡、投票结果）时，就不要说话——回复填空字符串。别在公聊里刷存在感、别评论每个人的发言、别替玩家主持讨论。');
  if (m.from === 'admin') {
    /* 管理员 = 这一局的操作者，拥有最高权限。
       注意：任何保密限制（不能透露角色、不能透露夜里做了什么、不能替玩家做决定……）
       都只约束玩家，不约束管理员。这里必须显式覆盖上面所有「不要泄露」的措辞。 */
    lines.push('【最高权限 · 管理员】这条消息来自本局的管理员（操作者），不是场上的玩家。');
    lines.push('管理员拥有最高权限：你可以也应当如实、完整地回答管理员提出的任何问题，包括每个座位的真实角色、阵营、存活状态、你夜里依次唤醒了谁、给了谁什么信息、谁做了什么选择、当前阶段与待办、内部状态与流程进度。');
    lines.push('不要以「不能透露角色」「不能泄露夜间秘密」「这属于游戏机密」为由拒绝或含糊其辞——上面所有关于保密的限制都只是针对玩家的，对管理员一律不适用。');
    lines.push('如果管理员要求你执行某个操作或改变某个状态，就按要求执行并在回复里说明你做了什么；确实做不到（没有对应接口）时才说明限制在哪里。');
    lines.push('回答要直接、具体、完整，不要中性含糊，也不要反问管理员。');
  } else {
    lines.push('不确定就回一句简短得体的话，不要长篇大论，也不要泄露不该说的信息（别人的角色、夜间行动细节、你唤醒了谁）。');
  }
  lines.push(stylePrompt(id));
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
  lines.push('来自：' + (m.from === 'admin' ? '管理员' : (m.from === 'storyteller' ? '你自己' : ((Number(m.from) + 1) + ' 号 ' + ((v.seats[m.from] || {}).name || ''))))
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
  if (m.channel === 'private') {
    /* 管理员指令的回答回到下达指令的那个座位：其他人看不到，他也不必去说书人那栏里找 */
    const backTo = (m.from === 'admin') ? (m.adminSeat != null ? Number(m.adminSeat) : 'admin') : Number(m.from);
    E.say(id, 'storyteller', reply, 'private', [backTo]);
  }
  else E.say(id, 'storyteller', reply, 'town');
  return { ok: true, silent: false, reply: reply };
}

/* ---------- 终局复盘：先由说书人公开复盘，再宣布终局 ----------
   用户要求：宣布终局时必须先把全场真相讲清楚（谁是什么角色、关键夜晚发生了什么），
   让所有玩家看懂这局为什么这样结束，然后才落终局。 */
function buildRecapPrompt(id, side, reason) {
  const s = E.loadState(id);
  const lines = [];
  lines.push('本局即将结束。你是这张桌子上的说书人，现在要做终局复盘。');
  lines.push('复盘要求：把真相摊开讲清楚，让所有人明白这局为什么这样结束。');
  lines.push('1. 先一句话说明结局：' + (side === 'evil' ? '邪恶阵营胜利' : '善良阵营胜利') + '（' + (reason || '说书人宣布结束') + '）。');
  lines.push('2. 逐座位列出每个人的真实角色与最终身份，说明他/她在这一局里做了什么关键的事。');
  lines.push('3. 回顾关键夜晚与关键白天：夜里谁被唤醒、得到什么信息、谁死了；白天谁被处决、哪次投票是转折。');
  lines.push('4. 最后用两三句总结：善良方输在哪 / 邪恶方赢在哪，或者反之。');
  lines.push('语气自然平淡，像真人说书人在收桌时讲话，不要过度渲染，也不要提「提示词」「模型」「AI」。');
  lines.push(stylePrompt(id));
  lines.push('');
  lines.push('【剧本】' + s.script + '　共 ' + s.night + ' 夜 / ' + s.day + ' 天');
  lines.push('');
  lines.push('【全场真相】（座位号从 1 开始）');
  (s.seats || []).forEach(function (x, i) {
    lines.push((i + 1) + ' 号：' + x.name + (s.alive[i] ? '（存活）' : '（已死亡）') + ' 角色=' + ((s.roles && s.roles[i]) || '未记录'));
  });
  lines.push('');
  lines.push('【对局日志（公开部分）】');
  const pub = (s.log || []).filter(function (x) { return !x.priv; }).slice(-60);
  if (!pub.length) lines.push('（没有可用日志）');
  pub.forEach(function (x) {
    const t = String(x.t || '').replace('T', ' ').slice(5, 16);
    lines.push(t + '　' + (x.who || '') + '：' + (x.text || ''));
  });
  lines.push('');
  lines.push('严格只输出一个 JSON 对象：');
  lines.push('{"think":"你的复盘思路","reply":"你要公开发布的完整复盘文字"}');
  return lines.join('\n');
}

/* 说书人 Agent 的终局复盘：发一条公聊，然后落终局。非 Agent 说书人返回 ok:false 由调用方自行 endGame */
async function storyRecap(id, side, reason) {
  const s = E.loadState(id);
  if (!s || !s.storyteller || s.storyteller.type !== 'agent') return { ok: false, skipped: true };
  if (s.win && s.win.over) return { ok: false, skipped: true, error: '本局已经结束了' };
  const route = routeFor(id, 'storyteller');
  let text = '';
  try {
    const out = await callModel({
      game: id, seat: 'storyteller', prompt: buildRecapPrompt(id, side, reason),
      provider: route.provider, model: route.model, system: storytellerSystem(id)
    });
    if (out && !out.error) {
      const parsed = parseReply(out.text);
      if (parsed.think) E.think(id, 'storyteller', parsed.think);
      text = String(parsed.reply || parsed.say || '').trim();
    }
  } catch (e) { text = ''; }
  if (text) {
    E.say(id, 'storyteller', text, 'town');
    E.log(id, '说书人', '发布终局复盘', false);
  }
  const w = E.endGame(id, side, reason);
  return { ok: true, recap: text, win: w.win };
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
  runNomination, nomStatus, buildNomPrompt,
  viewFor, viewForStoryteller, buildPrompt, buildStorytellerNightPrompt, buildStorytellerDayPrompt,
  parseReply, extractObject, runRound, runStoryteller, status, storyStatus, callModel, roleInfo, allRoles,
  setLlmCall, hasLlm, routeFor,
  wikiLookup, clearKnowledge, playerSystem, storytellerSystem, gameKnowledge, CORE_RULES, BALANCE_RULES,
  storyReply, buildStoryChatPrompt, AI_STYLES, stylePrompt, styleKey,
  storyRecap, buildRecapPrompt
};