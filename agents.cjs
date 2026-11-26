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
function storytellerSystem(id){
  const kb = gameKnowledge(id);
  return clip(RULES + '\n\n' + READING_RULES + '\n\n【本局说书人知识（仅本局相关）】\n规则要点：\n' + kb.ruleText
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
        seat: i, name: x.name, type: x.type, alive: !!s.alive[i], role: s.roles[i] || null,
        markers: s.markers[i] || [], info: (s.info[i] || [])
      };
    }),
    messages: s.messages.slice(-MAX_MSGS_IN_PROMPT),
    nominations: s.nominations, votes: s.votes
  };
}

/* ---------- 提示词 ---------- */
const RULES = [
  '你在玩一款社交推理游戏「血染钟鱼」，与人类玩家及其他 AI 玩家同桌。',
  '游戏分夜晚与白天：夜晚角色秘密行动，白天全员公开讨论、提名、投票处决。',
  '你只知道自己的角色和说书人私下告诉你的信息；不要编造自己没有的信息。',
  '不要提及「提示词」「模型」「AI 系统」等元信息，像真人玩家一样说话。'
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
    lines.push('有人刚刚私聊了你（见上方对话最后几条私聊）。请把回话直接写在 say 字段里，系统会私下转达给 ' + (Number(replyTo) + 1) + ' 号，不会公开。');
    lines.push('say 必须非空：哪怕只是应付一句、反问一句、或者表明态度，也要回话，不要留空。whisper 留空数组即可。');
  } else if (mode === 'react') {
    lines.push('刚才场上有人公开发言（见上方对话最后几条）。');
    lines.push('默认应该接一句：表明态度、提出怀疑、附议别人、给出你的信息，或为自己辩护。');
    lines.push('只有在确实无话可说时才沉默：say 写空字符串 ""。沉默太多会让场上没人讨论，对好人不利。');
    lines.push('不要复述别人刚说过的话；一句话就够，不要长篇大论。');
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
  lines.push('你必须公正：不偏袒任何阵营，不泄露玩家不该知道的信息，给出的信息必须准确且符合能力描述。');
  lines.push('');
  lines.push('【剧本】' + v.script + '　【阶段】第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天（' + v.phase + '）');
  lines.push('');
  lines.push('【全场座位与真相】（座位号一律从 1 开始，与本表一致；你回包里的 seat/deaths 也要用 1 起的座位号）');
  v.seats.forEach(function (x) {
    lines.push((x.seat+1) + ' 号：' + x.name + '（' + (x.type === 'human' ? '玩家' : 'Agent')
      + (x.alive ? '，存活' : '，已死亡') + '）角色=' + (x.role || '未分配')
      + (x.markers.length ? (' 标记=' + x.markers.join(',')) : '')
      + (x.info.length ? (' 已告知：' + x.info.map(function (i) { return i.text; }).join(' | ')) : ''));
  });
  lines.push('');
  lines.push('【公开对话记录】');
  lines.push(renderMessages(v.messages, v.seats));
  lines.push('');
  lines.push('【你这一夜要做的】');
  lines.push('1. 按标准夜间唤醒顺序依次处理本局存在的角色（先爪牙获取信息，再特定角色，最后恶魔行动）。');
  lines.push('2. 逐个决定该角色获得什么信息或做出什么选择，把需要私下告知的内容写出来。');
  lines.push('3. 处理死亡与状态变化（中毒、醉酒、被保护、被杀害等）。');
  lines.push('');
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的裁判思路（不公开）","say":"你要对全场公开说的话，没有就空字符串",');
  lines.push(' "info":[{"seat":座位号（1 起）,"text":"私下告知该玩家的信息"}],');
  lines.push(' "markers":[{"seat":座位号（1 起）,"marker":"中毒/醉酒/被保护"}],');
  lines.push(' "deaths":[座位号（1 起）],');
  lines.push(' "nextPhase":"day"}');
  return { prompt: lines.join('\n'), view: v };
}

