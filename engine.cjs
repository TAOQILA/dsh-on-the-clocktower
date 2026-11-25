'use strict';
/* 血染钟鱼 - 游戏状态机：唯一权威状态在服务端，所有动作经此校验 */
const fs = require('fs');
const path = require('path');

const GAMES_ROOT = path.join(__dirname, 'data', 'games');
const PHASES = ['setup','night','day','nomination','vote','dawn','ended'];

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }
function stamp(){
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'_'+p(d.getHours())+p(d.getMinutes());
}
function gameDir(id){ return path.join(GAMES_ROOT, id); }
function appendJsonl(file, obj){
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj)+'\n', 'utf8');
}
function idOf(id, seat){ return path.join(gameDir(id), 'agents', 'seat-'+String(seat).padStart(2,'0')); }

function createGame(cfg){
  // 同一分钟内同配置连续开局时自动加序号，避免覆盖上一局
  const base = stamp()+'_'+cfg.script+'_'+cfg.seats.length+'人';
  let id = base, n = 2;
  while (fs.existsSync(gameDir(id))) id = base+'_'+n++;
  const dir = gameDir(id);
  ensureDir(path.join(dir,'state'));
  ensureDir(path.join(dir,'agents'));
  const state = {
    id, script: cfg.script, created_at: new Date().toISOString(),
    phase: 'setup', night: 0, day: 0, turn: 0,
    storyteller: cfg.storyteller, seats: cfg.seats,
    roles: {}, alive: {}, markers: {}, info: {}, nominations: [], votes: {}, messages: [],
    log: [], readAcks: []
  };
  cfg.seats.forEach((s,i)=>{
    state.alive[i] = true;
    state.markers[i] = [];
    if (s.type === 'agent') ensureDir(idOf(id, i));
  });
  fs.writeFileSync(path.join(dir,'game.json'), JSON.stringify({id, script:cfg.script, seats:cfg.seats, storyteller:cfg.storyteller, config:cfg}, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify({id, created_at:state.created_at, script:cfg.script, seat_count:cfg.seats.length, engine:'血染钟鱼/1.0'}, null, 2), 'utf8');
  saveState(id, state);
  log(id, '系统', '对局创建：'+cfg.script+'，'+cfg.seats.length+' 座，说书人='+(cfg.storyteller.type==='agent'?'Agent':'玩家'));
  return state;
}
function loadState(id){ return JSON.parse(fs.readFileSync(path.join(gameDir(id),'state','current.json'),'utf8')); }
function saveState(id, s){
  fs.writeFileSync(path.join(gameDir(id),'state','current.json'), JSON.stringify(s,null,2),'utf8');
  fs.writeFileSync(path.join(gameDir(id),'state','turn-'+String(s.turn).padStart(4,'0')+'.json'), JSON.stringify(s,null,2),'utf8');
}
function log(id, who, text){
  const s = loadState(id);
  s.log.push({ t:new Date().toISOString(), who, text });
  appendJsonl(path.join(gameDir(id),'transcript-entries.jsonl'), {who,text});
  saveState(id, s);
}
function agentLog(id, seat, kind, obj){
  appendJsonl(path.join(idOf(id,seat), kind+'.jsonl'), Object.assign({t:new Date().toISOString(), seat}, obj));
}
function readAck(id, seat, nonce, ack){
  const s = loadState(id);
  if (!ack || ack.indexOf(nonce) < 0) return {ok:false, error:'READ_ACK 必须包含服务端下发的 nonce'};
  s.readAcks.push({seat, t:new Date().toISOString()});
  saveState(id,s);
  return {ok:true};
}
function allAcked(id){
  const s = loadState(id);
  return s.seats.filter(x=>x.type==='agent').every(x=>s.readAcks.some(a=>a.seat===x.seat));
}
function start(id){
  const s = loadState(id);
  if (s.phase!=='setup') return {ok:false,error:'仅 setup 阶段可开局'};
  if (!allAcked(id)) return {ok:false,error:'尚有 Agent 未完成知识库阅读回执'};
  s.phase='night'; s.night=1; s.turn=1;
  saveState(id,s); log(id,'系统','第一夜开始');
  return {ok:true, state:s};
}
function setPhase(id, phase){
  const s = loadState(id);
  if (!PHASES.includes(phase)) return {ok:false,error:'未知阶段'};
  if (phase==='night' && s.phase==='dawn'){ s.night++; }
  if (phase==='day' && s.phase==='night'){ s.day++; }
  s.phase=phase; s.turn++;
  saveState(id,s); log(id,'系统','进入阶段：'+phase+(phase==='night'?'（第'+s.night+'夜）':''));
  return {ok:true,state:s};
}
function assignRole(id, seat, role){
  const s = loadState(id);
  s.roles[seat]=role;
  saveState(id,s);
  log(id,'说书人','为 '+s.seats[seat].name+' 分配角色：'+role);
  return {ok:true};
}
function giveInfo(id, seat, text){
  const s = loadState(id);
  (s.info[seat]=s.info[seat]||[]).push({t:new Date().toISOString(), text});
  agentLog(id,seat,'actions',{kind:'info_received',text});
  saveState(id,s);
  return {ok:true};
}
function speak(id, seat, text){
  const s = loadState(id);
  log(id, s.seats[seat]?s.seats[seat].name:'#'+seat, text);
  if (s.seats[seat] && s.seats[seat].type==='agent') agentLog(id,seat,'speech',{text});
  return {ok:true};
}
function think(id, seat, text){ agentLog(id,seat,'think',{text}); return {ok:true}; }
function nominate(id, from, target){
  const s = loadState(id);
  s.nominations.push({from,target,t:new Date().toISOString()});
  saveState(id,s); log(id,s.seats[from].name,'提名 '+s.seats[target].name);
  return {ok:true};
}
function vote(id, seat, target){
  const s = loadState(id);
  s.votes[seat]=target; saveState(id,s);
  agentLog(id,seat,'actions',{kind:'vote',target});
  return {ok:true};
}
function execute(id, seat){
  const s = loadState(id);
  s.alive[seat]=false; s.markers[seat].push('死亡');
  saveState(id,s); log(id,'系统',s.seats[seat].name+' 被处决');
  return {ok:true};
}
function toggleMarker(id, seat, marker){
  const s = loadState(id);
  const i = s.markers[seat].indexOf(marker);
  if (i>=0) s.markers[seat].splice(i,1); else s.markers[seat].push(marker);
  saveState(id,s); return {ok:true, markers:s.markers[seat]};
}
function listGames(){
  if(!fs.existsSync(GAMES_ROOT)) return [];
  return fs.readdirSync(GAMES_ROOT).filter(d=>fs.existsSync(path.join(gameDir(d),'state','current.json')));
}
/* 群聊（town 公开频道）与私聊（private，仅收发双方+说书人可见） */
function say(id, seat, text, channel, to){
  const s = loadState(id);
  const ch = channel==='private'?'private':'town';
  const targets = ch==='private' ? (Array.isArray(to)?to:[to]).filter(x=>x!==undefined&&x!==null) : [];
  if (!Array.isArray(s.messages)) s.messages = [];
  const msg = { t:new Date().toISOString(), from:seat, channel:ch, to:targets, text:String(text||'') };
  s.messages.push(msg);
  saveState(id,s);
  const who = s.seats[seat]?s.seats[seat].name:'#'+seat;
  if (ch==='town') log(id, who, '[公开发言] '+msg.text);
  else log(id, '系统', who+' 私聊了 '+targets.map(x=>s.seats[x]?s.seats[x].name:'#'+x).join('、')+'（内容仅当事人可见）');
  if (s.seats[seat] && s.seats[seat].type==='agent') agentLog(id,seat,'speech',{channel:ch,to:targets,text:msg.text});
  targets.forEach(function(x){
    if (s.seats[x] && s.seats[x].type==='agent') agentLog(id,x,'actions',{kind:'dm_received',from:seat,text:msg.text});
  });
  return {ok:true, message:msg};
}
/* 按视角过滤消息：town 全员可见；private 仅发件人、收件人、说书人可见 */
function messages(id, viewer, isStoryteller){
  const s = loadState(id);
  if (!Array.isArray(s.messages)) s.messages = [];
  return s.messages.filter(function(m){
    if (m.channel!=='private') return true;
    if (isStoryteller || m.from===viewer) return true;
    return Array.isArray(m.to) && m.to.indexOf(viewer)>=0;
  });
}

/* 每个座位 / 说书人都可以单独指定模型：{provider, model} */
function setSeatModel(id, seat, provider, model){
  const s = loadState(id);
  const target = (seat === 'storyteller' || seat === 'story') ? s.storyteller : s.seats[seat];
  if (!target) return {ok:false, error:'没有这个座位'};
  target.provider = provider || '';
  target.model = model || '';
  saveState(id, s);
  const who = (seat === 'storyteller' || seat === 'story') ? '说书人' : s.seats[seat].name;
  log(id, '系统', who + ' 的模型已设为 ' + (target.provider&&target.model ? (target.provider+'/'+target.model) : '默认') );
  return {ok:true, seat, provider:target.provider, model:target.model};
}


/* 一步完成：创建 + Agent 阅读回执 + 进入第一夜（避免前端多次往返造成的卡死） */
function createAndStart(cfg){
  const s = createGame(cfg);
  const idxFile = path.join(__dirname, 'data', 'wiki', 'INDEX.md');
  const idx = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '';
  const ack = 'READ_ACK:init ' + idx.slice(0, 20);
  (s.seats || []).forEach(function(x){
    if (x.type === 'agent') readAck(s.id, x.seat, 'init', ack);
  });
  const r = start(s.id);
  if (r && r.ok === false) return r;
  return loadState(s.id);
}

module.exports = { createGame, createAndStart, setSeatModel, loadState, saveState, log, readAck, allAcked, start, setPhase,
  assignRole, giveInfo, speak, think, say, messages, nominate, vote, execute, toggleMarker, listGames,
  agentLog, gameDir };