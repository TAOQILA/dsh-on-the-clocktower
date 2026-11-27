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
    aiStyle: cfg.aiStyle || 'mild_fun',
    roleMode: cfg.roleMode || 'program',
    roles: {}, alive: {}, markers: {}, info: {}, nominations: [], votes: {}, messages: [], nightDeaths: [],
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
/* priv=true 的日志只有说书人视角可见（分配角色、改模型这类会暴露身份的操作） */
function log(id, who, text, priv){
  const s = loadState(id);
  s.log.push({ t:new Date().toISOString(), who, text, priv: !!priv });
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
  /* 白天计时：进入白天时打点，进入夜晚清空。前端据此显示「今天已过多少分钟」 */
  if (phase==='day') { if (!s.dayStarted) s.dayStarted = new Date().toISOString(); }
  else if (phase==='night') { s.dayStarted = null; }
  /* 换阶段时上一轮投票作废 */
  if (phase!=='day') s.vote = null;
  const wasNight = (s.phase === 'night');
  s.phase=phase; s.turn++;
  saveState(id,s); log(id,'系统','进入阶段：'+phase+(phase==='night'?'（第'+s.night+'夜）':''));
  /* 首夜：爪牙得知恶魔、恶魔得知爪牙 + 3 个伪装身份（程序机械下发，说书人不会漏）*/
  if (phase === 'night' && s.night === 1 && Object.keys(s.roles || {}).length) {
    try { dealEvilInfo(id); } catch (e) {}
  }
  /* 天亮必须由系统公开播报：玩家不该靠猜或翻日志才知道天亮了、谁死了 */
  if (phase === 'day' && wasNight){
    const dead = (s.nightDeaths || []).filter(function(i){ return s.seats[i] && !s.alive[i]; });
    s.nightDeaths = [];
    saveState(id,s);
    const nameOf = function(i){ return (i+1)+' 号 '+s.seats[i].name; };
    let text = '天亮了，第 '+s.day+' 天开始。';
    if (dead.length) text += '昨夜死亡：' + dead.map(nameOf).join('、') + '。';
    else text += '昨夜是平安夜，没有人死亡。';
    say(id,'storyteller',text,'town');
  }
  return {ok:true,state:s};
}
function assignRole(id, seat, role){
  const s = loadState(id);
  s.roles[seat]=role;
  saveState(id,s);
  log(id,'说书人','为 '+s.seats[seat].name+' 分配角色：'+role, true);
  return {ok:true};
}
function giveInfo(id, seat, text){
  const s = loadState(id);
  /* 同一座位不重复发同一条角色告知（程序发牌后说书人可能又想发一遍，会造成一人两个角色） */
  const dup = (s.info[seat] || []).some(function(x){ return String(x.text || '').trim() === String(text || '').trim(); });
  if (dup) return { ok:true, skipped:true };
  /* night/day 记录发放时刻：夜里得到的信息，要到下一个白天才能公开讨论 */
  (s.info[seat]=s.info[seat]||[]).push({t:new Date().toISOString(), text, night:s.night, day:s.day, phase:s.phase});
  /* 说书人的信息由说书人「亲自私聊」发给该座位：直接落一条 private 消息（不走 say()，因为夜里私聊通道对玩家关闭，说书人下发信息不受此限） */
  if (!Array.isArray(s.messages)) s.messages = [];
  s.messages.push({ t:new Date().toISOString(), from:'storyteller', channel:'private', to:[seat], text:String(text||'') });
  /* 若信息里写明「你的角色是【X】」，顺手把角色落到 roles，保证身份面板/胜负判定/夜间顺序一致 */
  const m = String(text||'').match(/你的角色是[【\[]([^】\]]+)[】\]]/);
  if (m && m[1] && !s.roles[seat]) { s.roles[seat] = m[1].trim(); }
  agentLog(id,seat,'actions',{kind:'info_received',text});
  saveState(id,s);
  return {ok:true};
}
/* 一条私有信息是否已经可以公开讨论：夜里拿到的，要等进入下一个白天（day 前进）才行 */
function infoRevealable(entry, s){
  if (!entry) return false;
  if (entry.phase !== 'night') return true;          /* 白天给的，当场就能说 */
  const givenNight = Number(entry.night || 0);
  if (s.phase === 'night') return false;              /* 还是夜里，同夜信息一律不许说 */
  return Number(s.day || 0) >= givenNight && Number(s.day||0) > 0;
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
  saveState(id,s); log(id,'系统',(seat+1)+' 号 '+s.seats[seat].name+' 被处决');
  const w = checkWin(id);
  return {ok:true, win:w};
}
/* ---------- 白天的提名与处决投票 ----------
   openVote：说书人（或玩家）宣布「现在开始对某人的处决投票」
   castVote：每个存活座位表态 yes / no
   resolveVote：计票并结算——赞成多于反对且赞成票数达到存活人数的一半才处决 */
