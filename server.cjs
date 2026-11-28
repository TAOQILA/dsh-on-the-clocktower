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
/* 血染钟鱼 - 本地服务：静态文件 + 对局 API + Agent 适配器接口
 * 既可作为独立进程运行（node server.cjs），也可由宿主端插件在 DSH 进程内启动，
 * 后者会注入 llmCall，使 Agent 直接使用 DSH 已配置的模型，无需任何额外配置。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('./engine.cjs');
const A = require('./agents.cjs');

const ROOT = __dirname, PUB = path.join(ROOT, 'public');
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.webmanifest':'application/manifest+json; charset=utf-8','.ico':'image/x-icon'};

function send(res, code, data, type){
  res.writeHead(code, {'Content-Type': type||'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
  res.end(typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));
}
function body(req){ return new Promise(ok=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{try{ok(JSON.parse(b||'{}'))}catch(e){ok({})}}) }); }

function buildApi(opts){
  opts = opts || {};
  return {
  scripts: () => {
    const d = path.join(ROOT,'data','scripts');
    return fs.readdirSync(d).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(d,f),'utf8')));
  },
  names: () => {
    const f = path.join(ROOT,'data','names.json');
    try { const j = JSON.parse(fs.readFileSync(f,'utf8')); return Array.isArray(j) ? j : (Array.isArray(j.names) ? j.names : []); }
    catch(e) { return []; }
  },
  wiki: (q) => {
    const name = String(q.name||'').replace(/[\\/:*?"<>|]/g,'_');
    const f = path.join(ROOT,'data','wiki','pages', name + '.md');
    return fs.existsSync(f) ? fs.readFileSync(f,'utf8') : null;
  },
  wikiIndex: () => fs.readFileSync(path.join(ROOT,'data','wiki','INDEX.md'),'utf8'),
  wikiList: () => {
    const base = path.join(ROOT,'data','wiki','pages');
    const names = fs.readdirSync(base).filter(f=>f.endsWith('.md')).sort().map(f=>f.slice(0,-3));
    let cat = {};
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT,'data','wiki','meta.json'),'utf8'));
      const pages = m.pages || m;
      if (Array.isArray(pages)) pages.forEach(p => { if (p && p.title) cat[p.title] = p.category || ''; });
      else if (pages && typeof pages === 'object') Object.keys(pages).forEach(k => { const p = pages[k] || {}; cat[p.title || k] = p.category || ''; });
    } catch (e) {}
    return names.map(n => ({ name: n, category: cat[n] || '' }));
  },
  health: () => ({ ok:true, llm: A.hasLlm(), mode: A.hasLlm() ? 'llm' : (process.env.AGENT_ENDPOINT ? 'endpoint' : 'mock') }),
  games: () => E.listGames(),
  game: (q) => {
    const s = E.loadState(q.id);
    if (!s) return s;
    /* 本局四种身份类型的基础配比（角色能力影响之前）：这是公开信息，任何视角都可以下发 */
    try { s.comp = E.compositionFor(((s.seats) || []).length); } catch (e) { s.comp = null; }
    /* 标记（中毒/醉酒/被保护等）属于说书人私有信息：非说书人视角一律清空，避免从前端或接口泄露 */
    const st = (q.storyteller === true || q.storyteller === 'true' || q.seat === 'storyteller');
    if (!st) {
      s.markers = (s.seats || []).map(function () { return []; });
      /* 日志里分配角色、改模型这类条目会暴露身份，非说书人视角一律过滤 */
      s.log = (s.log || []).filter(function (x) { return !x.priv; });
      /* 夜里死的人，天亮播报之前谁都不该知道：非说书人视角把「昨夜死亡」的存活状态还原成存活，
         否则圆桌头像会在半夜就变黑白，等于提前泄露了死亡结果。天亮进入白天后 nightDeaths 已被清空，自然恢复正常。 */
      if (s.phase === 'night' || s.phase === 'dawn') {
        (s.nightDeaths || []).forEach(function (i) { if (s.alive && s.alive[i] !== undefined) s.alive[i] = true; });
      }
      s.nightDeaths = [];
      /* 角色属于底牌：对局进行中只把「自己那一张」下发，终局后全部公开 */
      if (!(s.win && s.win.over)) {
        const mineSeat = Number(q.seat);
        const mineRole = (isFinite(mineSeat) && mineSeat >= 0) ? (s.roles || {})[mineSeat] : undefined;
        s.roles = (mineRole !== undefined) ? (function () { const o = {}; o[mineSeat] = mineRole; return o; })() : {};
      }
    }
    return s;
  },
  create: (b) => E.createGame(b),
  quickstart: (b) => E.createAndStart(b),
  start: (b) => E.start(b.id),
  phase: (b) => E.setPhase(b.id,b.phase),
  ack: (b) => E.readAck(b.id,b.seat,b.nonce,b.ack),
  role: (b) => { const r = E.assignRole(b.id,b.seat,b.role); A.clearKnowledge(b.id); return r; },
  info: (b) => E.giveInfo(b.id,b.seat,b.text),
  speak: (b) => E.speak(b.id,b.seat,b.text),
  say: (b) => {
    /* 「/管理员 内容」= 最高权限指令：不当作普通聊天，转成管理员私聊直接下达给说书人，
       并要求说书人如实回答、按指令操作。公聊里只留一行提示，不泄露管理员问了什么。 */
    /* 最高权限指令前缀（全部等价、忽略大小写）：
       /admin /ad /a /ch /cheat /c /z /zb /g /gl /gly
       /管理员 /管理 /作弊 /作 —— 长短写法都认，但前缀后面必须是空白、冒号或结尾，
       这样 /abcdef 之类的半截词不会被误判成指令。 */
    const ADMIN_ALIAS = '(?:admin|cheat|gly|gl|zb|ad|ch|a|c|z|g|管理员|管理|作弊|作)';
    const adminRe = new RegExp('^\\s*[\\/／]\\s*' + ADMIN_ALIAS + '(?=$|[\\s:：,，])\\s*[:：,，]?\\s*([\\s\\S]*)$', 'i');
    const adminText = String(b.text || '').match(adminRe);
    if (adminText) {
      const q = adminText[1].trim();
      if (q) {
        try {
          /* 能被确定性解析的指令（处决/杀死/复活/改角色/终局/推进阶段）由引擎直接执行，
             不指望模型自己记得调接口——历史上它就只在聊天里「宣布」了一句，游戏状态没动。 */
          let _exec = null;
          try { _exec = E.adminExecute(b.id, q); } catch (e) { _exec = null; }
          const ar = E.adminSay(b.id, q, b.seat, _exec);
          /* 公聊里下达的指令只在公聊留一行提示；私聊里下达的就保持私聊，不要把内容捅到公聊 */
          if (b.channel !== 'private') {
            E.say(b.id, b.seat === 'storyteller' ? 'storyteller' : b.seat, '（向说书人下达了管理员指令）', 'town');
          }
          try { if (ar && ar.message) A.storyReply(b.id, ar.message); } catch (e) {}
          return { ok: true, admin: true, message: ar && ar.message };
        } catch (e) {}
      }
    }
    /* 夜间程序化流程：如果这条消息是在回答某个角色的夜间选择，直接交给引擎机械结算，
       不再让说书人模型自由发挥（m11961）。 */
    let savedMsg = null;
    const saveOwn = function () {
      if (!savedMsg) { try { savedMsg = E.say(b.id, b.seat, b.text, b.channel || 'private', b.to); } catch (e) {} }
      return savedMsg;
    };
    if (b.seat !== undefined && b.seat !== null && b.seat !== '' && b.seat !== 'storyteller') {
      try {
        const na = E.nightAnswer(b.id, Number(b.seat), b.text);
        if (na && !na.ok && na.retry) {
          /* 选择不合法（人数不对等）：这句话要留在他自己的私聊里，同时把错误回给他，等他说对为止 */
          saveOwn();
          E.say(b.id, 'storyteller', na.error, 'private', [Number(b.seat)]);
          return { ok: true, night: true, retry: true, error: na.error };
        }
        if (na && na.ok && na.ignored) {
          /* 这一步已经结算过，玩家又补发了一条：留档但不再回「现在没有在等你的选择」 */
          saveOwn();
          return { ok: true, night: true };
        }
        if (na && na.ok) {
          saveOwn();
          /* 「收到，已经按你的选择结算。」改由 engine.nightAnswer 在给结果之前发出，
             保证玩家看到的是「确认 → 信息」，而不是「信息 → 确认」。 */
          /* 答案一落库，夜间流程要立刻接着往下走：
             否则玩家答完这一步，流程还停在原地，看起来就像卡死了（m11812）。 */
          try { const sN = E.loadState(b.id); if (sN.phase === 'night' && sN.nightRun && !sN.nightRun.finished) A.runStoryteller(b.id, {}); } catch (e) {}
          return { ok:true, night:true, text:na.text };
        }
      } catch (e) {}
    }
    const r = savedMsg || E.say(b.id, b.seat, b.text, b.channel, b.to);
    /* 杂耍艺人的公开猜测：程序解析并落库，说书人只负责回一句确认（不能只靠模型「记下」） */
    if (r && r.ok && r.message && (!r.message.channel || r.message.channel === 'town') && r.message.from !== 'storyteller') {
      try {
        const jg = E.jugglerFromChat(b.id, Number(r.message.from), r.message.text);
        if (jg && jg.handled) {
          const _ack = jg.ok
            ? '已记录你的公开猜测：' + jg.pairs.map(function (p) { return (p.target + 1) + ' 号 ' + p.guess; }).join('、') + '。今晚会告诉你命中几个。'
            : jg.error;
          E.say(b.id, 'storyteller', _ack, 'town');
          return r;
        }
      } catch (e) {}
    }
    /* 公聊里声明「我准备好进入提名了」：写进准备名单并公开显示在圆桌上，
       再由说书人结合天平判断是否真的进入提名阶段（m11961）。 */
    if (r && r.ok && r.message && r.message.channel === 'town' && r.message.from !== 'storyteller' && r.message.from !== 'admin') {
      try {
        const rd = E.nomReadyFromChat(b.id, Number(r.message.from), r.message.text);
        if (rd && rd.handled) {
          try { A.nomReadyDecide(b.id, Number(r.message.from)); } catch (e) {}
          return r;
        }
      } catch (e) {}
    }
    /* 公聊里直接说「我提名 X」：由引擎解析并真正发起提名，不再指望说书人自己记账。
       提名一旦进入引擎，之后就说书人主持流程，别让 LLM 再自由发挥一遍。 */
    if (r && r.ok && r.message && r.message.channel === 'town' && r.message.from !== 'storyteller') {
      try {
        const np = E.nomTryFromChat(b.id, r.message.from, r.message.text);
        if (np && np.handled) {
          if (!np.ok && np.error) E.say(b.id, 'storyteller', np.error, 'town');
          else if (np.ok) { try { A.runNomination(b.id, {}); } catch (e) {} }
          return r;
        }
      } catch (e) {}
    }
    /* 只有「真的在跟说书人说话」的消息才交给说书人思考：
       ① 私聊必须是发给说书人的（玩家之间私聊说书人看不到，也不该插话）
       ② 公聊必须点到说书人（否则说书人不要总在公聊里刷存在感）*/
    if (r && r.ok && r.message) {
      const m = r.message;
      const toSt = (Array.isArray(m.to) && m.to.indexOf('storyteller') >= 0) || m.to === 'storyteller';
      /* 怎么算「叫到说书人」：说书人/主持人这类通用称呼，或者直接喊出本局说书人的名字（含简称），
         不必@全名——玩家喊「@肥鱼」也应该被听见。 */
      const _stName = String((E.loadState(b.id).storyteller || {}).name || '');
      const _short = _stName.replace(/说书人|主持人|Agent|AI|agent|ai/g, '').trim();
      const addressed = /说书人|主持人|@\s*说书/.test(String(m.text || ''))
        || (_stName && String(m.text || '').indexOf(_stName) >= 0)
        || (_short.length >= 1 && String(m.text || '').indexOf(_short) >= 0);
      const need = (m.channel === 'private') ? toSt : addressed;
      if (need && m.from !== 'storyteller') { try { A.storyReply(b.id, m); } catch (e) {} }
    }
    /* 玩家之间私聊：不管前端有没有补那一句 /api/round，服务端都保证有人回。
       以前完全依赖前端，只要它没发出去或被并发吃掉，玩家就永远等不到回话（m14882/m14910）。 */
    if (r && r.ok && r.message && r.message.channel === 'private') {
      try { A.replyToDm(b.id, r.message); } catch (e) {}
    }
    return r;
  },
  messages: (b) => ({ messages: E.messages(b.id, b.viewer, !!b.storyteller) }),
  /* 管理员以管理员身份私聊说书人：消息只有说书人看得到，同时立刻交给说书人思考并回复 */
  adminSay: (b) => {
    const r = E.adminSay(b.id, b.text);
    if (r && r.ok && r.message) { try { A.storyReply(b.id, r.message); } catch (e) {} }
    return r;
  },
  think: (b) => E.think(b.id,b.seat,b.text),
  nominate: (b) => E.nominate(b.id,b.from,b.target),
  vote: (b) => E.vote(b.id,b.seat,b.target),
  execute: (b) => E.execute(b.id,b.seat),
  kill: (b) => E.kill(b.id,b.seat,b.reason||''),
  marker: (b) => E.toggleMarker(b.id,b.seat,b.marker),
  seatModel: (b) => E.setSeatModel(b.id, b.seat, b.provider, b.model, b.name),
  checkWin: (b) => E.checkWin(b.id),
  /* 宣布终局：Agent 说书人先把全场复盘发到公聊，然后才落终局；人类说书人直接终局 */
  endGame: async (b) => {
    try {
      const r = await A.storyRecap(b.id, b.side, b.reason);
      if (r && r.ok) return { ok:true, win:r.win, recap:r.recap };
    } catch (e) {}
    return E.endGame(b.id, b.side, b.reason);
  },
  /* 可用的模型目录：由宿主端注入（读 DSH 的 provider/model 清单） */
  models: async () => {
    if (typeof opts.listModels === 'function') {
      try { return await opts.listModels(); } catch (e) { return { error:String(e && e.message || e), providers:[] }; }
    }
    return { providers: [], note: '独立进程模式下无法枚举模型，请在插件内使用' };
  },
  /* Agent 驱动器：视角快照、轮次推进、进度查询 */
  view: (b) => A.viewFor(b.id, Number(b.seat)),
  storytellerView: (b) => A.viewForStoryteller(b.id),
  prompt: (b) => A.buildPrompt(b.id, Number(b.seat)),
  round: (b) => A.runRound(b.id, b),
  roundStatus: (b) => A.status(b.id),
  /* 说书人 Agent：主持夜间流程 */
  storyRound: (b) => A.runStoryteller(b.id, b),
  storyLog: (b) => E.storyLog(b.id),
  setStyle: (b) => E.setStyle(b.id, b.style),
  setRoleMode: (b) => E.setRoleMode(b.id, b.mode),
  dealRoles: (b) => E.dealRoles(b.id),
  openVote: (b) => E.openVote(b.id, b.target),
  castVote: (b) => E.castVote(b.id, b.seat, b.yes !== false),
  resolveVote: (b) => E.resolveVote(b.id),
  /* 提名与投票 */
  nomination: (b) => A.runNomination(b.id, b),
  nomGate: (b) => E.nomGate(b.id),
    aiErrors: (b) => E.aiErrors(b.id),
    nomAgreeAsk: async (b) => A.askNomibationAgreement(b.id, { reason: b.reason }),
    nomAgreeState: (b) => E.nomAgreeState(b.id),
  setNomCfg: (b) => E.setNomCfg(b.id, { min:b.min, softMax:b.softMax, hardMax:b.hardMax, unanimous:b.unanimous }),
  nomReady: (b) => (b.seat === undefined || b.seat === null || b.seat === "" ? E.nomReadyState(b.id) : E.nomSetReady(b.id, b.seat, b.yes !== false)),
  nightState: (b) => E.nightProgress(b.id, !!b.full),
  nomStatus: (b) => A.nomStatus(b.id),
  nomState: (b) => E.nomState(b.id),
  nomPropose: (b) => E.nomPropose(b.id, b.from, b.target, b.reason),
  nomSpeech: (b) => E.nomSpeech(b.id, b.kind, b.text),
  nomHand: (b) => E.nomHand(b.id, b.seat, b.yes !== false),
  nomSkip: (b) => E.nomSkip(b.id, b.seat),
  nomFinish: (b) => E.nomFinish(b.id),
  storyChat: (b) => A.storyReply(b.id, b.msg),
  storyStatus: (b) => A.storyStatus(b.id),
  agentSpeak: async (b) => {
    const s = E.loadState(b.id);
    const out = await A.callModel({
      seat: b.seat, prompt: b.prompt || '请用一句话公开发言。',
      system: '你在玩社交推理游戏，用一句话公开发言，像真人玩家，不要提及自己是 AI。'
    });
    if (!out.error && out.text) E.say(b.id, b.seat, A.parseReply(out.text).say || out.text, 'town');
    return {ok:true, text: out.error ? ('调用失败：'+out.error) : out.text};
  }
  };
}