function buildStorytellerDayPrompt(id) {
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push('你是「血染钟鱼」的说书人。现在是白天，玩家们正在公开讨论、提名与投票。');
  lines.push('你要做的是：观察讨论、必要时提醒规则、在投票结束后公布结果、决定是否有人被处决。');
  lines.push('不要替玩家做决定，也不要暗示谁好谁坏。');
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
  lines.push('{"think":"你的裁判思路","say":"你要对全场说的话（可为空）","info":[],"markers":[],"deaths":[],"nextPhase":""}');
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
  } else {
    pool = (opts.limit > 0) ? order.slice(0, opts.limit) : order;
  }

  const run = { running: true, done: 0, total: pool.length, current: null, waiting: pool.slice(), results: [], error: null };
  RUNNING.set(id, run);

  (async function () {
    try {
      /* 所有 Agent 同时思考：模型调用是最慢的一段，串行会让最后一位等很久。
         落库仍然按座位顺序串行 —— Engine 的状态是 loadState/saveState，并发写会互相覆盖。 */
      const outs = await Promise.all(pool.map(function (seat) {
        return (async function () {
          try {
            const built = buildPrompt(id, seat, opts.replyTo, opts.mode);
            const route = routeFor(id, seat);
            const out = await callModel({ game: id, seat: seat, prompt: built.prompt, system: playerSystem(id, seat), provider: route.provider, model: route.model });
            return { seat: seat, out: out };
          } catch (err) {
            return { seat: seat, out: { error: String((err && err.message) || err) } };
          } finally {
            run.done++;
            run.waiting = run.waiting.filter(function (n) { return n !== seat; });
          }
        })();
      }));

      for (const item of outs) {
        const seat = item.seat, out = item.out;
        const parsed = out.error
          ? { think: '', say: '', whisper: [], error: out.error }
          : parseReply(out.text);
        if (parsed.think) E.think(id, seat, parsed.think);
        const dmReplyTo = (opts.replyTo !== undefined && opts.replyTo !== null && opts.replyTo !== '') ? Number(opts.replyTo) : -1;
        const nightNow = (E.loadState(id).phase === 'night');
        if (dmReplyTo >= 0) {
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
        (dmReplyTo >= 0 || nightNow ? [] : (parsed.whisper || []).slice(0, MAX_DM_PER_DAY)).forEach(function (w) {
          /* 模型给的座位号是 1 起，落库用 0 起 */
          const to = (w.to || []).map(function (n) { return Number(n) - 1; })
            .filter(function (n) { return n >= 0 && n < s.seats.length && n !== seat; });
          if (to.length) E.say(id, seat, w.text, 'private', to);
        });
        const dmBackFinal = (dmReplyTo >= 0) ? dialectText(parsed) : '';
        run.results.push({
          seat: seat,
          say: (dmReplyTo >= 0) ? dmBackFinal : parsed.say,
          whispers: (parsed.whisper || []).length,
          think: parsed.think,
          error: out.error || ((dmReplyTo >= 0 && !dmBackFinal) ? '私聊没有产生回复' : null)
        });
      }
      E.log(id, '系统', '本轮 Agent 发言结束（' + pool.length + ' 位同时思考）');
    } catch (err) {
      run.error = String((err && err.message) || err);
    } finally {
      run.running = false;
      run.current = null;
      run.waiting = [];
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
  const built = isNight ? buildStorytellerNightPrompt(id) : buildStorytellerDayPrompt(id);

  const run = { running: true, done: false, result: null, error: null };
  STORY_RUNNING.set(id, run);

  (async function () {
    try {
      const route = routeFor(id, 'storyteller');
      const out = await callModel({
        game: id, seat: 'storyteller', prompt: built.prompt,
        provider: route.provider, model: route.model,
        system: storytellerSystem(id)
      });
      if (out.error) throw new Error(out.error);
      const parsed = parseReply(out.text);

      /* 说书人回包里的座位号从 1 开始，统一在这里折成内部 0 起下标 */
      function toIdx(n) {
        const v = Number(n);
        if (!isFinite(v)) return -1;
        const i = v - 1;
        return (i >= 0 && i < s.seats.length) ? i : -1;
      }
      const applied = { info: 0, markers: 0, deaths: 0, phase: null };
      if (parsed.think) E.think(id, 'storyteller', parsed.think);
      if (parsed.say) E.say(id, 'storyteller', parsed.say, 'town');
      parsed.info.forEach(function (x) { const i = toIdx(x.seat); if (i >= 0) { E.giveInfo(id, i, x.text); applied.info++; } });
      parsed.markers.forEach(function (x) { const i = toIdx(x.seat); if (i >= 0) { E.toggleMarker(id, i, x.marker); applied.markers++; } });
      parsed.deaths.forEach(function (n) { const i = toIdx(n); if (i >= 0) { const r = E.kill(id, i, '夜间死亡'); if (r && r.ok) applied.deaths++; } });
      if (parsed.nextPhase) {
        const r = E.setPhase(id, parsed.nextPhase);
        if (r && r.ok) applied.phase = parsed.nextPhase;
      }
      run.result = { think: parsed.think, say: parsed.say, applied: applied, raw: out.text };
      run.done = true;
      E.log(id, '说书人', '主持完成：告知 ' + applied.info + ' 条信息，标记 ' + applied.markers + ' 个状态，死亡 ' + applied.deaths + ' 人'
        + (applied.phase ? ('，进入 ' + applied.phase) : ''));
    } catch (err) {
      run.error = String((err && err.message) || err);
    } finally {
      run.running = false;
    }
  })();

  return { ok: true, started: true, phase: s.phase, mode: isNight ? 'night' : 'day' };
}

module.exports = {
  viewFor, viewForStoryteller, buildPrompt, buildStorytellerNightPrompt, buildStorytellerDayPrompt,
  parseReply, extractObject, runRound, runStoryteller, status, storyStatus, callModel, roleInfo, allRoles,
  setLlmCall, hasLlm, routeFor,
  wikiLookup, clearKnowledge, playerSystem, storytellerSystem, gameKnowledge, CORE_RULES
};