function openVote(id, target){
  const s = loadState(id);
  const t = Number(target);
  if (!(t >= 0 && t < s.seats.length)) return {ok:false, error:'目标座位越界'};
  if (!s.alive[t]) return {ok:false, error:'该座位已经死亡'};
  s.vote = { target:t, open:true, t0:new Date().toISOString(), yes:[], no:[] };
  saveState(id,s);
  log(id,'说书人','发起处决投票：目标 '+(t+1)+' 号 '+s.seats[t].name);
  return {ok:true, vote:s.vote};
}
function castVote(id, seat, yes){
  const s = loadState(id);
  if (!s.vote || !s.vote.open) return {ok:false, error:'现在没有进行中的投票'};
  if (!s.alive[seat]) return {ok:false, error:'死者没有投票权'};
  s.vote.yes = s.vote.yes.filter(function(x){ return x!==seat; });
  s.vote.no  = s.vote.no.filter(function(x){ return x!==seat; });
  (yes ? s.vote.yes : s.vote.no).push(seat);
  saveState(id,s);
  agentLog(id,seat,'actions',{kind:'vote_execute',target:s.vote.target,yes:!!yes});
  return {ok:true, yes:s.vote.yes.length, no:s.vote.no.length};
}
function resolveVote(id){
  const s = loadState(id);
  if (!s.vote || !s.vote.open) return {ok:false, error:'现在没有进行中的投票'};
  const alive = s.seats.filter(function(x,i){ return s.alive[i]; }).length;
  const yes = s.vote.yes.length, no = s.vote.no.length;
  const target = s.vote.target;
  s.vote.open = false; s.vote.yesCount = yes; s.vote.noCount = no; s.vote.aliveCount = alive;
  const pass = (yes > no) && (yes * 2 >= alive);
  s.vote.passed = pass;
  saveState(id,s);
  if (pass) {
    log(id,'系统','投票结果：'+(target+1)+' 号 '+s.seats[target].name+' 被处决（赞成 '+yes+' / 反对 '+no+'）');
    return execute(id, target);
  }
  log(id,'系统','投票未通过：'+(target+1)+' 号 '+s.seats[target].name+' 未被处决（赞成 '+yes+' / 反对 '+no+'）');
  return {ok:true, executed:false, yes, no, alive};
}

/* 夜间死亡（非处决）：与处决分开记账，避免日志写错 */
function kill(id, seat, reason){
  const s = loadState(id);
  if (!(seat >= 0 && seat < s.seats.length)) return {ok:false, error:'座位越界'};
  if (!s.alive[seat]) return {ok:false, error:'该座位已经死亡'};
  s.alive[seat]=false; s.markers[seat].push('死亡');
  if (!Array.isArray(s.nightDeaths)) s.nightDeaths = [];
  if (s.nightDeaths.indexOf(seat) < 0) s.nightDeaths.push(seat);
  saveState(id,s);
  log(id,'系统',(seat+1)+' 号 '+s.seats[seat].name+' 在夜里死亡'+(reason?('（'+reason+'）'):''));
  const w = checkWin(id);
  return {ok:true, win:w};
}

