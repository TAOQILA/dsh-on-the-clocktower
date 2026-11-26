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
/* 血染钟鱼 - 魔典前端：围坐圈、选座、Agent 管理、说书人面板（纯字符串拼接，无模板字面量） */
var VERSION = '0.8.8';
var $ = function(s){ return document.querySelector(s); };
var API = (function(){ var p = location.pathname; if (p.charAt(p.length-1) !== '/') p = p.replace(/[^/]*$/, ''); return p + 'api/'; })();
async function api(name, data){
  var r = await fetch(API+name, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
  var j = await r.json();
  if (!j.ok) throw new Error(j.error||'request failed');
  return j.data;
}
var S = { scripts:[], script:null, seats:[], game:null, history:null, me:{zone:'spectator',seat:0}, holdMe:false, storyProvider:'', storyModel:'', tab:'game', selSeat:0, chatChannel:'town', chatTo:[], chatLoading:false, models:null, starting:false, startError:'', view:null, story:null, wikiPage:null, wikiText:null, wikiNames:[], wikiCache:null, chatMsgs:[], chatSeen:0, namesPool:[], chatDraft:'', pendingRender:false, autoChat:true, autoStory:true, lastPhase:'' };
var PHASES = ['setup','night','day','nomination','vote','dawn','ended'];
var PHZH = {setup:'准备',night:'夜晚',day:'白天',nomination:'提名',vote:'投票',dawn:'日落',ended:'终局'};
var TABS = {setup:'建局',ai:'AI 设置',game:'游戏',story:'说书人',log:'日志',wiki:'知识库'};
/* 标签按两列三行排列：建局/AI 设置 → 游戏/说书人 → 日志/知识库 */
var TAB_ROWS = [['setup','ai','story'],['game','log','wiki']];

window.addEventListener('resize', function(){ if (typeof placeMe === 'function') placeMe(); });
async function init(){
  try { S.models = await api('models'); } catch(e){ S.models = {providers:[],error:String(e&&e.message||e)}; }
  try { var np = await api('names'); S.namesPool = Array.isArray(np) ? np : []; } catch(e2){ S.namesPool = []; }
  S.scripts = await api('scripts');
  if (!S.scripts.length){ $('#app').innerHTML='<p style="padding:30px">未找到剧本 JSON，请检查 data/scripts/</p>'; return; }
  S.script = S.scripts[0];
  S.seats = defaultSeats(7);
  loadPrefs();
  render();
}
function setTab(t){ S.tab=t; render(); if(t==='wiki') loadWiki(); if(t==='log'&&S.history===null) loadHistory(); }
/* 建局偏好落盘：刷新页面后座位名/模型、说书人模型、剧本都还在 */
var PREF_KEY = 'ran.prefs.v1';
function savePrefs(){
  try {
    /* 所有建局相关的选择都落盘：剧本、人数（= seats 长度）、每个座位的昵称与模型、
       说书人模型、「你」放在哪、自动讨论开关。这样无论刷新、关页面还是重启 DSH，
       回来都还是上一次的设置。 */
    localStorage.setItem(PREF_KEY, JSON.stringify({
      v: 2,
      script: S.script ? S.script.name : '',
      storyProvider: S.storyProvider || '',
      storyModel: S.storyModel || '',
      autoChat: S.autoChat !== false,
      autoStory: S.autoStory !== false,
      me: { zone: meZone(), seat: (S.me && S.me.seat) || 0 },
      seats: (S.seats || []).map(function(x){ return { name:x.name||'', type:x.type||'agent', provider:x.provider||'', model:x.model||'' }; })
    }));
  } catch(e){}
}
function loadPrefs(){
  try {
    var raw = localStorage.getItem(PREF_KEY);
    if (!raw) return false;
    var o = JSON.parse(raw);
    if (!o) return false;
    /* 剧本找不到（比如被删了）也不能拖累其它设置：只跳过剧本这一项 */
    if (o.script && S.scripts) {
      var hit = S.scripts.filter(function(x){ return x.name === o.script; })[0];
      if (hit) S.script = hit;
    }
    if (typeof o.autoChat === 'boolean') S.autoChat = o.autoChat;
    if (typeof o.autoStory === 'boolean') S.autoStory = o.autoStory;
    S.storyProvider = o.storyProvider || '';
    S.storyModel = o.storyModel || '';
    if (Array.isArray(o.seats) && o.seats.length >= 5 && o.seats.length <= 30) {
      S.seats = o.seats.map(function(x,i){
        return { seat:i, name:String(x.name||('玩家'+(i+1))), type:'agent', provider:x.provider||'', model:x.model||'' };
      });
    }
    /* 恢复「你」上次放在哪（说书人 / 某个座位 / 旁观席） */
    if (o.me && (o.me.zone === 'story' || o.me.zone === 'spectator' || o.me.zone === 'seat')) {
      var ms = Number(o.me.seat) || 0;
      if (o.me.zone === 'seat' && (!S.seats[ms])) ms = 0;
      S.me = { zone:o.me.zone, seat:(o.me.zone === 'seat' ? ms : 0) };
    }
    return true;
  } catch(e){ return false; }
}
/* 调整人数：只增删尾部座位，已有座位的名字与模型原样保留 */
function resizeSeats(n){
  n = Math.max(5, Math.min(30, n|0));
  var cur = S.seats || [], next = [];
  for (var i=0;i<n;i++){
    if (cur[i]) { next.push(cur[i]); continue; }
    var p = null, pairs = modelPairs();
    if (pairs.length) p = pairs[i % pairs.length];
    var nm = pickNicks(1)[0] || ('玩家'+(i+1));
    var used = {}; next.forEach(function(x){ used[x.name] = 1; });
    var base = nm, k = 2;
    while (used[nm]) { nm = base + ' ' + (k++); }
    next.push({seat:i, name:nm, type:'agent', provider:p?p.provider:'', model:p?p.model:''});
  }
  for (var j=0;j<next.length;j++) next[j].seat = j;
  S.seats = next;
  savePrefs();
  if (S.me.zone==='seat' && S.me.seat >= n) { S.me.zone = 'spectator'; S.me.seat = 0; }
  return next;
}
/* 随机昵称：从 data/names.json 的候选池里不放回抽取，抽完则追加序号 */
function nickPool(){
  var p = S.namesPool || [];
  return p.filter(function(x){ return String(x||'').trim(); }).map(function(x){ return String(x).trim(); });
}
function pickNicks(n){
  var pool = nickPool().slice(), out = [];
  if (!pool.length) { for (var q=0;q<n;q++) out.push('玩家'+(q+1)); return out; }
  for (var i=0;i<n;i++){
    if (!pool.length) { out.push(out[i-1]+'·2'); continue; }
    var k = Math.floor(Math.random()*pool.length);
    out.push(pool.splice(k,1)[0]);
  }
  var seen = {}, dup = 1;
  return out.map(function(nm){ if (seen[nm]) { dup++; return nm+' '+(dup); } seen[nm]=1; return nm; });
}
/* 随机全局昵称：开局前改内存，开局后逐座位写回对局 */
async function randomizeNames(){
  var arr = S.game ? S.game.seats : S.seats;
  if (!arr || !arr.length) return;
  var picks = pickNicks(arr.length);
  for (var i=0;i<arr.length;i++) arr[i].name = picks[i];
  if (!S.game) savePrefs();
  render();
  if (!S.game) return;
  for (var j=0;j<arr.length;j++){
    var cur = arr[j] || {};
    try { await api('seatModel',{id:S.game.id,seat:j,provider:cur.provider||'',model:cur.model||'',name:cur.name}); } catch(e){}
  }
  try { S.game = await api('game',gameReq()); } catch(e){}
  render();
}
function defaultSeats(n){
  var pairs = modelPairs(), a = [], used = {};
  for (var i=0;i<n;i++){
    var p = pairs.length ? pairs[i % pairs.length] : null;
    var provider = p ? p.provider : '', model = p ? p.model : '';
    var base = p ? prettyModelName(provider, model) : ('玩家'+(i+1));
    if (!base) base = '玩家'+(i+1);
    var nm = base, k = 2;
    while (used[nm]) { nm = base+' '+(k++); }
    used[nm] = 1;
    a.push({seat:i, name:nm, type:'agent', provider:provider, model:model});
  }
  return a;
}
function opt(v,label,cur){ return '<option value="'+v+'" '+(cur===v?'selected':'')+'>'+label+'</option>'; }
/* 模型目录：由宿主端注入（读 DSH 已配置的 provider/model 清单） */
/* 模型名里常带倍率后缀，如 "gpt-5.6-sol (0.6x)"，展示时去掉 */
function stripRate(s){ return String(s||'').replace(/\s*[\(（]\s*[0-9.]+\s*[xX×]\s*[\)）]\s*$/,'').trim(); }
function modelPairs(){
  var out = [], cat = S.models || {providers:[]};
  (cat.providers||[]).forEach(function(p){
    (p.models||[]).forEach(function(m){
      var nm = stripRate(m.name || '') || m.id;
      out.push({provider:p.id, model:m.id, name:nm, label:p.id+' / '+nm, key:p.id+'/'+m.id});
    });
  });
  return out;
}
function modelKeyOf(p, m){ return (p&&m)?(p+'/'+m):''; }
function cap1(s){ s = String(s||''); return s ? (s.charAt(0).toUpperCase()+s.slice(1)) : s; }
/* 模型正式名称：优先用目录里的内置名；没有就取 id 的末段、再取第一个“-”前的词，首字母大写 */
function prettyModelName(provider, model){
  var pairs = modelPairs();
  for (var i=0;i<pairs.length;i++){
    if (pairs[i].provider===provider && pairs[i].model===model){
      var nm = pairs[i].name;
      if (nm && nm !== pairs[i].model) return cap1(nm);
      break;
    }
  }
  var id = String(model||'');
  var tail = id.indexOf('/')>=0 ? id.split('/').pop() : id;
  var head = tail.split('-')[0].split('_')[0];
  return cap1(head || tail || id);
}
function modelSelect(id, provider, model, onchangeJs){
  var pairs = modelPairs(), cur = modelKeyOf(provider, model);
  var html = '<select id="'+id+'" '+(onchangeJs?('onchange="'+onchangeJs+'"'):'')+'>';
  var def = S.models && S.models.default ? (S.models.default.provider+'/'+S.models.default.model) : '';
  html += '<option value="" '+(cur?'':'selected')+'>跟随默认模型'+(def?('（'+def+'）'):'')+'</option>';
  pairs.forEach(function(p){
    html += '<option value="'+p.key+'" '+(cur===p.key?'selected':'')+'>'+p.label+'</option>';
  });
  html += '</select>';
  if (!pairs.length) html += ' <span class="muted">'+(S.models&&S.models.error?('模型清单读取失败：'+S.models.error):((S.models&&S.models.note)?S.models.note:'（未读到模型清单，请重启 DSH 后再打开）'))+'</span>';
  return html;
}
function splitKey(key){
  if(!key) return {provider:'',model:''};
  var i = key.indexOf('/');
  if(i<0) return {provider:'',model:''};
  return {provider:key.slice(0,i), model:key.slice(i+1)};
}

/* 整页重建前记住各滚动区域的位置，避免每 3 秒刷新把页面/聊天框弹回顶部 */
function capScroll(){
  var sc = document.scrollingElement || document.documentElement;
  var k = { win: sc ? sc.scrollTop : 0, right: 0, chat: null, chatBottom: true, chatCount: -1 };
  var rt = document.querySelector('.right'); if (rt) k.right = rt.scrollTop;
  var cl = document.getElementById('chatLog');
  if (cl){
    k.chat = cl.scrollTop;
    k.chatBottom = (cl.scrollHeight - cl.scrollTop - cl.clientHeight) < 28;
    k.chatCount = cl.getAttribute('data-count') !== null ? +cl.getAttribute('data-count') : -1;
  }
  return k;
}
function jumpChatBottom(){
  var cl = document.getElementById('chatLog'); if (cl) cl.scrollTop = cl.scrollHeight;
  S.chatSeen = (S.chatMsgs || []).length;
  var m = document.getElementById('chatMore'); if (m) m.style.display = 'none';
}
function restoreScroll(k){
  if (!k) return;
  var cl = document.getElementById('chatLog');
  if (cl){
    var cnt = (S.chatMsgs || []).length;
    if (k.chat === null || k.chatBottom){
      cl.scrollTop = cl.scrollHeight;
      S.chatSeen = cnt;
    } else {
      cl.scrollTop = k.chat;
      if (cnt > S.chatSeen){
        var m = document.getElementById('chatMore');
        if (m){ m.style.display = 'block'; m.textContent = '有 ' + (cnt - S.chatSeen) + ' 条新消息 ↓'; }
      }
    }
  }
  var rt = document.querySelector('.right'); if (rt) rt.scrollTop = k.right;
  var sc = document.scrollingElement || document.documentElement;
  if (sc) sc.scrollTop = k.win;
}
function render(force){
  /* 正在输入时不要重建整页，否则输入框会被销毁、光标丢失 */
  var ae = document.activeElement;
  if (!force && ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.tagName==='SELECT')){
    S.pendingRender = true; return;
  }
  S.pendingRender = false;
  var keep = capScroll();
  var g = S.game, seats = g?g.seats:S.seats;
  var cur = g?g.phase:'setup';
  document.body.classList.toggle('night', cur === 'night' || cur === 'dawn');
  var sel = seats[S.selSeat]||{};
  var roleNames = S.script?S.script.roles:[];
  var tabsHtml = '';
  TAB_ROWS.forEach(function(row){
    tabsHtml += '<div class="tabrow">';
    row.forEach(function(t){
      tabsHtml += '<button class="'+(S.tab===t?'active':'')+'" onclick="setTab(\''+t+'\')">'+TABS[t]+'</button>';
    });
    tabsHtml += '</div>';
  });
  var panel = '';
  var idCard = '';
  if (S.tab==='setup') panel = setupPanel();
  else if (S.tab==='ai') panel = aiPanel(seats,sel);
  else if (S.tab==='story') panel = storyPanel(seats,sel,roleNames,cur);
  else if (S.tab==='log') panel = logPanel(g);
  else if (S.tab==='wiki') panel = wikiPanel();
  else panel = gamePanel(seats,sel);
  var hdr = g?('对局 '+g.id):'未开局';
  var story = g?('第'+(g.night||0)+'夜 / 第'+(g.day||0)+'天'):'setup 阶段';
  $('#app').innerHTML =
    '<header><span class="logo">染</span><span class="header-title">血染钟鱼 · 魔典</span><span class="sub">'+hdr+'</span><span class="version">v'+VERSION+'</span></header>'+
    '<div class="layout"><div class="right">'+ winBanner(g) +'<div class="tabs">'+tabsHtml+'</div>'+ idCard + panel +'</div><div class="left">'+ stBox(g) + specBox() +'<div class="table" id="table">'+
    '<div class="center-badge"><div class="phase">'+(PHZH[cur]||cur)+'</div><div class="story">'+story+'</div></div>'+
    '</div></div><div class="chatcol">'+ chatPanel(g) +'</div></div>';
  drawTable(seats,g);
  fitBubbles();
  restoreScroll(keep);
}
/* 气泡字数太多时自动缩小字号来适应固定大小的气泡：
   从 11px 起逐级降到 7.5px；仍放不下就裁掉剩余内容并加省略号，保证永远不出框。 */
