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
    roles: {}, apparentRoles: {}, alignment: {}, alive: {}, markers: {}, info: {}, nominations: [], votes: {}, messages: [], nightDeaths: [],
    shields: {}, abilityUsed: {}, granted: {}, winBlocks: [], extra: {},
    nomCfg: Object.assign({ min: 20, softMax: 80, hardMax: 150, unanimous: true }, cfg.nomCfg || {}),
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
  /* 进入夜晚时，当天临时状态（不死、当天能力已用）作废；提名记录归档到 extra.dayLog */
  if (phase==='night'){
    s.shields = {};
    Object.keys(s.abilityUsed||{}).forEach(function(k){
      if (String(k).indexOf('day:') === 0) delete s.abilityUsed[k];
    });
  }
  const wasNight = (s.phase === 'night');
  const wasDay = (s.phase === 'day' || s.phase === 'nomination' || s.phase === 'vote');
  if (wasDay){ s.extra = s.extra || {}; s.extra.dayLog = s.extra.dayLog || []; s.extra.dayLog.push({ day:s.day, nominations:(s.nominations||[]).slice(), votes:s.votes||{} }); s.nominations = []; s.votes = {}; }
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
  /* 阶段推进后按当前局势检查一次胜负（含角色自定义钩子） */
  try { checkWin(id); } catch (e) {}
  return {ok:true,state:loadState(id)};
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
  const tt = String(text || '').trim();
  const dup = (s.info[seat] || []).some(function(x){
    if (String(x.text || '').trim() !== tt) return false;
    /* 角色告知永久幂等；其它信息只在同一夜/同一天/同阶段内去重（占卜师等每夜追问不会被吞） */
    if (/你的角色是/.test(tt)) return true;
    return Number(x.night||0) === Number(s.night||0) && Number(x.day||0) === Number(s.day||0) && x.phase === s.phase;
  });
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
/* 处决：带免死拦截、处决前置钩子、处决后钩子 */
function execute(id, seat, opts){
  opts = opts || {};
  const s = loadState(id);
  if (!(seat >= 0 && seat < s.seats.length)) return {ok:false, error:'座位越界'};
  if (!s.alive[seat]) return {ok:false, error:'该座位已经死亡'};
  /* 免死/拦截：s.shields[seat] 记录本日不死原因（茶艺师、和平主义者、弄臣、魔鬼代言人等） */
  const sh = s.shields && s.shields[seat];
  if (sh && !opts.force) {
    log(id, '系统', (seat+1)+' 号 '+s.seats[seat].name+' 免于处决（'+sh+'）', true);
    say(id, 'storyteller', '没有发生处决——有人挡下了这一票。', 'town');
    return {ok:true, blocked:true, reason:sh, win:{over:false}};
  }
  /* 处决前置钩子：圣徒处决→邪恶胜；替罪羊可能替死（由说书人通过 opts.substitute 指定） */
  const role = roleOfSeat(s, seat);
  let substitute = Number(opts.substitute);
  if (!(substitute >= 0 && substitute < s.seats.length) || !s.alive[substitute]) substitute = -1;
  const realSeat = substitute >= 0 ? substitute : seat;
  s.alive[realSeat]=false; s.markers[realSeat].push('死亡');
  if (role === '圣徒' && realSeat === seat) {
    s.winBlocks = s.winBlocks || [];
    s.win = { over:true, side:'evil', reason:'圣徒被处决', at:new Date().toISOString() };
    s.phase = 'ended'; s.winner = 'evil';
    saveState(id, s);
    log(id,'系统','对局结束：邪恶阵营胜利（圣徒被处决）');
    return {ok:true, win:s.win};
  }
  saveState(id,s); log(id,'系统',(realSeat+1)+' 号 '+s.seats[realSeat].name+' 被处决'+(substitute>=0?('（替 '+(seat+1)+' 号而死）'):''));
  if (!Array.isArray(s.nominations)) s.nominations = [];
  s.nominations.push({ kind:'execute', seat:realSeat, t:new Date().toISOString(), day:s.day });
  saveState(id,s);
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
/* 死亡（非处决）。opts.night=false 时不计入 nightDeaths（白天致死、猎手等） */
function kill(id, seat, reason, opts){
  opts = opts || {};
  const s = loadState(id);
  if (!(seat >= 0 && seat < s.seats.length)) return {ok:false, error:'座位越界'};
  if (!s.alive[seat]) return {ok:false, error:'该座位已经死亡'};
  const sh = s.shields && s.shields[seat];
  if (sh && !opts.force) {
    log(id, '系统', (seat+1)+' 号 '+s.seats[seat].name+' 免于死亡（'+sh+'）', true);
    return {ok:true, blocked:true, reason:sh, win:{over:false}};
  }
  s.alive[seat]=false; s.markers[seat].push('死亡');
  const isNight = opts.night !== false && (s.phase === 'night' || s.phase === 'dawn');
  if (isNight) {
    if (!Array.isArray(s.nightDeaths)) s.nightDeaths = [];
    if (s.nightDeaths.indexOf(seat) < 0) s.nightDeaths.push(seat);
  }
  saveState(id,s);
  log(id,'系统',(seat+1)+' 号 '+s.seats[seat].name+(isNight?' 在夜里死亡':' 死亡')+(reason?('（'+reason+'）'):''));
  /* 死亡时角色钩子：帽匠等 on_death 角色由说书人在提示词里处理，这里只记录 */
  try { onDeathHooks(id, seat); } catch (e) {}
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
  s.extra = s.extra || {};
  const seatRole = function(i){ return roleOfSeat(s, i); };
  const hasRole = function(name, aliveOnly){
    return (s.seats||[]).some(function(x,i){ return seatRole(i) === name && (!aliveOnly || s.alive[i]); });
  };
  const aliveSeats = [];
  (s.seats||[]).forEach(function(x,i){ if (s.alive[i]) aliveSeats.push(i); });
  /* 恶魔判定改为「按真身角色，含红唇女郎接替后的角色」 */
  let demonSeats = [];
  (s.seats||[]).forEach(function(x,i){ if (roleFaction(seatRole(i)) === 'demon') demonSeats.push(i); });
  if (!demonSeats.length) return { over:false };
  const demonAlive = demonSeats.filter(function(i){ return s.alive[i]; });
  /* 胜利结果可以被若干角色改写，最终统一通过 finish 落地 */
  const finish = function(side, reason){
    /* 异端分子：对调胜负（即使已死亡） */
    if (hasRole('异端分子', false)) {
      side = (side === 'good') ? 'evil' : 'good';
      reason = reason + '（异端分子对调）';
    }
    /* 胜者已定过就不再覆盖 */
    if (s.win && s.win.over) return s.win;
    const win = { over:true, side:side, reason:reason, at:new Date().toISOString() };
    s.phase = 'ended'; s.win = win; s.winner = side;
    saveState(id, s);
    log(id, '系统', '对局结束：' + (side==='good'?'善良阵营胜利':'邪恶阵营胜利') + '（' + reason + '）');
    return win;
  };
  /* 镇长：只有三名玩家存活且白天没有人被处决 → 善良胜 */
  const execToday = (s.nominations||[]).some(function(x){ return x && x.kind === 'execute' && Number(x.day||0) === Number(s.day||0); });
  if (hasRole('镇长', true) && aliveSeats.length === 3 && !execToday) {
    return finish('good', '镇长在场且仅剩三人、今天没有人被处决');
  }
  /* 利维坦：多于一名善良玩家被处决 → 邪恶胜 */
  if (hasRole('利维坦', true)) {
    const goodExec = Number((s.extra && s.extra.goodExecuted) || 0);
    if (goodExec >= 2) return finish('evil', '利维坦在场且已有 ' + goodExec + ' 名善良玩家被处决');
  }
  /* 恶魔全灭 */
  if (!demonAlive.length) {
    /* 红唇女郎接替：存活≥5 且红唇女郎存活时，她变成恶魔 */
    const redv = (s.seats||[]).map(function(x,i){ return i; }).filter(function(i){ return s.alive[i] && seatRole(i) === '红唇女郎'; });
    if (redv.length && aliveSeats.length >= 5) {
      s.roles[redv[0]] = '小恶魔';
      saveState(id, s);
      log(id, '系统', '红唇女郎接替成为新的恶魔', true);
      return { over:false, note:'红唇女郎接替恶魔' };
    }
    /* 主谋：恶魔死于处决 → 额外一个夜晚和一个白天 */
    if (hasRole('主谋', true) && !s.extra.mastermindExtra) {
      s.extra.mastermindExtra = true;
      saveState(id, s);
      log(id, '系统', '主谋在场：恶魔死于处决，游戏额外进行一个夜晚和一个白天', true);
      return { over:false, note:'主谋延长' };
    }
    return finish('good', '恶魔已出局');
  }
  /* 存活人数不足 */
  if (aliveSeats.length <= 2) {
    return finish('evil', '场上仅剩 ' + aliveSeats.length + ' 人且恶魔仍在');
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
/* ---------- 带 [] 的角色：能力括号里的配比/座位约束 ----------
   支持四类写法（其余写法一律只记录不强制）：
   ① 范围数量：[+0~2 村夫] [−0~1 外来者] [任意数量外来者]
   ② 指定角色：[+国王] [+落难少女]（该角色必须进场）
   ③ 座位约束：[邪恶角色全部邻座] [提线木偶会与恶魔邻座]
   ④ 在场条件：[无恶魔在场] [无邪恶角色在场] [多数玩家为军团]（正常开局不抽这些角色） */
function bracketSpec(ability){
  const ab = String(ability || "");
  const out = { plusOutsider:0, minusOutsider:0, anyOutsider:false, plusMinion:0, extraRoles:[], rangeRoles:[], evilAdjacent:false, puppetAdjacent:false, noDemon:false, noEvil:false, legion:false };
  const tags = [];
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(ab))) tags.push(m[1].trim());
  tags.forEach(function (t) {
    if (/无恶魔在场/.test(t)) out.noDemon = true;
    if (/无邪恶角色在场/.test(t)) out.noEvil = true;
    if (/多数玩家为军团/.test(t)) out.legion = true;
    if (/邪恶角色全部邻座/.test(t)) out.evilAdjacent = true;
    if (/提线木偶会与恶魔邻座/.test(t)) out.puppetAdjacent = true;
    if (/外来者数量任意|任意数量外来者/.test(t)) out.anyOutsider = true;
    let mm = t.match(/\+\s*(\d+)\s*~\s*(\d+)\s*([^\s,，]+)/);
    if (mm) { out.rangeRoles.push({ name:mm[3], min:Number(mm[1]), max:Number(mm[2]) }); return; }
    mm = t.match(/[+＋]\s*(\d+)\s*爪牙/);
    if (mm) { out.plusMinion += Number(mm[1]); return; }
    mm = t.match(/[+＋]\s*(\d+)\s*外来者/);
    if (mm) { out.plusOutsider += Number(mm[1]); return; }
    mm = t.match(/[-−]\s*(\d+)\s*外来者/);
    if (mm) { out.minusOutsider += Number(mm[1]); return; }
    mm = t.match(/^[+＋]\s*([^\d\s,，]+)$/);
    if (mm) { out.extraRoles.push(mm[1]); return; }
  });
  return out;
}
/* 每个剧本里可作为「额外指定角色」的角色名集合 */
function scriptRoleNames(sc){
  const g = (sc && sc.groups) || {};
  const all = [];
  Object.keys(g).forEach(function (k) { (g[k] || []).forEach(function (x) { all.push(x); }); });
  return all;
}
/* 程序发牌：返回 { ok, roles, roster, notes }；roster 是给说书人看的「几号是谁」清单 */
function dealRoles(id){
  const s = loadState(id);
  const sc = scriptData(s.script);
  if (!sc) return { ok:false, error:'找不到剧本：' + s.script };
  const g = sc.groups || {};
  const n = (s.seats || []).length;
  if (!n) return { ok:false, error:'没有座位' };
  const comp = compositionFor(n);          /* [镇民, 外来者, 爪牙, 恶魔] */
  const notes = [];
  /* 正常开局不能抽的「特殊开局」角色：先踢出牌池，再记一条备注 */
  function usable(listName, name){
    const info = roleInfoByName(name);
    const sp = bracketSpec(info && info.ability);
    if (sp.noDemon || sp.noEvil) { notes.push(name + ' 需要特殊开局（' + (sp.noDemon ? '无恶魔在场' : '无邪恶角色在场') + '），本次不抽'); return false; }
    if (sp.legion) { notes.push(name + ' 需要多数玩家为军团，本次不抽'); return false; }
    return true;
  }
  const pool = {};
  ['镇民', '外来者', '爪牙', '恶魔'].forEach(function (k) {
    pool[k] = (g[k] || []).filter(function (x) { return usable(k, x); });
  });
  /* 先抽恶魔：恶魔括号里的 [+N 爪牙] 会影响下面抽几个爪牙 */
  const demons = shuffle(pool['恶魔']).slice(0, comp[3]);
  let bonusMinion = 0;
  const reqRoles = [];            /* 必须进场的指定角色（[+国王] 等） */
  const rangeExtra = [];          /* 范围写法带来的可选额外角色 */
  const allNames = scriptRoleNames(sc);
  let evilAdjacent = false, puppetAdjacent = false;
  demons.forEach(function (name) {
    const info = roleInfoByName(name);
    const sp = bracketSpec(info && info.ability);
    bonusMinion += sp.plusMinion;
    if (sp.evilAdjacent) evilAdjacent = true;
    sp.extraRoles.forEach(function (x) { if (allNames.indexOf(x) >= 0) reqRoles.push(x); else notes.push('无法识别的额外角色 [' + x + ']（剧本里没有），已忽略'); });
    sp.rangeRoles.forEach(function (x) { if (allNames.indexOf(x) >= 0) rangeExtra.push(x); });
  });
  /* 再抽爪牙：数量 = 基础配比 + 恶魔/爪牙自身带来的额外爪牙 */
  const minions = shuffle(pool['爪牙']).slice(0, comp[2] + bonusMinion);
  /* 带 [..] 的角色对配比做机械修正（外来者增减 / 指定角色 / 范围写法） */
  let bonusOutsider = 0, anyOutsider = false;
  minions.concat(demons).forEach(function (name) {
    const info = roleInfoByName(name);
    const sp = bracketSpec(info && info.ability);
    bonusOutsider += sp.plusOutsider - sp.minusOutsider;
    if (sp.anyOutsider) anyOutsider = true;
    if (sp.puppetAdjacent) puppetAdjacent = true;
    sp.extraRoles.forEach(function (x) { if (allNames.indexOf(x) >= 0) reqRoles.push(x); else notes.push('无法识别的额外角色 [' + x + ']（剧本里没有），已忽略'); });
    sp.rangeRoles.forEach(function (x) { if (allNames.indexOf(x) >= 0) rangeExtra.push(x); });
  });
  let [nt, no, nm, nd] = comp;
  no = Math.max(0, no + bonusOutsider);
  /* 指定角色必须先排进各自阵营，占用对应名额 */
  const reqTown = [], reqOut = [];
  reqRoles.forEach(function (x) {
    if (reqTown.indexOf(x) >= 0 || reqOut.indexOf(x) >= 0) return;
    if (minions.indexOf(x) >= 0 || demons.indexOf(x) >= 0) return;
    const f = roleFaction(x);
    if (f === 'outsider') reqOut.push(x); else reqTown.push(x);
  });
  if (reqTown.length + reqOut.length) notes.push('指定角色必须进场：' + reqTown.concat(reqOut).join('、'));
  /* 范围写法：随机取 0~max 个 */
  const rangeTown = [];
  rangeExtra.forEach(function (x) {
    const k = Math.floor(Math.random() * 3);   /* 0~2 */
    for (let i = 0; i < k; i++) rangeTown.push(x);
    if (k) notes.push('范围角色 ' + x + ' 本次取 ' + k + ' 个');
  });
  no = Math.max(0, no - reqOut.length);
  nt = Math.max(0, n - no - minions.length - demons.length - reqTown.length - rangeTown.length);
  const towns = shuffle(pool['镇民'].filter(function (x) { return reqTown.indexOf(x) < 0 && rangeTown.indexOf(x) < 0; })).slice(0, nt);
  const outs = shuffle(pool['外来者'].filter(function (x) { return reqOut.indexOf(x) < 0; })).slice(0, no);
  let good = towns.concat(reqTown, rangeTown, outs, reqOut);
  const evil = shuffle(minions.concat(demons));
  /* 人数对不上时（剧本角色太少）用现有角色补足 / 截断 */
  while (good.length + evil.length < n && good.length > 0) good.push(good[Math.floor(Math.random() * good.length)]);
  good = shuffle(good);
  /* ---------- 座位编排：处理「邻座」类约束 ---------- */
  const picked = new Array(n).fill(null);
  const evilN = evil.length;
  if (evilAdjacent && evilN > 0 && evilN < n) {
    /* 邪恶角色全部邻座：随机选一段连续的座位段放邪恶方 */
    const start = Math.floor(Math.random() * n);
    for (let k = 0; k < evilN; k++) picked[(start + k) % n] = evil[k];
    notes.push('邪恶角色全部邻座：已排在第 ' + (start + 1) + ' 号起的连续座位');
  } else if (puppetAdjacent && evilN > 1) {
    /* 提线木偶必须与恶魔邻座 */
    const demonSeat = Math.floor(Math.random() * n);
    picked[demonSeat] = evil[0];
    let puppetSeat = (demonSeat + 1) % n;
    let kOther = 1;
    for (let i = 0; i < n && kOther < evilN; i++) { if (picked[i]) continue; if (i === puppetSeat) continue; picked[i] = evil[kOther++]; }
    picked[puppetSeat] = evil[evilN - 1];
    notes.push('提线木偶已排在恶魔邻座（' + (puppetSeat + 1) + ' 号）');
  } else {
    /* 普通局：邪恶方随机分散，保证恶魔与爪牙不扎堆也完全随机 */
    const idx = shuffle(Array.from({ length:n }, function (_, i) { return i; }));
    for (let i = 0; i < evilN; i++) picked[idx[i]] = evil[i];
  }
  let gi = 0;
  for (let i = 0; i < n; i++) { if (!picked[i]) picked[i] = good[gi++] || (good[0] || '镇民'); }
  s.roles = {};
  s.seats.forEach(function (x, i) { s.roles[i] = picked[i]; });
  saveState(id, s);
  log(id, '系统', '程序发牌：' + picked.join('、') + (notes.length ? '（' + notes.join('；') + '）' : ''), true);
  /* 一次把「你的角色是【X】」发给每个人（giveInfo 自带去重，不会重复发） */
  s.seats.forEach(function (x, i) { giveInfo(id, i, '你的角色是【' + picked[i] + '】。'); });
  /* 首夜机械下发爪牙信息 / 恶魔信息（含 3 个伪装身份）*/
  dealEvilInfo(id);
  const roster = s.seats.map(function (x, i) { return (i+1) + ' 号 ' + x.name + '：' + picked[i]; });
  return { ok:true, roles: picked, roster: roster, notes: notes };
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
/* ---------- 投票相关的角色能力（机械层） ----------
   • 管家：只能跟主人一起投票（主人没举手，管家的票不算）
   • 官员：一票算三票；窃贼：一票算负数；讷帽：算两票；报丧女妖：每次可投两票
   • 军团：一项提名如果只有邪恶玩家投票，投票无效
   • 狂信者（狂热者）：存活≥5 时必须投票
   • 街头风琴手：投票闭眼、票数秘密统计（不公布票数与是否上处决台） */
function roleOfSeat(s, seat){ return (s.roles && s.roles[seat]) || null; }
function abilityOfSeat(s, seat){
  const r = roleOfSeat(s, seat);
  if (!r) return "";
  const info = roleInfoByName(r);
  return (info && info.ability) || "";
}
/* 管家选定的主人：从标记里读「主人:N」或「主人=N」（N 从 1 开始） */
function butlerMaster(s, seat){
  const ms = (s.markers && s.markers[seat]) || [];
  for (let i = 0; i < ms.length; i++) {
    const m = String(ms[i]).match(/主人\s*[:：=]\s*(\d+)/);
    if (m) { const v = Number(m[1]) - 1; if (v >= 0 && v < s.seats.length) return v; }
  }
  return -1;
}
/* 这位玩家的一票算几张 */
function voteWeight(s, seat){
  const ab = abilityOfSeat(s, seat);
  if (/投票算作三票/.test(ab)) return 3;
  if (/投票算作两票/.test(ab)) return 2;
  if (/每次投票时可以投两票/.test(ab)) return 2;
  if (/投票会被算作负数/.test(ab)) return -1;
  const ms = (s.markers && s.markers[seat]) || [];
  if (ms.some(function(x){ return /讷帽/.test(String(x)); })) return 2;
  return 1;
}
function isEvilSeat(s, seat){
  const ov = s.alignment && s.alignment[seat];
  if (ov === 'evil') return true;
  if (ov === 'good') return false;
  const f = roleFaction(roleOfSeat(s, seat));
  return f === "minion" || f === "demon";
}
/* 座位的真实阵营（good/evil），带覆盖层：莽夫、食人魔、灵言师等可改变阵营 */
function alignOf(s, seat){
  const ov = s.alignment && s.alignment[seat];
  if (ov === 'evil' || ov === 'good') return ov;
  return isEvilSeat(s, seat) ? 'evil' : 'good';
}
/* 座位的「自称/表面角色」：酒鬼、疯子、提线木偶等看到的是假身份 */
function apparentOf(s, seat){
  const a = s.apparentRoles && s.apparentRoles[seat];
  return a || roleOfSeat(s, seat);
}
/* 说书人视角看到的角色（真身） */
function trueRoleOf(s, seat){ return roleOfSeat(s, seat); }
/* 街头风琴手在场且清醒时，本局所有投票都秘密统计 */
function secretBallot(s){
  return (s.seats || []).some(function(x, i){
    if (!s.alive[i]) return false;
    const r = roleOfSeat(s, i);
    if (r !== "街头风琴手") return false;
    const ms = (s.markers && s.markers[i]) || [];
    return !ms.some(function(m){ return /中毒|醉酒/.test(String(m)); });
  });
}
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
  const w = {};
  (s.seats || []).forEach(function (x, i) {
    if (!s.alive[i]) return;
    try { w[i] = voteWeight(s, i); } catch (e) { w[i] = 1; }
  });
  let secret = false;
  try { secret = secretBallot(s); } catch (e) { secret = false; }
  const butler = {};
  (s.seats || []).forEach(function (x, i) {
    try {
      if (roleOfSeat(s, i) === '管家') {
        const m = butlerMaster(s, i);
        if (m >= 0) butler[i] = m;
      }
    } catch (e) {}
  });
  return { ok:true, nom:s.nom, alive:s.alive, deadVoteUsed:s.deadVoteUsed||{}, secret:secret, weights:w, butler:butler,
    seats:s.seats.map(function(x,i){ return {name:x.name, alive:!!s.alive[i]}; }) };
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
  /* 管家：主人没举手时不能投票 */
  if (s.alive[seat] && roleOfSeat(s, seat) === '管家' && yes) {
    const master = butlerMaster(s, seat);
    if (master >= 0 && !s.nom.cur.hands[master]) return { ok:false, error:'管家只能在主人投票时投票（主人还没举手）' };
  }
  /* 狂信者：存活≥5 时必须在所有提名中投票 */
  if (!yes && s.alive[seat] && /大于等于五名玩家存活/.test(abilityOfSeat(s, seat))) {
    const aliveN = s.seats.filter(function(x, i){ return s.alive[i]; }).length;
    if (aliveN >= 5) return { ok:false, error:'狂信者在存活≥5 时必须在所有提名中投票' };
  }
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
  /* 管家：主人没举手时，管家的举手不生效 */
  let blocked = "";
  if (want && alive && roleOfSeat(s, seat) === '管家') {
    const master = butlerMaster(s, seat);
    if (master >= 0 && !cur.hands[master]) blocked = '管家（主人未投票）';
  }
  const countedWant = want && !blocked;
  let counted = false, weight = 1;
  if (countedWant) {
    if (alive) { counted = true; weight = voteWeight(s, seat); }
    else if (!(s.deadVoteUsed && s.deadVoteUsed[seat])) { counted = true; weight = voteWeight(s, seat); if (!s.deadVoteUsed) s.deadVoteUsed = {}; s.deadVoteUsed[seat] = true; }
  }
  if (counted) cur.yes.push(seat); else cur.no.push(seat);
  if (!cur.weights) cur.weights = {};
  cur.weights[seat] = counted ? weight : 0;
  if (!cur.locked) cur.locked = [];
  cur.locked.push({ seat:seat, hand:want, counted:counted, weight:counted ? weight : 0, blocked:blocked });
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
  let votes = 0;
  cur.yes.forEach(function (seat) { votes += (cur.weights && cur.weights[seat] != null) ? cur.weights[seat] : 1; });
  /* 军团：一项提名如果只有邪恶玩家投票，投票无效 */
  const legionIn = (s.seats||[]).some(function(x,i){ return s.alive[i] && roleOfSeat(s,i) === '军团'; });
  let invalid = "";
  if (legionIn && cur.yes.length && cur.yes.every(function (seat) { return isEvilSeat(s, seat); })) invalid = '只有邪恶玩家投票，投票无效';
  if (invalid) votes = 0;
  const majority = (votes * 2 >= aliveCount);
  const prev = s.nom.onBlock ? s.nom.onBlock.votes : 0;
  let passed = false;
  if (votes > prev) {
    if (votes >= 1 && majority) { passed = true; s.nom.onBlock = { target:cur.target, votes:votes, day:s.day }; }
    else { s.nom.onBlock = null; }
  } else if (votes === prev && s.nom.onBlock) {
    s.nom.onBlock = null;
  }
  const secret = secretBallot(s);
  cur.votes = votes; cur.passed = passed; cur.aliveCount = aliveCount; cur.secret = secret; cur.invalid = invalid;
  s.nom.stage = 'result';
  s.nom.results.push({ from:cur.from, target:cur.target, votes:votes, aliveCount:aliveCount, passed:passed, secret:secret });
  saveState(id, s);
  const tname = (cur.target+1)+' 号 '+s.seats[cur.target].name;
  if (secret) {
    /* 街头风琴手：闭眼秘密计票，不公布票数与是否上处决台 */
    say(id, 'storyteller', '投票结束。票数已秘密统计。', 'town');
    log(id, '说书人', '秘密计票：' + tname + ' 获得 ' + votes + ' 票（不公开）', true);
  } else {
    let txt = '投票结束：' + tname + ' 获得 ' + votes + ' 票（存活 ' + aliveCount + ' 人，需 ' + Math.ceil(aliveCount/2) + ' 票）。';
    if (invalid) txt += invalid + '。';
    txt += (s.nom.onBlock && s.nom.onBlock.target === cur.target) ? '当前在处决台上。' : '没有上处决台。';
    say(id, 'storyteller', txt, 'town');
    log(id, '说书人', txt, true);
  }
  return { ok:true, stage:'result', votes:votes, passed:passed, secret:secret, onBlock:s.nom.onBlock };
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
  say(id, 'storyteller', secretBallot(s) ? '今天没有人被处决。' : '今天没有人被处决。', 'town');
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
/* ================= 角色底座（供说书人 ops 调用） ================= */
/* 复活：撤销死亡标记，恢复存活；摆渡人/教授/集骨者等使用 */
function revive(id, seat, opts){
  opts = opts || {};
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  s.alive[seat] = true;
  s.markers[seat] = (s.markers[seat] || []).filter(function(x){ return String(x) !== '死亡'; });
  if (Array.isArray(s.nightDeaths)) s.nightDeaths = s.nightDeaths.filter(function(x){ return x !== seat; });
  if (s.deadVoteUsed) delete s.deadVoteUsed[seat];
  saveState(id, s);
  log(id, '系统', (seat+1)+' 号 '+s.seats[seat].name+' 复活'+(opts.reason?('（'+opts.reason+'）'):''));
  return { ok:true };
}
/* 强制改角色（理发师/麻脸巫婆/方古/小怪宝/巡山人/工程师/帽匠/学徒/哲学家/舞蛇人/食人魔…）
   opts.keepApparent=true 时只改真身、不改表面身份；opts.silent=true 不私聊告知 */
function forceRole(id, seat, role, opts){
  opts = opts || {};
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!role) return { ok:false, error:'缺少角色名' };
  s.roles[seat] = String(role);
  if (!opts.keepApparent) {
    if (s.apparentRoles) delete s.apparentRoles[seat];
  }
  saveState(id, s);
  log(id, '说书人', (seat+1)+' 号 '+s.seats[seat].name+' 的角色变为：'+role, true);
  if (!opts.silent && s.alive[seat]) {
    giveInfo(id, seat, '你的角色变成了【'+role+'】。');
  }
  return { ok:true, role:String(role) };
}
/* 假身份（酒鬼/疯子/提线木偶/遗忘之门）：真身 roles，看到的是 apparentRoles */
function setApparent(id, seat, role, opts){
  opts = opts || {};
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!s.apparentRoles) s.apparentRoles = {};
  s.apparentRoles[seat] = String(role);
  saveState(id, s);
  if (!opts.silent) giveInfo(id, seat, '你的角色是【'+role+'】。');
  return { ok:true };
}
/* 阵营覆盖：莽夫/食人魔/灵言师等 */
function setAlignment(id, seat, val){
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!s.alignment) s.alignment = {};
  s.alignment[seat] = (val === 'evil') ? 'evil' : 'good';
  saveState(id, s);
  log(id, '说书人', (seat+1)+' 号 '+s.seats[seat].name+' 的阵营变为：'+(val==='evil'?'邪恶':'善良'), true);
  if (s.alive[seat]) giveInfo(id, seat, '你的阵营变成了'+(val==='evil'?'邪恶':'善良')+'。');
  return { ok:true };
}
/* 免死护盾：茶艺师/和平主义者/弄臣/魔鬼代言人/腹语师/替罪羊/维齐尔
   until: 'day'（当天有效，入夜清空）| 'game'（永久）| 'next'（一次性，拦截后移除） */