/* 阵营表：从 data/roles.json 读角色→阵营，供胜负判定使用 */
let ROLE_FACTION = null;
function roleFaction(name){
  if (!ROLE_FACTION){
    ROLE_FACTION = {};
    try {
      const list = JSON.parse(fs.readFileSync(path.join(__dirname,'data','roles.json'),'utf8'));
      (Array.isArray(list)?list:(list.roles||[])).forEach(function(r){ ROLE_FACTION[r.name]=r.faction; });
    } catch(e){}
  }
  return ROLE_FACTION[name] || null;
}
/* 胜负判定：恶魔出局→善良胜；存活≤2 人且恶魔仍在→邪恶胜 */
function checkWin(id){
  const s = loadState(id);
  if (s.win && s.win.over) return s.win;
  if (!s.roles || !Object.keys(s.roles).length) return { over:false };
  /* 还没分配到恶魔，说明本局角色尚未真正落地，不能据此判定胜负 */
  const anyDemon = Object.keys(s.roles).some(function(k){ return roleFaction(s.roles[k]) === 'demon'; });
  if (!anyDemon) return { over:false };
  const aliveSeats = [];
  (s.seats||[]).forEach(function(x,i){ if (s.alive[i]) aliveSeats.push(i); });
  let demonAlive = false;
  aliveSeats.forEach(function(i){ if (roleFaction(s.roles[i]) === 'demon') demonAlive = true; });
  let win = null;
  if (!demonAlive){
    win = { over:true, side:'good', reason:'恶魔已出局', at:new Date().toISOString() };
  } else if (aliveSeats.length <= 2){
    win = { over:true, side:'evil', reason:'场上仅剩 ' + aliveSeats.length + ' 人且恶魔仍在', at:new Date().toISOString() };
  }
  if (win){
    s.phase = 'ended'; s.win = win; s.winner = win.side;
    saveState(id, s);
    log(id, '系统', '对局结束：' + (win.side==='good'?'善良阵营胜利':'邪恶阵营胜利') + '（' + win.reason + '）');
    return win;
  }
  return { over:false };
}
/* 手动宣布终局 */
function endGame(id, side, reason){
  const s = loadState(id);
  const w = { over:true, side: side==='evil'?'evil':'good', reason: reason || '说书人宣布结束', at:new Date().toISOString() };
  s.phase = 'ended'; s.win = w; s.winner = w.side;
  saveState(id, s);
  log(id, '说书人', '宣布终局：' + (w.side==='good'?'善良阵营胜利':'邪恶阵营胜利') + '（' + w.reason + '）');
  return { ok:true, win:w };
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
  /* 夜晚禁止玩家之间私聊，但允许与说书人私聊（夜里询问/回答角色选择） */
  if (ch==='private' && s.phase==='night') {
    const toSt = seat==='storyteller' || targets.indexOf('storyteller')>=0;
    if (!toSt) return { ok:false, error:'夜晚禁止玩家间私聊，只可与说书人私聊' };
  }
  if (!Array.isArray(s.messages)) s.messages = [];
  const msg = { t:new Date().toISOString(), from:seat, channel:ch, to:targets, text:String(text||'') };
  s.messages.push(msg);
  saveState(id,s);
  /* from / to 都可能是 'storyteller'：说书人不是座位，没有 seats[i] */
  const seatName = (x) => (x==='storyteller') ? ((s.storyteller&&s.storyteller.name)||'说书人')
                       : (s.seats[x] ? s.seats[x].name : ('#'+x));
  const who = seatName(seat);
  if (ch==='town') log(id, who, '[公开发言] '+msg.text);
  else log(id, '系统', who+' 私聊了 '+targets.map(seatName).join('、')+'（内容仅当事人可见）');
  if (s.seats[seat] && s.seats[seat].type==='agent') agentLog(id,seat,'speech',{channel:ch,to:targets,text:msg.text});
  targets.forEach(function(x){
    if (s.seats[x] && s.seats[x].type==='agent') agentLog(id,x,'actions',{kind:'dm_received',from:seat,text:msg.text});
  });
  return {ok:true, message:msg};
}
/* 管理员私聊说书人：以 from='admin' 的身份投递一条私聊，只有说书人能看到 */
function adminSay(id, text){
  const s = loadState(id);
  if (!Array.isArray(s.messages)) s.messages = [];
  const msg = { t:new Date().toISOString(), from:'admin', channel:'private', to:['storyteller'], text:String(text||'') };
  s.messages.push(msg);
  saveState(id, s);
  log(id, '管理员', '[私聊说书人] ' + msg.text);
  return { ok:true, message:msg };
}

/* 按视角过滤消息：town 全员可见；private 仅发件人、收件人、说书人可见 */
function messages(id, viewer, isStoryteller){
  const s = loadState(id);
  if (!Array.isArray(s.messages)) s.messages = [];
  return s.messages.filter(function(m){
    if (m.channel!=='private') return true;
    /* 管理员私聊说书人：只有说书人视角看得到，玩家/旁观者都看不到 */
    if (m.from==='admin' || (Array.isArray(m.to) && m.to.indexOf('admin')>=0)) return !!isStoryteller;
    /* 玩家之间的私聊只有收发双方能看到；说书人只在消息与自己有关时才看得到，
       否则「私聊 5 号」的内容会被说书人当成发给自己的话 */
    const involvesSt = (m.from === 'storyteller') || (Array.isArray(m.to) && m.to.indexOf('storyteller') >= 0);
    if (isStoryteller) return involvesSt;
    if (m.from===viewer) return true;
    return Array.isArray(m.to) && m.to.indexOf(viewer)>=0;
  });
}

