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
const MAX_MSGS_IN_PROMPT = 20;   /* 只带最近 20 条：历史越长首 token 越慢，这些足够推理 */
/* 私聊不再限制次数：上限只是防模型一次刷屏的兜底 */
const MAX_DM_PER_DAY = 99;
const CALL_TIMEOUT_MS = 90000;
/* 单个 AI 一次模型调用最多等这么久：超时就算这一位这轮弃权，不能让整轮卡死 */
const MODEL_TIMEOUT_MS = 45000;
const FENCE = String.fromCharCode(96, 96, 96);

let LLM_CALL = null;
function setLlmCall(fn) { LLM_CALL = typeof fn === 'function' ? fn : null; }
function hasLlm() { return typeof LLM_CALL === 'function'; }

/* 按对局精准知识包：只读规则总纲 + 本剧本 + 本局角色，绝不加载无关内容 */
const PAGES = path.join(ROOT, 'data', 'wiki', 'pages');
const PLAYER_RULES = ['规则概要','重要细节','术语汇总','投票','提名'];
const ST_RULES = ['规则概要','重要细节','夜晚行动顺序一览','相克规则','隐性规则汇总','给说书人的建议'];
const CORE_RULES = ST_RULES;
const PAGE_CLIP = 3000;      /* 单页最多注入字符数 */
const OWN_CLIP = 2000;       /* 玩家自己角色页最多注入字符数 */
const ROLE_DETAIL_CLIP = 500;/* 说书人：每个角色细则最多注入字符数 */
const SYSTEM_CLIP = 14000;   /* 玩家 system 最多字符数：prompt 越短模型吐字越快 */
const ST_SYSTEM_CLIP = 16000;/* 说书人 system 最多字符数：只带核心规则和精简角色能力，避免超长 prompt 拖慢响应 */
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

/* 四种身份类型是互不相同的分类。说书人最容易犯的错就是把外来者当成镇民，
   于是给「你会得知一个镇民角色」这类能力配了管家、酒鬼这种外来者。
   这一段在每一处说书人提示词里都注入，并且明确「类型只看括号标签」。 */
const FACTION_RULES = [
  '【四种身份类型 · 必须严格区分】本游戏的所有角色分属四个互不相同的身份类型，一个角色只属于其中一种，绝不可混用：',
  '· 镇民（好人阵营）：能力通常带来信息或保护，例如洗衣妇、图书管理员、调查员、厨师、共情者、占卜师、士兵、市长。',
  '· 外来者（好人阵营，但能力通常对自己人有害）：例如管家、酒鬼、陌客、圣徒、修补匠、月之子、狂人。外来者不是镇民，也不是邪恶。',
  '· 爪牙（邪恶阵营）：例如投毒者、间谍、男爵、红唇女郎、教父。爪牙不是恶魔，也不是镇民。',
  '· 恶魔（邪恶阵营）：例如小恶魔、僵怖、普卡、沙巴洛斯、方古。每局通常只有一名恶魔。',
  '判断某个角色属于哪种类型，唯一依据是角色清单里角色名后面括号中的标签（如「管家（外来者）」），不要凭名字或印象猜测。',
  '当能力要求「一个镇民角色」「一个外来者角色」「一个爪牙」时，只能从对应类型里选；给错类型就是明确的主持失误，必须避免。',
  '例：洗衣妇的能力是「你会得知两名玩家和一个镇民角色：这两名玩家之一是该角色」——这里必须是镇民，绝不能是管家、酒鬼这类外来者，也不能是爪牙或恶魔。同理，图书管理员给的是外来者，不是镇民。',
].join('\n');

