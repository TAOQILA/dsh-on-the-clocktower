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
var VERSION = '0.13.2';
var $ = function(s){ return document.querySelector(s); };
var API = (function(){ var p = location.pathname; if (p.charAt(p.length-1) !== '/') p = p.replace(/[^/]*$/, ''); return p + 'api/'; })();
async function api(name, data){
  var r = await fetch(API+name, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
  var j = await r.json();
  if (!j.ok) throw new Error(j.error||'request failed');
  return j.data;
}
var S = { scripts:[], script:null, seats:[], game:null, history:null, me:{zone:'spectator',seat:0}, holdMe:false, storyName:'说书人', storyProvider:'', storyModel:'', tab:'game', selSeat:0, chatChannel:'town', chatTo:[], chatLoading:false, models:null, starting:false, startError:'', view:null, story:null, wikiPage:null, wikiText:null, wikiNames:[], wikiCache:null, chatMsgs:[], chatSeen:0, chatUnread:0, dmUnread:0, namesPool:[], chatDraft:'', pendingRender:false, autoChat:true, autoStory:true, hideChat:true, hideDm:false, mentionOpen:false, lastPhase:'', showDm:false, dmDraft:'', dmTo:[], activeInput:'town', mentionList:[], mentionWhich:'town',
  fontScale:1, chatFade:true, showTimer:true, showBubbles:true, nightTheme:true, compactTabs:false, showScriptLine:true,
  bgOn:true, bgBlur:7.5, bgBright:20, panelAlpha:40, hideSide:true,
  storyLog:null, storyLogAt:0, aiStyle:'mild_fun' };
var PHASES = ['setup','night','day','nomination','vote','dawn','ended'];
var PHZH = {setup:'准备',night:'夜晚',day:'白天',nomination:'提名',vote:'投票',dawn:'日落',ended:'终局'};
var TABS = {setup:'开局',ai:'AI 设置',log:'日志',wiki:'知识库',game:'游戏',story:'说书人',cheat:'作弊',settings:'设置'};
/* 标签两行四列 */
var TAB_ROWS = [['setup','ai','log','wiki'],['game','story','cheat','settings']];

window.addEventListener('resize', function(){ if (typeof placeMe === 'function') placeMe(); });
async function init(){
  try { S.models = await api('models'); } catch(e){ S.models = {providers:[],error:String(e&&e.message||e)}; }
  try { var np = await api('names'); S.namesPool = Array.isArray(np) ? np : []; } catch(e2){ S.namesPool = []; }
  S.scripts = await api('scripts');
  if (!S.scripts.length){ $('#app').innerHTML='<p style="padding:30px">未找到剧本 JSON，请检查 data/scripts/</p>'; return; }
  S.script = S.scripts[0];
  S.seats = defaultSeats(7);
  loadPrefs();
  if (ACTIVE_GAME_ID) {
    try {
      var rg = await api('game', { id: ACTIVE_GAME_ID, storyteller: ACTIVE_GAME_ST });
      if (rg && rg.id) {
        S.game = rg; syncMeFromGame(rg); S.tab = 'game';
        try { await loadChat(true); } catch (e3) { /* ignore */ }
      }
    } catch (e4) { /* 对局文件没了就忽略 */ }
  }
  render();
}
function setTab(t){ S.tab=t; render(); if(t==='wiki') loadWiki(); if(t==='log'&&S.history===null) loadHistory(); if(t==='cheat') loadStoryLog().then(function(){ render(); }); }
/* 建局偏好落盘：刷新页面后座位名/模型、说书人模型、剧本都还在 */
var PREF_KEY = 'ran.prefs.v1';
var ACTIVE_GAME_ID = '';
var ACTIVE_GAME_ST = false;
function savePrefs(){
  try {
    /* 所有建局相关的选择都落盘：剧本、人数（= seats 长度）、每个座位的昵称与模型、
       说书人模型、「你」放在哪、自动讨论开关。这样无论刷新、关页面还是重启 DSH，
       回来都还是上一次的设置。 */
    localStorage.setItem(PREF_KEY, JSON.stringify({
      v: 2,
      script: S.script ? S.script.name : '',
      storyName: S.storyName || '说书人',
      storyProvider: S.storyProvider || '',
      storyModel: S.storyModel || '',
      hideChat: S.hideChat === true,
      hideDm: S.hideDm === true,
      autoChat: S.autoChat !== false,
      autoStory: S.autoStory !== false,
      fontScale: S.fontScale || 1,
      chatFade: S.chatFade !== false,
      showTimer: S.showTimer !== false,
      showBubbles: S.showBubbles !== false,
      nightTheme: S.nightTheme !== false,
      showScriptLine: S.showScriptLine !== false,
      hideSide: S.hideSide === true,
      panelAlpha: (typeof S.panelAlpha === 'number' ? S.panelAlpha : 40),
      bgOn: S.bgOn !== false,
      bgBlur: (typeof S.bgBlur === 'number' ? S.bgBlur : 7.5),
      bgBright: (typeof S.bgBright === 'number' ? S.bgBright : 20),
      me: { zone: meZone(), seat: (S.me && S.me.seat) || 0 },
      aiStyle: S.aiStyle || 'mild_fun',
      activeGame: S.game ? S.game.id : '',
      activeGameSt: S.game ? iAmStoryteller(S.game) : false,
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
    if (typeof o.panelAlpha === 'number' && isFinite(o.panelAlpha)) S.panelAlpha = o.panelAlpha;
    if (typeof o.bgOn === 'boolean') S.bgOn = o.bgOn;
    if (typeof o.bgBlur === 'number' && isFinite(o.bgBlur)) S.bgBlur = o.bgBlur;
    if (typeof o.bgBright === 'number' && isFinite(o.bgBright)) S.bgBright = o.bgBright;
    if (typeof o.autoChat === 'boolean') S.autoChat = o.autoChat;
    if (typeof o.autoStory === 'boolean') S.autoStory = o.autoStory;
    S.storyName = o.storyName || '说书人';
    S.storyProvider = o.storyProvider || '';
    S.storyModel = o.storyModel || '';
    S.hideDm = o.hideDm === true;
    if (Array.isArray(o.seats) && o.seats.length >= 5 && o.seats.length <= 30) {
      S.seats = o.seats.map(function(x,i){
        return { seat:i, name:String(x.name||('玩家'+(i+1))), type:'agent', provider:x.provider||'', model:x.model||'' };
      });
    }
    ACTIVE_GAME_ID = o.activeGame || '';
    ACTIVE_GAME_ST = o.activeGameSt === true;
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
  var lo = (S.script && S.script.minPlayers) || 5, hi = (S.script && S.script.maxPlayers) || 12;
  n = Math.max(lo, Math.min(hi, n|0));
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
/* 整页每 3 秒重建一次，所有滚动容器都会归零。
   做法：重建前把所有带 data-keep 的容器的滚动位置记下来，
   重建后按 key 还原；聊天框额外判断「是否贴底」。 */
function capScroll(){
  var sc = document.scrollingElement || document.documentElement;
  var k = { win: sc ? sc.scrollTop : 0, boxes: {}, chatBottom: true, chatCount: -1 };
  var nodes = document.querySelectorAll('[data-keep]');
  for (var i = 0; i < nodes.length; i++){
    var el = nodes[i];
    k.boxes[el.getAttribute('data-keep')] = el.scrollTop;
  }
  var cl = document.getElementById('chatLog');
  if (cl){
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
  var nodes = document.querySelectorAll('[data-keep]');
  for (var i = 0; i < nodes.length; i++){
    var el = nodes[i];
    var key = el.getAttribute('data-keep');
    if (k.boxes[key] === undefined) continue;
    if (key === 'chatLog') continue;
    el.scrollTop = k.boxes[key];
  }
  var cl = document.getElementById('chatLog');
  if (cl){
    var cnt = (S.chatMsgs || []).length;
    if (k.chatBottom){
      cl.scrollTop = cl.scrollHeight;
      S.chatSeen = cnt;
    } else {
      cl.scrollTop = (k.boxes['chatLog'] || 0);
      if (cnt > S.chatSeen){
        var m = document.getElementById('chatMore');
        if (m){ m.style.display = 'block'; m.textContent = '有 ' + (cnt - S.chatSeen) + ' 条新消息 ↓'; }
      }
    }
  }
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
  var isNightPhase = (cur === 'night' || cur === 'dawn');
  document.body.classList.toggle('night', (S.nightTheme !== false) && isNightPhase);
  /* 背景图始终跟着阶段走：切到夜晚时两张图淡入淡出 */
  document.body.classList.toggle('bgnight', isNightPhase);
  /* 字号：整个界面按比例缩放（Chromium/Edge 支持 zoom），设置里可调 */
  var appEl = document.getElementById('app');
  if (appEl) appEl.style.zoom = String(S.fontScale || 1);
  applyBg();
  applyPanelAlpha();
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
  else if (S.tab==='cheat') panel = cheatPanel(seats,sel);
  else if (S.tab==='settings') panel = settingsPanel();
  else panel = gamePanel(seats,sel);
  var hdr = g?('对局 '+g.id):'未开局';
  var story = g?('第'+(g.night||0)+'夜 / 第'+(g.day||0)+'天'):'setup 阶段';
  /* ---- 布局尺寸：圆桌永远居中，两侧面板都是覆盖式抽屉 ---- */
  var vw = Math.max(320, window.innerWidth);
  var sideW = Math.min(440, Math.round(vw * 0.40));
  var chatW = Math.min(460, Math.round(vw * 0.44));
  var dmW = chatW; /* 私聊与公聊同宽 */
  var HAN = 30; /* 抽屉拉手宽度 + 间距 */
  var sideOpen = !S.hideSide, chatOpen = !S.hideChat, dmOpen = !!S.showDm;
  /* 主面板内容 */
  var sideInner = '<div class="drawerbody" data-keep="right">' + winBanner(g) + '<div class="tabs">'+tabsHtml+'</div>' + idCard + panel + '</div>';
  /* 拉手位置：展开面板的拉手贴在自己面板左缘；未展开的拉手保持在屏幕最右侧，不跟着挤到面板左边 */
  var hChatRight, hChatTop = '50%', hDmRight, hDmTop = '50%';
  if (chatOpen && dmOpen) {
    hChatRight = chatW;
    hDmRight = chatW + HAN + dmW;
  } else if (chatOpen) {
    hChatRight = chatW;   /* 公聊展开：公聊拉手贴其左缘 */
    hDmRight = 0;         /* 私聊未展开：留在屏幕最右侧 */
  } else if (dmOpen) {
    hDmRight = dmW;       /* 私聊展开：私聊拉手贴其左缘 */
    hChatRight = 0;       /* 公聊未展开：留在屏幕最右侧 */
  } else {
    hChatRight = 0;
    hDmRight = HAN;       /* 两个都收起：并排贴在屏幕最右侧 */
  }
  var dmRight = dmOpen ? (chatOpen ? chatW + HAN : 0) : 0;
  var dmRound = (chatOpen && dmOpen) ? ' roundright' : '';
  $('#app').innerHTML =
    '<header><span class="logo">染</span><span class="header-title">血染钟鱼 · 魔典</span><span class="sub">'+hdr+'</span><span class="version">v'+VERSION+'</span></header>' +
    '<div class="layout'+(sideOpen?' side-open':'')+(chatOpen?' chat-open':'')+(dmOpen?' dm-open':'')+'">' +
      '<div class="left">'+ cornerDock(g) +'<div class="table" id="table">'+
        '<div class="center-badge"><div class="phase">'+(PHZH[cur]||cur)+'</div>'+
        '<div class="scriptline">'+(g&&g.script?esc(g.script):(S.script&&S.script.name?esc(S.script.name):'未选剧本'))+'</div>'+
        '<div class="story">'+story+'</div>'+
        ((S.showTimer !== false && g && g.phase==='day' && g.dayStarted) ? ('<div class="daytimer" id="dayTimer">白天 '+ dayClock(g) +'</div>') : '')+
        '</div>'+
      '</div></div>' +
      /* 左侧栏：抽屉，覆盖在圆桌上方 */
      '<aside class="drawer side" style="width:'+sideW+'px;transform:translateX('+(sideOpen?'0':'-100%')+')">'+ sideInner +'</aside>' +
      '<button class="handle h-side" onclick="toggleSide()" title="'+(sideOpen?'收起侧栏':'展开侧栏')+'" style="left:'+(sideOpen?sideW:0)+'px;top:50%">'+ vlabel('侧边栏', sideOpen?'‹':'›') +'</button>' +
      /* 公聊栏 + 私聊栏：两个抽屉，都在右侧 */
      '<aside class="drawer chat" style="width:'+chatW+'px;right:0;transform:translateX('+(chatOpen?'0':'100%')+')">'+ chatPanel(g) +'</aside>' +
      '<aside class="drawer dm'+dmRound+'" style="width:'+dmW+'px;right:'+dmRight+'px;transform:translateX('+(dmOpen?'0':'100%')+')">'+ dmPanel(g) +'</aside>' +
      '<button class="handle h-chat'+(S.chatUnread?' unread':'')+'" onclick="toggleChat()" title="'+(chatOpen?'收起公聊':'展开公聊')+'" style="right:'+hChatRight+'px;top:'+hChatTop+'">'+ vlabel('公聊栏', chatOpen?'›':'‹') +'</button>' +
      '<button class="handle h-dm'+(S.dmUnread?' unread':'')+'" onclick="toggleDm()" title="'+(dmOpen?'收起私聊':'展开私聊')+'" style="right:'+hDmRight+'px;top:'+hDmTop+'">'+ vlabel('私聊栏', dmOpen?'›':'‹') +'</button>' +
    '</div>';
    drawTable(seats,g);
  fitBubbles();
  restoreScroll(keep);
}
/* 气泡字数太多时自动缩小字号来适应固定大小的气泡：
   从 11px 起逐级降到 7.5px；仍放不下就裁掉剩余内容并加省略号，保证永远不出框。 */
/* 气泡开关关掉时，直接不渲染（drawTable / stBox 里也做了判断） */
function fitBubbles(){
  var list = document.querySelectorAll('.bubble');
  if (!list || !list.length) return;
  /* 先做一次边界收敛：气泡不允许超出圆桌框，也不允许压到圆桌中心 */
  var box = document.getElementById('table');
  var br = box ? box.getBoundingClientRect() : null;
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
    /* 上下左右都限制在圆桌范围内：贴边时把气泡整体往里推 */
    if (br) {
      var wrap = el.parentNode;
      wrap.style.transform = 'translateX(-50%)';
      var wr = wrap.getBoundingClientRect();
      var dx = 0;
      if (wr.left < br.left + 4) dx = (br.left + 4) - wr.left;
      else if (wr.right > br.right - 4) dx = (br.right - 4) - wr.right;
      if (dx) wrap.style.transform = 'translateX(calc(-50% + ' + Math.round(dx) + 'px))';
      /* 顶部放不下就改挂到座位下方，避免出框 */
      var seatEl = wrap.parentNode;
      var sr = seatEl ? seatEl.getBoundingClientRect() : null;
      if (sr && wr.top < br.top + 2) {
        wrap.classList.add('below');
      } else {
        wrap.classList.remove('below');
      }
    }
    /* 20 秒后自动淡出（设置里可关） */
    if (S.chatFade !== false) {
      var age = parseFloat(el.getAttribute('data-age') || '0');
      if (age >= 20) el.classList.add('faded');
      else setTimeout(function(node){ if (node && node.parentNode) node.classList.add('faded'); }, Math.max(0, (20 - age) * 1000), el);
    }
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
  /* 只显示最近一条：有新发言就替换掉上一条，避免头像上方堆成一片 */
  return msgs.slice(-1);
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
    var bub = (S.showBubbles === false) ? '' : bubblesFor(i).map(bubHtml).join('');
    el.innerHTML = (bub ? '<div class="bubbles">'+bub+'</div>' : '') +
      '<div class="seatnum" style="background:'+seatColor(i)+';color:#12100c">'+(i+1)+'</div><div class="token">'+esc(Array.from(s.name||'').slice(0,2).join(''))+(dead?'<span class="demontag">✝</span>':'')+'</div>'+
      '<div class="nameline"><div class="name">'+s.name+'</div><div class="role">'+role+'</div><div class="markers">'+marks+'</div></div>';
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
    toTxt = '<span class="dmto"> → ' + m.to.map(function(x){
      return (x === 'storyteller') ? '说书人' : ((x+1) + ' 号');
    }).join('、') + '</span>';
  }
  var age = 0;
  try { age = Math.max(0, (Date.now() - new Date(m.t).getTime()) / 1000); } catch(e){ age = 0; }
  return '<div class="bubble'+(isDm?' dm':'')+(age>=20?' faded':'')+'" data-age="'+age.toFixed(1)+'">'+(isDm?'<span class="dmtag">私聊</span>':'')
    + hlMentions(esc(m.text), seatLookup(S.game)) + toTxt + '</div>';
}
function stBubbles(){
  if (S.showBubbles === false) return '';
  var msgs = (S.chatMsgs || []).filter(function(m){ return m.from === 'storyteller'; });
  if (!msgs.length) return '';
  return '<div class="bubbles stbub">'+ msgs.slice(-1).map(bubHtml).join('') +'</div>';
}
function stBox(g){
  var st = (g && g.storyteller) || { type:(meZone()==='story'?'player':'agent'), name:(meZone()==='story'?'我':'说书人Agent') };
  var isMe = (g ? st.type === 'player' : meZone()==='story');
  return '<div class="stbox" data-zone="story" onclick="if(S.holdMe){dropMe(\'story\');}">'+
    stBubbles() +
    '<div class="sttoken">'+(isMe?'我':'AI')+'</div>'+
    '<div class="stname">'+esc(st.name||'说书人')+'</div><div class="strole">说书人</div></div>';
}
function specBox(){
  var on = meZone()==='spectator';
  return '<div class="specbox'+(on?' on':'')+'" data-zone="spectator" onclick="if(S.holdMe){dropMe(\'spectator\');}">'+
    '<span class="speclabel">旁观席</span><span class="specdesc">'+(on?'你在这里':'空')+'</span></div>';
}
/* 左上角竖向停靠区：说书人在上、旁观席在下，两者各占一行不会重叠 */
function cornerDock(g){
  return '<div class="dock">' + stBox(g) + specBox() + '</div>';
}
/* 左栏（聊天）收起 / 展开 */
/* 右侧面板栏收起 / 展开 */
/* 抽屉拉手的竖排文字：上面是文字，下面是箭头（‹ 收起 / › 展开） */
function vlabel(text, arrow){
  return '<span class="hlabel">'+text+'</span><span class="harrow">'+arrow+'</span>';
}
function toggleSide(){
  S.hideSide = !S.hideSide;
  savePrefs();
  render(true);
  setTimeout(placeMe, 0);
}
/* 侧边栏不透明度（0–100，默认 75） */
function setPanelAlpha(val){
  var v = Number(val);
  if (!isFinite(v)) return;
  S.panelAlpha = Math.max(0, Math.min(100, v));
  var lab = document.getElementById('panelAlphaVal');
  if (lab) lab.textContent = Math.round(S.panelAlpha) + '%';
  savePrefs();
  applyPanelAlpha();
}
function applyPanelAlpha(){
  var a = (typeof S.panelAlpha === 'number' ? S.panelAlpha : 40) / 100;
  document.body.style.setProperty('--panel-alpha', a.toFixed(3));
}
function toggleChat(){
  S.hideChat = !S.hideChat;
  if (!S.hideChat) S.chatUnread = 0;
  savePrefs();
  render(true);
  setTimeout(placeMe, 0);
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
  var pills = '';
  return '<div class="section"><h3>建局配置</h3>'+
    '<p class="muted">先在这里定下剧本、人数、谁是「你」以及各座位的昵称；每个座位用哪个模型请到「AI 设置」页配置。</p>'+
    '<div class="row">剧本：<select onchange="S.script=S.scripts.find(x=>x.name===this.value);if(S.script)resizeSeats(S.seats.length);savePrefs();render()">'+scripts+'</select></div>'+
    '<div class="row">人数：<input id="seatCount" type="number" min="'+((S.script&&S.script.minPlayers)||5)+'" max="'+((S.script&&S.script.maxPlayers)||12)+'" value="'+S.seats.length+'" style="width:60px" title="人数范围由所选剧本决定">'+
    '<button onclick="resizeSeats(+document.getElementById(\'seatCount\').value);render()">应用人数</button></div>'+
    '<div class="row">你的位置：<b>'+meZoneLabel()+'</b></div>'+
    (S.game
      ? '<p class="muted">本局已开始，「你」的位置已写入对局、不可再改；要换身份请新建一局。</p>'
      : '<p class="muted">按住「你」拖到目标位置松手即可（也可点一下拿起、再点目标位置）。默认每个人都是 AI。把「你」放到某个座位，你就成为那位玩家；放到说书人圆圈，你就当说书人；放到旁观席，你就只是看。其余座位都由 Agent 扮演。</p>')+
    '<div class="row"><button id="startBtn" onclick="startGame()" '+(S.starting?'disabled':'')+'>'+(S.starting?'正在创建并进入第一夜...':'创建对局并进入第一夜')+'</button></div>'+
    (S.startError?('<div class="errbox">开局失败：'+S.startError+'（可直接重试）</div>'):'')+
    '</div>'+
    nickPanel(S.seats);
}
/* 昵称配置：只在建局页，负责「这个座位叫什么」 */
function nickPanel(seats){
  if (!seats || !seats.length) return '';
  var rows = seats.map(function(s,i){
    var mine = S.game ? (s.type==='human') : (meZone()==='seat' && S.me.seat===i);
    return '<div class="smrow"><span class="smno">'+(i+1)+'</span>'+
      '<input class="smname-input" value="'+esc(s.name||('座位'+(i+1)))+'" onchange="renameSeat('+i+',this.value)">'+
      (mine ? '<span class="muted">你</span>' : '')+
      '</div>';
  }).join('');
  var stLine = '<div class="row">说书人的名称：<input class="smname-input" value="'+esc(S.game?((S.game.storyteller&&S.game.storyteller.name)||'说书人'):(S.storyName||'说书人'))+'" onchange="'+(S.game?'renameStory(this.value)':'S.storyName=this.value;savePrefs()')+'"></div>';
  return '<div class="section"><h3>昵称</h3>'+ stLine +
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
    storyLine = '<div class="row">说书人的名称：<input class="smname-input" value="'+esc(st.name||'说书人')+
        '" onchange="renameStory(this.value)"></div>'
      + ((st.type === 'agent')
        ? ('<div class="row">说书人的模型：'+modelSelect('aiStSel', st.provider, st.model,
            'var k=this.value;var q=splitKey(k);saveStoryModel(q.provider,q.model)')+'</div>')
        : '<p class="muted">本局说书人是你（真人），不需要模型。</p>');
  } else if (meZone() !== 'story') {
    storyLine = '<div class="row">说书人的名称：<input class="smname-input" value="'+esc(S.storyName||'说书人')+
        '" onchange="S.storyName=this.value;savePrefs()"></div>'
      + '<div class="row">说书人的模型：'+modelSelect('aiStorySel', S.storyProvider, S.storyModel,
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
async function renameStory(name){
  name = String(name||'').trim();
  if (!name) return;
  if (!S.game) { S.storyName = name; savePrefs(); render(true); return; }
  var st = S.game.storyteller || {};
  try {
    await api('seatModel',{id:S.game.id,seat:'storyteller',provider:st.provider||'',model:st.model||'',name:name});
    S.game = await api('game',gameReq());
  } catch(e){ S.startError = '改名失败：'+((e&&e.message)||e); }
  render(true);
}
async function startGame(){
  if (S.starting) return;
  var zone = meZone();
  var seatsNew = S.seats.map(function(s,i){
    return { seat:i, name:s.name, type:(zone==='seat' && S.me.seat===i) ? 'human' : 'agent', provider:s.provider||'', model:s.model||'' };
  });
  var cfg = { script:S.script.name, seats:seatsNew, aiStyle:(S.aiStyle||'mild_fun'),
    storyteller:(zone==='story')
      ? {type:'player',name:'我'}
      : {type:'agent',name:(S.storyName||'说书人'),provider:S.storyProvider||'',model:S.storyModel||''} };
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
    savePrefs();
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
  return '<div class="idcard me"><b>你是 '+(mySeatInGame(g)+1)+' 号 '+((g.seats[mySeatInGame(g)]||{}).name||'')+'</b>'+
    '<div class="idline">角色：<b>'+role+'</b>'+fac+' '+(v.alive===false?'（已出局，仍可发言）':'')+'</div>'+ab+'</div>';
}
/* 终局横幅 */
function winBanner(g){
  if(!g || !g.win || !g.win.over) return '';
  var good = g.win.side === 'good';
  return '<div class="winbanner '+(good?'good':'evil')+'">'+
    '<div class="wintitle">'+(good?'善良阵营胜利':'邪恶阵营胜利')+'</div>'+
    '<div class="muted">'+(g.win.reason||'')+'</div></div>';
}
/* 游戏页：先说明你是谁，再看当前选中座位的详情。
   说书人给你的信息不再单独列板块，而是说书人亲自私聊你（见「私聊」浮层）。 */
function gamePanel(seats,sel){
  return myIdentityPanel() + seatPanel(seats,sel);
}
function seatPanel(seats,sel){
  var ro = S.game && !canControl();
  if (ro) return '<div class="section"><h3>'+(S.selSeat+1)+' 号 · '+sel.name+'</h3>'+
    '<p class="muted">旁观模式：只能查看，不能改名、换模型或替 Agent 发言。</p></div>';
  return '<div class="section"><h3>'+(S.selSeat+1)+' 号 · '+sel.name+'</h3>'+
    '<div class="row">身份：<b>'+((meZone()==='seat'&&S.me.seat===S.selSeat)?'你（真人玩家）':'Agent 玩家')+'</b>'+
    '</div>'+
    '<div class="row">名字：<input value="'+sel.name+'" onchange="renameSeat(S.selSeat,this.value)"></div>'+
    '<div class="row">模型：'+(sel.type==='human'?'<b>你</b>（无需模型）':modelSelect('seatModelSel',sel.provider,sel.model,'var k=this.value;var q=splitKey(k);saveSeatModel(S.selSeat,q.provider,q.model)'))+'</div>'+
    '</div><p class="muted">点击围坐圈上的座位可切换选中。每个座位可单独指定模型，留空则跟随默认模型。</p>'+ roundSection();
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
  var phase = (S.game||{}).phase;
  /* 运行中只显示「正在做什么」的公开流程描述，绝不暴露说书人手里的内容 */
  var doing = '';
  if (phase === 'night') doing = '正在按夜间顺序核对在场角色、唤醒角色、整理要私下告知的内容，并结算死亡与状态。';
  else if (phase === 'day' || phase === 'nomination' || phase === 'vote') doing = '正在梳理场上的讨论、权衡善良与邪恶双方的局势，判断是否发起提名处决。';
  else doing = '正在主持这一阶段。';
  var out = '';
  if (st.running) out = '<div class="muted">说书人正在思考：'+doing+'</div>';
  else if (res){
    /* 只展示公开结果：说出口的话、死亡人数、进入的阶段、投票；不显示私有信息与标记数量 */
    var pub = [];
    if (res.applied && res.applied.deaths) pub.push('本阶段有 '+res.applied.deaths+' 人出局');
    if (res.applied && res.applied.vote) pub.push('投票：'+res.applied.vote);
    if (res.applied && res.applied.phase) pub.push('进入 '+res.applied.phase);
    out = '<div class="log" data-keep="storyLog" style="max-height:260px">' +
      (res.say?('<div><b>说书人</b> '+esc(res.say)+'</div>'):'') +
      (pub.length?('<div class="muted">'+esc(pub.join(' · '))+'</div>'):'') +
      '</div>';
  } else if (st.error) out = '<div class="errbox">说书人出错：'+esc(st.error)+'</div>';
  return '<div class="section"><h3>Agent 说书人主持</h3>' +
    '<p class="muted">本局说书人由 Agent 担任，它会依规则主持当前阶段。下面只显示它公开的动作，私密信息不会显示在这里。</p>' +
    (iAmStoryteller(S.game) ? '<div class="row"><button onclick="runStory()" '+(st.running?'disabled':'')+'>'+(st.running?'进行中…':'让说书人 Agent 主持这一阶段')+'</button></div>' : '') +
    out+'</div>';
}

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
/* 白天已过去多久（说书人与玩家都能看到） */
function dayClock(g){
  if (!g || !g.dayStarted) return '0:00';
  var ms = Date.now() - new Date(g.dayStarted).getTime();
  if (!(ms > 0)) ms = 0;
  var sec = Math.floor(ms / 1000);
  var m = Math.floor(sec / 60), ss = sec % 60;
  return m + ':' + (ss < 10 ? '0' : '') + ss;
}
/* 每秒刷新一次计时器，不重建整页 */
setInterval(function(){
  var el = document.getElementById('dayTimer');
  if (el && S.game && S.game.phase === 'day') el.textContent = '白天 ' + dayClock(S.game);
}, 1000);
/* 作弊页：控制他人发言、强行改状态。只给玩家当说书人/旁观时用；对局中也可以用来救场。 */
function cheatPanel(seats, sel){
  var g = S.game;
  if (!g) return '<div class="section"><h3>作弊</h3><p class="muted">还没有对局。</p></div>';
  var roleOpts = '<option value="">—</option>' + (S.script ? S.script.roles : []).map(function(r){ return '<option>'+r+'</option>'; }).join('');
  var seatOpts = seats.map(function(s,i){ return '<option value="'+i+'"'+(i===S.selSeat?' selected':'')+'>'+(i+1)+' 号 '+esc(s.name)+'</option>'; }).join('');
  var seatRow = '<div class="row">目标座位：<select id="cheatSeat" onchange="S.selSeat=+this.value;render()">'+seatOpts+'</select></div>';
  var h = '<div class="section"><h3>作弊</h3><p class="muted">这里的操作会直接写进对局，说书人 Agent 不会收到通知。仅在救场或测试时使用。</p>'+seatRow;
  h += '<div class="cheatgrp"><h4>发言与驱动</h4>'+
    '<div class="row"><input id="cheatSay" class="smname-input" placeholder="用这个座位发一条公开消息">'+
    '<button onclick="cheatSpeak()">发言</button></div>'+
    '<div class="row"><button onclick="cheatRound()">让 AI 们随机接一轮</button>'+
    '<button onclick="cheatStory()">让说书人主持这一阶段</button></div></div>';
  h += '<div class="cheatgrp"><h4>角色与信息</h4>'+
    '<div class="row">分配角色：<select id="cheatRole">'+roleOpts+'</select>'+
    '<button onclick="api(\'role\',{id:S.game.id,seat:S.selSeat,role:document.getElementById(\'cheatRole\').value}).then(refresh)">分配</button></div>'+
    '<div class="row">下发私有信息：<input id="cheatInfo" class="smname-input" placeholder="说书人私聊发给该座位">'+
    '<button onclick="api(\'info\',{id:S.game.id,seat:S.selSeat,text:document.getElementById(\'cheatInfo\').value}).then(refresh)">发送</button></div></div>';
  h += '<div class="cheatgrp"><h4>死亡与终局</h4>'+
    '<div class="row"><button onclick="if(confirm(\'确定处决该座位？处决后会立刻进入夜晚。\'))api(\'execute\',{id:S.game.id,seat:S.selSeat}).then(refresh)">处决该座位（立刻入夜）</button></div>'+
    '<div class="row"><button onclick="if(confirm(\'确定杀死该座位？普通死亡不会立刻入夜。\'))api(\'kill\',{id:S.game.id,seat:S.selSeat,reason:\'作弊杀死\'}).then(refresh)">杀死该座位（不立即入夜）</button></div>'+
    '<div class="row"><button onclick="if(confirm(\'确定宣布本局结束？\'))doEndGame()">宣布终局</button></div></div>';
  h += '<div class="cheatgrp"><h4>说书人日志</h4>'+ storyLogHtml() +'</div>';
  h += '</div>';
  return h;
}
async function cheatSpeak(){
  var inp = document.getElementById('cheatSay'); if(!inp) return;
  var txt = inp.value; if(!txt.trim()) return;
  try { var r = await api('say',{id:S.game.id, seat:S.selSeat, text:txt, channel:'town', to:[]}); if(r&&r.ok===false) S.startError=r.error; } catch(e){ S.startError=String(e&&e.message||e); }
  inp.value=''; await loadChat(); render();
}
async function cheatRound(){ await reactAll(); }
async function cheatStory(){ await runStory(); }
/* 说书人日志：把它的完整思考与操作按时间顺序摊开，作弊页实时查看 */
function storyLogHtml(){
  var rows = S.storyLog;
  if (!rows) return '<p class="muted">正在读取说书人的日志…</p>';
  if (!rows.length) return '<p class="muted">这一局说书人还没有留下日志（它可能还没开始思考）。</p>';
  var KIND = { think:'思考', log:'操作', actions:'操作', speech:'发言' };
  var body = rows.map(function(r){
    var t = String(r.t || '').replace('T',' ').slice(11,19);
    var k = KIND[r.kind] || r.kind || '';
    var txt = r.text || '';
    if (!txt && r.data) {
      var d = r.data;
      if (d.kind) txt = d.kind + (d.target != null ? ' → ' + d.target : '');
      if (d.text) txt = d.text;
    }
    return '<div class="stlogrow"><span class="stlogt">'+esc(t)+'</span><span class="stlogk">'+esc(k)+'</span><span class="stlogx">'+esc(String(txt))+'</span></div>';
  }).join('');
  return '<div class="stlog" data-keep="stlog">'+body+'</div>';
}
async function loadStoryLog(){
  if (!S.game) return;
  try { S.storyLog = await api('storyLog', { id: S.game.id }); S.storyLogAt = Date.now(); }
  catch(e){ S.storyLog = []; }
}
/* 设置页：所有开关分组整理 */
function settingsPanel(){
  function sw(key,label,desc){
    return '<div class="setrow"><label><input type="checkbox" '+(S[key]!==false?'checked':'')
      +' onchange="setOpt(\''+key+'\',this.checked)"> '+label+'</label>'
      + (desc?('<div class="muted">'+desc+'</div>'):'') + '</div>';
  }
  var bgBox = '<div id="bgopts" style="'+(S.bgOn===false?'display:none':'')+'">'+
      '<div class="setrow"><div>背景模糊度 <span class="setval" id="bgBlurVal">'+(S.bgBlur==null?7.5:S.bgBlur)+'%</span></div>'+
        '<input type="range" min="0" max="20" step="0.5" value="'+(S.bgBlur==null?7.5:S.bgBlur)+'" oninput="setBg(\'bgBlur\',this.value)"></div>'+
      '<div class="setrow"><div>背景亮度 <span class="setval" id="bgBrightVal">'+(S.bgBright==null?20:S.bgBright)+'%</span></div>'+
        '<input type="range" min="0" max="100" step="1" value="'+(S.bgBright==null?20:S.bgBright)+'" oninput="setBg(\'bgBright\',this.value)">'+
        '<div class="muted">50% 为原图亮度；越高越亮，100% 纯白，0% 纯黑。</div></div>'+
    '</div>';
  var styleSel = modelStyleSelect();
  return '<div class="section"><h3>设置 · 外观</h3>'+
      '<div class="setrow"><label><input type="checkbox" '+(S.bgOn!==false?'checked':'')+' onchange="toggleBg(this)"> 显示背景图</label>'+
      '<div class="muted">白天与夜晚各有一张背景，切换阶段时自动渐变过渡；开启后界面底色透明，只保留圆桌。</div></div>'+
      bgBox+
      '<div class="setrow"><div>侧边栏不透明度 <span class="setval" id="panelAlphaVal">'+Math.round(S.panelAlpha==null?40:S.panelAlpha)+'%</span></div>'+
        '<input type="range" min="0" max="100" step="1" value="'+(S.panelAlpha==null?40:S.panelAlpha)+'" oninput="setPanelAlpha(this.value)">'+
        '<div class="muted">作用于左右两侧面板、公聊栏、说书人与旁观席小框、私聊浮层。100% 为不透明。</div></div>'+
      sw('nightTheme','夜晚切换为冷色主题','进入夜晚/日落时界面变成蓝紫色。')+
      sw('showTimer','白天显示计时器','圆桌中心左下角显示「白天 分:秒」。')+
      sw('showBubbles','头像上方显示聊天气泡','只显示最近一条，20 秒后自动淡出。')+
      sw('showScriptLine','圆桌中心显示剧本名','')+
    '</div>'+
    '<div class="section"><h3>设置 · AI 风格</h3>'+styleSel+'</div>'+
    '<div class="section"><h3>设置 · 自动流程</h3>'+
      sw('autoChat','进入白天时自动讨论','阶段切到白天时，AI 们自动接一轮话。')+
      sw('autoStory','进入夜晚时自动主持','阶段切到夜晚时，Agent 说书人自动结算这一夜。')+
    '</div>'+
    '<div class="section"><h3>设置 · 聊天</h3>'+
      sw('chatFade','气泡自动淡出','最新头像气泡停留 20 秒后渐隐，避免长期挡视线。')+
      '<div class="setrow"><div>私聊浮层</div><div class="row">'+
        '<button class="pill'+(S.showDm?' on':'')+'" onclick="toggleDm()">'+(S.showDm?'收起':'展开')+'</button></div>'+
        '<div class="muted">私聊浮层默认盖在圆桌上，不挤压其它面板。</div></div>'+
    '</div>'+
    '<div class="section"><h3>设置 · 重置</h3>'+
      '<div class="row"><button onclick="if(confirm(\'清除本机保存的所有建局偏好？\')){localStorage.removeItem(PREF_KEY);location.reload();}">清除本机偏好</button></div>'+
      '<div class="muted">会清掉剧本、人数、昵称、模型、外观设置，回到默认。</div></div>';
}
/* AI 说话风格：7 档，从极端严肃到极端娱乐；把选中的档位写进 S.aiStyle，
   开局后由后端 state.aiStyle 注入所有 Agent 的提示词（含说书人）。 */
var AI_STYLE_LIST = [
  ['super_serious','极端严肃'],['serious','严肃'],['mild_serious','轻度严肃'],
  ['neutral','不干预'],['mild_fun','轻度娱乐'],['fun','娱乐'],['super_fun','极端娱乐']
];
function modelStyleSelect(){
  var cur = S.aiStyle || 'mild_fun';
  var opts = AI_STYLE_LIST.map(function(p){
    return '<option value="'+p[0]+'"'+(p[0]===cur?' selected':'')+'>'+p[1]+'</option>';
  }).join('');
  var tail = (S.game && S.game.id)
    ? '<div class="muted">本局已开始：改动会立刻对本局所有 AI 生效。</div>'
    : '<div class="muted">只影响之后创建的对局；也可以在建局页调整。</div>';
  return '<div class="setrow"><div>AI 说话风格</div>'
    +'<select onchange="setAiStyle(this.value)">'+opts+'</select>'
    +'<div class="muted">极左更严肃理性，极右更轻松娱乐；不影响推理内容，只影响语气。</div>'
    + tail + '</div>';
}
async function setAiStyle(key){
  S.aiStyle = key || 'mild_fun';
  savePrefs();
  if (S.game && S.game.id) {
    try { await api('setStyle',{ id:S.game.id, style:S.aiStyle }); }
    catch(e){ S.startError = String((e && e.message) || e); }
  }
  render(true);
}

/* 背景：白天/夜晚两张图叠在一起，靠 body.bgnight 切 opacity 实现渐变；
   亮度以 50% 为原图，100% 纯白、0% 纯黑（用白色/黑色蒙层实现，不做计算）。 */
function applyBg(){
  var on = S.bgOn !== false;
  var body = document.body;
  body.classList.toggle('hasbg', on);
  body.classList.toggle('nobg', !on);
  var blur = (typeof S.bgBlur === 'number' && isFinite(S.bgBlur)) ? S.bgBlur : 7.5;
  var bright = (typeof S.bgBright === 'number' && isFinite(S.bgBright)) ? S.bgBright : 20;
  body.style.setProperty('--bg-blur', blur + 'px');
  /* 50% = 原图：亮度用 filter 保持 1，靠白色蒙层提亮、黑色蒙层压暗 */
  body.style.setProperty('--bg-bright', '1');
  if (bright >= 50){
    var w = (bright - 50) / 50;   /* 0 → 1 纯白 */
    body.style.setProperty('--bg-tint', 'rgba(255,255,255,' + (w * 0.92).toFixed(3) + ')');
  } else {
    var d = (50 - bright) / 50;   /* 0 → 1 纯黑 */
    body.style.setProperty('--bg-tint', 'rgba(0,0,0,' + (d * 0.32).toFixed(3) + ')');
  }
}
/* 设置页里的滑块 */
function setBg(key, val){
  val = Number(val);
  if (!isFinite(val)) return;
  S[key] = val;
  var lab = document.getElementById(key + 'Val');
  if (lab) lab.textContent = val + (key === 'bgBlur' ? '%' : '%');
  savePrefs();
  applyBg();
}
function toggleBg(el){
  S.bgOn = !!el.checked;
  savePrefs();
  applyBg();
  var box = document.getElementById('bgopts');
  if (box) box.style.display = S.bgOn ? '' : 'none';
}
function setOpt(key, val){
  S[key] = val;
  if (key === 'fontScale') S.fontScale = Number(val) || 1;
  savePrefs();
  render(true);
  setTimeout(function(){ if (typeof placeMe === 'function') placeMe(); }, 0);
}
function roundSection(){
  if(!S.game) return '';
  if(!canControl()) return '';
  var st = S.round || {running:false,done:0,total:0,current:null,waiting:[],results:[]};
  var waiting = st.waiting || [];
  var thinking = st.running ? Math.max(0, st.total - st.done) : 0;
  return '<div class="section"><h3>AI 玩家</h3>'+
    (st.running ? ('<div class="muted">目前 ' + thinking + ' 个 Agent 正在思考…</div>') : '') +
    '</div>';
}
/* 手动让 AI 自己聊一轮（不需要玩家先说话） */
function roundSectionStart(){ reactAll(); }
/* 公聊后：唤醒所有存活 Agent，各自决定要不要接话（mode:'react'） */
async function reactAll(){
  S.lastAutoChat = Date.now();
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
  if (g.storyteller) {
    S.storyName = g.storyteller.name || '说书人';
    S.storyProvider = g.storyteller.provider || '';
    S.storyModel = g.storyteller.model || '';
  }
  if (g.storyteller && g.storyteller.type === 'player'){ S.me = { zone:'story', seat:0 }; return; }
  for (var i=0;i<(g.seats||[]).length;i++){
    if (g.seats[i].type === 'human'){ S.me = { zone:'seat', seat:i }; return; }
  }
  S.me = { zone:'spectator', seat:0 };
}
/* 只重画聊天记录：输入时也能看到新消息，不销毁输入框 */
/* @ 提及候选：座位名 + 说书人。用原生 datalist，输入 @ 后浏览器会给候选 */
/* ---------- @ 提及：自绘候补下拉（只有输入框里真的打了 @ 才弹出） ---------- */
function mentionCandidates(g, q){
  var out = [];
  q = String(q || '');
  (g && g.seats ? g.seats : []).forEach(function(s, i){
    var nm = s.name || ('座位' + (i + 1));
    if (q && nm.indexOf(q) < 0) return;
    out.push({ name: nm, label: (i + 1) + ' 号 · ' + nm, color: seatColor(i) });
  });
  var stn = (g && g.storyteller && g.storyteller.name) || '';
  if (stn && (!q || stn.indexOf(q) >= 0)) out.push({ name: stn, label: '说书人 · ' + stn, color: '#c9a227' });
  return out.slice(0, 8);
}
function showMentionPop(which){
  var g = S.game;
  var el = document.getElementById(which === 'dm' ? 'dmText' : 'chatText');
  var pop = document.getElementById(which === 'dm' ? 'mentionPop-dm' : 'mentionPop-town');
  if (!pop) return;
  var val = el ? el.value : '';
  var pos = (el && typeof el.selectionStart === 'number') ? el.selectionStart : String(val).length;
  var before = String(val).slice(0, pos);
  var m = /@([^\s@]{0,12})$/.exec(before);
  if (!g || !m){ pop.style.display = 'none'; pop.innerHTML = ''; S.mentionOpen = false; return; }
  var list = mentionCandidates(g, m[1]);
  S.mentionList = list; S.mentionWhich = which;
  if (!list.length){ pop.style.display = 'none'; pop.innerHTML = ''; S.mentionOpen = false; return; }
  S.mentionOpen = true;
  pop.innerHTML = list.map(function(c, i){
    return '<div class="mitem" onmousedown="event.preventDefault()" onclick="pickMentionIdx(' + i + ')">'
      + '<span class="mdot" style="background:' + c.color + '"></span>' + esc(c.label) + '</div>';
  }).join('');
  pop.style.display = 'block';
}
function pickMentionIdx(i){
  var c = (S.mentionList || [])[i];
  if (!c) return;
  var which = S.mentionWhich || 'town';
  var el = document.getElementById(which === 'dm' ? 'dmText' : 'chatText');
  var cur = el ? el.value : '';
  var pos = (el && typeof el.selectionStart === 'number') ? el.selectionStart : cur.length;
  var headTxt = cur.slice(0, pos).replace(/@([^\s@]{0,12})$/, '@' + c.name + ' ');
  var nv = headTxt + cur.slice(pos);
  if (which === 'dm') S.dmDraft = nv; else S.chatDraft = nv;
  if (el){ el.value = nv; el.focus(); try { el.setSelectionRange(headTxt.length, headTxt.length); } catch(e){} }
  var pop = document.getElementById(which === 'dm' ? 'mentionPop-dm' : 'mentionPop-town');
  if (pop){ pop.style.display = 'none'; pop.innerHTML = ''; }
  S.mentionOpen = false;
}
function chatInput(el, which){
  S.activeInput = which || 'town';
  if (which === 'dm') S.dmDraft = el.value; else S.chatDraft = el.value;
  showMentionPop(which);
}
function chatKey(ev, which){
  if (ev.key === 'Escape'){
    var pop = document.getElementById(which === 'dm' ? 'mentionPop-dm' : 'mentionPop-town');
    if (pop){ pop.style.display = 'none'; pop.innerHTML = ''; S.mentionOpen = false; }
    return;
  }
  if (ev.key === 'Enter'){ if (which === 'dm') sendDm(); else sendChat(); }
}
function blurInput(){ if (S.pendingRender) render(true); }
function insertMention(name){
  var which = S.activeInput || 'town';
  if (name && typeof name === 'object'){ which = name.which || which; name = name.name; }
  var el = document.getElementById(which === 'dm' ? 'dmText' : 'chatText');
  var cur = el ? el.value : (which === 'dm' ? (S.dmDraft || '') : (S.chatDraft || ''));
  var add = '@' + name + ' ';
  var pos = (el && typeof el.selectionStart === 'number') ? el.selectionStart : cur.length;
  var nv = cur.slice(0, pos) + add + cur.slice(pos);
  if (which === 'dm') S.dmDraft = nv; else S.chatDraft = nv;
  if (el){ el.value = nv; el.focus(); try { el.setSelectionRange(pos + add.length, pos + add.length); } catch(e){} }
}

/* ---------- 消息渲染：按频道分开，公聊 / 私聊各一个侧栏 ---------- */
function chatMsgsHtml(g, channel){
  if (!g) return '<div class="muted">暂无消息</div>';
  var seats = g.seats || [];
  var lk = seatLookup(g);
  var stName = (g.storyteller && g.storyteller.name) || '说书人';
  var list = (S.chatMsgs || []).filter(function(m){
    if (!channel) return true;
    return ((m.channel === 'private') ? 'private' : 'town') === channel;
  });
  var h = list.map(function(m){
    var who = (m.from === 'storyteller')
      ? stBadge(stName)
      : seatBadge(m.from, seats[m.from] ? seats[m.from].name : '');
    var cls = m.channel === 'private' ? 'dm' : 'town';
    var tag = m.channel === 'private' ? '<span class="mtag">私聊</span>' : '';
    var toTxt = '';
    if (m.channel === 'private' && m.to && m.to.length){
      toTxt = '<span class="dmto"> → ' + m.to.map(function(x){
        return (x === 'storyteller') ? '说书人' : ((x + 1) + ' 号' + (seats[x] ? ('·' + seats[x].name) : ''));
      }).join('、') + '</span>';
    }
    return '<div class="msg ' + cls + '"><span class="who">' + who + '</span>' + tag + toTxt
      + '<div class="mtext">' + hlMentions(esc(m.text), lk) + '</div></div>';
  }).join('');
  return h || '<div class="muted">' + (channel === 'private' ? '还没有私聊。' : '暂无消息') + '</div>';
}
function paintChat(){
  var cl = document.getElementById('chatLog');
  if (!cl) return;
  var nearBottom = (cl.scrollHeight - cl.scrollTop - cl.clientHeight) < 28;
  cl.setAttribute('data-count', String((S.chatMsgs || []).length));
  cl.innerHTML = chatMsgsHtml(S.game, 'town');
  if (nearBottom) { cl.scrollTop = cl.scrollHeight; S.chatSeen = (S.chatMsgs || []).length; }
}
function paintDm(){
  var dl = document.getElementById('dmLog');
  if (!dl) return;
  var nearBottom = (dl.scrollHeight - dl.scrollTop - dl.clientHeight) < 28;
  dl.innerHTML = chatMsgsHtml(S.game, 'private');
  if (nearBottom) dl.scrollTop = dl.scrollHeight;
}
function chatSelfLabel(g){
  if (iAmStoryteller(g)){
    return '说书人' + ((g.storyteller && g.storyteller.name) ? ('（' + esc(g.storyteller.name) + '）') : '');
  }
  var self = mySeatInGame(g);
  return (self + 1) + ' 号' + (g.seats[self] ? ('（' + esc(g.seats[self].name) + '）') : '');
}
function deadNote(g){
  if (iAmStoryteller(g) || !iAmPlayer(g)) return '';
  var self = mySeatInGame(g);
  return (g && g.alive && g.alive[self] === false) ? ' <span class="deadnote">已出局 · 仍可发言</span>' : '';
}

/* ---------- 公聊侧栏（最右列，只显示全员可见发言） ---------- */
function chatPanel(g){
  if (!g) return '<div class="chatempty muted">先在「建局」创建对局，这里会显示公聊。</div>';
  var ro = !iAmStoryteller(g) && !iAmPlayer(g);
  return '<div class="chatwrap"><h3>公聊</h3>'
    + '<div id="chatLog" class="log chatlog" data-keep="chatLog" data-count="' + ((S.chatMsgs || []).length) + '">' + chatMsgsHtml(g, 'town') + '</div>'
    + (ro
      ? '<p class="muted">旁观模式：只能阅读对话，不能发言。</p>'
      : '<div class="row chatinput"><input id="chatText" style="flex:1" placeholder="公开发言…（输入 @ 可以直接 @人）" value="' + esc(S.chatDraft || '') + '" oninput="chatInput(this,\'town\')" onfocus="S.activeInput=\'town\'" onblur="blurInput()" onkeydown="chatKey(event,\'town\')"><button onclick="sendChat()">发送</button></div>')
    + '<div id="mentionPop-town" class="mentionpop"></div>'
    + '<div id="chatMore" class="chatmore" onclick="jumpChatBottom()" style="display:none"></div>'
    + '</div>';
}

/* ---------- 私聊侧栏：浮在圆桌之上，不挤开其他框 ---------- */
function dmPanel(g){
  if (!g) return '';
  var seats = g.seats || [];
  var ro = !iAmStoryteller(g) && !iAmPlayer(g);
  var night = (g.phase === 'night');
  var selfIdx = iAmStoryteller(g) ? -1 : mySeatInGame(g);
  var who = '';
  for (var i = 0; i < seats.length; i++){
    if (i === selfIdx) continue;
    var on = S.dmTo.indexOf(String(i)) >= 0;
    who += '<button type="button" class="dmtab'+(on?' on':'')+'" onclick="pickDmTo(\''+i+'\')">'+(i+1)+' 号 '+esc(seats[i].name)+'</button>';
  }
  if (selfIdx !== -1){
    who += '<button type="button" class="dmtab'+(S.dmTo.indexOf('storyteller')>=0?' on':'')+'" onclick="pickDmTo(\'storyteller\')">说书人</button>';
  }
  var whoTargets = who; /* 夜晚也显示全部玩家标签，只是切到非说书人时不能发送 */
  var nightBlocked = night && (S.dmTo || []).some(function(x){ return x !== 'storyteller'; });
  var dmPlaceholder = nightBlocked ? '夜晚禁止玩家间私聊，只可与说书人私聊。' : '悄悄话…（输入 @ 可以直接 @人）';
  var dmDis = nightBlocked ? ' disabled' : '';
  return '<div class="dmcol"><div class="dmhead"><b>私聊</b></div>'
    + (ro ? '<p class="muted">旁观模式：只能阅读私聊。</p>'
      : (night
        ? '<div class="dmwho"><div class="dmtargets">' + whoTargets + '</div></div>'
        : '<div class="dmwho"><div class="dmtargets">' + who + '</div></div>'))
    + '<div id="dmLog" class="log chatlog dmLog">' + chatMsgsHtml(g, 'private') + '</div>'
    + (ro ? ''
      : '<div class="row chatinput"><input id="dmText" style="flex:1" placeholder="' + dmPlaceholder + '" value="' + esc(S.dmDraft || '') + '"' + dmDis + ' oninput="chatInput(this,\x27dm\x27)" onfocus="S.activeInput=\x27dm\x27" onblur="blurInput()" onkeydown="chatKey(event,\x27dm\x27)"><button onclick="sendDm()"' + dmDis + '>发送</button></div>')
    + '<div id="mentionPop-dm" class="mentionpop"></div>'
    + '</div>';
}
function pickDmTo(v){
  v = String(v);
  S.dmTo = (S.dmTo.length === 1 && S.dmTo[0] === v) ? [] : [v];
  render(true);
}
function toggleDmTo(el){
  var v = String(el.value);
  var at = S.dmTo.indexOf(v);
  if (el.checked && at < 0) S.dmTo.push(v);
  if (!el.checked && at >= 0) S.dmTo.splice(at, 1);
}
function toggleDm(){
  S.showDm = !S.showDm;
  if (S.showDm) S.dmUnread = 0;
  if (S.showDm && !(S.dmTo || []).length && S.game){
    S.dmTo = ['storyteller'];
  }
  render(true);
}
/* 私聊浮层：绝对定位盖在圆桌之上，展开/收起都不影响其它框的布局 */
function dmFloating(g){
  if (!g) return '';
  var btn = '<button class="dmfab' + (S.showDm ? ' on' : '') + '" onclick="toggleDm()" title="私聊">'
    + (S.showDm ? '× 收起私聊' : '私聊') + '</button>';
  return '<div class="dmbox' + (S.showDm ? ' open' : '') + '">' + btn
    + (S.showDm ? dmPanel(g) : '') + '</div>';
}

/* ---------- 发送 ---------- */
async function sendChat(){
  var inp = document.getElementById('chatText');
  var txt = inp ? inp.value : (S.chatDraft || '');
  if (!txt.trim()) return;
  var seat = iAmStoryteller(S.game) ? 'storyteller' : mySeatInGame(S.game);
  try {
    var r = await api('say', { id: S.game.id, seat: seat, text: txt, channel: 'town', to: [] });
    if (r && r.ok === false) { S.startError = r.error || '发送失败'; render(true); return; }
  } catch(e){ S.startError = String((e && e.message) || e); render(true); return; }
  S.chatDraft = ''; if (inp) inp.value = '';
  await loadChat();
  reactAll();
}
async function sendDm(){
  var inp = document.getElementById('dmText');
  var txt = inp ? inp.value : (S.dmDraft || '');
  if (!txt.trim()) return;
  var seat = iAmStoryteller(S.game) ? 'storyteller' : mySeatInGame(S.game);
  var to = (S.dmTo || []).slice();
  if (!to.length){ S.startError = '请先选择私聊对象'; render(true); return; }
  if (S.game && S.game.phase === 'night' && to.some(function(x){ return x !== 'storyteller'; })){ S.startError = '夜晚禁止玩家间私聊，只可与说书人私聊。'; render(true); return; }
  try {
    var r = await api('say', { id: S.game.id, seat: seat, text: txt, channel: 'private', to: to });
    if (r && r.ok === false) { S.startError = r.error || '发送失败'; render(true); return; }
  } catch(e){ S.startError = String((e && e.message) || e); render(true); return; }
  S.dmDraft = ''; if (inp) inp.value = '';
  await loadChat();
  var idxs = to.filter(function(x){ return x !== 'storyteller'; }).map(Number);
  if (idxs.length) api('round', { id: S.game.id, seats: idxs, replyTo: seat }).catch(function(){});
  refresh();
}
/* 离开当前对局（不删文件） */
function leaveGame(){
  S.game=null; S.view=null; S.round=null; S.story=null; S.chatMsgs=[]; S.chatUnread=0; S.dmUnread=0; S.history=null;
  savePrefs();
  setTab('setup');
}
async function loadChat(skipRender){
  if(!S.game) return;
  var oldMsgs = S.chatMsgs || [];
  try {
    var d = await api('messages',{id:S.game.id,viewer:mySeatInGame(S.game),storyteller:iAmStoryteller(S.game)});
    S.chatMsgs = d.messages || [];
  } catch(e){ return; }
  /* 未读计数：新消息只在对应面板收起时累加；展开即视为已读。自己发的不算。 */
  if (S.chatMsgs.length > oldMsgs.length){
    var selfWho = !(S.game&&S.game.storyteller&&S.game.storyteller.type==='player') ? 'storyteller' : mySeatInGame(S.game);
    var added = S.chatMsgs.slice(oldMsgs.length);
    for (var _ui=0; _ui<added.length; _ui++){
      var _m = added[_ui];
      if (String(_m.from) === String(selfWho)) continue;
      if (_m.channel === 'private'){ if (!S.showDm) S.dmUnread = (S.dmUnread||0)+1; }
      else { if (S.hideChat) S.chatUnread = (S.chatUnread||0)+1; }
    }
  }
  if (skipRender) return;
  var ae = document.activeElement;
  if (ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA')) { paintChat(); paintDm(); return; }
  render();
}
function logPanel(g){
  var head = g ? ('<div class="section"><h3>对局日志</h3><div class="log" data-keep="gameLog">'+g.log.map(function(l){ return '<div><b>'+l.who+'</b> '+l.text+'</div>'; }).join('')+'</div></div>'+
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
    return '<div class="histitem'+(cur?' on':'')+'" title="'+esc(id)+'" onclick="openGame(\''+id+'\')">'+(cur?'▶ ':'')+esc(id)+'</div>';
  }).join('');
  return '<div class="section"><h3>历史对局</h3>'+
    '<div class="row"><button onclick="loadHistory()">刷新历史</button>'+
    (S.game?'<button onclick="closeGame()">关闭当前对局</button>':'')+'</div>'+
    '<div class="histlist" data-keep="histlist">'+body+'</div></div>';
}
async function loadHistory(){
  try { S.history = await api('games'); } catch(e){ S.history = []; }
  render();
}
async function openGame(id, st){
  try {
    var g = await api('game',{id:id, storyteller: st === true});
    if(!g) throw new Error('没有这一局');
    S.game = g; S.selSeat = 0; S.tab = 'game'; S.round = null; S.chatUnread = 0; S.dmUnread = 0;
    syncMeFromGame(g);
    savePrefs();
    render();
  } catch(e){ alert('打开失败：'+((e&&e.message)||e)); }
}
function closeGame(){ S.game = null; S.round = null; S.tab = 'setup'; S.chatUnread = 0; S.dmUnread = 0; savePrefs(); render(); }
/* 座位号配色：颜色跟着「座位号」走，不跟人走。换人、改名都不改色。 */
/* 座位号配色：在色环上平均分配，1 号(i=0)为红色(色相 0)，依次等间隔绕过一圈 */
function seatColor(i){
  var n = Number(i);
  if (!isFinite(n) || n < 0) return '#9c8b6d';
  var total = (S.game && S.game.seats && S.game.seats.length) || (S.seats && S.seats.length) || 7;
  if (total < 1) total = 1;
  var hue = (n * 360 / total) % 360;
  return 'hsl(' + hue + ', 68%, 55%)';
}
/* 说书人徽章：写「说书人」而不是座位号 */
function stBadge(name){
  return '<span class="snbadge stbadge">说书人</span>'
       + '<span class="snname" style="color:#d9b66a">'+esc(name||'说书人')+'</span>';
}
/* 座位号徽章：数字做底色，后面跟昵称 */
function seatBadge(i, name){
  var c = seatColor(i);
  return '<span class="snbadge" style="background:'+c+'">'+(Number(i)+1)+'</span>'
       + '<span class="snname" style="color:'+c+'">'+esc(name||((Number(i)+1)+' 号'))+'</span>';
}
/* 把「@名字」标成对方座位的颜色。lookup = { names:[长名在前], colorOf(name) } */
function hlMentions(escaped, lookup){
  var s = String(escaped||'');
  if (!lookup || !lookup.names || !lookup.names.length){
    return s.replace(/@([^\s@<,，.。！？!?、：:；;"'）)】\]]{1,16})/g, '<span class="mention">@$1</span>');
  }
  var names = lookup.names, out = '', i = 0;
  while (i < s.length){
    if (s.charAt(i) === '@'){
      var hit = '';
      for (var k = 0; k < names.length; k++){
        var nm = names[k];
        if (nm && s.substr(i+1, nm.length) === nm){ hit = nm; break; }
      }
      if (hit){
        out += '<span class="mention" style="color:'+lookup.colorOf(hit)+'">@'+hit+'</span>';
        i += 1 + hit.length;
        continue;
      }
    }
    out += s.charAt(i); i++;
  }
  return out;
}
/* 由对局座位表造一个 @ 解析器 */
function seatLookup(g){
  var seats = (g && g.seats) || [];
  var names = seats.map(function(x){ return (x && x.name) ? x.name : ''; })
                   .filter(function(x){ return x.length >= 1; })
                   .sort(function(a,b){ return b.length - a.length; });
  return {
    names: names,
    colorOf: function(nm){
      for (var i = 0; i < seats.length; i++){ if (seats[i] && seats[i].name === nm) return seatColor(i); }
      return '#9c8b6d';
    }
  };
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
  return '<div class="section"><h3>知识库</h3><div id="wikiView" class="wikiview" data-keep="wikiView">'+inner+'</div></div>';
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
    if (S.autoChat && canControl() && !(S.round && S.round.running)
        && (Date.now() - (S.lastAutoChat || 0)) > 20000) { S.lastAutoChat = Date.now(); reactAll(); }
  } else if (S.game) {
    S.lastPhase = S.game.phase;
  }
  /* 先取消息再渲染：头像上方的气泡要用最新的聊天记录 */
  await loadChat(true);
  render();
  if(S.tab==='wiki') loadWiki();
  /* 作弊页停留时持续拉取说书人日志：它正在思考时也要能一行行看到 */
  if(S.tab==='cheat' && S.game){
    var before = S.storyLog ? S.storyLog.length : -1;
    await loadStoryLog();
    if (S.storyLog && S.storyLog.length !== before) render(true);
  }
}
setInterval(refresh, 3000);
/* 每 40 秒随机唤醒一位存活 AI 思考一次（对局进行中、无其它轮次在跑时） */
setInterval(function(){
  if(!S.game || (S.game.win && S.game.win.over)) return;
  if(S.round && S.round.running) return;
  if(!canControl() && !iAmStoryteller(S.game)) return;
  var alive=[]; (S.game.seats||[]).forEach(function(s,i){ if(s.type==='agent' && S.game.alive[i]) alive.push(i); });
  if(!alive.length) return;
  var pick=alive[Math.floor(Math.random()*alive.length)];
  try{ api('round',{id:S.game.id, seats:[pick]}); }catch(e){}
}, 40000);
init();