/* 每个座位 / 说书人都可以单独指定模型：{provider, model} */
function setSeatModel(id, seat, provider, model, name){
  const s = loadState(id);
  const target = (seat === 'storyteller' || seat === 'story') ? s.storyteller : s.seats[seat];
  if (!target) return {ok:false, error:'没有这个座位'};
  target.provider = provider || '';
  target.model = model || '';
  if (typeof name === 'string' && name.trim()) target.name = name.trim();
  saveState(id, s);
  const who = (seat === 'storyteller' || seat === 'story') ? '说书人' : s.seats[seat].name;
  log(id, '系统', who + ' 的模型已设为 ' + (target.provider&&target.model ? (target.provider+'/'+target.model) : '默认'), true);
  return {ok:true, seat, provider:target.provider, model:target.model};
}


/* 一步完成：创建 + Agent 阅读回执 + 进入第一夜（避免前端多次往返造成的卡死） */
/* ---------- 程序发牌 ----------
   角色表由程序机械、随机地生成，不经过说书人的自由裁量：
   1) 按人数决定 镇民/外来者/爪牙/恶魔 的配比；
   2) 从本剧本对应阵营里随机抽取，不重复；
   3) 能力描述里带 [..] 的角色（例如 男爵 [+2 外来者]、无神论者 [无邪恶角色在场]）会改变配比，
      这里按最常见的写法做机械修正：遇到 [+N 外来者] 就加外来者、减镇民；遇到 [-N 外来者] 反之；
   4) 抽完随机分配到座位，并把「你的角色是【X】」私聊发给每个人。
   roleMode='storyteller' 时不做任何处理，全部交由说书人 Agent 自己决定。 */
