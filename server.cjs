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
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8'};

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
  game: (q) => E.loadState(q.id),
  create: (b) => E.createGame(b),
  quickstart: (b) => E.createAndStart(b),
  start: (b) => E.start(b.id),
  phase: (b) => E.setPhase(b.id,b.phase),
  ack: (b) => E.readAck(b.id,b.seat,b.nonce,b.ack),
  role: (b) => { const r = E.assignRole(b.id,b.seat,b.role); A.clearKnowledge(b.id); return r; },
  info: (b) => E.giveInfo(b.id,b.seat,b.text),
  speak: (b) => E.speak(b.id,b.seat,b.text),
  say: (b) => E.say(b.id, b.seat, b.text, b.channel, b.to),
  messages: (b) => ({ messages: E.messages(b.id, b.viewer, !!b.storyteller) }),
  think: (b) => E.think(b.id,b.seat,b.text),
  nominate: (b) => E.nominate(b.id,b.from,b.target),
  vote: (b) => E.vote(b.id,b.seat,b.target),
  execute: (b) => E.execute(b.id,b.seat),
  marker: (b) => E.toggleMarker(b.id,b.seat,b.marker),
  seatModel: (b) => E.setSeatModel(b.id, b.seat, b.provider, b.model),
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
      console.log('血染钟鱼 running at http://127.0.0.1:'+PORT+' ('+(A.hasLlm()?'llm':(process.env.AGENT_ENDPOINT?'endpoint':'mock'))+')');
      resolve({ ok:true, port:PORT, server:server, reused:false });
    });
  });
}

module.exports = { serve, buildApi, makeHandler };

if (require.main === module){
  serve({});
}