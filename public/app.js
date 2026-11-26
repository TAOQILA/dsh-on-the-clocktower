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
var VERSION = '0.6.7';
var $ = function(s){ return document.querySelector(s); };
var API = (function(){ var p = location.pathname; if (p.charAt(p.length-1) !== '/') p = p.replace(/[^/]*$/, ''); return p + 'api/'; })();
async function api(name, data){
  var r = await fetch(API+name, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
  var j = await r.json();
  if (!j.ok) throw new Error(j.error||'request failed');
  return j.data;
}
var S = { scripts:[], script:null, seats:[], game:null, history:null, me:{zone:'spectator',seat:0}, holdMe:false, storyProvider:'', storyModel:'', tab:'grimoire', selSeat:0, chatChannel:'town', chatTo:[], chatLoading:false, models:null, starting:false, startError:'', view:null, story:null, wikiPage:null, wikiText:null, wikiNames:[], wikiCache:null };
var PHASES = ['setup','night','day','nomination','vote','dawn','ended'];
var PHZH = {setup:'准备',night:'夜晚',day:'白天',nomination:'提名',vote:'投票',dawn:'日落',ended:'终局'};
var TABS = {grimoire:'魔典',setup:'建局',story:'说书人',chat:'群聊/私聊',log:'日志',wiki:'知识库'};

window.addEventListener('resize', function(){ if (typeof placeMe === 'function') placeMe(); });
async function init(){
  try { S.models = await api('models'); } catch(e){ S.models = {providers:[],error:String(e&&e.message||e)}; }
  S.scripts = await api('scripts');
  if (!S.scripts.length){ $('#app').innerHTML='<p style="padding:30px">未找到剧本 JSON，请检查 data/scripts/</p>'; return; }
  S.script = S.scripts[0];
  S.seats = defaultSeats(7);
  render();
}
function setTab(t){ S.tab=t; render(); if(t==='wiki') loadWiki(); if(t==='chat'&&S.game) loadChat(); if(t==='log'&&S.history===null) loadHistory(); }
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

function render(){
  var g = S.game, seats = g?g.seats:S.seats;
  var cur = g?g.phase:'setup';
  document.body.classList.toggle('night', cur === 'night' || cur === 'dawn');
  var sel = seats[S.selSeat]||{};
  var roleNames = S.script?S.script.roles:[];
  var tabsHtml = '';
  ['grimoire','setup','story','chat','log','wiki'].forEach(function(t){
    tabsHtml += '<button class="'+(S.tab===t?'active':'')+'" onclick="setTab(\''+t+'\')">'+TABS[t]+'</button>';
  });
  var panel = '';
  var idCard = myIdentityPanel();
  if (S.tab==='setup') panel = setupPanel();
  else if (S.tab==='story') panel = storyPanel(seats,sel,roleNames,cur);
  else if (S.tab==='chat') panel = chatPanel(g);
  else if (S.tab==='log') panel = logPanel(g);
  else if (S.tab==='wiki') panel = wikiPanel();
  else panel = seatPanel(seats,sel);
  var hdr = g?('对局 '+g.id):'未开局';
  var story = g?('第'+(g.night||0)+'夜 / 第'+(g.day||0)+'天'):'setup 阶段';
  $('#app').innerHTML =
    '<header><span class="logo">染</span><span class="header-title">血染钟鱼 · 魔典</span><span class="sub">'+hdr+'</span><span class="version">v'+VERSION+'</span></header>'+
    '<div class="layout"><div class="left">'+ stBox(g) + specBox() +'<div class="table" id="table">'+
    '<div class="center-badge"><div class="phase">'+(PHZH[cur]||cur)+'</div><div class="story">'+story+'</div></div>'+
    '</div></div><div class="right">'+ winBanner(g) +'<div class="tabs">'+tabsHtml+'</div>'+ idCard + panel +'</div></div>';
  drawTable(seats,g);
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
    var marks = g && g.markers[i] ? g.markers[i].join(' ') : '';
    el.innerHTML = '<div class="seatnum">'+(i+1)+'</div><div class="token">'+(mine?'你':'AI')+(dead?'<span class="demontag">✝</span>':'')+'</div>'+
      '<div class="name">'+s.name+'</div><div class="role">'+role+'</div><div class="markers">'+marks+'</div>';
    el.dataset.zone = 'seat:'+i;
    el.onclick = function(){ S.selSeat=i; if(S.holdMe){ S.me={zone:'seat',seat:i}; S.holdMe=false; } render(); };
    table.appendChild(el);
  });
  placeMe();
}
function meZone(){ return (S.me && S.me.zone) ? S.me.zone : 'spectator'; }
function stBox(g){
  var st = (g && g.storyteller) || { type:(meZone()==='story'?'player':'agent'), name:(meZone()==='story'?'我':'说书人Agent') };
  var isMe = (g ? st.type === 'player' : meZone()==='story');
  return '<div class="stbox" data-zone="story" onclick="dropMe(\'story\')">'+
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
  S.holdMe = false; render();
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
      '<div class="row"><button onclick="setTab(\'grimoire\')">回到魔典</button>'+
      '<button onclick="leaveGame()">离开本局，回到建局</button></div>'+
      '<p class="muted">离开只是把这一局从界面收起，对局文件仍保存在 data/games/ 下，可在「日志」里重新打开。</p></div>';
  }
  var scripts = S.scripts.map(function(s){ return opt(s.name,s.name+'（'+s.roles.length+'角色）',S.script.name); }).join('');
  var pills = S.seats.map(function(s,i){
    var mine = (meZone()==='seat' && S.me.seat===i);
    return '<span class="pill '+(mine?'on':'')+'" onclick="dropMe(\'seat\','+i+')">'+(mine?'你 · ':'')+(i+1)+' 号 · '+s.name+'</span>';
  }).join('');
  return '<div class="section"><h3>建局配置</h3>'+
    '<div class="row">剧本：<select onchange="S.script=S.scripts.find(x=>x.name===this.value);S.seats=defaultSeats(S.seats.length);render()">'+scripts+'</select></div>'+
    '<div class="row">人数：<input id="seatCount" type="number" min="5" max="30" value="'+S.seats.length+'" style="width:60px">'+
    '<button onclick="S.seats=defaultSeats(Math.max(5,Math.min(30,+document.getElementById(\'seatCount\').value)));render()">应用人数</button></div>'+
    '<div class="row">你的位置：<b>'+meZoneLabel()+'</b></div>'+
    (S.game
      ? '<p class="muted">本局已开始，「你」的位置已写入对局、不可再改；要换身份请新建一局。</p>'
      : '<p class="muted">按住「你」拖到目标位置松手即可（也可点一下拿起、再点目标位置）。</p>')+
    ((meZone()!=='story')?('<div class="row">说书人模型：'+modelSelect('storyModelSel',S.storyProvider,S.storyModel,'var k=this.value;var q=splitKey(k);saveStoryModel(q.provider,q.model)')+'</div>'):'')+
    '<div class="row"><button id="startBtn" onclick="startGame()" '+(S.starting?'disabled':'')+'>'+(S.starting?'正在创建并进入第一夜...':'创建对局并进入第一夜')+'</button></div>'+
    (S.startError?('<div class="errbox">开局失败：'+S.startError+'（可直接重试）</div>'):'')+
    '<p class="muted">默认每个人都是 AI。把「你」放到某个座位，你就成为那位玩家；放到说书人圆圈，你就当说书人；放到旁观席，你就只是看。其余座位都由 Agent 扮演。</p>'+
    '</div><div class="seatlist">'+pills+'</div>';
}
function toggleSeat(i){ dropMe('seat', i); }
/* 改名：未开局只改内存；已开局连名字一起写回对局 */
async function renameSeat(seat, name){
  name = String(name||'').trim();
  var arr = S.game ? S.game.seats : S.seats;
  if (arr && arr[seat]) arr[seat].name = name;
  if (!S.game) { render(); return; }
  try {
    var cur = S.game.seats[seat] || {};
    await api('seatModel',{id:S.game.id,seat:seat,provider:cur.provider||'',model:cur.model||'',name:name});
    S.game = await api('game',{id:S.game.id});
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
    if (isAuto) old.name = autoNameOf(old.provider, old.model);
  }
  if (!S.game) { render(); return; }
  try {
    var nm = arr && arr[seat] ? arr[seat].name : '';
    await api('seatModel',{id:S.game.id,seat:seat,provider:provider,model:model,name:nm});
    S.game = await api('game',{id:S.game.id}); render();
  } catch(e){}
}
function autoNameOf(provider, model){
  if (!provider && !model) return '';
  return prettyModelName(provider, model);
}
async function saveStoryModel(provider, model){
  S.storyProvider = provider || ''; S.storyModel = model || '';
  if(!S.game) { render(); return; }
  try {
    await api('seatModel',{id:S.game.id,seat:'storyteller',provider:provider,model:model});
    S.game = await api('game',{id:S.game.id});
    render();
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
    S.tab='story';
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
  var pins = (v.privateInfo && v.privateInfo.length) ? ('<div class="idline">私有信息：'+v.privateInfo.join('；')+'</div>') : '';
  var quota = (typeof v.dmQuotaLeft === 'number') ? ('<span class="muted">今日私聊剩余 '+v.dmQuotaLeft+' 次</span>') : '';
  return '<div class="idcard me"><b>你是 '+(mySeatInGame(g)+1)+' 号 '+((g.seats[mySeatInGame(g)]||{}).name||'')+'</b>'+
    '<div class="idline">角色：<b>'+role+'</b>'+fac+' '+(v.alive===false?'（已出局）':'')+'</div>'+ab+pins+
    '<div class="idline">'+quota+'</div></div>';
}
/* 终局横幅 */
function winBanner(g){
  if(!g || !g.win || !g.win.over) return '';
  var good = g.win.side === 'good';
  return '<div class="winbanner '+(good?'good':'evil')+'">'+
    '<div class="wintitle">'+(good?'善良阵营胜利':'邪恶阵营胜利')+'</div>'+
    '<div class="muted">'+(g.win.reason||'')+'</div></div>';
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
    speakPart+'</div><p class="muted">点击围坐圈上的座位可切换选中。每个座位可单独指定模型，留空则跟随默认模型。</p>';
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
  var st = S.round || {running:false,done:0,total:0,current:null,results:[]};
  var prog = st.total ? ('<div class="muted">进度 '+st.done+'/'+st.total+(st.current!=null?('，正在 '+(st.current+1)+' 号'):'')+'</div>') : '';
  var last = (st.results||[]).map(function(r){
    return '<div><b>'+(r.seat+1)+' 号</b>：'+r.say+(r.whispers?('（私聊 '+r.whispers+' 条）'):'')+'</div>';
  }).join('');
  return '<div class="section"><h3>让 AI 玩家发言</h3>'+
    '<p class="muted">按座位顺序依次唤醒存活 Agent，前一位说完后一位才看到（顺序即信息）。</p>'+
    '<div class="row"><button onclick="runRound()" '+(st.running?'disabled':'')+'>'+(st.running?'进行中...':'让所有 AI 玩家发言')+'</button>'+
    '<button onclick="runRound(3)" '+(st.running?'disabled':'')+'>只让 3 位发言</button></div>'+
    prog+
    '<div class="log" style="max-height:220px">'+(last||'<div class="muted">本轮尚无发言</div>')+'</div></div>';
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
/* 打开/创建对局后，把「你」的摆放同步成这一局里的真实身份 */
function syncMeFromGame(g){
  if(!g) return;
  if (g.storyteller && g.storyteller.type === 'player'){ S.me = { zone:'story', seat:0 }; return; }
  for (var i=0;i<(g.seats||[]).length;i++){
    if (g.seats[i].type === 'human'){ S.me = { zone:'seat', seat:i }; return; }
  }
  S.me = { zone:'spectator', seat:0 };
}
function chatPanel(g){
  if(!g) return '<p class="muted">请先在「建局」中创建对局。</p>';
  var seats = g.seats||[];
  var self = mySeatInGame(g);
  var roChat = !iAmStoryteller(g) && !iAmPlayer(g);
  var chOpts = opt('town','town（全员可见）',S.chatChannel)+opt('private','private（私聊）',S.chatChannel);
  var seatOpts = seats.map(function(s,i){ return '<label style="margin-right:8px"><input type="checkbox" class="chtarget" value="'+i+'" '+(S.chatTo.indexOf(i)>=0?'checked':'')+'>'+(i+1)+' 号 · '+s.name+'</label>'; }).join('');
  var msgs = (S.chatMsgs||[]).map(function(m){
    var from = seats[m.from]?seats[m.from].name:((m.from+1)+' 号');
    var cls = m.channel==='private'?'dm':'town';
    var tag = m.channel==='private'?'私聊':'';
    return '<div class="msg '+cls+'"><b>'+from+'</b> '+tag+'：'+m.text+'</div>';
  }).join('');
  return '<div class="section"><h3>群聊 / 私聊</h3>'+
    '<p class="muted">当前视角：'+(self+1)+' 号'+(seats[self]?'（'+seats[self].name+'）':'')+'。公开频道全员可见；私聊仅收发双方与说书人可见。</p>'+
    '<div class="row">频道：<select id="chatCh" onchange="S.chatChannel=this.value;render()">'+chOpts+'</select></div>'+
    (S.chatChannel==='private'?'<div class="row">收件人：<div>'+seatOpts+'</div></div>':'')+
    (roChat ? '<p class="muted">旁观模式：只能阅读对话，不能发言。</p>' :
    '<div class="row"><input id="chatText" style="flex:1" placeholder="输入消息..." onkeydown="if(event.key===\'Enter\')sendChat()"><button onclick="sendChat()">发送</button></div>')+
    '<div id="chatLog" class="log" style="max-height:360px">'+(msgs||'<div class="muted">暂无消息</div>')+'</div>'+
    roundSection()+
    '</div>';
}
async function sendChat(){
  var inp = $('#chatText'); if(!inp||!inp.value.trim()) return;
  var to = [];
  if(S.chatChannel==='private'){
    document.querySelectorAll('.chtarget').forEach(function(el){ if(el.checked) to.push(+el.value); });
  }
  var ch = S.chatChannel;
  await api('say',{id:S.game.id,seat:mySeatInGame(S.game),text:inp.value,channel:ch,to:to});
  inp.value='';
  await loadChat();
  if (ch === 'town') runRound(3);
  else refresh();
}
/* 离开当前对局（不删文件） */
function leaveGame(){
  S.game=null; S.view=null; S.round=null; S.story=null; S.chatMsgs=[]; S.history=null;
  setTab('setup');
}
async function loadChat(){
  if(!S.game || S.tab!=='chat') return;
  var d = await api('messages',{id:S.game.id,viewer:mySeatInGame(S.game),storyteller:!(S.game&&S.game.storyteller&&S.game.storyteller.type==='player')});
  S.chatMsgs = d.messages;
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
    var g = await api('game',{id:id});
    if(!g) throw new Error('没有这一局');
    S.game = g; S.selSeat = 0; S.tab = 'grimoire'; S.round = null;
    syncMeFromGame(g);
    render();
  } catch(e){ alert('打开失败：'+((e&&e.message)||e)); }
}
function closeGame(){ S.game = null; S.round = null; S.tab = 'setup'; render(); }
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
  var ae = document.activeElement;
  if (ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA' || ae.tagName==='SELECT')) return;
  if(!S.game) return;
  S.game = await api('game',{id:S.game.id});
  if(!S.round || !S.round.running){
    try { S.round = await api('roundStatus',{id:S.game.id}); } catch(e){}
  }
  if (iAmPlayer(S.game)){
    try { S.view = await api('view',{id:S.game.id, seat:mySeatInGame(S.game)}); } catch(e){}
  } else { S.view = null; }
  if (S.tab==='story' && !iAmStoryteller(S.game) && !(S.story && S.story.running)){
    try { S.story = await api('storyStatus',{id:S.game.id}); } catch(e){}
  }
  render();
  if(S.tab==='wiki') loadWiki();
  if(S.tab==='chat') loadChat();
}
setInterval(refresh, 3000);
init();