function scriptData(name){
  const p = path.join(__dirname, 'data', 'scripts', name + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e){ return null; }
}
function compositionFor(n){
  const table = { 5:[3,0,1,1], 6:[3,1,1,1], 7:[5,0,1,1], 8:[5,1,1,1], 9:[5,2,1,1], 10:[7,2,1,1],
                  11:[7,2,1,1], 12:[7,2,1,1], 13:[9,2,1,1], 14:[9,3,1,1], 15:[9,3,1,1] };
  if (table[n]) return table[n].slice();
  if (n < 5) return [n-2, 0, 1, 1];
  const townsfolk = n - 2 - Math.max(1, Math.floor((n-7)/3));
  return [Math.max(1, townsfolk), Math.max(0, n - townsfolk - 2), 1, 1];
}
function shuffle(a){
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = out[i]; out[i] = out[j]; out[j] = t; }
  return out;
}
/* 程序发牌：返回 { ok, roles, roster }；roster 是给说书人看的「几号是谁」清单 */
function dealRoles(id){
  const s = loadState(id);
  const sc = scriptData(s.script);
  if (!sc) return { ok:false, error:'找不到剧本：' + s.script };
  const g = sc.groups || {};
  const pool = { 镇民: (g['镇民']||[]).slice(), 外来者: (g['外来者']||[]).slice(), 爪牙: (g['爪牙']||[]).slice(), 恶魔: (g['恶魔']||[]).slice() };
  const n = (s.seats || []).length;
  if (!n) return { ok:false, error:'没有座位' };
  const comp = compositionFor(n);          /* [镇民, 外来者, 爪牙, 恶魔] */
  /* 先抽恶魔：恶魔的 [..] 括号可能要求额外爪牙，会影响下面抽几个爪牙 */
  const demons = shuffle(pool['恶魔']).slice(0, comp[3]);
  let bonusMinion = 0;
  demons.forEach(function(name){
    const r = roleInfoByName(name);
    const ab = (r && r.ability) || '';
    const m = ab.match(/\[\s*\+\s*(\d+)\s*爪牙/);
    if (m) bonusMinion += Number(m[1]);
  });
  /* 再抽爪牙：数量 = 基础配比 + 恶魔/爪牙自身带来的额外爪牙 */
  const minions = shuffle(pool['爪牙']).slice(0, comp[2] + bonusMinion);
  /* 带 [..] 的角色对配比做机械修正（外来者增减） */
  let bonusOutsider = 0;
  minions.concat(demons).forEach(function(name){
    const r = roleInfoByName(name);
    const ab = (r && r.ability) || '';
    let m = ab.match(/\[\s*\+\s*(\d+)\s*外来者/);
    if (m) bonusOutsider += Number(m[1]);
    m = ab.match(/\[\s*-\s*(\d+)\s*外来者/);
    if (m) bonusOutsider -= Number(m[1]);
  });
  let [nt, no, nm, nd] = comp;
  no = Math.max(0, no + bonusOutsider);
  nt = Math.max(0, n - no - minions.length - demons.length);
  const towns = shuffle(pool['镇民']).slice(0, nt);
  const outs  = shuffle(pool['外来者']).slice(0, no);
  const bag = shuffle(towns.concat(outs, minions, demons));
  /* 人数与角色池对不上时（剧本角色太少），用现有角色循环补足 */
  while (bag.length < n && bag.length > 0) { bag.push(bag[Math.floor(Math.random() * bag.length)]); }
  const picked = bag.slice(0, n);
  s.roles = {};
  s.seats.forEach(function (x, i) { s.roles[i] = picked[i]; });
  saveState(id, s);
  log(id, '系统', '程序发牌：' + picked.join('、'), true);
  /* 一次把「你的角色是【X】」发给每个人（giveInfo 自带去重，不会重复发） */
  s.seats.forEach(function (x, i) { giveInfo(id, i, '你的角色是【' + picked[i] + '】。'); });
  /* 首夜机械下发爪牙信息 / 恶魔信息（含 3 个伪装身份）*/
  dealEvilInfo(id);
  const roster = s.seats.map(function (x, i) { return (i+1) + ' 号 ' + x.name + '：' + picked[i]; });
  return { ok:true, roles: picked, roster: roster };
}
/* ---------- 首夜：爪牙信息 / 恶魔信息 ----------
   规则要求（所有剧本通用）：
   · 爪牙在首夜得知谁是恶魔；
   · 恶魔在首夜得知自己有哪些爪牙，并获得 3 个「伪装身份」（本局不在场的善良角色）。
   这两步由程序机械执行，保证不会漏、也不会被说书人自由发挥掉。 */
function evilInfoFor(id){
  const s = loadState(id);
  const roles = s.roles || {};
  const minionSeats = [], demonSeats = [];
  Object.keys(roles).forEach(function(k){
    const seat = Number(k);
    const fac = roleFaction(roles[k]);
    if (fac === 'minion') minionSeats.push(seat);
    else if (fac === 'demon') demonSeats.push(seat);
  });
  return { minionSeats: minionSeats.sort(function(a,b){return a-b;}), demonSeats: demonSeats.sort(function(a,b){return a-b;}) };
}
/* 3 个伪装身份：从本剧本里挑 3 个本局不在场的善良角色 */
function bluffRoles(id){
  const s = loadState(id);
  const sc = scriptData(s.script) || {};
  const g = sc.groups || {};
  const inPlay = Object.keys((s.roles||{})).map(function(k){ return s.roles[k]; });
  const pool = (g['镇民']||[]).concat(g['外来者']||[]).filter(function(x){ return inPlay.indexOf(x) < 0; });
  return shuffle(pool).slice(0, 3);
}
/* 首夜把爪牙信息 / 恶魔信息下发给对应座位。重复调用安全（giveInfo 自带去重）*/
function dealEvilInfo(id){
  const s = loadState(id);
  const info = evilInfoFor(id);
  if (!info.demonSeats.length) return { ok:false, error:'本局还没有恶魔' };
  const nameOf = function(i){ return (i+1) + ' 号 ' + ((s.seats[i] && s.seats[i].name) || ''); };
  const demonTxt = info.demonSeats.map(nameOf).join('、');
  /* 爪牙 → 得知恶魔是谁 */
  info.minionSeats.forEach(function(m){
    giveInfo(id, m, '你的同伴是：' + demonTxt + '（恶魔）。夜里不要公开谈论这些。');
  });
  /* 恶魔 → 得知爪牙 + 3 个伪装身份 */
  const minionTxt = info.minionSeats.length ? info.minionSeats.map(nameOf).join('、') : '（本局没有其他爪牙）';
  const bluffs = bluffRoles(id);
  const bluffTxt = bluffs.length ? bluffs.join('、') : '（剧本里没有可用的伪装身份）';
  info.demonSeats.forEach(function(d){
    giveInfo(id, d, '你的爪牙是：' + minionTxt + '。可以伪装成的三个身份：' + bluffTxt + '。夜里不要公开谈论这些。');
  });
  log(id, '系统', '首夜已下发爪牙信息与恶魔信息（伪装身份：' + bluffTxt + '）', true);
  return { ok:true, minions: info.minionSeats, demons: info.demonSeats, bluffs: bluffs };
}

function roleInfoByName(name){
  try {
    if (!ROLE_LIST_CACHE) {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'roles.json'), 'utf8'));
      ROLE_LIST_CACHE = Array.isArray(raw) ? raw : (raw.roles || Object.values(raw));
    }
    return ROLE_LIST_CACHE.find(function(r){ return r && (r.name === name || r.id === name); }) || null;
  } catch(e){ return null; }
}
let ROLE_LIST_CACHE = null;
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
  /* 默认由程序机械、随机地发牌；roleMode='storyteller' 时留给说书人 Agent 决定 */
  const st0 = loadState(s.id);
  if ((st0.roleMode || 'program') === 'program') {
    const d = dealRoles(s.id);
    if (!d || d.ok === false) log(s.id, '系统', '程序发牌失败：' + ((d && d.error) || '未知原因'), true);
  }
  return loadState(s.id);
}