/* 供宿主插件以 webServer.register({kind:'prefix', path:PREFIX}) 挂载：
 * 请求 URL 已经带前缀，这里先剥掉前缀再走同一套路由。 */
function makeHandler(opts, prefix){
  opts = opts || {};
  const api = buildApi(opts);
  if (opts.llmCall) A.setLlmCall(opts.llmCall);
  const pre = String(prefix || '').replace(/\/+$/, '');
  return async function handler(req, res){
    let raw = String(req.url || '/');
    if (pre && raw.indexOf(pre) === 0) raw = raw.slice(pre.length) || '/';
    const u = new URL(raw, 'http://localhost');
    if (u.pathname === '/api' || u.pathname.indexOf('/api/') === 0){
      const name = u.pathname.replace(/^\/api\/?/, '');
      const fn = api[name];
      if (!fn) return send(res,404,{error:'unknown api: '+name});
      try{
        const q = Object.fromEntries(u.searchParams);
        const b = req.method==='POST'?await body(req):{};
        send(res,200,{ok:true, data:await fn(Object.assign({},q,b))});
      }catch(e){ send(res,500,{ok:false,error:String(e&&e.message||e)}); }
      return;
    }
    let p = u.pathname;
    if (p === '/' || p === '') p = '/index.html';
    const fp = path.join(PUB, path.normalize(p).replace(/^([.][.][\\/])+/,''));
    if (!fp.startsWith(PUB)) return send(res,403,'forbidden','text/plain; charset=utf-8');
    if (!fs.existsSync(fp)) return send(res,404,'not found','text/plain; charset=utf-8');
    send(res,200,fs.readFileSync(fp),MIME[path.extname(fp)]||'application/octet-stream');
  };
}

function serve(opts){
  opts = opts || {};
  const PORT = Number(opts.port || process.env.PORT || 6325);
  const handler = makeHandler(opts, '');
  const server = http.createServer(handler);
  if (opts.llmCall) A.setLlmCall(opts.llmCall);

  return new Promise(function(resolve){
    server.on('error', function(err){
      if (err && err.code === 'EADDRINUSE') resolve({ ok:true, port:PORT, reused:true, server:null });
      else resolve({ ok:false, port:PORT, error:String(err && err.message || err) });
    });
    server.listen(PORT, '127.0.0.1', function(){
      const mode = (A.hasLlm()?'llm':(process.env.AGENT_ENDPOINT?'endpoint':'mock'));
      console.log('血染钟鱼 running at http://127.0.0.1:'+PORT+' ('+mode+')');
      resolve({ ok:true, port:PORT, server:server, reused:false });
    });
  });
}

module.exports = { serve, buildApi, makeHandler };

if (require.main === module){
  serve({});
}