function setShield(id, seat, reason, until){
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!s.shields) s.shields = {};
  s.shields[seat] = String(reason || '免死');
  saveState(id, s);
  log(id, '说书人', (seat+1)+' 号 '+s.seats[seat].name+' 获得免死：'+reason, true);
  return { ok:true };
}
function clearShield(id, seat){
  const s = loadState(id);
  if (s.shields) delete s.shields[Number(seat)];
  saveState(id, s);
  return { ok:true };
}
/* 能力已用记录（每局一次 / 每天一次） */
function markUsed(id, seat, key){
  const s = loadState(id);
  s.abilityUsed = s.abilityUsed || {};
  s.abilityUsed[String(seat)+'|'+String(key)] = true;
  saveState(id, s);
  return { ok:true };
}
function isUsed(id, seat, key){
  const s = loadState(id);
  return !!(s.abilityUsed && s.abilityUsed[String(seat)+'|'+String(key)]);
}
/* 座位交换（女舍监/舞蛇人） */
function swapSeats(id, a, b){
  const s = loadState(id);
  a = Number(a); b = Number(b);
  if (!(a >= 0 && a < s.seats.length) || !(b >= 0 && b < s.seats.length)) return { ok:false, error:'座位越界' };
  const t = s.seats[a]; s.seats[a] = s.seats[b]; s.seats[b] = t;
  const mv = function(map){
    if (!map) return;
    const x = map[a]; map[a] = map[b]; map[b] = x;
    if (x === undefined) delete map[a];
  };
  ['roles','apparentRoles','alignment','alive','markers','info','shields','abilityUsed'].forEach(function(k){ mv(s[k]); });
  saveState(id, s);
  log(id, '系统', (a+1)+' 号 与 '+(b+1)+' 号 交换了座位', true);
  return { ok:true };
}
/* 带作用域的标记：scope='day'（当天有效，入夜清空）|'night'|'game'；默认 game */
function setMarker(id, seat, marker, scope){
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!s.markers[seat]) s.markers[seat] = [];
  if (marker && s.markers[seat].indexOf(marker) < 0) s.markers[seat].push(marker);
  s.extra = s.extra || {};
  s.extra.markerScope = s.extra.markerScope || {};
  s.extra.markerScope[seat+'|'+marker] = scope === 'day' ? ('day:'+s.day) : (scope === 'night' ? ('night:'+s.night) : 'game');
  saveState(id, s);
  return { ok:true, markers:s.markers[seat] };
}
function clearMarker(id, seat, marker){
  const s = loadState(id);
  seat = Number(seat);
  if (s.markers[seat]) s.markers[seat] = s.markers[seat].filter(function(x){ return String(x) !== String(marker); });
  if (s.extra && s.extra.markerScope) delete s.extra.markerScope[seat+'|'+marker];
  saveState(id, s);
  return { ok:true };
}
/* 授予能力（瘟疫医生/科学怪人/哲学家/学徒/炼金术士）：写进 granted，说书人与前端据此提示 */
function grantAbility(id, seat, role, opts){
  opts = opts || {};
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  s.granted = s.granted || {};
  s.granted[seat] = String(role || '');
  saveState(id, s);
  log(id, '说书人', (seat+1)+' 号 获得能力：'+role, true);
  if (!opts.silent && s.alive[seat]) giveInfo(id, seat, '你获得了【'+role+'】的能力。');
  return { ok:true };
}
/* 死亡钩子：读到 roles.json 的 on_death，交给后续提示词与机械效果 */
function onDeathHooks(id, seat){
  const s = loadState(id);
  const role = roleOfSeat(s, seat);
  s.extra = s.extra || {};
  s.extra.deathLog = s.extra.deathLog || [];
  s.extra.deathLog.push({ seat:seat, role:role, day:s.day, night:s.night, phase:s.phase });
  saveState(id, s);
  /* 罂粟种植者：爪牙与恶魔当场互认 */
  if (role === '罂粟种植者') { try { dealEvilInfo(id); } catch (e) {} }
  /* 瘟疫医生：说书人获得一个爪牙能力（记录，供提示词提醒） */
  if (role === '瘟疫医生') { log(id, '系统', '瘟疫医生死亡：说书人获得一个爪牙能力', true); }
  /* 帽匠：当晚爪牙与恶魔可换角色，由说书人在提示词中处理 */
  if (role === '帽匠') { log(id, '系统', '帽匠死亡：今晚爪牙与恶魔可以更换角色', true); }
  return { ok:true };
}
/* 流放（旅行者/异教领袖/歌伶式）：不消耗提名权、不算处决 */
function exile(id, seat){
  const s = loadState(id);
  seat = Number(seat);
  if (!(seat >= 0 && seat < s.seats.length)) return { ok:false, error:'座位越界' };
  if (!s.alive[seat]) return { ok:false, error:'该座位已经死亡' };
  s.alive[seat] = false;
  s.markers[seat].push('流放');
  saveState(id, s);
  log(id, '系统', (seat+1)+' 号 '+s.seats[seat].name+' 被流放');
  say(id, 'storyteller', (seat+1)+' 号 '+s.seats[seat].name+' 被流放。', 'town');
  const w = checkWin(id);
  return { ok:true, win:w };
}
/* 新增座位（旅行者进场） */
function addSeat(id, name, type, role){
  const s = loadState(id);
  if (!name) return { ok:false, error:'缺少昵称' };
  const seat = s.seats.length;
  s.seats.push({ name:String(name), type:(type === 'agent' ? 'agent' : 'human') });
  s.alive[seat] = true; s.markers[seat] = []; s.info[seat] = s.info[seat] || [];
  if (type === 'agent') ensureDir(idOf(id, seat));
  if (role) s.roles[seat] = String(role);
  saveState(id, s);
  log(id, '系统', '新增座位：'+(seat+1)+' 号 '+name+(role?('（'+role+'）'):''));
  return { ok:true, seat:seat };
}
/* 重置某人今天的提名权（屠夫/报丧女妖/法官） */
function resetNomination(id, seat, which){
  const s = nomEnsure(id);
  if (!s.nom) nomNewDay(s);
  const k = (which === 'target') ? 'usedTarget' : 'usedNom';
  if (seat == null) s.nom[k] = {}; else delete s.nom[k][Number(seat)];
  saveState(id, s);
  return { ok:true };
}
/* 重置所有死者的投票标记（摆渡人） */
function resetDeadVotes(id){
  const s = loadState(id);
  s.deadVoteUsed = {};
  saveState(id, s);
  log(id, '系统', '所有死亡玩家重新获得投票标记', true);
  return { ok:true };
}
/* 说书人回包里的通用操作分发：逐条执行并汇总 */
function applyOps(id, ops){
  const out = { roleChanges:0, revives:0, kills:0, executes:0, shields:0, aligns:0, apparent:0, grants:0, swaps:0, markers:0, wins:0, exiles:0, extra:0 };
  if (!Array.isArray(ops)) return out;
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i] || {};
    try {
      switch (String(o.op || '').toLowerCase()) {
        case 'role': case 'rolechange': case 'setrole':
          if (forceRole(id, o.seat, o.role, { keepApparent:!!o.keepApparent, silent:!!o.silent }).ok) out.roleChanges++; break;
        case 'apparent': case 'fakerole':
          if (setApparent(id, o.seat, o.role, { silent:!!o.silent }).ok) out.apparent++; break;
        case 'align': case 'alignment':
          if (setAlignment(id, o.seat, o.value || o.align).ok) out.aligns++; break;
        case 'revive': case 'resurrect':
          if (revive(id, o.seat, { reason:o.reason }).ok) out.revives++; break;
        case 'kill':
          if (kill(id, o.seat, o.reason || '能力致死', { night:o.night !== false }).ok) out.kills++; break;
        case 'execute':
          if (execute(id, o.seat, { substitute:o.substitute, force:!!o.force }).ok) out.executes++; break;
        case 'shield':
          if (setShield(id, o.seat, o.reason || '免死', o.until).ok) out.shields++; break;
        case 'unshield':
          if (clearShield(id, o.seat).ok) out.shields++; break;
        case 'grant':
          if (grantAbility(id, o.seat, o.role || o.ability, { silent:!!o.silent }).ok) out.grants++; break;
        case 'swap': case 'swapseat':
          if (swapSeats(id, o.a, o.b).ok) out.swaps++; break;
        case 'marker': case 'setmarker':
          if (setMarker(id, o.seat, o.marker, o.scope).ok) out.markers++; break;
        case 'clearmarker':
          if (clearMarker(id, o.seat, o.marker).ok) out.markers++; break;
        case 'used':
          markUsed(id, o.seat, o.key || 'ability'); out.extra++; break;
        case 'resetnom':
          resetNomination(id, o.seat, o.which); out.extra++; break;
        case 'resetdeadvotes':
          resetDeadVotes(id); out.extra++; break;
        case 'exile':
          if (exile(id, o.seat).ok) out.exiles++; break;
        case 'addseat':
          if (addSeat(id, o.name, o.type, o.role).ok) out.extra++; break;
        case 'win': {
          const side = (o.side === 'evil') ? 'evil' : 'good';
          endGame(id, side, o.reason || '角色能力达成胜利条件');
          out.wins++; break;
        }
        default:
          log(id, '系统', '未识别的说书人操作：' + String(o.op || ''), true);
      }
    } catch (e) {
      log(id, '系统', '执行说书人操作失败（' + String(o.op || '') + '）：' + String(e && e.message || e), true);
    }
  }
  return out;
}
/* ---------- 提名时机：公共消息计数与进入提名的判定 ----------
   用户设定（m09758）：说书人根据局势自己判断要不要进入提名阶段；
   公共消息数 < min 不进入，min~softMax 之间由说书人裁量，softMax 之后应当进入，
   hardMax 到达必须进入（硬性）；若所有存活玩家都表示同意，可以提前进入。
   这三个数值与「全员同意可提前」都可在设置里改。 */