/* 切换角色决定方式：program=程序机械随机发牌（默认），storyteller=交由说书人 Agent 决定 */
function setRoleMode(id, mode){
  const s = loadState(id);
  s.roleMode = (mode === 'storyteller') ? 'storyteller' : 'program';
  saveState(id, s);
  log(id, '系统', '角色决定方式切换为 ' + (s.roleMode === 'program' ? '由程序决定' : '由说书人决定'), true);
  return { ok:true, roleMode:s.roleMode };
}

/* 切换本局所有 AI 的说话风格（含说书人） */
function setStyle(id, style){
  const s = loadState(id);
  s.aiStyle = String(style || 'mild_fun');
  saveState(id, s);
  log(id, '系统', 'AI 说话风格切换为 '+s.aiStyle, true);
  return { ok:true, aiStyle:s.aiStyle };
}

/* 说书人完整日志：把 seat-storyteller 目录下所有 .jsonl 与 state.log 中说书人条目按时间合并，供作弊页实时查看 */
function storyLog(id){
  const rows = [];
  const dir = path.join(gameDir(id), 'agents', 'seat-storyteller');
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter(function(f){ return /\.jsonl$/.test(f); }).forEach(function(f){
      const p = path.join(dir, f);
      const kind = f.replace(/\.jsonl$/, '');
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(function(line){
        if (!line.trim()) return;
        try { const o = JSON.parse(line); rows.push({ t: o.t || '', kind: kind, text: o.text || '', data: o }); } catch(e) {}
      });
    });
  }
  try {
    const st = loadState(id);
    (st.log || []).forEach(function(x){ if (x.who === '说书人') rows.push({ t: x.t || '', kind: 'log', text: x.text || '', data: x }); });
  } catch(e) {}
  rows.sort(function(a,b){ return String(a.t).localeCompare(String(b.t)); });
  return rows;
}
/* ==================== 提名与投票（按规则实现） ==================== */
/* 每个白天：每名存活玩家各有 1 次提名权、1 次被提名权；死者有 1 张死亡票（复活则恢复不限票，再死再给 1 张）。
   一次提名流程：提名理由 → 被提名发言 → 投票（举手）→ 时钟轮转（经过即锁定）→ 结算 → 上处决台。 */