function fitBubbles(){
  var list = document.querySelectorAll('.bubble');
  if (!list || !list.length) return;
  for (var i = 0; i < list.length; i++){
    var el = list[i];
    el.classList.remove('clipped');
    var size = 11;
    el.style.fontSize = size + 'px';
    var guard = 0;
    while ((el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) && size > 7.5 && guard < 20){
      size -= 0.5;
      el.style.fontSize = size + 'px';
      guard++;
    }
    if (el.scrollHeight > el.clientHeight + 1) el.classList.add('clipped');
  }
}
/* 本局说书人是否由 Agent 担任 */
function iAmStorytellerAgent(g){
  var st = (g && g.storyteller) || null;
  if (!st) return false;
  return st.type !== 'player';
}
/* 每个座位最近的几条发言：贴在其头像正上方（私聊紫色，公聊普通色） */
function bubblesFor(seat){
  var msgs = (S.chatMsgs || []).filter(function(m){ return m.from === seat; });
  return msgs.slice(-2);
}
function drawTable(seats,g){
  var table = $('#table'), n = seats.length, cx=50, cy=50, rx=36, ry=36;
  seats.forEach(function(s,i){
    var a = -Math.PI/2 + 2*Math.PI*i/n;
    var x = cx+rx*Math.cos(a), y = cy+ry*Math.sin(a);
    var el = document.createElement('div');
    var dead = g && !g.alive[i];
    var mine = g ? (s.type==='human') : (meZone()==='seat' && S.me.seat===i);
    el.className = 'seat '+(mine?'human':'agent')+(dead?' dead':'')+(S.selSeat===i?' selected':'');
    el.style.left=x+'%'; el.style.top=y+'%';
    var role = g && g.roles[i] ? g.roles[i] : (s.role||'');
    if (g && !iAmStoryteller(g) && !iAmSpectator(g) && i !== mySeatInGame(g) && !(g.win && g.win.over)) role = '';
    var marks = g && g.markers[i] ? g.markers[i].join(' ') : '';
    var bub = bubblesFor(i).map(bubHtml).join('');
    el.innerHTML = (bub ? '<div class="bubbles">'+bub+'</div>' : '') +
      '<div class="seatnum">'+(i+1)+'</div><div class="token">'+(mine?'你':'AI')+(dead?'<span class="demontag">✝</span>':'')+'</div>'+
      '<div class="name">'+s.name+'</div><div class="role">'+role+'</div><div class="markers">'+marks+'</div>';
    el.dataset.zone = 'seat:'+i;
    el.onclick = function(){ S.selSeat=i; if(S.holdMe){ S.me={zone:'seat',seat:i}; S.holdMe=false; } render(); };
    table.appendChild(el);
  });
  placeMe();
}
function meZone(){ return (S.me && S.me.zone) ? S.me.zone : 'spectator'; }
function bubHtml(m){
  var isDm = m.channel === 'private';
  var toTxt = '';
  if (isDm && m.to && m.to.length){
    toTxt = '<span class="dmto"> → ' + m.to.map(function(x){ return (x+1); }).join('、') + ' 号</span>';
  }
  return '<div class="bubble'+(isDm?' dm':'')+'">'+(isDm?'<span class="dmtag">私聊</span>':'')+hlMentions(esc(m.text))+toTxt+'</div>';
}
function stBubbles(){
  var msgs = (S.chatMsgs || []).filter(function(m){ return m.from === 'storyteller'; });
  if (!msgs.length) return '';
  return '<div class="bubbles stbub">'+ msgs.slice(-2).map(bubHtml).join('') +'</div>';
}
function stBox(g){
  var st = (g && g.storyteller) || { type:(meZone()==='story'?'player':'agent'), name:(meZone()==='story'?'我':'说书人Agent') };
  var isMe = (g ? st.type === 'player' : meZone()==='story');
  return '<div class="stbox" data-zone="story" onclick="dropMe(\'story\')">'+
    stBubbles() +
    '<div class="sttoken">'+(isMe?'我':'AI')+'</div>'+
    '<div class="stname">'+st.name+'</div><div class="strole">说书人</div></div>';
}
function specBox(){
  var on = meZone()==='spectator';
  return '<div class="specbox'+(on?' on':'')+'" data-zone="spectator" onclick="dropMe(\'spectator\')">'+
    '<span class="speclabel">旁观席</span><span class="specdesc">'+(on?'你在这里':'空')+'</span></div>';
}
function dropMe(zone, seat){
  if (S.game) return; // 对局已开始：身份已写入对局，位置锁定，避免误解
  if(zone==='seat') S.me = { zone:'seat', seat:seat }; else S.me = { zone:zone, seat:0 };
  S.holdMe = false; savePrefs(); render();
}
function placeMe(){
  var left = document.querySelector('.left'); if(!left) return;
  var old = document.getElementById('mechip'); if(old && old.parentNode) old.parentNode.removeChild(old);
  var zone = meZone(), target = null;
  if(zone==='seat'){ target = document.querySelector('.seat[data-zone="seat:'+S.me.seat+'"]'); }
  else if(zone==='story'){ target = document.querySelector('.stbox'); }
  else { target = document.querySelector('.specbox'); }
  if(!target) return;
  var lr = left.getBoundingClientRect(), tr = target.getBoundingClientRect();
  var chip = document.createElement('div');
  chip.id = 'mechip'; chip.className = 'mechip' + (S.game ? ' locked' : ''); chip.textContent = '你';
  chip.style.left = (tr.left - lr.left + tr.width/2) + 'px';
  chip.style.top  = (tr.top - lr.top + tr.height - 10) + 'px';
  /* 拖动：按住「你」拖到目标位置松手即落位；原地松手视为回弹 */
  var drag = null, moved = false;
  chip.addEventListener('pointerdown', function(ev){
    if (S.game) return; // 对局已开始，位置锁定
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    var r0 = left.getBoundingClientRect();
    drag = {
      dx: ev.clientX - (r0.left + (parseFloat(chip.style.left) || 0)),
      dy: ev.clientY - (r0.top + (parseFloat(chip.style.top) || 0))
    };
    moved = false;
    chip.classList.add('dragging');
    try { chip.setPointerCapture(ev.pointerId); } catch (e) { /* 老浏览器忽略 */ }
  });
  chip.addEventListener('pointermove', function(ev){
    if (!drag) return;
    ev.preventDefault();
    var r1 = left.getBoundingClientRect();
    chip.style.left = (ev.clientX - r1.left - drag.dx) + 'px';
    chip.style.top  = (ev.clientY - r1.top  - drag.dy) + 'px';
    moved = true;
  });
  chip.addEventListener('pointerup', function(ev){
    if (!drag) return;
    drag = null; chip.classList.remove('dragging');
    try { chip.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    if (!moved) { S.holdMe = !S.holdMe; chip.classList.toggle('holding', S.holdMe); return; }
    chip.style.pointerEvents = 'none';
    var hit = document.elementFromPoint(ev.clientX, ev.clientY);
    chip.style.pointerEvents = '';
    var zoneEl = null, p = hit;
    while (p && p !== document.body) {
      if (p.dataset && p.dataset.zone) { zoneEl = p; break; }
      p = p.parentNode;
    }
    if (!zoneEl) { placeMe(); return; }
    var z = String(zoneEl.dataset.zone);
    if (z.indexOf('seat:') === 0) dropMe('seat', +z.slice(5)); else dropMe(z);
  });
  chip.addEventListener('pointercancel', function(){ drag = null; chip.classList.remove('dragging'); placeMe(); });
  left.appendChild(chip);
}
function meZoneLabel(){
  var z = meZone();
  if(z==='story') return '说书人';
  if(z==='seat') return (S.me.seat+1)+' 号座位（玩家）';
  return '旁观席';
}
function setupPanel(){
  if (S.game) {
    return '<div class="section"><h3>建局配置</h3>'+
      '<p class="muted">本局正在进行中（'+S.game.id+'），一局未结束前不能再建新局。</p>'+
      '<div class="row"><button onclick="setTab(\'game\')">回到游戏</button>'+
      '<button onclick="setTab(\'ai\')">去 AI 设置改模型/昵称</button>'+
      '<button onclick="leaveGame()">离开本局，回到建局</button></div>'+
      '<p class="muted">离开只是把这一局从界面收起，对局文件仍保存在 data/games/ 下，可在「日志」里重新打开。</p></div>';
  }
  var scripts = S.scripts.map(function(s){ return opt(s.name,s.name+'（'+s.roles.length+'角色）',S.script.name); }).join('');
  var pills = S.seats.map(function(s,i){
    var mine = (meZone()==='seat' && S.me.seat===i);
    return '<span class="pill '+(mine?'on':'')+'" onclick="dropMe(\'seat\','+i+')">'+(mine?'你 · ':'')+(i+1)+' 号 · '+s.name+'</span>';
  }).join('');
  return '<div class="section"><h3>建局配置</h3>'+
    '<div class="row">剧本：<select onchange="S.script=S.scripts.find(x=>x.name===this.value);savePrefs();render()">'+scripts+'</select></div>'+
    '<div class="row">人数：<input id="seatCount" type="number" min="5" max="30" value="'+S.seats.length+'" style="width:60px" title="减少人数只删除编号最大的座位">'+
    '<button onclick="resizeSeats(+document.getElementById(\'seatCount\').value);render()">应用人数</button></div>'+
    '<div class="row">你的位置：<b>'+meZoneLabel()+'</b></div>'+
    (S.game
      ? '<p class="muted">本局已开始，「你」的位置已写入对局、不可再改；要换身份请新建一局。</p>'
      : '<p class="muted">按住「你」拖到目标位置松手即可（也可点一下拿起、再点目标位置）。</p>')+

    '<p class="muted">先在这里定下剧本、人数、谁是「你」以及各座位的昵称；每个座位用哪个模型请到「AI 设置」页配置。</p>'+
    '<div class="row"><button id="startBtn" onclick="startGame()" '+(S.starting?'disabled':'')+'>'+(S.starting?'正在创建并进入第一夜...':'创建对局并进入第一夜')+'</button></div>'+
    (S.startError?('<div class="errbox">开局失败：'+S.startError+'（可直接重试）</div>'):'')+
    '<p class="muted">默认每个人都是 AI。把「你」放到某个座位，你就成为那位玩家；放到说书人圆圈，你就当说书人；放到旁观席，你就只是看。其余座位都由 Agent 扮演。</p>'+
    '</div><div class="seatlist">'+pills+'</div>'+
    nickPanel(S.seats);
}
/* 昵称配置：只在建局页，负责「这个座位叫什么」 */
function nickPanel(seats){
  if (!seats || !seats.length) return '';
  var rows = seats.map(function(s,i){
    var mine = S.game ? (s.type==='human') : (meZone()==='seat' && S.me.seat===i);
    return '<div class="smrow"><span class="smno">'+(i+1)+'</span>'+
      (mine ? '<span class="smname">'+esc(s.name||('座位'+(i+1)))+'</span><span class="muted">你（真人玩家）</span>'
            : '<input class="smname-input" value="'+esc(s.name||('座位'+(i+1)))+'" onchange="renameSeat('+i+',this.value)">')+
      '</div>';
  }).join('');
  return '<div class="section"><h3>座位昵称</h3>'+
    '<div class="row"><button onclick="randomizeNames()">随机全局昵称</button>'+
    '<span class="muted">从 data/names.json 的 '+nickPool().length+' 个昵称里随机分配。</span></div>'+
    '<div class="smgrid">'+rows+'</div></div>';
}
/* AI 设置页：每个座位用什么模型 */
function aiPanel(seats,sel){
  var arr = S.game ? S.game.seats : S.seats;
  var storyLine = '';
  if (S.game) {
    var st = S.game.storyteller || {};
    storyLine = (st.type === 'agent')
      ? ('<div class="row">说书人的模型：'+modelSelect('aiStSel', st.provider, st.model,
          'var k=this.value;var q=splitKey(k);saveStoryModel(q.provider,q.model)')+'</div>')
      : '<p class="muted">本局说书人是你（真人），不需要模型。</p>';
  } else if (meZone() !== 'story') {
    storyLine = '<div class="row">说书人的模型：'+modelSelect('aiStorySel', S.storyProvider, S.storyModel,
      'var k=this.value;var q=splitKey(k);saveStoryModel(q.provider,q.model)')+'</div>';
  } else {
    storyLine = '<p class="muted">你打算当说书人，不需要给说书人配模型。</p>';
  }
  var allSel = modelSelect('allModelSel', '', '',
    'var k=this.value;var q=splitKey(k);applyAllModels(q.provider,q.model)');
  return '<div class="section"><h3>AI 设置</h3>'+
    '<p class="muted">这里定义每个座位由哪个模型扮演。改动立刻生效，开局后也可以随时改。</p>'+
    '<div class="row">一键设置所有 AI：'+allSel+
    '<span class="muted">'+(S.allBusy?'正在写入…':'选中后立即把下面每个 AI 座位（不含你自己）都改成这个模型。')+'</span></div>'+
    storyLine+
    '</div>'+
    seatModelConfig(arr);
}
/* 座位模型配置：开局前作用于 S.seats，开局后作用于对局内的 seats，随时可改 */
function seatModelConfig(seats){
  if (!seats || !seats.length) return '';
  var rows = seats.map(function(s,i){
    var isHuman = S.game ? (s.type==='human') : (meZone()==='seat' && S.me.seat===i);
    var model = isHuman
      ? '<span class="muted">你（无需模型）</span>'
      : modelSelect('smSel'+i, s.provider, s.model, 'var k=this.value;var q=splitKey(k);saveSeatModel('+i+',q.provider,q.model)');
    return '<div class="smrow"><span class="smno">'+(i+1)+'</span><span class="smname">'+esc(s.name||('座位'+(i+1)))+'</span>'+model+'</div>';
  }).join('');
  return '<div class="section"><h3>座位模型</h3>'+
    '<p class="muted">每个座位可单独指定模型；「跟随默认模型」即用 DSH 当前的默认对话模型，改动立刻生效。</p>'+
    '<div class="smgrid">'+rows+'</div></div>';
}
function toggleSeat(i){ dropMe('seat', i); }
/* 改名：未开局只改内存；已开局连名字一起写回对局 */
async function renameSeat(seat, name){
  name = String(name||'').trim();
  var arr = S.game ? S.game.seats : S.seats;
  if (arr && arr[seat]) arr[seat].name = name;
  if (!S.game) { savePrefs(); render(true); return; }
  try {
    var cur = S.game.seats[seat] || {};
    await api('seatModel',{id:S.game.id,seat:seat,provider:cur.provider||'',model:cur.model||'',name:name});
    S.game = await api('game',gameReq());
  } catch(e){}
  render();
}
async function saveSeatModel(seat, provider, model){
  var arr = S.game ? S.game.seats : S.seats;
  if (arr && arr[seat]) {
    var old = arr[seat];
    var autoOld = autoNameOf(old.provider, old.model);
    var isAuto = !old.name || old.name === autoOld || /^玩家\d+$/.test(old.name);
    old.provider = provider || '';
    old.model = model || '';
    /* 选「跟随默认模型」时 autoNameOf 为空，别把座位名清空 */
    if (isAuto) { var autoNew = autoNameOf(old.provider, old.model); if (autoNew) old.name = autoNew; }
    if (S.seats && S.seats[seat] && S.game) {
      S.seats[seat].provider = old.provider; S.seats[seat].model = old.model; S.seats[seat].name = old.name;
    }
  }
  if (!S.game) { savePrefs(); render(true); return; }
  try {
    var nm = arr && arr[seat] ? arr[seat].name : '';
    await api('seatModel',{id:S.game.id,seat:seat,provider:provider,model:model,name:nm});
    S.game = await api('game',gameReq()); savePrefs(); render(true);
  } catch(e){ S.startError = '模型保存失败：'+((e&&e.message)||e); render(true); }
}
/* 一键把「所有 AI 座位」的模型改成同一个（真人座位不动，说书人另算） */
async function applyAllModels(provider, model){
  provider = provider || ''; model = model || '';
  var arr = S.game ? S.game.seats : S.seats;
  if (!arr || !arr.length) return;
  var targets = [];
  arr.forEach(function(s,i){
    var isHuman = (s.type === 'human') || (!S.game && meZone() === 'seat' && S.me.seat === i);
    if (!isHuman) targets.push(i);
  });
  if (!targets.length) return;
  var newName = autoNameOf(provider, model);
  targets.forEach(function(i){
    var old = arr[i];
    var autoOld = autoNameOf(old.provider, old.model);
    var isAuto = !old.name || old.name === autoOld || /^玩家\d+$/.test(old.name);
    old.provider = provider; old.model = model;
    if (isAuto && newName) old.name = newName;
    if (S.seats && S.seats[i] && S.game) {
      S.seats[i].provider = provider; S.seats[i].model = model; S.seats[i].name = old.name;
    }
  });
  if (!S.game) { savePrefs(); render(true); return; }
  S.allBusy = true; render();
  try {
    for (var k = 0; k < targets.length; k++) {
      var i2 = targets[k];
      var nm = arr[i2] ? arr[i2].name : '';
      await api('seatModel', { id:S.game.id, seat:i2, provider:provider, model:model, name:nm });
    }
    S.game = await api('game', gameReq());
    savePrefs();
    S.allBusy = false; render(true);
  } catch(e){
    S.allBusy = false;
    S.startError = '批量设置模型失败：' + ((e && e.message) || e);
    render(true);
  }
}
function autoNameOf(provider, model){
  if (!provider && !model) return '';
  return prettyModelName(provider, model);
}
async function saveStoryModel(provider, model){
  S.storyProvider = provider || ''; S.storyModel = model || '';
  if(!S.game) { savePrefs(); render(true); return; }
  try {
    await api('seatModel',{id:S.game.id,seat:'storyteller',provider:provider,model:model});
    S.game = await api('game',gameReq());
    savePrefs();
    render(true);
  } catch(e){ S.startError = '说书人模型保存失败：'+((e&&e.message)||e); render(); }
}
async function startGame(){
  if (S.starting) return;
  var zone = meZone();
  var seatsNew = S.seats.map(function(s,i){
    return { seat:i, name:s.name, type:(zone==='seat' && S.me.seat===i) ? 'human' : 'agent', provider:s.provider||'', model:s.model||'' };
  });
  var cfg = { script:S.script.name, seats:seatsNew,
    storyteller:(zone==='story')
      ? {type:'player',name:'我'}
      : {type:'agent',name:'说书人Agent',provider:S.storyProvider||'',model:S.storyModel||''} };
  S.starting = true; S.startError = ''; render();
  try {
    var res = await fetch(API+'quickstart', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    var j = await res.json();
    if(!j.ok){
      if(res.status===404 && /unknown api/.test(j.error||'')) throw new Error('服务版本过旧：缺少 quickstart 接口，请重启 DSH 后再打开魔典');
      throw new Error(j.error||'开局失败');
    }
    S.game = j.data;
    syncMeFromGame(S.game);
    S.tab='game';
  } catch(e) {
    S.startError = (e && e.message) ? e.message : String(e);
  } finally {
    S.starting = false; render();
  }
}
/* 顶部身份卡：你是谁、你看到什么（玩家显示自己的角色与私有信息） */
function myIdentityPanel(){
  var g = S.game; if(!g) return '';
  if (iAmSpectator(g)) return '<div class="idcard spec"><b>旁观</b><span class="muted">你可以看魔典、看日志，但不能操作。</span></div>';
  if (iAmStoryteller(g)) return '<div class="idcard st"><b>你是说书人</b><span class="muted">全场信息对你可见，由你主持夜晚与白天。</span></div>';
  var v = S.view || {};
  var role = v.role || '未分配';
  var fac = v.faction ? ('（'+v.faction+'）') : '';
  var ab = v.ability ? ('<div class="idline muted">'+v.ability+'</div>') : '';
  var pins = '';
  if (v.privateInfo && v.privateInfo.length) {
    var secs = v.secretInfo || [];
    var shown = v.privateInfo.map(function(t){
      var t2 = String(t);
      return (secs.indexOf(t2) >= 0) ? (esc(t2) + ' <span class="muted">（本夜，天亮后才能说）</span>') : esc(t2);
    }).join('；');
    pins = '<div class="idline">私有信息：' + shown + '</div>';
  }
  return '<div class="idcard me"><b>你是 '+(mySeatInGame(g)+1)+' 号 '+((g.seats[mySeatInGame(g)]||{}).name||'')+'</b>'+
    '<div class="idline">角色：<b>'+role+'</b>'+fac+' '+(v.alive===false?'（已出局，仍可发言）':'')+'</div>'+ab+pins+'</div>';
}
/* 终局横幅 */
function winBanner(g){
  if(!g || !g.win || !g.win.over) return '';
  var good = g.win.side === 'good';
  return '<div class="winbanner '+(good?'good':'evil')+'">'+
    '<div class="wintitle">'+(good?'善良阵营胜利':'邪恶阵营胜利')+'</div>'+
    '<div class="muted">'+(g.win.reason||'')+'</div></div>';
}
/* 游戏页：你是谁、说书人对你说了什么、以及当前选中座位的详情 */
function gamePanel(seats,sel){
  return myIdentityPanel() + inboxPanel() + seatPanel(seats,sel);
}
/* 说书人发给「你」的消息（只显示你自己的，不泄露别人） */
function inboxPanel(){
  var g = S.game; if(!g) return '';
  var v = S.view;
  if (!v) return '';
  var items = v.privateInfo || [];
  if (!items.length) {
    return '<div class="section"><h3>说书人的消息</h3><p class="muted">说书人还没有单独给你发过信息。</p></div>';
  }
  var secs = v.secretInfo || [];
  var html = items.map(function(t){
    var s2 = String(t);
    var secret = secs.indexOf(s2) >= 0;
    return '<div class="inboxitem'+(secret?' secret':'')+'">'+esc(s2)+
      (secret ? '<span class="muted">　（本夜刚得到，天亮后才能公开讨论）</span>' : '')+'</div>';
  }).join('');
  return '<div class="section"><h3>说书人的消息</h3>'+html+'</div>';
}
function seatPanel(seats,sel){
  var ro = S.game && !canControl();
  var speakPart = (S.game && !ro) ?
    ('<div class="row"><button onclick="api(\'say\',{id:S.game.id,seat:'+S.selSeat+',text:document.getElementById(\'say\').value,channel:\'town\'}).then(refresh)">发言</button></div><textarea id="say" placeholder="以该座位发言..."></textarea>') : '';
  if (ro) return '<div class="section"><h3>'+(S.selSeat+1)+' 号 · '+sel.name+'</h3>'+
    '<p class="muted">旁观模式：只能查看，不能改名、换模型或替 Agent 发言。</p></div>';
  return '<div class="section"><h3>'+(S.selSeat+1)+' 号 · '+sel.name+'</h3>'+
    '<div class="row">身份：<b>'+((meZone()==='seat'&&S.me.seat===S.selSeat)?'你（真人玩家）':'Agent 玩家')+'</b>'+
    (S.game?'':' <button onclick="dropMe(\'seat\','+S.selSeat+')">把「你」放到这里</button>')+'</div>'+
    '<div class="row">名字：<input value="'+sel.name+'" onchange="renameSeat(S.selSeat,this.value)"></div>'+
    '<div class="row">模型：'+(sel.type==='human'?'<b>你</b>（无需模型）':modelSelect('seatModelSel',sel.provider,sel.model,'var k=this.value;var q=splitKey(k);saveSeatModel(S.selSeat,q.provider,q.model)'))+'</div>'+
    speakPart+'</div><p class="muted">点击围坐圈上的座位可切换选中。每个座位可单独指定模型，留空则跟随默认模型。</p>'+ roundSection();
}
function storyPanel(seats,sel,roles,phase){
  if (!S.game) return '<p class="muted">请先在「建局」中创建对局。</p>';
  if (S.game.win && S.game.win.over) return '<p class="muted">本局已结束。可到「日志」里回看，或在「建局」里开新局。</p>';
  if (!iAmStoryteller(S.game)) return '<div class="section"><h3>说书人</h3><p class="muted">本局说书人由 Agent「'+S.game.storyteller.name+'」担任，你没有主持人权限。</p></div>'+ agentStorySection();
  return humanStoryPanel(seats,sel,roles,phase) + agentEndRow();
}
/* 说书人为 Agent 时：让 Agent 主持夜晚/白天 */
function agentStorySection(){
  if (!S.game) return '';
  var st = S.story || {running:false,result:null,error:null};
  var res = st.result;
  var out = '';
  if (st.running) out = '<div class="muted">说书人思考中…</div>';
  else if (res){
    out = '<div class="log" style="max-height:260px">'+
      (res.say?('<div><b>说书人</b> '+res.say+'</div>'):'')+
      (res.applied?('<div class="muted">告知 '+(res.applied.info||0)+' 条 · 标记 '+(res.applied.markers||0)+' 个 · 死亡 '+(res.applied.deaths||0)+' 人'+(res.applied.phase?(' · 进入 '+res.applied.phase):'')+'</div>'):'')+
      '</div>';
  } else if (st.error) out = '<div class="errbox">说书人出错：'+st.error+'</div>';
  return '<div class="section"><h3>Agent 说书人主持</h3>'+
    '<p class="muted">按当前阶段（'+(PHZH[(S.game||{}).phase]||'')+'）让说书人 Agent 依规则宣布夜晚行动、下发私密信息、结算死亡并推进阶段。</p>'+
    '<div class="row"><button onclick="runStory()" '+(st.running?'disabled':'')+'>'+(st.running?'进行中…':'让说书人 Agent 主持这一阶段')+'</button></div>'+
    out+'</div>';
}
/* 说书人为「我」时：底部给一个「交给 Agent 代主持」的入口 + 结束对局 */
function agentEndRow(){
  return '<div class="section"><h3>结束对局</h3>'+
    '<div class="row"><select id="winSide"><option value="good">善良阵营胜利</option><option value="evil">邪恶阵营胜利</option></select>'+
    '<input id="winReason" placeholder="原因（可选）" style="flex:1">'+
    '<button onclick="doEndGame()">宣布终局</button></div></div>';
}
function humanStoryPanel(seats,sel,roles,phase){
  var roleOpts = '<option value="">—</option>'+roles.map(function(r){ return '<option>'+r+'</option>'; }).join('');
  var phaseOpts = PHASES.map(function(p){ return opt(p,PHZH[p],phase); }).join('');
  return '<div class="story-panel"><b>说书人面板</b>（'+S.game.storyteller.name+'）'+
    '<div class="row">给 '+(S.selSeat+1)+' 号分配角色：<select id="roleSel">'+roleOpts+'</select>'+
    '<button onclick="api(\'role\',{id:S.game.id,seat:'+S.selSeat+',role:document.getElementById(\'roleSel\').value}).then(refresh)">分配</button></div>'+
    '<div class="row">下发私有信息：<input id="infoText" placeholder="例如：你是小恶魔，爪牙是 3 号"><button onclick="api(\'info\',{id:S.game.id,seat:'+S.selSeat+',text:document.getElementById(\'infoText\').value}).then(refresh)">发送</button></div>'+
    '<div class="row">阶段：<select onchange="api(\'phase\',{id:S.game.id,phase:this.value}).then(refresh)">'+phaseOpts+'</select></div></div>'+
    modelPanel()+
    '<div class="section"><h3>操作</h3>'+
    '<div class="row">标记：<select id="markSel"><option>中毒</option><option>醉酒</option><option>被保护</option><option>死亡</option></select>'+
    '<button onclick="api(\'marker\',{id:S.game.id,seat:'+S.selSeat+',marker:document.getElementById(\'markSel\').value}).then(refresh)">切换</button></div>'+
    '<div class="row">提名 '+(S.selSeat+1)+' 号 → 目标（号）：<input id="nomTarget" type="number" min="1" max="'+seats.length+'" style="width:60px">'+
    '<button onclick="api(\'nominate\',{id:S.game.id,from:'+S.selSeat+',target:(+document.getElementById(\'nomTarget\').value-1)}).then(refresh)">提名</button></div>'+
    '<div class="row"><button onclick="api(\'execute\',{id:S.game.id,seat:'+S.selSeat+'}).then(refresh)">处决该座位</button>'+
    '<button onclick="api(\'agentSpeak\',{id:S.game.id,seat:'+S.selSeat+',prompt:\'请发言\'}).then(function(x){document.getElementById(\'say\').value=x.text;refresh()})">让该 Agent 发言</button></div>'+
    '<textarea id="say" readonly placeholder="Agent 发言显示在这里"></textarea></div>' +
    roundSection();
}
/* 让 Agent 说书人主持当前阶段，并轮询结果 */
/* 自动主持：失败不打断界面，只把错误记在 S.story 里 */
async function autoRunStory(){
  if (!S.game) return;
  S.story = { running:true, result:null, error:null };
  try { await api('storyRound',{id:S.game.id}); }
  catch(e){ S.story = { running:false, result:null, error:String((e&&e.message)||e) }; render(); return; }
  render();
  pollStory();
}
async function runStory(){
  if(!S.game) return;
  try { await api('storyRound',{id:S.game.id}); }
  catch(e){ S.startError = '说书人启动失败：'+((e&&e.message)||e); render(); return; }
  S.story = {running:true,result:null,error:null};
  render(); pollStory();
}
function pollStory(){
  if(!S.game) return;
  setTimeout(async function(){
    try { S.story = await api('storyStatus',{id:S.game.id}); } catch(e){ S.story = {running:false,error:String((e&&e.message)||e)}; }
    render();
    if (S.story && S.story.running) pollStory(); else refresh();
  }, 1500);
}
async function doEndGame(){
  if(!S.game) return;
  var side = ($('#winSide')||{}).value || 'good';
  var reason = ($('#winReason')||{}).value || '';
  try { await api('endGame',{id:S.game.id, side:side, reason:reason}); } catch(e){ S.startError=String((e&&e.message)||e); }
  await refresh();
}
/* 模型面板：只放说书人自己的模型；各座位模型在「魔典」页点座位改。 */
function modelPanel(){
  var g = S.game; if(!g) return '';
  var st = g.storyteller || {};
  if (st.type !== 'agent') return '';
  return '<div class="section"><h3>说书人的模型</h3>'+
    '<p class="muted">本局说书人由 Agent 担任。「跟随默认模型」即用 DSH 当前的默认对话模型，改动立刻生效。</p>'+
    '<div class="row">说书人：'+modelSelect('stModelSel', st.provider, st.model,
      'var k=this.value;var q=splitKey(k);saveStoryModel(q.provider,q.model)')+'</div></div>';
}
/* 轮次驱动器：一次唤醒全场存活 Agent，按座位顺序串行发言 */
function roundSection(){
  if(!S.game) return '';
  if(!canControl()) return '';
  var st = S.round || {running:false,done:0,total:0,current:null,waiting:[],results:[]};
  var waiting = st.waiting || [];
  var prog = '';
  if (st.running) {
    var nowWho = (st.current !== null && st.current !== undefined) ? ((st.current+1) + ' 号正在发言') : '准备中';
    prog = '<div class="muted">正在依次发言：' + nowWho + '，已完成 ' + st.done + '/' + st.total +
      (waiting.length ? ('，后面还有 ' + waiting.map(function(n){return (n+1)+' 号';}).join('、')) : '') + '</div>';
  } else if (st.total) {
    prog = '<div class="muted">上一次：' + st.total + ' 位 Agent 依次发过言，其中 ' +
      (st.results||[]).filter(function(r){ return r.say && String(r.say).trim(); }).length + ' 位开口。</div>';
  }
  var last = (st.results||[]).map(function(r){
    var said = (r.say && String(r.say).trim()) ? esc(r.say) : '<span class="muted">（沉默）</span>';
    var err = r.error ? ('<span class="err">　调用失败：' + esc(r.error) + '</span>') : '';
    return '<div><b>' + (r.seat+1) + ' 号</b>：' + said + (r.whispers ? ('（私聊 ' + r.whispers + ' 条）') : '') + err + '</div>';
  }).join('');
  return '<div class="section"><h3>AI 玩家</h3>'+
    '<p class="muted">你发一条公开消息后，AI 会按座位顺序一位一位地接话：后说的人能听到前面说了什么，所以彼此能顺着聊。每位自己决定接不接。白天夜里都能说话。</p>'+
    '<div class="row"><button onclick="roundSectionStart()" '+(st.running?'disabled':'')+'>让 AI 自己聊一轮</button>'+
    '<label class="muted"><input type="checkbox" '+(S.autoChat?'checked':'')+' onchange="S.autoChat=this.checked;savePrefs()"> 进入白天时自动讨论</label>'+
    '<label class="muted"><input type="checkbox" '+(S.autoStory!==false?'checked':'')+' onchange="S.autoStory=this.checked;savePrefs()"> 进入夜晚时自动主持</label></div>'+
    prog+
    '<div class="log" style="max-height:220px">'+(last||'<div class="muted">本轮尚无发言</div>')+'</div></div>';
}
/* 手动让 AI 自己聊一轮（不需要玩家先说话） */
function roundSectionStart(){ reactAll(); }
/* 公聊后：唤醒所有存活 Agent，各自决定要不要接话（mode:'react'） */
async function reactAll(){
  if(!S.game) return;
  try { await api('round',{id:S.game.id, mode:'react'}); }
  catch(e){ S.startError='启动 AI 反应失败：'+((e&&e.message)||e); render(); return; }
  S.round = await api('roundStatus',{id:S.game.id});
  render();
  pollRound();
}
async function runRound(limit){
  if(!S.game) return;
  try { await api('round',{id:S.game.id, limit:limit||0}); }
  catch(e){ S.startError='启动发言失败：'+((e&&e.message)||e); render(); return; }
  S.round = await api('roundStatus',{id:S.game.id});
  render();
  pollRound();
}
function pollRound(){
  if(!S.round || !S.round.running) return;
  setTimeout(async function(){
    try { S.round = await api('roundStatus',{id:S.game.id}); } catch(e){ return; }
    render();
    if(S.round.running) pollRound(); else refresh();
  }, 1200);
}
function mySeatInGame(g){
  if(!g || !g.seats) return 0;
  for(var i=0;i<g.seats.length;i++){ if(g.seats[i].type==='human') return i; }
  return 0;
}
/* 本局「我」是哪种身份：说书人 / 玩家 / 旁观，决定哪些操作可用 */
function iAmStoryteller(g){ return !!(g && g.storyteller && g.storyteller.type === 'player'); }
function iAmPlayer(g){
  if(!g || !g.seats) return false;
  for(var i=0;i<g.seats.length;i++){ if(g.seats[i].type === 'human') return true; }
  return false;
}
function iAmSpectator(g){ return !!g && !iAmStoryteller(g) && !iAmPlayer(g); }
/* 观战/历史回看：只读 */
function canControl(){
  if (!S.game) return true;
  if (S.game.win && S.game.win.over) return false; // 终局后一切操作只读
  return iAmStoryteller(S.game) || iAmPlayer(S.game);
}
/* 读取对局时带上视角，非说书人不会拿到中毒/醉酒等隐藏标记 */
function gameReq(){ return { id:S.game.id, storyteller:iAmStoryteller(S.game) }; }
/* 打开/创建对局后，把「你」的摆放同步成这一局里的真实身份 */
function syncMeFromGame(g){
  if(!g) return;
  if (g.storyteller) { S.storyProvider = g.storyteller.provider || ''; S.storyModel = g.storyteller.model || ''; }
  if (g.storyteller && g.storyteller.type === 'player'){ S.me = { zone:'story', seat:0 }; return; }
  for (var i=0;i<(g.seats||[]).length;i++){
    if (g.seats[i].type === 'human'){ S.me = { zone:'seat', seat:i }; return; }
  }
  S.me = { zone:'spectator', seat:0 };
}
/* 只重画聊天记录：输入时也能看到新消息，不销毁输入框 */
/* @ 提及候选：座位名 + 说书人。用原生 datalist，输入 @ 后浏览器会给候选 */
function mentionListHtml(g){
  if(!g) return '';
  var opts = (g.seats||[]).map(function(s,i){
    var nm = s.name||('座位'+(i+1));
    return '<option value="@'+esc(nm)+'">'+esc((i+1)+' 号')+'</option>';
  }).join('');
  return '<datalist id="mentionList">'+opts+'</datalist>';
}
/* 点座位名时把「@名字」插到输入框光标处 */
function insertMention(name){
  var inp = document.getElementById('chatText');
  var cur = S.chatDraft || '';
  var add = '@' + name + ' ';
  if (inp && typeof inp.selectionStart === 'number'){
    var a = inp.selectionStart, b = inp.selectionEnd;
    cur = cur.slice(0,a) + add + cur.slice(b);
    S.chatDraft = cur;
    render(true);
    var ni = document.getElementById('chatText');
    if (ni) { ni.focus(); try { ni.setSelectionRange(a+add.length, a+add.length); } catch(e){} }
    return;
  }
  S.chatDraft = cur + add;
  render(true);
}
function chatMsgsHtml(g){
  if(!g) return '<div class="muted">暂无消息</div>';
  var seats = g.seats||[];
  var h = (S.chatMsgs||[]).map(function(m){
    var from = seats[m.from]?seats[m.from].name:((m.from+1)+' 号');
    var cls = m.channel==='private'?'dm':'town';
    var tag = m.channel==='private'?'私聊':'';
    var toTxt = '';
    if (m.channel==='private' && m.to && m.to.length){
      toTxt = ' → ' + m.to.map(function(x){ return (x+1)+' 号'+(seats[x]?('·'+seats[x].name):''); }).join('、');
    }
    return '<div class="msg '+cls+'"><b>'+from+'</b> '+tag+toTxt+'：'+hlMentions(esc(m.text))+'</div>';
  }).join('');
  return h || '<div class="muted">暂无消息</div>';
}
function paintChat(){
  var cl = document.getElementById('chatLog');
  if(!cl) return;
  var g = S.game;
  var nearBottom = (cl.scrollHeight - cl.scrollTop - cl.clientHeight) < 28;
  cl.setAttribute('data-count', String((S.chatMsgs||[]).length));
  cl.innerHTML = chatMsgsHtml(g);
  if (nearBottom) { cl.scrollTop = cl.scrollHeight; S.chatSeen = (S.chatMsgs||[]).length; }
}
function chatPanel(g){
  if(!g) return '<div class="chatempty muted">先在「建局」创建对局，这里会显示群聊。</div>';
  var seats = g.seats||[];
  var self = mySeatInGame(g);
  var roChat = !iAmStoryteller(g) && !iAmPlayer(g);
  var isNight = (g.phase === 'night');
  if (isNight && S.chatChannel === 'private') S.chatChannel = 'town';
  var chOpts = opt('town','town（全员可见）',S.chatChannel)+(isNight?'':opt('private','private（私聊）',S.chatChannel));
  var seatOpts = seats.map(function(s,i){ return '<label style="margin-right:8px"><input type="checkbox" class="chtarget" value="'+i+'" '+(S.chatTo.indexOf(i)>=0?'checked':'')+'>'+(i+1)+' 号 · '+s.name+'</label>'; }).join('');
  var msgs = chatMsgsHtml(g);
  return '<div class="chatwrap"><h3>群聊 / 私聊</h3>'+
    '<p class="chatwho muted">'+(self+1)+' 号'+(seats[self]?'（'+seats[self].name+'）':'')+
      ((S.game && S.game.alive && S.game.alive[self]===false) ? ' <span class="deadnote">已出局 · 仍可发言</span>' : '')+'</p>'+
    '<div class="row">频道：<select id="chatCh" onchange="S.chatChannel=this.value;render()">'+chOpts+'</select>'+(isNight?'<span class="muted">夜晚只能公聊；当晚得到的信息天亮后才能说</span>':'')+'</div>'+
    (S.chatChannel==='private'?'<div class="row">收件人：<div>'+seatOpts+'</div></div>':'')+
    '<div id="chatLog" class="log chatlog" data-count="'+((S.chatMsgs||[]).length)+'">'+(msgs||'<div class="muted">暂无消息</div>')+'</div>'+
    (roChat ? '<p class="muted">旁观模式：只能阅读对话，不能发言。</p>' :
    '<div class="row chatinput"><input id="chatText" list="mentionList" style="flex:1" placeholder="说点什么…（输入 @ 可以直接 @人）" value="'+esc(S.chatDraft||'')+'" oninput="S.chatDraft=this.value" onblur="if(S.pendingRender)render(true)" onkeydown="if(event.key===\'Enter\')sendChat()"><button onclick="sendChat()">发送</button></div>')+
    mentionListHtml(g)+
    '<div id="chatMore" class="chatmore" onclick="jumpChatBottom()" style="display:none"></div>'+
    '</div>';
}
async function sendChat(){
  var inp = $('#chatText');
  var txt = inp ? inp.value : (S.chatDraft || '');
  if(!txt.trim()) return;
  var to = [];
  if(S.chatChannel==='private'){
    document.querySelectorAll('.chtarget').forEach(function(el){ if(el.checked) to.push(+el.value); });
  }
  var ch = S.chatChannel;
  await api('say',{id:S.game.id,seat:mySeatInGame(S.game),text:txt,channel:ch,to:to});
  S.chatDraft=''; if(inp) inp.value='';
  await loadChat();
  if (ch === 'town') reactAll();
  else {
    /* 私聊：唤醒收件人 Agent 回一条（不占用其主动私聊名额） */
    if (to.length) api('round',{id:S.game.id, seats:to, replyTo:mySeatInGame(S.game)}).catch(function(){});
    refresh();
  }
}
/* 离开当前对局（不删文件） */
function leaveGame(){
  S.game=null; S.view=null; S.round=null; S.story=null; S.chatMsgs=[]; S.history=null;
  setTab('setup');
}
async function loadChat(skipRender){
  if(!S.game) return;
  try {
    var d = await api('messages',{id:S.game.id,viewer:mySeatInGame(S.game),storyteller:!(S.game&&S.game.storyteller&&S.game.storyteller.type==='player')});
    S.chatMsgs = d.messages;
  } catch(e){ return; }
  if (skipRender) return;
  var ae = document.activeElement;
  if (ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA')) { paintChat(); return; }
  render();
}
function logPanel(g){
  var head = g ? ('<div class="section"><h3>对局日志</h3><div class="log">'+g.log.map(function(l){ return '<div><b>'+l.who+'</b> '+l.text+'</div>'; }).join('')+'</div></div>'+
    '<p class="muted">每个 Agent 的完整日志位于 data/games/'+g.id+'/agents/</p>') : '<p class="muted">当前没有打开的对局</p>';
  return head + historyPanel();
}
/* 历史对局：列出 data/games 下的全部对局，点开即恢复观看 */
function historyPanel(){
  var list = S.history || null;
  var body;
  if (list === null) body = '<div class="muted">点「刷新历史」读取列表</div>';
  else if (!list.length) body = '<div class="muted">还没有历史对局</div>';
  else body = list.map(function(id){
    var cur = (S.game && S.game.id === id);
    return '<div class="histitem'+(cur?' on':'')+'" onclick="openGame(\''+id+'\')">'+(cur?'▶ ':'')+id+'</div>';
  }).join('');
  return '<div class="section"><h3>历史对局</h3>'+
    '<div class="row"><button onclick="loadHistory()">刷新历史</button>'+
    (S.game?'<button onclick="closeGame()">关闭当前对局</button>':'')+'</div>'+
    '<div class="histlist">'+body+'</div></div>';
}
async function loadHistory(){
  try { S.history = await api('games'); } catch(e){ S.history = []; }
  render();
}
async function openGame(id){
  try {
    var g = await api('game',{id:id, storyteller:false});
    if(!g) throw new Error('没有这一局');
    S.game = g; S.selSeat = 0; S.tab = 'game'; S.round = null;
    syncMeFromGame(g);
    render();
  } catch(e){ alert('打开失败：'+((e&&e.message)||e)); }
}
function closeGame(){ S.game = null; S.round = null; S.tab = 'setup'; render(); }
/* 把「@名字」包成高亮标签。输入必须是已经转义过的文本。 */
function hlMentions(escaped){
  return String(escaped||'').replace(/@([^\s@<,，.。！？!?、：:；;"'）)】\]]{1,16})/g, '<span class="mention">@$1</span>');
}
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtWiki(raw){
  var t = String(raw||'');
  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  t = t.replace(/^[<]*\s*返回\s*\[\[[^\]]*\]\]\s*$/gm, '');
  t = esc(t);
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  t = t.replace(/'''([^']+)'''/g, '<b>$1</b>');
  var out = '';
  t.split(/\r?\n\s*\r?\n/).forEach(function(block){
    var b = block.trim();
    if(!b) return;
    var m = b.match(/^==\s*([^=]+?)\s*==$/);
    if(m){ out += '<h4>'+m[1]+'</h4>'; return; }
    out += '<p>'+b.replace(/\r?\n/g,'<br>')+'</p>';
  });
  return out || '<p class="muted">（这个条目没有正文）</p>';
}
function wikiPanel(){
  var inner;
  if(S.wikiPage){
    var body = (S.wikiText===null) ? '<p class="muted">加载中...</p>' : fmtWiki(S.wikiText);
    inner = '<div class="wikihead"><button class="wikiback" onclick="wikiBack()">← 返回分类</button><b>'+esc(S.wikiPage)+'</b></div><div class="wikibody">'+body+'</div>';
  } else {
    inner = '加载中...';
  }
  return '<div class="section"><h3>知识库</h3><div id="wikiView" class="wikiview">'+inner+'</div></div>';
}
async function showWikiPage(name){
  S.wikiPage = name; S.wikiText = null; render();
  try {
    var t = await api('wiki',{name:name});
    if(S.wikiPage!==name) return;
    S.wikiText = (t==null) ? '（知识库里没有这个条目）' : t;
  } catch(e){ S.wikiText = '（读取失败：'+String(e&&e.message||e)+'）'; }
  render();
}
function openWikiIdx(i){ var n = S.wikiNames[i]; if(n) showWikiPage(n); }
function wikiBack(){ S.wikiPage = null; S.wikiText = null; render(); loadWiki(); }
async function loadWiki(){
  if(S.tab!=='wiki') return;
  if(S.wikiPage) return;
  var v = $('#wikiView'); if(!v) return;
  v.textContent = '加载中...';
  try {
    if(!S.wikiCache) S.wikiCache = await api('wikiList');
    if(S.tab!=='wiki' || S.wikiPage) return;
    var d = S.wikiCache;
    var list = Array.isArray(d) ? d : ((d && d.data) || []);
    var WIKI_ORDER = ['角色能力类别','规则','剧本','角色'];
    var groups = { '角色能力类别': [], '规则': [], '剧本': [], '角色': [] };
    S.wikiNames = [];
    list.forEach(function(it){
      var c = it.category || '';
      (groups[c] || (groups[c] = [])).push(it.name);
    });
    WIKI_ORDER.forEach(function(k){ (groups[k]||[]).forEach(function(n){ S.wikiNames.push(n); }); });
    Object.keys(groups).forEach(function(k){ if(WIKI_ORDER.indexOf(k)<0) groups[k].forEach(function(n){ S.wikiNames.push(n); }); });
    var idx = {};
    S.wikiNames.forEach(function(n,i){ idx[n]=i; });
    var html = '';
    var sec = function(k, arr){
      if(!arr.length) return;
      html += '<div class="wikigrp"><h4>'+k+'（'+arr.length+'）</h4><div class="wikitags">';
      arr.forEach(function(n){ html += '<span class="wikitag" onclick="openWikiIdx('+idx[n]+')">'+esc(n)+'</span>'; });
      html += '</div></div>';
    };
    WIKI_ORDER.forEach(function(k){ sec(k, groups[k]||[]); });
    Object.keys(groups).forEach(function(k){ if(WIKI_ORDER.indexOf(k)<0) sec(k, groups[k]||[]); });
    v.innerHTML = html || '<p class="muted">知识库为空</p>';
  } catch(e) {
    if(S.tab!=='wiki') return;
    v.textContent = '知识库加载失败：'+String(e&&e.message||e);
  }
}
async function refresh(){
  if(!S.game) return;
  S.game = await api('game',gameReq());
  if(!S.round || !S.round.running){
    try { S.round = await api('roundStatus',{id:S.game.id}); } catch(e){}
  }
  if (iAmPlayer(S.game)){
    try { S.view = await api('view',{id:S.game.id, seat:mySeatInGame(S.game)}); } catch(e){}
  } else { S.view = null; }
  if (S.tab==='story' && !iAmStoryteller(S.game) && !(S.story && S.story.running)){
    try { S.story = await api('storyStatus',{id:S.game.id}); } catch(e){}
  }
  /* 阶段翻转时的自动推进：
     - 进夜晚：Agent 说书人自动主持这一夜（发私密信息、结算死亡、推进到白天）
     - 进白天：自动让 AI 们先聊一轮，免得白天一片死寂 */
  if (S.game && S.game.phase === 'night' && S.lastPhase !== 'night') {
    S.lastPhase = 'night';
    if (S.autoStory !== false && iAmStorytellerAgent(S.game)
        && !(S.story && S.story.running) && !(S.round && S.round.running)) {
      autoRunStory();
    }
  } else if (S.game && S.game.phase === 'day' && S.lastPhase !== 'day') {
    S.lastPhase = 'day';
    if (S.autoChat && canControl() && !(S.round && S.round.running)) reactAll();
  } else if (S.game) {
    S.lastPhase = S.game.phase;
  }
  /* 先取消息再渲染：头像上方的气泡要用最新的聊天记录 */
  await loadChat(true);
  render();
  if(S.tab==='wiki') loadWiki();
}
setInterval(refresh, 3000);
init();