const NOM_CFG_DEFAULT = { min: 20, softMax: 80, hardMax: 150, unanimous: true };
const NOM_AGREE_RE = /(进入|开始|发起|进行|走|开).{0,6}提名|提名(阶段|吧|了|一下)|可以提名|同意提名|赶紧提名|该提名/;

function nomCfgOf(s){
  const c = Object.assign({}, NOM_CFG_DEFAULT, (s && s.nomCfg) || {});
  c.min = Math.max(0, Number(c.min) || 0);
  c.softMax = Math.max(c.min, Number(c.softMax) || 0);
  c.hardMax = Math.max(c.softMax, Number(c.hardMax) || 0);
  c.unanimous = c.unanimous !== false;
  return c;
}
/* 当天（dayStarted 之后）的公共消息条数：公聊频道，说书人的天亮播报也算 */
function dayPublicCount(id){
  const s = loadState(id);
  const since = s.dayStarted ? new Date(s.dayStarted).getTime() : 0;
  return (s.messages || []).filter(function(m){
    if (m.channel !== 'town') return false;
    if (!since) return true;
    const t = new Date(m.t).getTime();
    return !isFinite(t) ? true : t >= since;
  }).length;
}
/* 是否所有存活玩家今天都在公聊里表示过「可以进提名」 */
function allAgreeNominate(id){
  const s = loadState(id);
  const since = s.dayStarted ? new Date(s.dayStarted).getTime() : 0;
  const said = {};
  (s.messages || []).forEach(function(m){
    if (m.channel !== 'town') return;
    if (m.from === 'storyteller' || m.from === 'admin') return;
    if (since && new Date(m.t).getTime() < since) return;
    if (NOM_AGREE_RE.test(String(m.text || ''))) said[String(m.from)] = true;
  });
  const alive = [];
  (s.seats || []).forEach(function(x, i){ if (s.alive[i]) alive.push(i); });
  return alive.length > 0 && alive.every(function(i){ return said[String(i)] === true; });
}
/* 给说书人与前端共用的一道闸：stage = early/window/overdue/hard/unanimous */
function nomGate(id){
  const s = loadState(id);
  const cfg = nomCfgOf(s);
  const count = dayPublicCount(id);
  const allAgree = cfg.unanimous ? allAgreeNominate(id) : false;
  const aliveN = (s.seats || []).filter(function(x, i){ return s.alive[i]; }).length;
  let stage = 'early';
  if (count >= cfg.hardMax) stage = 'hard';
  else if (allAgree) stage = 'unanimous';
  else if (count >= cfg.softMax) stage = 'overdue';
  else if (count >= cfg.min) stage = 'window';
  return {
    ok: true, phase: s.phase, day: s.day || 0, count: count, alive: aliveN,
    cfg: cfg, allAgree: allAgree, stage: stage,
    mustEnter: (stage === 'hard' || stage === 'unanimous'),
    mayConsider: (stage === 'window' || stage === 'overdue' || stage === 'hard' || stage === 'unanimous')
  };
}
function setNomCfg(id, cfg){
  const s = loadState(id);
  s.nomCfg = nomCfgOf({ nomCfg: cfg });
  saveState(id, s);
  log(id, '系统', '提名时机参数：最少 ' + s.nomCfg.min + ' 条 / 建议 ' + s.nomCfg.softMax + ' 条 / 最多 ' + s.nomCfg.hardMax + ' 条公共消息' + (s.nomCfg.unanimous ? '（全员同意可提前）' : ''), true);
  return { ok: true, nomCfg: s.nomCfg };
}