function storytellerSystem(id){
  const kb = gameKnowledge(id);
  return clip(RULES + '\n\n' + stylePrompt(id) + '\n\n' + READING_RULES + '\n\n' + FACTION_RULES + '\n\n' + BALANCE_RULES + '\n\n【本局说书人知识（仅本局相关）】\n规则要点：\n' + kb.ruleText
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
  /* 假身份优先：酒鬼、疯子、提线木偶这类角色「以为自己是谁」，玩家看到的就是这张假牌，
     绝不能把他真实的那张（酒鬼/提线木偶）发给他自己。 */
  const apparent = (s.apparentRoles || {})[seat] || null;
  let myRole = apparent || s.roles[seat] || null;
  if (!myRole) {
    const said = (s.info[seat] || []).map(function (x) { return String(x.text || ''); }).join('\\n');
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
    apparent: !!apparent,
    /* 只有能力明确改写过阵营时才告诉玩家「你现在的阵营变了」；角色自带的阵营仍以他自己那张牌为准，
    /* 阵营可能被能力改写（莽夫、食人魔、灵言师等）：只告诉玩家自己当前的阵营，不解释原因 */
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
/* ---------- 带 [..] 标签的特殊角色：说书人照顾要点 ----------
   带方括号的角色会改变开局配置或在场上制造额外状态。其中「配比 / 座位编排」这一层
   已由 engine.dealRoles 机械完成（外来者增减、指定角色、邻座、特殊开局点名），
   这里补的是留在说书人手里的那一层：谁醉酒、谁变角色、什么时候告知谁、规则该如何改写。 */
const SPECIAL_ROLE_RULES = {
  '男爵': '程序已按 [+2 外来者] 多配了 2 名外来者，你不需要再改配置；但别忘了外来者变多意味着善良方更弱，天平上多给善良一点空间。',
  '军团': '这是一桌军团局：所有玩家都是军团，没有人是真正的镇民/外来者/爪牙。每个夜晚*（首夜不发动）可能有一名玩家死亡，由你决定死不死。若一项提名只有邪恶阵营投票则该提名无效（程序已自动判）。军团也会被当作爪牙。',
  '卡扎力': '你要在首夜亲自决定「谁是什么爪牙」：用 ops 的 role 操作把爪牙改成你选的爪牙角色，并私聊告知本人新的角色能力。外来者数量可以是任意值：需要增减时用 ops 的 role 改角色，而不是依赖配比表。',
  '召唤师': '首夜先私聊告知 ta 三个伪装身份；第三个夜晚让 ta 选择一名玩家，用 ops 的 role 把该玩家改成你指定的恶魔角色（并把阵营改成邪恶）。你不在场时不要生成真正的恶魔。',
  '唱诗男孩': '程序已保证国王在场。当恶魔杀死国王时，用 info 私聊告知 ta「谁是恶魔」。其它夜晚不要给 ta 信息。',
  '堤丰之首': '程序已把邪恶角色排成连续邻座、把你（恶魔）放在正中，并多配 1 名爪牙。外来者数量你可以任意定（默认按配比表）。',
  '小怪宝': '程序已多配 1 名爪牙。每个夜晚，所有爪牙要秘密决定由谁照看小怪宝并「是恶魔」：私下问爪牙，收到答复后用 ops 的 marker 标记照看者。',
  '巡山人': '程序已保证落难少女在场。每局限一次：ta 选中落难少女时，用 ops 的 role 把落难少女改成一名不在场的镇民角色，并私聊告知新角色与能力。',
  '提线木偶': '程序已把木偶排在恶魔邻座。首夜要用 info 私聊告诉恶魔「谁是提线木偶」；木偶本人以为自己是你发给 ta 的那个善良角色，绝对不要向 ta 透露真相。',
  '无神论者': '本局没有爪牙也没有恶魔（程序已改写配比）。你是唯一可以打破规则的人：可以给假信息、可以让能力「出错」，但必须服务于平衡。如果说书人（也就是你）被处决，善良阵营直接获胜——这一点要在那天如实结算。',
  '村夫': '程序已按 [+0~2 村夫] 随机决定村夫数量。若场上有 2 名以上村夫，其中一人醉酒：用 ops 的 marker 给 ta 加「醉酒」，并让 ta 的能力悄悄失效（给的信息可以是错的）。',
  '气球驾驶员': '程序已按 [+0~1 外来者] 随机决定外来者数量。ta 每夜得知一名「与上一夜得知的玩家角色类型不同」的玩家：给信息时注意不要和上一夜重复类型。',
  '限': '外来者数量可以是任意值（不必按配比表）。在「等同于初始外来者数量的夜晚」（即第 N 夜，N=开局时的外来者人数）用 ops 的 marker 给所有镇民加「中毒」，直到下个黄昏再清掉。',
  '隐士': '程序已按 [-0~1 外来者] 随机决定外来者数量。隐士拥有所有外来者能力：当有人查验 ta 时，可以按需要把 ta 当作任意一个外来者/邪恶角色来回答。'
};
function specialRolesBrief(id){
  const s = E.loadState(id);
  const seen = {};
  const out = [];
  (s.seats || []).forEach(function (x, i) {
    const r = (s.roles || {})[i];
    if (!r || seen[r]) return;
    if (!SPECIAL_ROLE_RULES[r]) return;
    seen[r] = true;
    out.push('- ' + (i + 1) + ' 号 ' + x.name + '（' + r + '，' + (s.alive[i] ? '存活' : '已死亡') + '）：' + SPECIAL_ROLE_RULES[r]);
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
        apparent: (s.apparentRoles || {})[i] || null,
        alignment: (s.alignment && s.alignment[i]) || null,
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
  '【能力文本里的星号 * 必须看准】角色能力里「每个夜晚*」的星号表示：这个能力在首个夜晚不发动，从第二个夜晚起才每夜发动。',
  '不带星号的「每个夜晚」表示：包括首个夜晚在内，每夜都发动。',
  '「每局游戏限一次，在夜晚时*」这种写法里的星号同样表示首个夜晚不能用，要从第二个夜晚起才能用。',
  '「在你的首个夜晚」表示只在第一个夜晚发动。判断某个角色今夜该不该行动时，一律以这条星号规则为准，不要凭印象。',
  '你只知道自己的角色和说书人私下告诉你的信息；不要编造自己没有的信息。',
  '不要提及「提示词」「模型」「AI」「机器人」等元信息，像普通玩家一样说话。',
  '指代任何一位玩家时必须写成「@名字」，例如「我觉得 @长庚 有问题」。不要只用座位号，也不要只写名字而不带 @。',
  '使用公开能力、或需要说书人裁定/公布结果时，要在发言里 @说书人 并说明你要做什么（例如「@说书人 我要公开查验结果」）；玩家可以不这么做，但你作为 AI 要养成这个习惯，否则说书人可能收不到你的请求。',
  '提名是有礼仪顺序的：① 提名时只说「@X 提名 @Y」，不要一上来就讲理由 ② 说书人点名请你说明理由时，你才说理由 ③ 说书人请被提名者反驳，被提名者才开口 ④ 之后才投票。轮到你之前不要抢话。',
  '提名阶段进入正式的一项提名后，只有提名者、被提名者和说书人可以公开发言，其他人保持安静。',
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
  /* 邪恶阵营夜里的串供：恶魔要把三个伪装身份分给爪牙、商量谁扮谁；爪牙要回报自己打算怎么演。
     夜里只有邪恶之间能私聊，善良玩家之间不行——所以这条只对邪恶角色显示。 */
  if (v.phase === 'night' && v.faction && /恶魔|爪牙/.test(String(v.faction))) {
    lines.push('【夜里可以闭眼串供】邪恶阵营之间可以在夜里私聊（善良玩家之间不行）。');
    if (/恶魔/.test(String(v.faction))) {
      lines.push('你是恶魔。上面「说书人私下告诉你的信息」里给了你爪牙是谁、以及三个可以拿来伪装的身份。');
      lines.push('今晚请用 whisper 逐个私聊每一位爪牙（用他们的座位号），把这三个伪装身份原样告诉他们，并和他们商量谁扮哪一个——尽量一人一个、不要撞身份，尽量挑和你们发言风格不冲突的。');
      lines.push('顺便可以商量今晚刀谁、明天怎么带节奏。这些只发给爪牙，不要发到公聊。');
    } else {
      lines.push('你是爪牙。今晚恶魔大概率会私聊你，把三个伪装身份分给你们。收到后回复一句你打算扮哪一个、准备怎么说，也可以主动说说你想刀谁。');
      lines.push('如果恶魔还没找你，可以主动私聊恶魔问「我们三个伪装怎么分」。这些只发给邪恶同伴，不要发到公聊。');
    }
  }
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
    lines.push('说书人（或另一位玩家）刚刚私聊了你，这是在向你提问。请把回答直接写在 say 字段里，系统会私下转达给对方，不会公开。');
    /* 把对方最后发来的私聊原文单独摘出来：只写「见上方对话」时模型经常答错对象——
       实测玩家问「三个伪装是什么」，恶魔回了一句「今晚我要选 @棉花糖」（把夜间刀人指令当成了问题）。 */
    var _rp = String(replyTo);
    var _peer = (_rp === 'storyteller')
      ? String((s.storyteller && s.storyteller.name) || '说书人')
      : String(((s.seats[Number(_rp)] || {}).name) || (Number(_rp) + 1) + ' 号');
    var _in = (v.messages || []).filter(function (m) { return m && m.channel === 'private' && String(m.from) === _rp; }).slice(-2);
    if (_in.length) {
      lines.push('【对方最后发给你的私聊原文】' + _peer + '：');
      _in.forEach(function (m) { lines.push('  「' + String(m.text || '') + '」'); });
      lines.push('你这一轮只回答上面这条私聊里问的事。对方问角色、问你的伪装身份、问你要穿哪个身份，就把你手上对应的信息告诉他（对邪恶同伴可以直说）；对方问夜间目标才回答夜间目标。不要答非所问，也不要反过来问他。');
    }
    lines.push('say 必须非空：必须给出一句真实的回答（说书人的提问尤其必须回答，例如你要选择的目标），不能留空。whisper 留空数组即可。');
    lines.push('【正面回答，不许敷衍】对方问什么，你第一句就先回答什么：他问「你是不是信息位」就回答是或不是、你是什么位；他问「你怀疑谁」就点出具体座位。禁止用「收到」「我先听听」「等 X 摊完再说」「知道了」这类空话开头——那等于没回。');
    lines.push('不方便说也要给出理由（「现在不说，报了就等于把身份交出去」），而不是答非所问。回答一句就够，不要长篇。');
    lines.push('【输出要短】think 只写一句话（不超过 40 字）；say 最多两句、不超过 60 字。别写小作文，对方在等你回话。');
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
    if (reactedCount >= 3) {
      lines.push('已经有三四个人说过了：除非你被 @ 到、被点名、被怀疑、被问到，或手里有直接相关的信息，否则可以不说了，say 写空字符串 ""。');
    } else if (reactedCount >= 1) {
      lines.push('已经有人接话，但仍然需要你表态：有观点、有信息、有怀疑对象就直说，别只是附和。');
    } else {
      lines.push('【还没有任何人回应这条消息】场子不能冷：你必须开口接一句，给出你的看法、态度或追问，不能沉默。');
    }
    lines.push(stylePrompt(id));
    lines.push('被 @ 到、被点名、被怀疑、被问到，或者你手上有跟它直接相关的信息 —— 那一定要说一句（但也可以用玩笑的方式说）。');
    lines.push('尽量不要说空话，但也不要把场面晾着：能接就接一句（一句话就够），只有确实完全插不上话时才写空字符串 ""。不要复述别人刚说过的话，不要长篇大论。');
    if (v.phase === 'night') lines.push('现在是夜晚：可以公开发言（不能私聊）。夜里大家也在广场上低声交谈，别因为天黑了就闭口不谈。');
    else lines.push('想单独问谁就私聊谁（whisper），不限次数；但别刷屏，一两句说清楚。');
  } else {
    lines.push(stylePrompt(id));
    lines.push('公开发言一句（按上面的风格说话，可以闲聊、给点信息或拉票），想单独问谁就私聊谁（whisper），不限次数。');
  }
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的真实推理（不公开）","say":"你的公开发言","whisper":[{"to":[座位号（从 1 开始）],"text":"私聊内容"}],"nominate":[你今天想提名的座位号，按优先级排序，可以为空数组]}');
  lines.push('【提名清单 nominate】你脑子里一直维护着一份「今天我想提名谁」的名单：把最想处决的人排最前面。每一次发言都可以顺手更新它——名单没变化就不要写这个字段（或者写 null）；要改就写完整的新名单，例如 [3,6]；确实一个人都不想提名就写空数组 []。到提名阶段说书人一问，系统会直接拿这份名单里还活着、今天还没被提名过的第一个人去发起提名，不会再问你一遍。所以名单要提前想清楚。');
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
  lines.push(FACTION_RULES);
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
  const srp = specialRolesBrief(id);
  if (srp) { lines.push(''); lines.push('【本局带 [ ] 标签的特殊角色 · 配比与座位已由程序排好，剩下这些要你亲自落实】'); lines.push('（凡是写着「程序已…」的，你不需要再做一遍；写着「你要…」的必须用 ops 或 info 真的做，只在 say 里说一句不算数）'); lines.push(srp); }
  lines.push('【关于提名处决】你不必急着投票。先听大家讨论：当有人提出了值得表决的指控、讨论已经充分、或者白天拖得太久（比如超过 10 分钟）没人推进，你就发起对某人的处决投票（见输出字段 voteTarget）。投票要按规则来：只有存活玩家有票，赞成必须多于反对且赞成票达到存活人数的一半才算通过。公告结果时如实说明票数与是否处决。');
  lines.push('');
  lines.push('【全场座位与真相】（座位号一律从 1 开始，与本表一致；你回包里的 seat/deaths 也要用 1 起的座位号）；角色名后面括号里的就是它的身份类型，给信息时严格按这个类型来选');
  v.seats.forEach(function (x) {
    const ri = x.role ? roleInfo(x.role) : null;
    const ab = ri && ri.ability ? (' 能力=' + String(ri.ability).replace(/\s+/g, ' ').slice(0, 220)) : '';
    const ft = ri ? ('（' + (ri.faction_zh || ri.faction || '') + '）') : '';
    lines.push((x.seat+1) + ' 号：' + x.name
      + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配') + ft + ab
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
  lines.push('【读能力文本时必须看准星号 *】「每个夜晚*」里的星号表示：这个能力在首个夜晚不发动，从第二个夜晚起才每夜发动；不带星号的「每个夜晚」才包含首个夜晚。「每局游戏限一次，在夜晚时*」同理，首个夜晚不能用。「在你的首个夜晚」则是只在第一个夜晚发动。判断某个角色今夜该不该行动、今夜该给谁发信息，一律以上表为准（表里已经按星号规则分好首个夜晚与其他夜晚），不要凭印象多加或漏掉。');
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
  lines.push('【角色能力需要用到的操作（ops）】当某个角色的能力不是「给信息」而是「真的改变场上状态」时，你必须用 ops 真的执行它，而不是只在 think 里想一想、或在 say 里宣布一句——只说不做等于没发生。可用操作（seat 一律写 1 起的座位号）：');
  lines.push('· {"op":"role","seat":N,"role":"角色名"} 把某人的角色改成该角色（舞蛇人、麻脸巫婆、方古、理发师、小怪宝继承、红唇女郎接替等）');
  lines.push('· {"op":"apparent","seat":N,"role":"角色名"} 只改他「看起来是什么」，不改真实角色（酒鬼、疯子、提线木偶、魔术师这类假身份）');
  lines.push('· {"op":"align","seat":N,"value":"evil或good"} 改阵营（莽夫、食人魔、灵言师、异端分子等）');
  lines.push('· {"op":"revive","seat":N} 复活（教授、集骨者、摆渡人）；{"op":"kill","seat":N,"reason":"原因","night":false} 白天致死请写 night:false');
  lines.push('· {"op":"execute","seat":N} 立刻处决（贞洁者、猎手、枪手、精神病患者等能力导致的处决）；{"op":"exile","seat":N} 流放旅行者');
  lines.push('· {"op":"shield","seat":N,"reason":"来源"} 免死一次（茶艺师、和平主义者、弄臣、魔鬼代言人、暴风捕手、维齐尔等）；{"op":"unshield","seat":N} 解除');
  lines.push('· {"op":"swap","a":N,"b":M} 交换两个座位的角色（女舍监、理发师等）');
  lines.push('· {"op":"marker","seat":N,"marker":"文本","scope":"day|night|game"} 打持续标记；{"op":"clearmarker","seat":N,"marker":"文本"} 清除');
  lines.push('· {"op":"grant","seat":N,"role":"角色名"} 让某人获得某角色的能力（哲学家、学徒、炼金术士、科学怪人等）');
  lines.push('· {"op":"used","seat":N,"key":"能力"} 记「本局已用过一次」；{"op":"resetnom","seat":N} 恢复提名权；{"op":"resetdeadvotes"} 恢复死亡票');
  lines.push('· {"op":"win","side":"good或evil","reason":"原因"} 直接判定胜负（圣徒被处决、主谋、利维坦等特殊胜负条件）');
  lines.push('不需要用到 ops 时写空数组 []。绝不要用 ops 去替玩家做「他能自己决定的事」。');
  lines.push('严格只输出一个 JSON 对象，不要代码块、不要多余文字：');
  lines.push('{"think":"你的裁判思路（不公开）","say":"你要对全场公开说的话，没有就空字符串",');
  lines.push(' "info":[{"seat":座位号（1 起）,"text":"私下告知该玩家的信息"}],');
  lines.push(' "markers":[{"seat":座位号（1 起）,"marker":"中毒/醉酒/被保护"}],');
  lines.push(' "deaths":[座位号（1 起）],');
  lines.push(' "ops":[{"op":"操作名","seat":座位号（1 起）,其余参数}],');
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
  lines.push(FACTION_RULES);
  lines.push('你要做的是：观察讨论、必要时提醒规则、在投票结束后公布结果、决定是否有人被处决。');
  lines.push('不要替玩家做决定，也不要暗示谁好谁坏。');
  lines.push('公聊要克制：没有人问你、也没有必须公布的结果（天亮、死亡、投票结果）时就不要说话，say 留空字符串。不要评论每个玩家的发言、不要替大家主持讨论、不要刷存在感。');
  lines.push('但记得天平：白天如果你要行使裁量权（是否处决、给什么提示、如何描述死亡），先判断哪一方更弱，把空间留给弱势方。');
  lines.push('');
  lines.push('【剧本】' + v.script + '　【阶段】第 ' + v.night + ' 夜 / 第 ' + v.day + ' 天（' + v.phase + '）');
  lines.push('');
  const srpD = specialRolesBrief(id);
  if (srpD) { lines.push(''); lines.push('【本局带 [ ] 标签的特殊角色 · 白天也要顾到的一层】'); lines.push(srpD); lines.push(''); }
  const vrbD = voteRolesBrief(id);
  if (vrbD) { lines.push(''); lines.push('【本局投票相关角色】'); lines.push(vrbD); lines.push(''); }
  lines.push('【全场座位与真相】（座位号从 1 开始）');
  v.seats.forEach(function (x) {
    const ri = x.role ? roleInfo(x.role) : null;
    const ab = ri && ri.ability ? (' 能力=' + String(ri.ability).replace(/\s+/g, ' ').slice(0, 220)) : '';
    const ft = ri ? ('（' + (ri.faction_zh || ri.faction || '') + '）') : '';
    lines.push((x.seat+1) + ' 号：' + x.name + (x.alive ? '（存活）' : '（已死亡）') + ' 角色=' + (x.role || '未分配') + ft + ab);
  });
  lines.push('');
  lines.push('【公开对话记录】');
  lines.push(renderMessages(v.messages, v.seats));
  lines.push('');
  lines.push('严格只输出一个 JSON 对象：');
  lines.push('{"think":"你的裁判思路","say":"你要对全场说的话（可为空）","info":[],"markers":[],"deaths":[],"ops":[],"nextPhase":"","voteTarget":0,"resolveVote":false,"enterNomination":false}');
  lines.push('若某个角色的能力要真的改变场上状态（改角色/改阵营/复活/处决/免死/交换座位/持续标记/判定胜负），必须写进 ops 真正执行，只在 say 里说一句不算数。op 的写法与夜晚相同，seat 一律 1 起；不需要就写 []。');
  lines.push('白天由能力导致的死亡必须写 {"op":"kill","seat":N,"night":false} 或 {"op":"execute","seat":N}——不要写进 deaths 数组，deaths 只表示「昨夜死亡」。');
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
        model: payload.model || '',
        maxTokens: payload.maxTokens || 0
      });
      const flat = (text && typeof text === 'object') ? (text.text != null ? text.text : (text.content != null ? text.content : '')) : text;
      return { text: String(flat == null ? '' : flat) };
    } catch (err) {
      const msg = String((err && err.message) || err);
      try { if (payload.game) E.aiError(payload.game, payload.seat, msg); } catch (e) {}
      return { error: msg };
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
  const empty = { think: '', say: '', whisper: [], info: [], markers: [], deaths: [], nextPhase: '', reply: '', nominate: null, ops: [] };
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
    /* 角色能力要真正改变场上状态时用 ops（这里保持 1 起座位号，落库前再转 0 起） */
    ops: Array.isArray(obj.ops) ? obj.ops.filter(function (o) { return o && o.op; }) : [],
    /* 说书人聊天回包用的是 reply 字段，这里显式保留，否则回复会被当成「选择沉默」 */
    reply: String(obj.reply == null ? '' : obj.reply),
    /* 白天主持时：说书人自己判断现在是否该进入提名阶段 */
    enterNomination: obj.enterNomination === true
    ,/* 提名清单：null 表示这一轮没提到、不要改动；数组(可为空)表示用新清单覆盖 */
    nominate: Array.isArray(obj.nominate) ? obj.nominate.map(Number).filter(function (n) { return n >= 1; }) : null,
    /* 原始对象：个别流程（例如提名表态的 agree）要直接读字段 */
    raw: obj
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
/* 私聊回复排队：这一局正在跑一轮时，收到的私聊回复请求先存这里，
   等当前这一轮结束再补上。否则「我正在想事情」就等于永远不回玩家。 */
const DM_QUEUE = new Map();
/* 串行补发排队中的私聊：以前一轮结束只补一位，后面的要再等一整轮（好几分钟），
   玩家在界面上看到的就是「他不理我」。这里一次把队列补完。 */
const DM_DRAIN = new Set();
/* 同一句私聊可能被前端和宿主端各触发一次（见 server.cjs 的自动补发），这里按「座位>对端」去重 */
const DM_INFLIGHT = new Set();
/* 正在跑的私聊轮计数（私聊轮不进 RUNNING，免得公聊轮的进度被它打乱） */
const DM_RUN = new Map();
/* 队列落盘：只放内存的话，插件热重载 / DSH 重启会把整条队列吞掉——玩家那边显示「已读」，
   却永远等不到回话（m14808：04:38:51 发来的私聊，04:39:31 重启后再也没人回）。
   所以入队 / 出队都写一份到 state/dmQueue.json，重启后第一次碰到这局时读回来接着补。 */
function dmQueueFile(id) { return path.join(E.gameDir(id), 'state', 'dmQueue.json'); }
function loadDmQueue(id) {
  if (DM_QUEUE.has(id)) return DM_QUEUE.get(id);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(dmQueueFile(id), 'utf8')); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  arr = arr.filter(function (j) { return j && Array.isArray(j.seats) && j.seats.length; });
  if (arr.length) DM_QUEUE.set(id, arr);
  return arr;
}
function saveDmQueue(id) {
  const q = DM_QUEUE.get(id) || [];
  try {
    const dir = path.join(E.gameDir(id), 'state');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.writeFileSync(dmQueueFile(id), JSON.stringify(q, null, 2), 'utf8');
  } catch (e) { /* 落盘失败不能影响内存队列 */ }
}
function dmQueued(id) { return loadDmQueue(id).length; }
/* 这句私聊是不是已经回过了：重启前刚回完、还没来得及从队列里删掉，不要重复回一遍 */
function dmAnswered(id, job) {
  if (!job || job.replyTo === undefined || job.replyTo === null || job.replyTo === '' || job.replyTo === 'storyteller') return false;
  try {
    const s = E.loadState(id);
    const seat = String((job.seats || [])[0]);
    const to = String(job.replyTo);
    const since = String(job.t || '');
    if (!isFinite(Number(seat)) || !isFinite(Number(to))) return false;
    return (s.messages || []).some(function (m) {
      return m && m.channel === 'private' && String(m.from) === seat
        && (m.to || []).map(String).indexOf(to) >= 0 && (!since || String(m.t) >= since);
    });
  } catch (e) { return false; }
}
/* 玩家给 Agent 发私聊后，保证有人回：服务端每次落库玩家私聊都调这个。
   正在跑一轮就排队（队列落盘），重启后接着补。 */
function replyToDm(id, message) {
  if (!message || message.channel !== 'private') return { ok: false, error: '不是私聊' };
  if (message.from === 'storyteller' || message.from === 'admin') return { ok: false, error: '不是玩家发起的私聊' };
  const st = E.loadState(id);
  const from = Number(message.from);
  const tos = (Array.isArray(message.to) ? message.to : [message.to]);
  const ag = tos.filter(function (x) { return x !== 'storyteller' && x !== undefined && x !== null && x !== ''; })
    .map(Number).filter(function (i) { return isFinite(i) && st.seats[i] && st.seats[i].type === 'agent'; });
  if (!isFinite(from) || !ag.length) return { ok: false, error: '没有需要回应的 Agent' };
  return runRound(id, { seats: ag, replyTo: from });
}

async function drainDm(id) {
  if (DM_DRAIN.has(id)) return;
  DM_DRAIN.add(id);
  try {
    for (;;) {
      const cur = RUNNING.get(id);
      if (cur && cur.running) break;   /* 公聊轮还在跑：等它的 finally 或前端轮询再来一次 */
      const q = DM_QUEUE.get(id) || [];
      if (!q.length) break;
      const job = q.shift();
      if (q.length) DM_QUEUE.set(id, q); else DM_QUEUE.delete(id);
      saveDmQueue(id);
      if (dmAnswered(id, job)) { await sleep(50); continue; }
      let started = null;
      try { started = runRound(id, job); } catch (e) { started = null; }
      if (!started || !started.ok) break;
      const r2 = RUNNING.get(id);
      if (r2 && r2.promise) { try { await r2.promise; } catch (e) {} }
      await sleep(200);
    }
  } finally { DM_DRAIN.delete(id); }
}
const STORY_RUNNING = new Map();

function status(id) {
  loadDmQueue(id);   /* 前端 2.5s 轮询会走到这里：重启后靠它把落盘的队列续上 */
  const r = RUNNING.get(id);
  const queued = dmQueued(id);
  if (!r) {
    /* 队列里还有没回的私聊、而当前没有轮次在跑：借这次轮询立刻补上
       （解决「上一轮结束后补发那一步因故没执行 → 队列永远卡住」） */
    if (queued) setTimeout(function () { try { drainDm(id); } catch (e) {} }, 0);
    if (queued) setTimeout(function () { try { drainDm(id); } catch (e) {} }, 0);
    return { running: false, done: 0, total: 0, current: null, results: [], queued: queued, dm: DM_RUN.get(id) || 0 };
  }
  const out = { running: r.running, done: r.done, total: r.total, current: r.current, waiting: r.waiting || [], results: r.results, error: r.error || null, queued: queued, dm: DM_RUN.get(id) || 0 };
  if (!r.running && queued) setTimeout(function () { try { drainDm(id); } catch (e) {} }, 0);
  return out;
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
  /* 每次思考都可以顺手更新自己的提名清单：AI 自己维护，到提名阶段直接取用 */
  if (Array.isArray(parsed.nominate)) { try { E.nomSetIntent(id, seat, parsed.nominate); } catch (e) {} }
  const dmReplyTo = (opts.replyTo === 'storyteller') ? 'storyteller' : ((opts.replyTo !== undefined && opts.replyTo !== null && opts.replyTo !== '') ? Number(opts.replyTo) : -1);
  const isDm = (dmReplyTo === 'storyteller' || dmReplyTo >= 0);
  const nightNow = (st.phase === 'night');
  if (isDm) {
    /* 私聊回复模式：把话私下回给发件人（说书人侧也能看到），不占公开发言 */
    let back = dialectText(parsed);
    /* 私聊必须有回音：模型没答上来（空回包 / 调用报错 / JSON 解析失败）就重试，
       最多两次。以前只在「没报错但内容为空」时重试一次，调用报错就直接静默丢弃，
       玩家那边看起来就是「已读不回」。 */
    let dmTried = 0;
    for (let attempt = 0; !back && attempt < 2; attempt++) {
      dmTried++;
      try {
        const built2 = buildPrompt(id, seat, dmReplyTo, opts.mode);
        const route2 = routeFor(id, seat);
        const out2 = await callModel({
          game: id, seat: seat,
          prompt: built2.prompt + '\n\n【再强调一次】对方在等你回话。say 字段必须填写一句真实的回复，不能空；只输出 JSON。',
          system: playerSystem(id, seat), provider: route2.provider, model: route2.model
        });
        const p2 = parseReply(out2.text);
        back = dialectText(p2);
        if (back) { parsed.say = back; parsed.think = parsed.think || p2.think; }
      } catch (e) { /* 这一次失败，继续下一次 */ }
    }
    if (back) E.say(id, seat, back, 'private', [dmReplyTo]);
    else {
      const why = out.error ? String(out.error) : '模型没有给出可用回包';
      try { E.aiError(id, seat, '私聊回复失败（重试 ' + dmTried + ' 次）：' + why); } catch (e) {}
    }
  } else if (parsed.say && String(parsed.say).trim()) {
    E.say(id, seat, String(parsed.say).trim(), 'town');
  }
  /* 夜里默认不许私聊，但邪恶阵营之间可以（恶魔分配伪装、商量刀口）。
     E.say 会再拦一道，这里提前把善良玩家和说书人方向的私聊放行。 */
  const evilNight = nightNow && /恶魔|爪牙/.test(String((viewFor(id, seat).faction) || ''));
  (isDm ? [] : ((nightNow && !evilNight) ? [] : (parsed.whisper || []).slice(0, MAX_DM_PER_DAY))).forEach(function (w) {
    /* 模型给的座位号是 1 起，落库用 0 起 */
    const to = (w.to || []).map(function (n) { return Number(n) - 1; })
      .filter(function (n) { return n >= 0 && n < st.seats.length && n !== seat; });
    /* 以「@说书人」开头的私聊是给主持人的回复：不要误投给某个座位 */
    if (/^\s*@?\s*(说书人|主持人)/.test(String(w.text || ''))) { E.say(id, seat, String(w.text || ''), 'private', ['storyteller']); return; }
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
    .filter(function (x) { return x.name.length >= 1; })
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
  /* 最多重想 2 轮：每多一轮就多一次完整模型调用，是整轮发言最慢的一环 */
  for (;;) {
    round++;
    if (round > 2) break;
    const built = buildPrompt(id, seat, opts.replyTo, opts.mode);
    const prompt = (round === 1)
      ? built.prompt
      : built.prompt + '\n\n【重要】你上一次思考时，场上又出现了新消息（见上方对话中最新几条）。'
        + '你之前的想法可能已经不成立了，请结合这些新消息重新判断，再给出你这一轮的回答。';
    let cur;
    try {
      cur = await Promise.race([
        callModel({ game: id, seat: seat, prompt: prompt, system: system, provider: route.provider, model: route.model, maxTokens: 700 }),
        new Promise(function (res) { setTimeout(function () { res({ error: '模型调用超时（' + Math.round(MODEL_TIMEOUT_MS / 1000) + ' 秒），本轮跳过' }); }, MODEL_TIMEOUT_MS); })
      ]);
    } catch (e) {
      if (out) break;
      return { error: String((e && e.message) || e) };
    }
    if (!cur || cur.error) {
      if (out) break;
      try { E.aiError(id, seat, (cur && cur.error) || '模型没有返回内容'); } catch (e) {}
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
  loadDmQueue(id);   /* 重启后第一次进来：把没回完的私聊队列从盘上接回来 */
  const _isDm = Array.isArray(opts.seats) && opts.seats.length === 1
    && opts.replyTo !== undefined && opts.replyTo !== null && opts.replyTo !== '';
  const _dmKey = _isDm ? (String(opts.seats[0]) + '>' + String(opts.replyTo)) : null;
  if (_dmKey && DM_INFLIGHT.has(_dmKey)) return { ok: true, dedup: true, total: 0 };
  const cur = RUNNING.get(id);
  /* 私聊回复走独立通道：公聊轮再长，一句私聊也不该等上几分钟。
     E.say / E.think / E.nomSetIntent 都是同步落库函数（Node 单线程，读-改-写之间没有 await），
     所以私聊轮和公聊轮同时跑不会互相覆盖状态。 */
  if (cur && cur.running && !_isDm) return { ok: false, error: '这一局正在跑一轮，请等它结束' };
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
    const _ment = mentionedSeats(id).filter(function (n) { return pool.indexOf(n) >= 0; });
    /* 被 @ 的人排到最前面：先让被点名的人开口，别让他排在四五个人后面等半天 */
    pool = _ment.concat(pool.filter(function (n) { return _ment.indexOf(n) < 0; }));
    for (let _i = pool.length - 1; _i > _ment.length; _i--) { const _j = _ment.length + Math.floor(Math.random() * (_i - _ment.length + 1)); const _t = pool[_i]; pool[_i] = pool[_j]; pool[_j] = _t; }
    /* 其余人随机排序：不是按座位号一个一个来 */
  } else {
    pool = (opts.limit > 0) ? order.slice(0, opts.limit) : order;
  }

  const run = { running: true, done: 0, total: pool.length, current: null, waiting: pool.slice(), results: [], error: null, dm: !!_isDm };
  if (_isDm) DM_RUN.set(id, (DM_RUN.get(id) || 0) + 1);
  else RUNNING.set(id, run);
  if (_dmKey) DM_INFLIGHT.add(_dmKey);

  run.promise = (async function () {
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
        /* 有人私聊进来：公聊先暂停，插队把私聊回掉，再接着说——
           玩家不该等一整轮（好几分钟）才被搭理。 */
        /* 每一位说完都检查一次私聊队列（包括最后一位）：玩家不该为了等一句回话而整轮排队 */
        if (dmQueued(id)) {
          const _dq = DM_QUEUE.get(id);
          if (_dq && _dq.length) {
            const _job = _dq.shift();
            if (_dq.length) DM_QUEUE.set(id, _dq); else DM_QUEUE.delete(id);
            saveDmQueue(id);
            const _ds = Number((_job.seats || [])[0]);
            if (isFinite(_ds) && order.indexOf(_ds) >= 0 && !dmAnswered(id, _job)) {
              E.log(id, '系统', '有玩家私聊：暂停公开讨论，立刻先回私聊', true);
              run.current = _ds;
              let _dout = null;
              try { _dout = await thinkAndSpeak(id, _ds, { replyTo: _job.replyTo }); }
              catch (e) { _dout = { error: String((e && e.message) || e) }; }
              try { await applyOne(id, _ds, _dout, { replyTo: _job.replyTo }, run); } catch (e) {}
              run.current = seat;
            }
          }
        }
      }
      E.log(id, '系统', '本轮 Agent 发言结束（' + pool.length + ' 位依次发言）');
    } catch (err) {
      run.error = String((err && err.message) || err);
    } finally {
      run.running = false;
      run.current = null;
      run.waiting = [];
      if (_dmKey) DM_INFLIGHT.delete(_dmKey);
      if (_isDm) {
        const n = (DM_RUN.get(id) || 1) - 1;
        if (n > 0) DM_RUN.set(id, n); else DM_RUN.delete(id);
      }
      if (!_isDm) {
        ROUND_LAST_AT.set(id, Date.now());
        /* 补发排队中的私聊回复：一次全部补完 */
        if (dmQueued(id)) setTimeout(function () { try { drainDm(id); } catch (e) {} }, 300);
      }
    }
  })();

  return { ok: true, started: true, total: pool.length, order: pool };
}

/* ---------- 「现在要不要进提名阶段」：逐个问所有存活 AI，必须每位都表态 ----------
   一次提议只问一遍，答过的记进 state.nomAgree；全员同意才提前进入提名阶段。 */
async function askNomibationAgreement(id, opts) {
  opts = opts || {};
  const s = E.loadState(id);
  const seats = s.seats || [];
  const ask = [];
  seats.forEach(function (x, i) {
    if (!s.alive[i]) return;
    if (x.type !== 'agent') return;
    if (i === s.storytellerSeat) return;
    ask.push(i);
  });
  const names = function (i) { return (i + 1) + ' 号 ' + ((seats[i] && seats[i].name) || ''); };
  const detail = (opts.reason ? '有人提议现在进入提名阶段（' + String(opts.reason).slice(0, 60) + '）。' : '有人提议现在进入提名阶段。');
  const out = [];
  for (let k = 0; k < ask.length; k++) {
    const seat = ask[k];
    const route = routeFor(id, seat);
    const prompt = [
      '【现在有一个流程决定要你表态】' + detail,
      '当前是第 ' + (s.day || 0) + ' 天白天。进入提名阶段后，每位存活玩家今天有一次提名权，通过投票可能处决一个人，然后立刻入夜。',
      '请判断现在是否适合进入提名阶段：如果你还有话没说完、还想再听听别人的说法、或者觉得现在提名容易处决错人，就表示不同意；如果讨论得差不多了、或者你急着要处决某个人，就表示同意。',
      '严格只输出一个 JSON 对象：{"think":"你的判断","agree":true 或 false,"say":"你在公聊里的一句话表态（20 字以内，自然点）"}',
      stylePrompt(id)
    ].join('\n');
    let r = null;
    try {
      r = await Promise.race([
        callModel({ game: id, seat: seat, prompt: prompt, system: playerSystem(id, seat), provider: route.provider, model: route.model, maxTokens: 300 }),
        new Promise(function (res) { setTimeout(function () { res({ error: '模型调用超时' }); }, MODEL_TIMEOUT_MS); })
      ]);
    } catch (e) { r = { error: String((e && e.message) || e) }; }
    let agree = null, say = '';
    if (r && !r.error) {
      const p = parseReply(r.text);
      const obj = (p && p.raw) || {};
      if (typeof obj.agree === 'boolean') agree = obj.agree;
      else if (/同意|可以|好啊|行|进提名|开吧/.test(String(p.say || ''))) agree = true;
      else if (/不同意|再等等|先别|不用|不要/.test(String(p.say || ''))) agree = false;
      say = String(p.say || '').trim();
    }
    if (agree === null) {
      /* 拿不到明确答复时不阻塞流程：当成弃权（记同意），避免整局卡在这一次表态上 */
      agree = true;
      try { E.aiError(id, seat, '提名表态没有给出 agree 字段，按弃权处理'); } catch (e) {}
    }
    try { E.nomAgreeSet(id, seat, agree); } catch (e) {}
    try { E.say(id, seat, (say || (agree ? '行，进提名吧。' : '我不同意现在进提名。')), 'town'); } catch (e) {}
    out.push({ seat: seat, name: names(seat), agree: agree });
  }
  const st = E.nomAgreeState(id);
  return { ok: true, answers: out, yes: st.yes, no: st.no, allAgree: out.every(function (x) { return x.agree; }) };
}
/* ---------- 说书人 Agent 主持一夜 / 一天 ---------- */


/* 进入提名阶段并启动流程：说书人已经判断要进，或者闸门到了，都由程序统一从这里进。
   公告一律用预设句子，不依赖 Agent 说话（m11876/m11995）。 */
function enterNominationPhase(id){
  let s = null;
  try { s = E.loadState(id); } catch (e) { return { ok:false, error:"对局不存在" }; }
  if (!s || (s.phase !== "day" && s.phase !== "nomination")) return { ok:false, error:"现在不是白天" };
  if (s.phase === "day") { try { E.setPhase(id, "nomination"); } catch (e) {} }
  try { E.log(id, "系统", "进入提名阶段", true); } catch (e) {}
  setTimeout(function () { try { runNomination(id, {}); } catch (e) {} }, 50);
  return { ok:true, entered:true };
}

/* 有人声明「准备好进入提名」时，由说书人结合天平判断是否真的进入提名阶段。
   说书人只返回标准 JSON，不发言——进入 / 不进入的公告一律由程序用预设句子发出（m11961/m11995）。 */
async function nomReadyDecide(id, bySeat){
  let s = null;
  try { s = E.loadState(id); } catch (e) { return { ok:false, error:"对局不存在" }; }
  if (!s || (s.phase !== "day" && s.phase !== "nomination")) return { ok:false, error:"现在不是白天" };
  let rs = null;
  try { rs = E.nomReadyState(id); } catch (e) { rs = null; }
  if (!rs || !rs.ok) return { ok:false, error:"准备状态读取失败" };
  /* 全员准备好：不必再问模型，直接由程序进入提名阶段 */
  if (rs.aliveCount > 0 && rs.readyCount >= rs.aliveCount) {
    try { E.log(id, "系统", "全部存活玩家都已准备进入提名，程序直接进入提名阶段", true); } catch (e) {}
    enterNominationPhase(id);
    return { ok:true, enter:true, reason:"全员准备" };
  }
  let gate = null;
  try { gate = E.nomGate(id); } catch (e) { gate = null; }
  if (gate && gate.mustEnter) { try { E.log(id, "系统", "已达到硬性上限或全员同意，直接进入提名阶段", true); } catch (e) {} enterNominationPhase(id); return { ok:true, enter:true, reason:"闸门" }; }
  const v = viewForStoryteller(id);
  const lines = [];
  lines.push(ST_TONE);
  lines.push("你是「血染钟鱼」的说书人。现在是第 " + (s.day || 1) + " 天白天，玩家们还在讨论。有人刚刚表示「我准备好进入提名了」。");
  lines.push(stylePrompt(id));
  lines.push(FACTION_RULES);
  lines.push(BALANCE_RULES);
  lines.push("【现在的准备情况】存活 " + rs.aliveCount + " 人，已准备 " + rs.readyCount + " 人（座位 " + rs.ready.map(function (i) { return (i + 1) + " 号"; }).join("、") + "）。刚刚表示准备好的是 " + ((Number(bySeat) + 1) + " 号") + "。");
  if (gate) lines.push("【讨论时长】今天公聊已有 " + gate.count + " 条公开消息（最早 " + gate.cfg.min + "，通常 " + gate.cfg.softMax + "，上限 " + gate.cfg.hardMax + "）。");
  lines.push("【判断】现在是否应该进入提名阶段？你要考虑：讨论是否已经充分、有没有人还有重要信息没说、强弱天平是否需要再给弱势方一点时间、有没有人明确表示还想继续聊。");
  lines.push("只有少数人准备好、讨论还很短时，可以继续等；多数人准备好、或者讨论已经充分时，就进入。");
  lines.push('严格只输出一个 JSON 对象：{"think":"你的判断","enter":true或false,"say":""}');
  lines.push("say 一律写空字符串：这个阶段的所有公告都由程序用预设句子发出，你不需要说话。");
  const route = routeFor(id, "storyteller");
  let o = null;
  try {
    o = await Promise.race([
      callModel({ game: id, seat: "storyteller", prompt: lines.join("\n"), provider: route.provider, model: route.model, system: storytellerSystem(id), maxTokens: 500 }),
      new Promise(function (res) { setTimeout(function () { res({ error: "裁量调用超时" }); }, MODEL_TIMEOUT_MS); })
    ]);
  } catch (e) { o = { error: String((e && e.message) || e) }; }
  if (!o || o.error) { E.log(id, "系统", "提名时机裁量失败，按「再等等」处理：" + String((o && o.error) || ""), true); return { ok:false, error:"裁量失败" }; }
  let rp = null;
  try { rp = parseReply(o.text); } catch (e) { rp = null; }
  if (rp && rp.think) { try { E.think(id, "storyteller", rp.think); } catch (e) {} }
  const enter = !!(rp && rp.raw && rp.raw.enter === true);
  try { E.log(id, "系统", "说书人判断" + (enter ? "进入" : "暂不进入") + "提名阶段", true); } catch (e) {}
  if (enter) enterNominationPhase(id);
  return { ok:true, enter:enter, reason:'说书人判断' };
}

/* ==================== 程序化夜间主持（m11876 / m11961） ==================== */
/* 规则能机械算的由 engine.nightExec 直接算并发私聊；
   需要玩家自己选目标的，程序发预设问句、等回答、机械结算；
   只有「可能」「由你决定」这类柔性裁量才叫说书人模型，并且它必须回标准 JSON。 */
const NIGHT_ANSWER_MS = 90000;   /* 等一位玩家回答夜间选择的时限 */

/* 等某座位就「夜间的某个选择」作答，收到后交给 engine 机械结算。返回 true 表示已结算 */
async function waitNightAnswer(id, seat, sinceN){
  const t0 = Date.now();
  let seen = typeof sinceN === "number" ? sinceN : ((E.loadState(id).messages || []).length);
  /* 选择不合法（选了自己、座位越界）时不能就这么干等：把错误告诉玩家，
     再驱动它重想一次。最多重问 3 次，避免模型死磕同一个错误答案。 */
  let retry = 0;
  for (;;) {
    const s = E.loadState(id);
    const msgs = s.messages || [];
    let bad = false;
    for (let k = seen; k < msgs.length; k++) {
      const m = msgs[k];
      if (!m || m.from === "storyteller" || m.from === "admin") continue;
      if (Number(m.from) !== Number(seat)) continue;
      const r = E.nightAnswer(id, seat, m.text);
      if (r && r.ok) return true;
      if (r && r.error) {
        bad = true;
        try { E.say(id, "storyteller", String(r.error), "private", [seat]); } catch (e) {}
      }
    }
    seen = msgs.length;
    if (bad) {
      retry++;
      if (retry > 3) return false;
      const st2 = E.loadState(id);
      const step2 = ((st2.nightRun || {}).steps || []).filter(function (x) { return x.status === "await" && Number(x.seat) === Number(seat); })[0];
      if (!step2) return false;
      try { runRound(id, { seats: [seat], replyTo: "storyteller" }); } catch (e) {}
    }
    if (Date.now() - t0 >= NIGHT_ANSWER_MS) return false;
    await sleep(600);
  }
}

/* 柔性裁量：把这一步交给说书人模型，它必须返回标准 JSON，由程序落地 */
async function runStoryDecision(id, step){
  const v = viewForStoryteller(id);
  const s = E.loadState(id);
  const ri = roleInfo(step.role);
  const lines = [];
  lines.push(ST_TONE);
  lines.push("你是「血染钟鱼」的说书人。现在是第 " + (s.night || 1) + " 夜，程序化的夜间流程正在进行，只剩这一个角色需要你行使裁量权。");
  lines.push(stylePrompt(id));
  lines.push(FACTION_RULES);
  lines.push(BALANCE_RULES);
  lines.push("【要处理的事】" + (Number(step.seat) + 1) + " 号 " + ((s.seats[step.seat] || {}).name || "") + " 的角色是【" + step.role + "】。");
  if (ri && ri.ability) lines.push("【能力原文】" + String(ri.ability).replace(/\s+/g, " "));
  lines.push("【为什么需要你】这条能力里有「可能」「由你决定」这类空间，程序无法机械判定。请结合全场局势与天平系统决定结果。规则里写死的部分不得改动。");
  lines.push("【全场座位与真相】（座位号从 1 开始）");
  v.seats.forEach(function (x) {
    lines.push((x.seat + 1) + " 号：" + x.name + (x.alive ? "（存活）" : "（已死亡）") + " 角色=" + (x.role || "未分配")
      + (x.markers.length ? (" 标记=" + x.markers.join(",")) : "")
      + (x.info.length ? (" 已告知：" + x.info.map(function (i) { return i.text; }).join(" | ")) : ""));
  });
  lines.push("【公开对话记录】");
  lines.push(renderMessages(v.messages, v.seats));
  lines.push("严格只输出一个 JSON 对象，不要代码块、不要多余文字：");
  lines.push('{"think":"你的裁判思路（不公开）",');
  lines.push(' "info":[{"seat":座位号（1 起）,"text":"私下告知该玩家的信息"}],');
  lines.push(' "markers":[{"seat":座位号（1 起）,"marker":"中毒/醉酒/被保护"}],');
  lines.push(' "deaths":[座位号（1 起）],');
  lines.push(' "ops":[{"op":"操作名","seat":座位号（1 起）,其余参数}]}');
  lines.push("不需要给信息就写空数组；不要用 ops 替玩家做他能自己决定的事。");
  const route = routeFor(id, "storyteller");
  let o = null;
  try {
    o = await Promise.race([
      callModel({ game: id, seat: "storyteller", prompt: lines.join("\n"), provider: route.provider, model: route.model, system: storytellerSystem(id) }),
      new Promise(function (res) { setTimeout(function () { res({ error: "裁量调用超时" }); }, MODEL_TIMEOUT_MS); })
    ]);
  } catch (e) { o = { error: String((e && e.message) || e) }; }
  const out = { info: 0, markers: 0, deaths: 0, ops: 0, win: null };
  if (!o || o.error) {
    E.log(id, "系统", "【" + step.role + "】的柔性裁量调用失败，按无效果处理：" + String((o && o.error) || ""), true);
    E.nightMarkDone(id, step.key, "说书人裁定失败，按无效果处理");
    return out;
  }
  let rp = null;
  try { rp = parseReply(o.text); } catch (e) { rp = null; }
  if (rp && rp.think) { try { E.think(id, "storyteller", rp.think); } catch (e) {} }
  const toIdx = function (n) { const v0 = Number(n); if (!isFinite(v0)) return -1; const i = v0 - 1; return (i >= 0 && i < s.seats.length) ? i : -1; };
  if (rp && Array.isArray(rp.info)) rp.info.forEach(function (x) { const i = toIdx(x.seat); if (i < 0) return; if (E.giveInfo(id, i, String(x.text || ""))) out.info++; });
  if (rp && Array.isArray(rp.markers)) rp.markers.forEach(function (x) { const i = toIdx(x.seat); if (i >= 0) { E.toggleMarker(id, i, x.marker); out.markers++; } });
  if (rp && Array.isArray(rp.deaths)) rp.deaths.forEach(function (n) { const i = toIdx(n); if (i >= 0 && E.kill(id, i, "夜间死亡")) out.deaths++; });
  if (rp && Array.isArray(rp.ops) && rp.ops.length) {
    const conv = rp.ops.map(function (o0) {
      const o1 = Object.assign({}, o0);
      if (o1.seat !== undefined && o1.seat !== null && o1.seat !== "") o1.seat = toIdx(o1.seat);
      if (o1.a !== undefined) o1.a = toIdx(o1.a);
      if (o1.b !== undefined) o1.b = toIdx(o1.b);
      return o1;
    });
    const r = E.applyOps(id, conv);
    out.ops = (r.roleChanges || 0) + (r.revives || 0) + (r.kills || 0) + (r.executes || 0) + (r.shields || 0) + (r.aligns || 0) + (r.apparent || 0) + (r.grants || 0) + (r.swaps || 0) + (r.markers || 0) + (r.wins || 0) + (r.exiles || 0) + (r.extra || 0);
    if (r.wins) out.win = "ability";
  }
  E.nightMarkDone(id, step.key, "说书人裁量完成");
  return out;
}

/* 程序化夜间主循环 */
async function nightDriver(id, run){
  {
    const s0 = E.loadState(id);
    if (s0.phase === "setup") { try { E.setPhase(id, "night"); } catch (e) {} }
  }
  const applied = { info: 0, markers: 0, deaths: 0, ops: 0, phase: null, win: null };
  E.nightEnsure(id);
  let guard = 0;
  for (;;) {
    guard++;
    if (guard > 300) { E.log(id, "系统", "夜间流程步数超限，已强制停止", true); break; }
    const s = E.loadState(id);
    if (s.phase !== "night" && s.phase !== "dawn") break;
    let r = null;
    try { r = E.nightExec(id); } catch (e) { E.log(id, "系统", "夜间流程异常：" + String((e && e.message) || e), true); break; }
    if (!r || !r.ok) break;
    if (r.kind === "done") { applied.phase = r.phase || "day"; break; }
    if (r.kind === "skip") continue;
    if (r.kind === "info") { applied.info++; continue; }
    if (r.kind === "ask") {
      const seat = Number(r.step.seat);
      const before = (E.loadState(id).messages || []).length;
      try { E.giveInfo(id, seat, r.prompt); } catch (e) {}
      try { runRound(id, { seats: [seat], replyTo: "storyteller" }); } catch (e) {}
      const ok = await waitNightAnswer(id, seat, before);
      if (!ok) {
        E.log(id, "系统", "等待 " + (seat + 1) + " 号回答「" + r.step.role + "」超时，视为放弃这一步，流程继续", true);
        try { E.nightMarkDone(id, r.step.key, "（玩家超时未回答，视为放弃）"); } catch (e) {}
        continue;
      }
      applied.info++;
      continue;
    }
    if (r.kind === "st") {
      const d = await runStoryDecision(id, r.step);
      applied.info += d.info; applied.markers += d.markers; applied.deaths += d.deaths; applied.ops += d.ops;
      if (d.win) { applied.win = d.win; break; }
      continue;
    }
    break;
  }
  const sEnd = E.loadState(id);
  run.result = { think: "", say: "", applied: applied, raw: "" };
  run.done = true;
  E.log(id, "说书人", "夜间流程完成：告知 " + applied.info + " 条信息，标记 " + applied.markers + " 个状态，死亡 " + applied.deaths + " 人"
    + (applied.ops ? ("，能力操作 " + applied.ops + " 项") : "")
    + (applied.phase ? ("，进入 " + applied.phase) : ("，当前仍在 " + sEnd.phase)));
}

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
      /* 夜间：规则能机械算的全部交给 engine.nightExec，只有柔性裁量才问模型（m11876） */
      if (isNight) { await nightDriver(id, run); return; }
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
  const applied = { info: 0, markers: 0, deaths: 0, ops: 0, phase: null, vote: null, win: null };
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
        const pre = { info: applied.info, markers: applied.markers, deaths: applied.deaths, ops: applied.ops, phase: applied.phase };
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
        /* 角色能力真正改变场上状态（改角色/阵营/复活/处决/免死/交换/标记/判定胜负）：
           说书人回包里的座位号是 1 起，engine 的底座函数一律 0 起，这里统一换算一次。 */
        if (rp && Array.isArray(rp.ops) && rp.ops.length) {
          const conv = [];
          rp.ops.forEach(function (o0) {
            const o = Object.assign({}, o0);
            if (o.seat !== undefined && o.seat !== null && o.seat !== '') o.seat = toIdx(o.seat);
            if (o.a !== undefined) o.a = toIdx(o.a);
            if (o.b !== undefined) o.b = toIdx(o.b);
            conv.push(o);
          });
          const opRes = E.applyOps(id, conv);
          const opN = (opRes.roleChanges || 0) + (opRes.revives || 0) + (opRes.kills || 0) + (opRes.executes || 0)
            + (opRes.shields || 0) + (opRes.aligns || 0) + (opRes.apparent || 0) + (opRes.grants || 0)
            + (opRes.swaps || 0) + (opRes.markers || 0) + (opRes.wins || 0) + (opRes.exiles || 0) + (opRes.extra || 0);
          applied.ops += opN;
          if (opRes.wins) applied.win = 'ability';
        }
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
        const didAct = (applied.info > pre.info) || (applied.markers > pre.markers) || (applied.deaths > pre.deaths) || (applied.ops > (pre.ops || 0)) || (applied.phase && applied.phase !== pre.phase);
        stallN = didAct ? 0 : (stallN + 1);
        if (applied.win) break;     /* 角色能力直接判定了胜负，主持到此为止 */
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

/* 提名相关的专用提示词：程序负责流程与结算，模型只负责「要不要提名 / 理由 / 辩护 / 举不举手」。
   每一种都附带该玩家自己能看到的一切（身份、私下信息、最近公开对话、当前提名与投票进度），
   并要求返回固定结构的 JSON，由程序解析落库（m12353）。 */
function nomVoteSnapshot(id, seat){
  /* 当前这项提名的投票进度：谁已经表态、谁还没表态、票权、死亡票、管家主人 */
  const out = { target:0, targetName:'', from:0, fromName:'', reason:'', voted:[], pending:[], myWeight:1, myMaster:-1, masterVoted:false, dead:false, deadVoteUsed:false, secret:false };
  try {
    const ns = E.nomState(id);
    const s = E.loadState(id);
    if (!ns || !ns.ok) return out;
    const cur = ns.nom && ns.nom.cur;
    if (cur) {
      out.target = cur.target; out.from = cur.from;
      out.targetName = (cur.target+1) + ' 号 ' + ((s.seats[cur.target]||{}).name || '');
      out.fromName = (cur.from+1) + ' 号 ' + ((s.seats[cur.from]||{}).name || '');
      out.reason = String(cur.reason || cur.reasonHint || '');
      Object.keys(cur.hands || {}).forEach(function(k){ if (cur.hands[k] !== undefined) out.voted.push(Number(k)); });
      (s.seats||[]).forEach(function(x,i){ if (ns.alive[i] && out.voted.indexOf(i) < 0) out.pending.push(i); });
    }
    out.myWeight = (ns.weights && ns.weights[seat] !== undefined) ? ns.weights[seat] : 1;
    out.myMaster = (ns.butler && ns.butler[seat] !== undefined) ? ns.butler[seat] : -1;
    if (out.myMaster >= 0 && cur && cur.hands) out.masterVoted = !!cur.hands[out.myMaster];
    out.dead = !s.alive[seat];
    out.deadVoteUsed = !!(ns.deadVoteUsed && ns.deadVoteUsed[seat]);
    out.secret = !!ns.secret;
  } catch (e) {}
  return out;
}
function buildNomPrompt(id, seat, kind, extra){
  extra = extra || {};
  const v = viewFor(id, seat);
  const s = E.loadState(id);
  const vs = nomVoteSnapshot(id, seat);
  const lines = [];
  lines.push('【局面】第 ' + (s.day||1) + ' 天白天，提名与投票阶段。存活：' + v.aliveList.join('、') + '；已出局：' + (v.deadList.join('、') || '无') + '。');
  lines.push('【你的身份】你是 ' + (seat+1) + ' 号 ' + v.name + '，角色 ' + (v.role || '未知') + (v.ability ? ('（' + v.ability + '）') : '') + '。');
  if (v.privateInfo && v.privateInfo.length) lines.push('【你掌握的私下信息】');
  if (v.privateInfo && v.privateInfo.length) (v.privateInfo || []).forEach(function(t){ lines.push('- ' + String(t)); });
  const secret = (v.secretInfo || []);
  if (secret.length) {
    lines.push('【注意】上面标着「本夜刚得知」的信息，今晚结束前不能公开引用，但可以影响你的判断。');
  }
  lines.push('【最近的公开对话】');
  lines.push(renderMessages(v.messages, s.seats));
  lines.push(stylePrompt(id));
  lines.push(talkBiasText(id));
  if (kind === 'propose') {
    lines.push('【现在】轮到你表态：今天要不要发起提名？');
    lines.push('规则：每位存活玩家每天只有 1 次提名权；同一时间只能有一项提名；可以提名自己；被提名过的目标今天不能再被提名。');
    lines.push('【提名礼仪】正式流程是：① 你先只说「@X 提名 @Y」② 程序点名请你说明理由，你才说理由 ③ 程序请被提名者反驳 ④ 才开始投票。所以现在这一步你只要给出「提名谁」以及你打算说的理由，不要自己一上来就把理由倒出来。');
    lines.push('想提名就把 nominate 写 true，并在 target 写被提名者的座位号（从 1 开始），reason 写你稍后要公开说明的提名理由（一两句，直接对全桌说）。');
    lines.push('不想提名就 nominate 写 false，target 写 0，reason 留空。不要为了凑热闹乱提名。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","nominate":true或false,"target":座位号,"reason":"提名理由"}');
  } else if (kind === 'reason') {
    lines.push('【现在】你刚刚提名了 ' + (extra.target ? (extra.target + ' 号 ' + (extra.targetName || '')) : vs.targetName) + '，程序请你说明理由。');
    if (extra.hint) lines.push('你原先的打算：「' + extra.hint + '」。可以照这个说，也可以按场上最新情况调整。');
    lines.push('说一两句话，直接对全桌说清楚你为什么要提名他。不要写「我要提名」这种客套，也不要长篇大论。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","say":"你的提名理由"}');
  } else if (kind === 'defense') {
    lines.push('【现在】你被 ' + (extra.from || (vs.from+1)) + ' 号 ' + (extra.fromName || vs.fromName) + ' 提名了，理由：「' + (extra.reason || vs.reason || '（没有说明）') + '」。');
    lines.push('请做被提名发言：为自己辩解、说明你的身份与信息、或者指出提名者的破绽。一两句话，直接对全桌说。');
    lines.push('如果你已经出局，也可以说明自己被提名的处境——死亡玩家同样会被点名反驳。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","say":"你的被提名发言"}');
  } else {
    lines.push('【现在】正在对 ' + (extra.target ? (extra.target + ' 号 ' + (extra.targetName || '')) : vs.targetName) + ' 投票（被提名理由：「' + (extra.reason || vs.reason || '无') + '」）。');
    lines.push('请决定你要不要举手赞成处决 ta。举手＝公开支持今天处决这个人，圆桌上会用 ✋ 标出来。');
    lines.push('判断依据：你信不信 ta 的身份、ta 的死对哪一方有利、你自己会不会因此暴露、这一步投票会不会把无辜的人推上处决台。想清楚再举手，别随大流。');
    lines.push('规则要点：票数要「严格最多」且达到存活人数的一半才能上处决台；每人每天只有一次提名权，被提名次数也有限。');
    if (vs.myWeight !== 1) {
      lines.push('【你的票权】程序已经按你的角色能力算好：你这一票算 ' + vs.myWeight + ' 票' + (vs.myWeight < 0 ? '（负票会抵消别人的票）' : '') + '。这一项不需要你判断，程序会自动加权。');
    }
    if (vs.myMaster >= 0) {
      lines.push('【管家规则】你的主人是 ' + (vs.myMaster+1) + ' 号。' + (vs.masterVoted ? '主人已经举手，你可以跟着举手。' : '主人还没举手——你现在举手程序会拒绝。可以等主人表态，或者这一轮放弃。'));
    }
    if (vs.dead) {
      lines.push('【你已经出局】你手上的是一张死亡票。' + (vs.deadVoteUsed ? '这张票你已经用掉了，这次不能再投。' : '投出去就没有了（除非你复活），所以只在关键时刻用。'));
    }
    if (vs.voted.length) {
      lines.push('【目前的投票进度】已有 ' + vs.voted.length + ' 人举手：' + vs.voted.map(function(x){ return (x+1)+' 号'; }).join('、') + '。');
    }
    if (vs.pending.length) {
      lines.push('还没表态：' + vs.pending.map(function(x){ return (x+1)+' 号'; }).join('、') + '。');
    }
    lines.push('【举手方式】举手只由 hand 字段决定，圆桌上会用 ✋ 显示，不需要也不允许用发言说出「我举手 / 我投票」这类话——投票阶段没有公开发言的环节。');
    lines.push('严格只输出一个 JSON 对象：{"think":"你的真实判断","hand":true或false,"say":""}');
  }
  return { prompt: lines.join('\n'), view: v, vote: vs };
}
/* 让一位 Agent 就提名相关的一件事表态。三件事都要保证拿到「结构化结果」：
   ①调用包超时，绝不让整轮卡住；②解析失败/字段缺失时补一次强指令重试；③最终失败写进 AI 报错面板，
   由程序给一个安全的默认值（提名=false / 举手=false / 发言用兜底句）。 */
async function askSeat(id, seat, kind, extra){
  const built = buildNomPrompt(id, seat, kind, extra || {});
  const route = routeFor(id, seat);
  const wantKey = (kind === 'vote') ? 'hand' : 'say';
  async function once(prompt, strict){
    let out = null;
    try {
      out = await Promise.race([
        callModel({ game:id, seat:seat, prompt:prompt, system:playerSystem(id, seat), provider:route.provider, model:route.model, maxTokens:600 }),
        new Promise(function (res) { setTimeout(function () { res({ error: '模型调用超时（' + Math.round(MODEL_TIMEOUT_MS/1000) + ' 秒）' }); }, MODEL_TIMEOUT_MS); })
      ]);
    } catch (e) { out = { error: String((e && e.message) || e) }; }
    if (!out || out.error) return { error: (out && out.error) || '调用失败' };
    const p = parseReply(out.text);
    const obj = extractObject(String(out.text || '')) || {};
    const hasField = (kind === 'vote') ? (typeof obj.hand === 'boolean') : (typeof obj.say === 'string' && String(obj.say).trim());
    return { parsed:p, obj:obj, hasField: hasField, text: out.text };
  }
  let r = await once(built.prompt);
  if (!r.error && !r.hasField) {
    const strict = built.prompt + '\n\n【再强调一次】上一次的回答缺少必填字段（' + wantKey + '），这是无效输出。只输出一个 JSON 对象，不要任何解释文字，' + (kind === 'vote' ? 'hand 必须是 true 或 false。' : 'say 必须是一句非空的话。');
    r = await once(strict, true);
  }
  if (r.error || !r.hasField) {
    try { E.aiError(id, seat, '提名阶段的「' + kind + '」表态失败：' + (r.error || '输出缺少必填字段 ' + wantKey)); } catch (e) {}
    const fallback = (kind === 'vote') ? { think:'', say:'', hand:false } : { think:'', say:'' };
    return { parsed:{ think:'', say: fallback.say, whisper:[], info:[], markers:[], deaths:[], nextPhase:'', reply:'', nominate:null, ops:[] }, obj: fallback, error:null, degraded:true };
  }
  if (r.parsed && r.parsed.think) { try { E.think(id, seat, r.parsed.think); } catch (e) {} }
  return { parsed:r.parsed, obj:r.obj || {} };
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

function seatType(s, i){
  /* 真人座位的 type 由 engine 统一落成 'human'（createGame 里做过归一），前端建局时传的是 'player'。
     以前这里只认 'player'，结果真人被当成 Agent：提名阶段替他生成「提名理由/反驳/投票」，
     玩家会看到「我发了根本不是我发的话」。两种写法都认。 */
  const t = s.seats[i] && s.seats[i].type;
  return (t === 'player' || t === 'human') ? 'player' : 'agent';
}

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
        /* 催办：提名阶段不能拖成茶话会。每 18 秒点一次名，把还没表态的人念出来 */
        const nudge = setInterval(function () {
          try {
            const stN = E.nomState(id);
            if (!stN.ok || run.stage !== 'ask') return;
            const sN = E.loadState(id);
            const left = askList.filter(function (x) { return sN.alive[x] && !(stN.nom.asked[x]); });
            if (!left.length) return;
            if (!left.length) { clearInterval(nudge); return; }
            const names = left.map(function (x) { return '@' + (x+1) + ' 号 ' + (sN.seats[x] ? sN.seats[x].name : ''); }).join('、');
            E.say(id, 'storyteller', '提名阶段不要拖：' + names + '，请马上表态——要提名谁，或者明确说今天不提名。', 'town');
          } catch (e) {}
        }, 18000);
        if (nudge.unref) nudge.unref();
        log('询问第 ' + (pi+1) + ' 轮：' + askList.length + ' 位玩家需要表态');
        /* 全员同时开始思考「要不要提名」：以前是一个个排队问，7 个人就要等 7 个模型的完整时延。
           现在并发调用，再按座位顺序把结果落库（落库必须串行，saveState 是全量写）。 */
        const aiAsk = [];
        const humanAsk = [];
        askList.forEach(function (seat) {
          const sNow = E.loadState(id);
          if (sNow.nom && sNow.nom.asked[seat]) return;
          if (seatType(sNow, seat) === 'player') humanAsk.push(seat); else aiAsk.push(seat);
        });
        log('同时唤醒 ' + aiAsk.length + ' 位 Agent 思考是否提名' + (humanAsk.length ? '，并等待 ' + humanAsk.length + ' 位真人表态' : ''));
        /* AI 的提名不再现场问：每位 Agent 平时聊天时就在维护自己的「提名清单」，
           这里直接照着清单取第一个还活着、今天还没被提名过的人，立刻发出来。
           清单为空的就不提名。只有清单从未建立过的老玩家才临时问一次模型。 */
        const aiOuts = [];
        const askNow = [];
        for (const seat of aiAsk) {
          let picked = 0; try { picked = E.nomPickIntent(id, seat); } catch (e2) { picked = 0; }
          const hasList = (function () { try { const sI = E.loadState(id); return !!(sI.nomIntents && Object.prototype.hasOwnProperty.call(sI.nomIntents, seat)); } catch (e2) { return false; } })();
          if (picked > 0) { aiOuts.push({ seat:seat, r:{ obj:{ nominate:true, target:picked, reason:'' } } }); }
          else if (hasList) { aiOuts.push({ seat:seat, r:{ obj:{ nominate:false, target:0, reason:'' } } }); }
          else askNow.push(seat);
        }
        const aiPending = askNow.map(function (seat) {
          return askSeat(id, seat, 'propose', {}).then(function (r) {
            /* 临时问出来的结果顺手存回清单，下次就不用再问 */
            try { if (r && r.obj) { const o = r.obj; E.nomSetIntent(id, seat, o.nominate === true && Number(o.target) > 0 ? [Number(o.target)] : []); } } catch (e2) {}
            return { seat:seat, r:r };
          }).catch(function (e2) { return { seat:seat, r:{ error:String((e2 && e2.message) || e2) } }; });
        });
        /* 真人这段时间也在表态，AI 处理与真人决策是并行的 */
        const humanWait = (async function () {
          for (const seat of humanAsk) {
            const t0 = Date.now();
            for (;;) {
              const stW = E.nomState(id);
              if (!stW.ok || stW.nom.asked[seat]) break;
              if (Date.now() - t0 > NOM_ASK_WAIT_MS) { E.nomMarkAsked(id, seat); break; }
              await sleep(400);
            }
          }
        })();
        const tmpOuts = await Promise.all(aiPending);
        tmpOuts.forEach(function (x) { aiOuts.push(x); });
        await humanWait;
        clearInterval(nudge);
        for (const got of aiOuts) {
          const seat = got.seat, r = got.r;
          E.nomMarkAsked(id, seat);
          if (!r || r.error) { log((seat+1) + ' 号提名表态失败：' + ((r && r.error) || '未知错误')); continue; }
          let want = (r.obj && r.obj.nominate === true);
          let tgt = Number((r.obj && r.obj.target) || 0);
          const reason = String((r.obj && r.obj.reason) || '').trim();
          const sNow = E.loadState(id);
          /* 目标不可用（死了 / 今天已被提名 / 自己）就顺着清单往下取下一个 */
          for (let guard = 0; want && guard < 6; guard++) {
            const okT = tgt >= 1 && tgt <= sNow.seats.length && sNow.alive[tgt-1] && !((sNow.nom && sNow.nom.usedTarget) || {})[tgt-1];
            if (okT) break;
            let nx2 = 0; try { nx2 = E.nomPickIntent(id, seat); } catch (e2) { nx2 = 0; }
            if (!nx2 || nx2 === tgt) { want = false; break; }
            tgt = nx2;
          }
          if (!want || !(tgt >= 1 && tgt <= sNow.seats.length)) continue;
          const pr = E.nomPropose(id, seat, tgt - 1, reason);
          if (!pr.ok) { log((seat+1) + ' 号提名未生效：' + pr.error); continue; }
          try { E.nomDropIntent(id, seat, tgt); } catch (e2) {}
          anyNom = true;
          log((seat+1) + ' 号提名了 ' + tgt + ' 号：' + reason);
        }
        /* ---- 处理队列（真人在提问阶段也可能自己提名，所以以队列是否有货为准）---- */
        for (;;) {
          const stQ = E.nomState(id);
          if (!stQ.ok) break;
          /* 上一项结束时 nomClose 可能已经把队列里的下一项直接提成 cur：
             这时队列是空的、但还有一项没处理，只按 queue 判断会把后面的提名整项丢掉（m12764）。 */
          let nx = null;
          if (stQ.nom && stQ.nom.cur) nx = { ok:true, cur:stQ.nom.cur };
          else if (stQ.nom && stQ.nom.queue && stQ.nom.queue.length) nx = E.nomNext(id);
          if (!nx || !nx.ok) break;
          anyNom = true;
          const c = nx.cur;
          run.cur = { from:c.from, target:c.target };
          const sC = E.loadState(id);
          const nmF = (c.from+1) + ' 号 ' + sC.seats[c.from].name;
          const nmT = (c.target+1) + ' 号 ' + sC.seats[c.target].name;
          /* ① 宣告：只说「X 提名 Y」，不说理由（理由由提名者本人被点名后再说） */
          setStage('announce');
          nomSay(id, '@' + nmF + ' 提名 @' + nmT + '。');
          await sleep(400);
          /* ② 请提名者说明理由 */
          setStage('reason');
          nomSay(id, '@' + nmF + ' 提名 @' + nmT + '，@' + nmF + ' 请说明理由。');
          if (seatType(sC, c.from) === 'player') {
            await waitStage(id, 'defense', NOM_ASK_WAIT_MS);
          } else {
            const rr = await askSeat(id, c.from, 'reason', { target:c.target+1, targetName:sC.seats[c.target].name, hint:c.reasonHint || '' });
            const rtxt = (rr.parsed && rr.parsed.say) ? String(rr.parsed.say).trim() : '';
            const finalReason = rtxt || c.reasonHint || '（没有说明理由）';
            E.say(id, c.from, finalReason, 'town');
            E.nomSpeech(id, 'reason', finalReason);
          }
          /* ③ 请被提名者反驳 */
          const sD = E.loadState(id);
          setStage('defense');
          nomSay(id, '@' + nmT + ' 请反驳。');
          if (seatType(sD, c.target) === 'player') {
            await waitStage(id, 'vote', NOM_ASK_WAIT_MS);
          } else {
            const curD = E.loadState(id);
            const reasonNow = (curD.nom && curD.nom.cur) ? String(curD.nom.cur.reason || '') : '';
            const d = await askSeat(id, c.target, 'defense', { from:c.from+1, fromName:sD.seats[c.from].name, reason:reasonNow });
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
  lines.push(FACTION_RULES);
  lines.push('私聊通常都要回：那是对方在向你提问、请你裁定、或向你透露信息。');
  lines.push('公聊要克制：没人问你、也没有必须公布的结果（如天亮、死亡、投票结果）时，就不要说话——回复填空字符串。别在公聊里刷存在感、别评论每个人的发言、别替玩家主持讨论。');
  /* 提名阶段：说书人的职责是把这件事推着走，不能摆烂「谁想提谁提」 */
  let _nomStage = '';
  try { const _ns = E.nomState(id); if (_ns && _ns.ok && _ns.nom) _nomStage = String(_ns.nom.stage || ''); } catch (e) {}
  if (_nomStage === 'ask' || _nomStage === 'announce' || _nomStage === 'reason' || _nomStage === 'defense' || _nomStage === 'vote' || _nomStage === 'clock') {
    lines.push('【提名阶段 · 你现在必须催】现在是白天的提名投票阶段，这个阶段是你在主持，你有责任把它推着走，绝不能摆出「谁想提谁提，我不掺和」的中立旁观姿态——那是失职。');
    lines.push('有人问你流程或问要不要提名时：直接点名还没表态的人（用 @N 号 名字），要求他立刻给答复「提名谁、或者明确说今天不提名」；也可以提醒大家时间在走、提名不发起就白过一天。');
    lines.push('不要复述规则条文、不要长篇解释，一句话把人推起来就够。');
  }
  if (m.from === 'admin') {
    /* 管理员 = 这一局的操作者，拥有最高权限。
       注意：任何保密限制（不能透露角色、不能透露夜里做了什么、不能替玩家做决定……）
       都只约束玩家，不约束管理员。这里必须显式覆盖上面所有「不要泄露」的措辞。 */
    lines.push('【最高权限 · 管理员】这条消息来自本局的管理员（操作者），不是场上的玩家。');
    lines.push('管理员拥有最高权限：你可以也应当如实、完整地回答管理员提出的任何问题，包括每个座位的真实角色、阵营、存活状态、你夜里依次唤醒了谁、给了谁什么信息、谁做了什么选择、当前阶段与待办、内部状态与流程进度。');
    lines.push('不要以「不能透露角色」「不能泄露夜间秘密」「这属于游戏机密」为由拒绝或含糊其辞——上面所有关于保密的限制都只是针对玩家的，对管理员一律不适用。');
    lines.push('如果管理员要求你执行某个操作或改变某个状态，就按要求执行并在回复里说明你做了什么；确实做不到（没有对应接口）时才说明限制在哪里。');
    /* 系统已经替你把确定性指令执行掉了：这时必须照真实结果回答，
       不能像以前那样只在聊天里「宣布」一句、而引擎里什么都没发生。 */
    if (m.exec && m.exec.handled) {
      lines.push('');
      lines.push('【系统已经直接执行了管理员这条指令，下面是真实结果】');
      lines.push('执行内容：' + String(m.exec.summary || '（已执行）'));
      const snap = m.exec.snapshot;
      if (snap) {
        lines.push('当前真实状态：阶段=' + snap.phase + '　第 ' + snap.night + ' 夜 / 第 ' + snap.day + ' 天'
          + (snap.win ? ('　已终局：' + (snap.win.side === 'evil' ? '邪恶阵营胜利' : '善良阵营胜利')) : ''));
        (snap.seats || []).forEach(function (x) { lines.push('  ' + x); });
      }
      lines.push('你的回复必须以上面的真实结果为准：不要否认、不要改口、不要再提出与它矛盾的说法。');
      lines.push('已经在执行内容里说清楚的事实（谁死了、谁被处决、谁是什么角色、是否终局），你在 reply 里用一句话确认即可，不要重复罗列整张座位表。');
      lines.push('');
    }
    lines.push('回答要直接、具体、完整，不要中性含糊，也不要反问管理员。');
    /* 真相信封：管理员问「谁还活着 / 6 号死没死」这类事实题，必须照这份真实状态答，
       不能凭上下文印象编——历史上它就编出过「6 号还活着」这种和引擎状态相反的话。 */
    try {
      const _snap = E.adminSnapshot(id);
      lines.push('');
      lines.push('【当前真实状态（以下为引擎里的权威数据，回答任何事实问题都必须以此为准）】');
      lines.push('阶段=' + _snap.phase + '　第 ' + _snap.night + ' 夜 / 第 ' + _snap.day + ' 天'
        + (_snap.win ? ('　已终局：' + (_snap.win.side === 'evil' ? '邪恶阵营胜利' : '善良阵营胜利') + '（' + (_snap.win.reason || '') + '）') : '　对局进行中'));
      (_snap.seats || []).forEach(function (x) { lines.push('  ' + x); });
      lines.push('如果上面写着某人已死亡，那他就是死了；如果写着已终局，那就是已经结束了。不许说反。');
      lines.push('');
    } catch (e) {}
  } else {
    lines.push('不确定就回一句简短得体的话，不要长篇大论，也不要泄露不该说的信息（别人的角色、夜间行动细节、你唤醒了谁）。');
    /* 玩家向私聊的信息隔离：历史上这里漏得最惨——玩家问「让 2 号变成贤者」，
       说书人回「2 号已经死了…而且贤者这个角色就在场上（2 号自己）」，一次泄了两条机密。 */
    lines.push('【回答玩家时的信息边界 · 违反就是毁了这一局】');
    lines.push('① 绝不确认、也绝不否认任何一个角色是否在场。不要说「这个角色在场上」「本局没有这个角色」「他就是贤者」这类话，哪怕是在解释一个选择为什么不成立。');
    lines.push('② 绝不透露某个座位是死是活，除非这件事已经在公聊里公开播报过（天亮公告、处决公告）。夜里或尚未公布时，一律按「不能回答」处理。');
    lines.push('③ 玩家的选择不合法（目标已死、目标不存在、角色不在场、能力已用过）时，只回一句中性的「这个选择不成立，请重新选一个」，然后说明你需要他重新给一个目标。不要解释为什么不成立——理由里往往就是机密。');
    lines.push('④ 绝不透露夜间你唤醒了谁、给了谁什么信息、谁做了什么选择、谁被谁选过。');
    lines.push('⑤ 玩家追问「为什么不行」「是不是因为 X」时，不要顺着猜，也不要暗示；就说「我不能解释，请换一个目标」。');
    lines.push('⑥ 玩家报出自己的角色或能力时，不评价真假、不确认、不纠正。');
    lines.push('⑦ 唯一可以正常回答的是公开规则、公开流程、以及他自己已经知道的信息（他自己的角色、他自己收到的私聊、已经公开播报过的事实）。');
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
  /* 不能只看这一条：要带上最近的公开对话与提名进展，否则说书人会忘掉前文、答不到点上 */
  try {
    const _recent = (stt.messages || []).filter(function (x) { return x.channel !== 'private' || x.from === 'storyteller' || (Array.isArray(x.to) && x.to.indexOf('storyteller') >= 0); }).slice(-24);
    if (_recent.length) {
      lines.push('【最近的对话与场面】');
      lines.push(renderMessages(_recent, stt.seats));
      lines.push('');
    }
  } catch (e) {}
  try {
    const _ns2 = E.nomState(id);
    if (_ns2 && _ns2.ok && _ns2.nom) {
      lines.push('【提名阶段进展】阶段=' + String(_ns2.nom.stage || 'idle')
        + '　今天被提名过=' + (Object.keys(_ns2.nom.usedTarget || {}).map(function (k) { return (Number(k) + 1) + ' 号'; }).join('、') || '无')
        + '　当前在处决台=' + (_ns2.nom.onBlock ? ((_ns2.nom.onBlock.target + 1) + ' 号') : '无'));
      lines.push('');
    }
  } catch (e) {}
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
  nomReadyDecide, enterNominationPhase,
  askNomibationAgreement,
  runNomination, nomStatus, buildNomPrompt,
  viewFor, viewForStoryteller, buildPrompt, buildStorytellerNightPrompt, buildStorytellerDayPrompt,
  parseReply, extractObject, runRound, replyToDm, runStoryteller, status, storyStatus, callModel, roleInfo, allRoles,
  setLlmCall, hasLlm, routeFor,
  wikiLookup, clearKnowledge, playerSystem, storytellerSystem, gameKnowledge, CORE_RULES, BALANCE_RULES,
  storyReply, buildStoryChatPrompt, specialRolesBrief, SPECIAL_ROLE_RULES, AI_STYLES, stylePrompt, styleKey,
  storyRecap, buildRecapPrompt
};