function nomNewDay(s){
  s.nom = { stage:'idle', queue:[], cur:null, usedNom:{}, usedTarget:{}, onBlock:null, results:[], day:s.day||0, busy:false, lastTick:0, asked:{} };
}
function nomEnsure(id){
  const s = loadState(id);
  if (!s.nom || s.nom.day !== (s.day||0)) { nomNewDay(s); saveState(id, s); }
  return s;
}
function nomState(id){
  const s = nomEnsure(id);
  return { ok:true, nom:s.nom, alive:s.alive, deadVoteUsed:s.deadVoteUsed||{}, seats:s.seats.map(function(x,i){ return {name:x.name, alive:!!s.alive[i]}; }) };
}
function nomCanNominate(s, seat){
  if (!s.alive[seat]) return false;
  return !(s.nom.usedNom[seat]);
}
function nomPropose(id, from, target, reason){
  const s = nomEnsure(id);
  if (!s.nom) nomNewDay(s);
  from = Number(from); target = Number(target);
  if (!(from >= 0 && from < s.seats.length)) return { ok:false, error:'提名者座位越界' };
  if (!(target >= 0 && target < s.seats.length)) return { ok:false, error:'被提名者座位越界' };
  if (!s.alive[from]) return { ok:false, error:'已死亡的玩家不能发起提名' };
  if (s.nom.usedNom[from]) return { ok:false, error:'你今天已经提名过了' };
  if (s.nom.usedTarget[target]) return { ok:false, error:'该玩家今天已经被提名过了' };
  if (s.nom.cur) return { ok:false, error:'当前还有一项提名没有处理完' };
  s.nom.usedNom[from] = true; s.nom.usedTarget[target] = true;
  s.nom.asked[from] = true;
  s.nom.queue.push({ from:from, target:target, reason:String(reason||''), t:new Date().toISOString() });
  saveState(id, s);
  say(id, 'storyteller', s.seats[from].name + ' 提名了 ' + s.seats[target].name + '。', 'town');
  log(id, '说书人', (from+1)+' 号 '+s.seats[from].name+' 提名 '+(target+1)+' 号 '+s.seats[target].name);
  return { ok:true, queue:s.nom.queue.length };
}
function nomNext(id){
  const s = nomEnsure(id);
  if (s.nom.cur) return { ok:true, cur:s.nom.cur };
  if (!s.nom.queue.length) return { ok:false, error:'没有待处理的提名' };
  const q = s.nom.queue.shift();
  const n = s.seats.length;
  const order = [];
  for (let k = 1; k <= n; k++) order.push((q.from + k) % n);
  s.nom.cur = { from:q.from, target:q.target, reason:String(q.reason||''), defense:'', hands:{}, order:order, ptr:-1, yes:[], no:[], passed:false, votes:0, startedAt:new Date().toISOString() };
  s.nom.stage = 'reason';
  saveState(id, s);
  log(id, '说书人', '处理提名：'+(q.from+1)+' 号 提名 '+(q.target+1)+' 号', true);
  return { ok:true, cur:s.nom.cur, stage:s.nom.stage };
}
function nomSpeech(id, kind, text){
  const s = nomEnsure(id);
  if (!s.nom.cur) return { ok:false, error:'当前没有提名' };
  const k = (kind === 'defense') ? 'defense' : 'reason';
  s.nom.cur[k] = String(text||'');
  if (k === 'reason') { s.nom.stage = 'defense'; }
  else { s.nom.stage = 'vote'; }
  saveState(id, s);
  return { ok:true, stage:s.nom.stage };
}
function nomHand(id, seat, yes){
  const s = nomEnsure(id);
  if (!s.nom.cur) return { ok:false, error:'当前没有提名' };
  if (s.nom.stage !== 'vote') return { ok:false, error:'现在不在投票阶段' };
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!s.alive[seat] && s.deadVoteUsed && s.deadVoteUsed[seat]) return { ok:false, error:'死者的投票标记已经用掉了' };
  s.nom.cur.hands[seat] = !!yes;
  saveState(id, s);
  return { ok:true, hands:s.nom.cur.hands };
}
function nomClockBegin(id){
  const s = nomEnsure(id);
  if (!s.nom.cur) return { ok:false, error:'当前没有提名' };
  s.nom.stage = 'clock'; s.nom.cur.ptr = -1; s.nom.lastTick = Date.now();
  saveState(id, s);
  return { ok:true, stage:'clock' };
}
function nomFinalizeSeat(s, seat){
  const cur = s.nom.cur;
  const want = !!cur.hands[seat];
  const alive = !!s.alive[seat];
  let counted = false;
  if (want) {
    if (alive) { counted = true; }
    else if (!(s.deadVoteUsed && s.deadVoteUsed[seat])) { counted = true; if (!s.deadVoteUsed) s.deadVoteUsed = {}; s.deadVoteUsed[seat] = true; }
  }
  if (counted) cur.yes.push(seat); else cur.no.push(seat);
  if (!cur.locked) cur.locked = [];
  cur.locked.push({ seat:seat, hand:want, counted:counted });
}
function nomTick(id){
  const s = nomEnsure(id);
  if (!s.nom.cur || s.nom.stage !== 'clock') return { ok:false, error:'不在时钟阶段' };
  const cur = s.nom.cur;
  if (cur.ptr >= 0) nomFinalizeSeat(s, cur.order[cur.ptr]);
  cur.ptr++;
  if (cur.ptr >= cur.order.length) {
    s.nom.stage = 'result';
    saveState(id, s);
    return nomResolve(id);
  }
  s.nom.lastTick = Date.now();
  saveState(id, s);
  return { ok:true, ptr:cur.ptr, seat:cur.order[cur.ptr], stage:'clock', yes:cur.yes.length };
}
function nomResolve(id){
  const s = nomEnsure(id);
  const cur = s.nom.cur;
  if (!cur) return { ok:false, error:'当前没有提名' };
  const aliveCount = s.seats.filter(function(x,i){ return s.alive[i]; }).length;
  const votes = cur.yes.length;
  const majority = (votes * 2 >= aliveCount);
  const prev = s.nom.onBlock ? s.nom.onBlock.votes : 0;
  let passed = false;
  if (votes > prev) {
    if (votes >= 1 && majority) { passed = true; s.nom.onBlock = { target:cur.target, votes:votes, day:s.day }; }
    else { s.nom.onBlock = null; }
  } else if (votes === prev && s.nom.onBlock) {
    s.nom.onBlock = null;
  }
  cur.votes = votes; cur.passed = passed; cur.aliveCount = aliveCount;
  s.nom.stage = 'result';
  s.nom.results.push({ from:cur.from, target:cur.target, votes:votes, aliveCount:aliveCount, passed:passed });
  saveState(id, s);
  const tname = (cur.target+1)+' 号 '+s.seats[cur.target].name;
  let txt = '投票结束：' + tname + ' 获得 ' + votes + ' 票（存活 ' + aliveCount + ' 人，需 ' + Math.ceil(aliveCount/2) + ' 票）。';
  txt += (s.nom.onBlock && s.nom.onBlock.target === cur.target) ? '当前在处决台上。' : '没有上处决台。';
  say(id, 'storyteller', txt, 'town');
  log(id, '说书人', txt, true);
  return { ok:true, stage:'result', votes:votes, passed:passed, onBlock:s.nom.onBlock };
}
/* 结束当前这一项提名：清空 cur；队列里还有就接着处理下一项 */
function nomClose(id){
  const s = nomEnsure(id);
  if (s.nom.cur) { s.nom.cur = null; s.nom.stage = 'idle'; saveState(id, s); }
  if (s.nom.queue.length) return nomNext(id);
  return { ok:true, cleared:true };
}
/* 提名阶段收尾：处决当天的最高票（在处决台上的人），没有就不处决 */
function nomFinish(id){
  const s = nomEnsure(id);
  s.nom.cur = null;
  s.nom.stage = 'done';
  const ob = s.nom.onBlock;
  s.nom.onBlock = null;
  saveState(id, s);
  if (ob) {
    const r = execute(id, ob.target);
    return { ok:true, executed:true, target:ob.target, win:(r && r.win) || null };
  }
  say(id, 'storyteller', '今天没有人被处决。', 'town');
  return { ok:true, executed:false };
}
function nomClearAsked(id){
  const s = nomEnsure(id);
  s.nom.asked = {};
  saveState(id, s);
  return { ok:true };
}
function nomSkip(id, seat){
  const s = nomEnsure(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  s.nom.asked[seat] = true;
  saveState(id, s);
  return { ok:true };
}
function nomSetStage(id, stage){
  const s = nomEnsure(id);
  s.nom.stage = String(stage || 'idle');
  saveState(id, s);
  return { ok:true, stage:s.nom.stage };
}
function nomSetBusy(id, busy){
  const s = nomEnsure(id);
  s.nom.busy = !!busy;
  saveState(id, s);
  return { ok:true };
}
function nomMarkAsked(id, seat){
  const s = nomEnsure(id);
  s.nom.asked[seat] = true;
  saveState(id, s);
  return { ok:true };
}
function nomReset(id){
  const s = nomEnsure(id);
  nomNewDay(s);
  saveState(id, s);
  return { ok:true };
}
module.exports = { createGame, createAndStart, setSeatModel, loadState, saveState, log, readAck, allAcked, start, setPhase, infoRevealable,
  assignRole, giveInfo, speak, think, say, messages, nominate, vote, execute, kill, toggleMarker, listGames,
  agentLog, gameDir, checkWin, endGame, roleFaction, openVote, castVote, resolveVote, storyLog, setStyle,
  dealRoles, scriptData, compositionFor, setRoleMode, adminSay,
  evilInfoFor, bluffRoles, dealEvilInfo,
  nomState, nomPropose, nomNext, nomSpeech, nomHand, nomClockBegin, nomTick, nomResolve, nomClose, nomReset, nomNewDay, nomSetBusy, nomMarkAsked, nomEnsure, nomFinish, nomSkip, nomSetStage, nomClearAsked };