module.exports = { createGame, createAndStart, setSeatModel, loadState, saveState, log, readAck, allAcked, start, setPhase, infoRevealable,
  assignRole, giveInfo, speak, think, say, messages, nominate, vote, execute, kill, toggleMarker, listGames,
  agentLog, gameDir, checkWin, endGame, roleFaction, openVote, castVote, resolveVote, storyLog, setStyle,
  dealRoles, scriptData, compositionFor, setRoleMode, adminSay,
  evilInfoFor, bluffRoles, dealEvilInfo,
  voteWeight, secretBallot, butlerMaster, abilityOfSeat, isEvilSeat,
  revive, forceRole, setApparent, setAlignment, setShield, clearShield, markUsed, isUsed, swapSeats, setMarker, clearMarker,
  grantAbility, onDeathHooks, exile, addSeat, resetNomination, resetDeadVotes, applyOps, alignOf, apparentOf, trueRoleOf,
  nomState, nomPropose, nomNext, nomSpeech, nomHand, nomClockBegin, nomTick, nomResolve, nomClose, nomReset, nomNewDay, nomSetBusy, nomMarkAsked, nomEnsure, nomFinish, nomSkip, nomSetStage, nomClearAsked,
  dayPublicCount, allAgreeNominate, nomGate, setNomCfg, nomCfgOf, NOM_CFG_DEFAULT };