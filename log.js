/* Chaundoo Card Scan — Profit Log
   Moved over from Chaundoo Card Flipz. The log lives in profitlog.json in this repo, each card show
   locked (AES-GCM) with a key made from the 4-digit passcode (PBKDF2). After the passcode is entered once
   on a device, the key stays there so the log opens by itself.
   Edits save on this device right away, as a list of what differs from GitHub ("ccs.sync").
   "Save to GitHub" opens a ready-made GitHub issue holding just those changes (already locked); the
   "Save profit log" GitHub job writes them into profitlog.json and closes the issue.
   Card names for older entries come from the Card Flipz card list (same site, read only). */
(function(){
'use strict';
var DATA_REPO = "Chaundoo/card-scan", SYNC_KEY = "ccs.sync", KEY_STORE = "ccs.logKey", NOTES_MAX = 5000, CFZ = "/card-flipz/";
var root = null, state = {view:"loading", showId:null, logTab:null, notice:"", backupPanel:null, logConfirm:null, sxOpen:{}, pairMsg:""};
var LOG = {shows:[], lastBackup:""}, REMOTE_SHOWS = [], LOCK = null, KEY = null, STATUS = "loading", ERR = "";
var cards = [], cardIdx = {}, ERAS = [], catalogP = null, chartMode = "show", resizeTimer = null, listeners = [];
var logStorageOk = true; try{ localStorage.setItem("ccs.t","1"); localStorage.removeItem("ccs.t"); }catch(e){ logStorageOk = false; }

/* ---------- small helpers (same look as Card Flipz) ---------- */
function load(k, d){ try{ var v = localStorage.getItem(k); return v==null ? d : JSON.parse(v); }catch(e){ return d; } }
function save(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
function money(n, dec){ if(n==null||n===""||isNaN(n)) return "—"; var d = dec!=null?dec:(Math.abs(n)<100 && n%1!==0?2:0); return "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d}); }
function signed(n){ return (n>=0?"+":"−")+money(Math.abs(n),0); }
function pct(n){ return (n>=0?"+":"−")+Math.abs(Math.round(n)).toLocaleString("en-US")+"%"; }
function fmtDate(d){ if(!d) return "—"; var m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(d); if(!m) return esc(d); return m[3] ? m[2]+"/"+m[3]+"/"+m[1] : m[2]+"/"+m[1]; }
function clone(o){ return JSON.parse(JSON.stringify(o)); }
function vendorPct(){ var s = load("ccs.settings", {}) || {}; return Number(s.vendor) > 0 ? Number(s.vendor) : 70; }
function b64e(u){ var t = ""; for(var i=0;i<u.length;i++) t += String.fromCharCode(u[i]); return btoa(t); }
function b64d(t){ var b = atob(t), u = new Uint8Array(b.length); for(var i=0;i<b.length;i++) u[i] = b.charCodeAt(i); return u; }
function todayStr(){ var d = new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function uid(p){ return p+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36); }
function isNum(v){ return v!=="" && v!=null && !isNaN(Number(v)); }
function numOr(v){ return v!=="" && v!=null && !isNaN(Number(v)) && Number(v)>=0 ? Number(v) : ""; }

/* ---------- Card Flipz card list: names, pictures, eras and today's prices for entries that point at it ---------- */
function loadCatalog(){
  if(catalogP) return catalogP;
  catalogP = fetch(CFZ+"eras/eras.json").then(function(r){ return r.json(); }).then(function(man){
    ERAS = man.eras || [];
    return Promise.all(ERAS.map(function(e){ return fetch(CFZ+"eras/"+e.id+"/"+e.id+".json").then(function(r){ return r.json(); })
      .then(function(d){ (d.cards||[]).forEach(function(c){ c.era = e.id; cards.push(c); cardIdx[c.id] = c; }); }).catch(function(){}); }));
  }).then(function(){ if(STATUS==="open") render(true); }).catch(function(){});
  return catalogP;
}
function cardById(id){ return id ? cardIdx[id] || null : null; }
function title(c){ return c.name + (c.variant ? " ("+c.variant+")" : ""); }
function thumb(c){ var u = c && c.image || ""; return /^https:\/\/tcgplayer-cdn\.tcgplayer\.com\/product\/\d+_400w\.jpg$/.test(u) ? u.replace("_400w.jpg","_200w.jpg") : u; }
function eraName(id){ var e = ERAS.find(function(x){return x.id===id;}); return e ? e.name : (id||"Other"); }
function priceAt(c,k){ var x = c && c.raw && c.raw[k]; var v = x && Number(x.price); return v>0 ? v : 0; }
function searchCards(q){
  var w = q.toLowerCase().split(/\s+/).filter(Boolean); if(!w.length) return [];
  var out = [];
  for(var i=0;i<cards.length && out.length<40;i++){ var c = cards[i], t = (c.name+" "+(c.variant||"")+" "+(c.set||"")+" "+(c.number||"")).toLowerCase();
    if(w.every(function(x){ return t.indexOf(x)>=0; })) out.push(c); }
  return out.sort(function(a,b){ return (a.name.toLowerCase().indexOf(w[0])===0?0:1)-(b.name.toLowerCase().indexOf(w[0])===0?0:1); }).slice(0,6);
}

/* ---------- data shapes (same as Card Flipz, so old entries keep working) ---------- */
function normShow(s){ s = s||{};
  var o = {id:String(s.id||uid("s")), name:String(s.name||"Card show").slice(0,60), date:String(s.date||"").slice(0,10), hours:numOr(s.hours), notes:String(s.notes||"").slice(0,NOTES_MAX),
    sales:(Array.isArray(s.sales)?s.sales:[]).map(normSale)};
  var c = numOr(s.costs); if(c!=="" && c>0) o.costs = c;
  return o; }
function normSale(r){ r = r||{};
  var o = {id:String(r.id||uid("r")), cardId:r.cardId?String(r.cardId):null, label:String(r.label||"").slice(0,80), bought:numOr(r.bought), sold:numOr(r.sold)};
  var cond = ["nm","lp","mp","dmg"], day = /^\d{4}-\d{2}-\d{2}$/;
  if(["sold","holding","traded"].indexOf(r.status)>=0) o.status = r.status;
  if(r.vendor && String(r.vendor).trim()) o.vendor = String(r.vendor).trim().slice(0,40);
  if(r.batch) o.batch = String(r.batch).slice(0,40);
  if(cond.indexOf(r.from)>=0) o.from = r.from;
  if(cond.indexOf(r.to)>=0) o.to = r.to;
  var e = numOr(r.expected); if(e!=="" && e>0) o.expected = e;
  if(day.test(r.boughtOn||"")) o.boughtOn = r.boughtOn;
  if(day.test(r.soldOn||"")) o.soldOn = r.soldOn;
  if(r.img && /^https:\/\//.test(r.img)) o.img = String(r.img).slice(0,300);
  return o; }
function canon(o){
  if(Array.isArray(o)) return "["+o.map(canon).join(",")+"]";
  if(o && typeof o==="object") return "{"+Object.keys(o).sort().map(function(k){ return JSON.stringify(k)+":"+canon(o[k]); }).join(",")+"}";
  return JSON.stringify(o==null ? null : o);
}

/* ---------- changes not on GitHub yet ---------- */
function emptyDiff(){ return {up:{}, del:{}}; }
var SYNC = (function(){ var s = load(SYNC_KEY, null); if(!s || typeof s!=="object") s = {};
  if(!s.shows || typeof s.shows.up!=="object" || typeof s.shows.del!=="object") s.shows = emptyDiff(); return s; })();
function applyDraft(remote, d){
  var out = [], seen = {};
  remote.forEach(function(x){ seen[x.id] = 1; if(d.del[x.id]) return; out.push(clone(d.up[x.id] || x)); });
  Object.keys(d.up).forEach(function(id){ if(!seen[id]) out.unshift(clone(d.up[id])); });
  return out;
}
function diffList(remote, cur){
  var d = emptyDiff(), rm = {}, ids = {};
  remote.forEach(function(x){ rm[x.id] = canon(x); });
  cur.forEach(function(x){ var c = normShow(x); ids[c.id] = 1; if(rm[c.id] !== canon(c)) d.up[c.id] = c; });
  remote.forEach(function(x){ if(!ids[x.id]) d.del[x.id] = 1; });
  return d;
}
function pendingCount(){ return STATUS==="open" ? Object.keys(SYNC.shows.up).length + Object.keys(SYNC.shows.del).length : 0; }
function syncSave(){
  if(STATUS!=="open") return;
  SYNC.shows = diffList(REMOTE_SHOWS, LOG.shows); warmEnc();
  if(!pendingCount()) delete SYNC.sentAt;
  save(SYNC_KEY, SYNC);
}
function saveLog(){ syncSave(); renderBar(); tabBadge(); listeners.forEach(function(f){ try{ f(); }catch(e){} }); }
function syncSummary(){ var s = pendingCount(); return s+" card show"+(s===1?"":"s"); }

/* each changed card show is locked on this phone before it goes to GitHub, so GitHub only ever sees scrambled data */
var ENC = {};
function encShow(sh){
  var src = canon(sh), c = ENC[sh.id]; if(c && c.src===src) return Promise.resolve(c.rec);
  var iv = crypto.getRandomValues(new Uint8Array(12)), te = new TextEncoder();
  return crypto.subtle.encrypt({name:"AES-GCM", iv:iv, additionalData:te.encode(sh.id)}, KEY, te.encode(JSON.stringify(sh))).then(function(ct){
    var rec = {id:sh.id, iv:b64e(iv), ct:b64e(new Uint8Array(ct))}; ENC[sh.id] = {src:src, rec:rec}; return rec; });
}
function warmEnc(){ if(!KEY) return; Object.keys(SYNC.shows.up).forEach(function(id){ encShow(SYNC.shows.up[id]).catch(function(){}); }); }
function encAll(){ return Promise.all(Object.keys(SYNC.shows.up).map(function(id){ return encShow(SYNC.shows.up[id]); })); }
function copyText(t){
  if(navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); }catch(e){} ta.remove(); return Promise.resolve();
}
function pushToGitHub(){
  syncSave(); if(!pendingCount()) return;
  var win = window.open("about:blank", "_blank"); /* opened right away so the phone doesn't block it */
  encAll().then(function(ups){
    var payload = {v:1, shows:{up:ups, del:Object.keys(SYNC.shows.del)}};
    var body = "Sent from Chaundoo Card Scan. Press **Create**: the bot saves this and closes the issue in about a minute.\n\n```json\n"+JSON.stringify(payload)+"\n```";
    var base = "https://github.com/"+DATA_REPO+"/issues/new?title="+encodeURIComponent("Save data: "+syncSummary())+"&body=";
    var url = base+encodeURIComponent(body);
    if(url.length > 7600){ copyText(body); url = base+encodeURIComponent("Delete this line, then paste (Card Scan copied your changes), then press Create.");
      state.pairMsg = "That's a lot of changes, so they were copied instead of filled in. In GitHub, clear the description box, paste, then press Create."; }
    else state.pairMsg = "";
    if(win && !win.closed) win.location.href = url; else window.open(url, "_blank");
    SYNC.sentAt = Date.now(); save(SYNC_KEY, SYNC); renderBar();
  }).catch(function(){ if(win) win.close(); state.pairMsg = "Couldn't lock the changes on this phone. Try again."; renderBar(); });
}
function renderBar(){
  var el = document.getElementById("log-bar"); if(!el) return;
  var n = pendingCount(); if(!n){ el.hidden = true; el.innerHTML = ""; return; }
  var sent = SYNC.sentAt ? (Date.now()-SYNC.sentAt)/60000 : null, status = "";
  if(state.pairMsg) status = esc(state.pairMsg);
  else if(sent!=null && sent < 10) status = "Sent to GitHub. Press Create there if you haven’t, then tap Check in about a minute.";
  else if(sent!=null) status = 'Not on GitHub yet. If you pressed Create, <a href="https://github.com/'+DATA_REPO+'/issues?q=is%3Aissue+%22Save+data%22" target="_blank" rel="noopener">see what the bot said</a>; otherwise save again.';
  el.hidden = false;
  el.innerHTML = '<b>'+esc(syncSummary())+' not on GitHub yet</b><span class="bar-btns"><button class="btn" id="pb-discard">Discard</button>'+(sent!=null?'<button class="btn" id="pb-check">Check</button>':'')+
    '<button class="btn primary" id="pb-save">'+(sent!=null?'Save again':'Save to GitHub')+'</button></span>'+(status?'<span class="msg" role="status">'+status+'</span>':'');
  document.getElementById("pb-save").onclick = pushToGitHub;
  var ck = document.getElementById("pb-check"); if(ck) ck.onclick = function(){ ck.textContent = "Checking…"; reloadRemote(); };
  document.getElementById("pb-discard").onclick = function(){
    if(!confirm("Throw away the "+syncSummary()+" changes that aren't on GitHub yet?")) return;
    LOG.shows = REMOTE_SHOWS.map(clone); SYNC = {shows:emptyDiff()}; save(SYNC_KEY, SYNC); state.pairMsg = "";
    if(state.view==="show" && !showById(state.showId)) state.view = "log"; saveLog(); render(); };
}
function tabBadge(){ var b = document.getElementById("log-dot"); if(!b) return; var n = pendingCount(); b.hidden = !n; b.textContent = n || ""; }

/* ---------- loading + passcode ---------- */
function fetchLog(){ return fetch("profitlog.json?t="+Date.now(), {cache:"no-store"}).then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); }); }
function keyFrom(raw){ return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt","decrypt"]); }
function decryptAll(log, k){
  function dec(o, aad){ return crypto.subtle.decrypt({name:"AES-GCM", iv:b64d(o.iv), additionalData:new TextEncoder().encode(aad)}, k, b64d(o.ct)).then(function(b){ return JSON.parse(new TextDecoder().decode(b)); }); }
  return dec(log.enc.check, "check").then(function(){
    return Promise.all((log.shows||[]).map(function(x){ return dec(x, x.id).catch(function(){ return null; }); }));
  }).then(function(shows){ return shows.filter(function(x){ return x && typeof x==="object"; }).map(normShow); });
}
function open(log){
  LOCK = log.enc;
  var saved = load(KEY_STORE, null);
  if(!(window.crypto && crypto.subtle)){ STATUS = "error"; ERR = "This browser can't open the locked log."; return Promise.resolve(); }
  if(!saved || saved.salt!==LOCK.salt){ STATUS = "locked"; return Promise.resolve(); }
  return keyFrom(b64d(saved.key)).then(function(k){ return decryptAll(log, k).then(function(shows){ start(k, shows); }); })
    .catch(function(){ try{ localStorage.removeItem(KEY_STORE); }catch(e){} STATUS = "locked"; });
}
function start(k, shows){
  KEY = k; REMOTE_SHOWS = shows; STATUS = "open";
  LOG = {shows:applyDraft(REMOTE_SHOWS, SYNC.shows), lastBackup:load("ccs.lastBackup","")};
  bringOverFromCardFlipz();
  syncSave(); loadCatalog();
}
function unlock(code){
  var te = new TextEncoder();
  return crypto.subtle.importKey("raw", te.encode(code), "PBKDF2", false, ["deriveKey"]).then(function(base){
    return crypto.subtle.deriveKey({name:"PBKDF2", salt:b64d(LOCK.salt), iterations:LOCK.iter, hash:"SHA-256"}, base, {name:"AES-GCM", length:256}, true, ["encrypt","decrypt"]);
  }).then(function(k){
    return fetchLog().then(function(log){ return decryptAll(log, k).then(function(shows){
      return crypto.subtle.exportKey("raw", k).then(function(raw){ save(KEY_STORE, {salt:LOCK.salt, key:b64e(new Uint8Array(raw))}); start(k, shows); }); }); });
  });
}
function lockLog(){ try{ localStorage.removeItem(KEY_STORE); }catch(e){} KEY = null; STATUS = "locked"; LOG = {shows:[], lastBackup:""}; REMOTE_SHOWS = []; state.view = "lock"; render(); tabBadge(); listeners.forEach(function(f){ try{ f(); }catch(e){} }); }
function reloadRemote(){
  return fetchLog().then(function(log){ LOCK = log.enc; if(!KEY) return open(log);
    return decryptAll(log, KEY).then(function(shows){ REMOTE_SHOWS = shows; LOG.shows = applyDraft(REMOTE_SHOWS, SYNC.shows); state.pairMsg = ""; syncSave(); }); })
  .catch(function(e){ state.pairMsg = "Couldn't reach GitHub ("+e.message+"). Try again in a moment."; })
  .then(function(){ render(true); tabBadge(); listeners.forEach(function(f){ try{ f(); }catch(e){} }); });
}
/* One time per device: anything logged in Card Flipz on this phone that never reached GitHub, plus sales
   Card Scan sent to Card Flipz that Card Flipz hadn't picked up yet, join this log as unsaved changes. */
function bringOverFromCardFlipz(){
  if(load("ccs.cfzMoved", false)) return;
  var n = 0, have = {}; LOG.shows.forEach(function(s){ have[s.id] = s; });
  var cs = load("cfz.sync", null), d = cs && cs.shows;
  if(d && d.up && d.del){
    Object.keys(d.up).forEach(function(id){ var s = normShow(d.up[id]); var cur = have[id];
      if(!cur){ LOG.shows.push(s); have[id] = s; n++; } else if(canon(cur)!==canon(s)){ LOG.shows[LOG.shows.indexOf(cur)] = s; have[id] = s; n++; } });
    Object.keys(d.del).forEach(function(id){ if(have[id]){ LOG.shows = LOG.shows.filter(function(s){ return s.id!==id; }); delete have[id]; n++; } });
  }
  var box = load("cfz.inbox", []), seen = {};
  LOG.shows.forEach(function(sh){ sh.sales.forEach(function(r){ seen[r.id] = 1; }); });
  if(Array.isArray(box)) box.forEach(function(it){
    if(!it || !it.sale || seen[it.sale.id]) return;
    var sh = (it.showId && have[it.showId]) || LOG.shows.filter(function(x){ return x.name===(it.showName||"Card show") && x.date===it.date; })[0];
    if(!sh){ sh = normShow({name:it.showName||"Card show", date:/^\d{4}-\d{2}-\d{2}$/.test(it.date||"")?it.date:todayStr(), sales:[]}); LOG.shows.push(sh); have[sh.id] = sh; }
    sh.sales.push(normSale(it.sale)); seen[it.sale.id] = 1; n++; });
  save("ccs.cfzMoved", true);
  if(n) state.notice = n+" change"+(n===1?"":"s")+" that were waiting in Card Flipz on this phone moved here. Tap Save to GitHub to keep "+(n===1?"it":"them")+".";
}

/* ---------- profit math (unchanged from Card Flipz) ---------- */
var LOGSET = (function(){ var s = load("ccs.logset", null) || load("cfz.logset", null) || {}; return {bench:isNum(s.bench)&&Number(s.bench)>0 ? Number(s.bench) : 17, buffer:isNum(s.buffer)&&Number(s.buffer)>=0 ? Number(s.buffer) : 30}; })();
function saveLogSet(){ save("ccs.logset", LOGSET); }
var LCONDS = {nm:"NM", lp:"LP", mp:"MP", dmg:"DMG"};
function showById(id){ for(var i=0;i<LOG.shows.length;i++) if(LOG.shows[i].id===id) return LOG.shows[i]; return null; }
function saleName(r){ var c = r.cardId ? cardById(r.cardId) : null; return c ? title(c) : (r.label || (r.cardId ? "Loading card…" : "Card")); }
function sortedShows(asc){ return LOG.shows.slice().sort(function(a,b){ var c = String(a.date).localeCompare(String(b.date)); return asc ? c : -c; }); }
function perHr(n){ return n==null ? "—" : (n<0?"−":"")+"$"+Math.abs(n).toFixed(Math.abs(n)<100?2:0).replace(/\.00$/,"")+"/hr"; }
function saleStatus(r){ if(r.status==="holding"||r.status==="traded") return r.status; return isNum(r.sold) ? "sold" : "holding"; }
function saleDone(r){ return saleStatus(r)!=="holding" && isNum(r.sold); }
function saleProfit(r){ return saleDone(r) ? Number(r.sold)-(Number(r.bought)||0) : null; }
function dayDiff(a, b){ var x = Date.parse(a), y = Date.parse(b); return isNaN(x)||isNaN(y) ? null : Math.round((y-x)/864e5); }
function bufferHrs(){ return LOGSET.buffer/60; }
function showStats(sh){
  var t = {spent:0, got:0, gross:0, sold:0, unsold:0, unsoldCost:0, doneCost:0, traded:0, hours:Number(sh.hours)||0, costs:Number(sh.costs)||0};
  sh.sales.forEach(function(r){ var b = Number(r.bought)||0; t.spent += b;
    if(saleDone(r)){ t.sold++; t.got += Number(r.sold); t.gross += Number(r.sold) - b; t.doneCost += b; if(saleStatus(r)==="traded") t.traded++; }
    else { t.unsold++; t.unsoldCost += b; } });
  t.profit = t.gross - t.costs;
  t.allInHours = t.hours > 0 ? t.hours + bufferHrs() : 0;
  t.perHour = t.hours > 0 ? t.profit/t.hours : null;
  t.allIn = t.allInHours > 0 ? t.profit/t.allInHours : null;
  var base = t.doneCost + t.costs; t.roi = base > 0 ? t.profit/base*100 : null;
  t.beats = t.allIn==null ? null : t.allIn >= LOGSET.bench;
  t.target = t.hours > 0 ? LOGSET.bench*t.allInHours : null;
  return t;
}
function logStats(){
  var t = {profit:0, hours:0, allInHours:0, hProfit:0, shows:LOG.shows.length, sold:0, base:0, holding:0, holdingCost:0, rated:0, beat:0, best:null, costs:0};
  LOG.shows.forEach(function(sh){ var s = showStats(sh); t.profit += s.profit; t.sold += s.sold; t.base += s.doneCost + s.costs; t.costs += s.costs;
    t.holding += s.unsold; t.holdingCost += s.unsoldCost;
    if(s.hours > 0){ t.hours += s.hours; t.allInHours += s.allInHours; t.hProfit += s.profit; t.rated++; if(s.beats) t.beat++; }
    if(!t.best || s.profit > t.best.s.profit) t.best = {sh:sh, s:s}; });
  t.hours = Math.round(t.hours*100)/100;
  t.perHour = t.hours > 0 ? t.hProfit/t.hours : null;
  t.allIn = t.allInHours > 0 ? t.hProfit/t.allInHours : null;
  t.avg = t.shows ? t.profit/t.shows : null;
  t.roi = t.base > 0 ? t.profit/t.base*100 : null;
  t.benchPay = LOGSET.bench*t.allInHours; t.extra = t.hProfit - t.benchPay;
  if(t.best && t.rated > 1 && t.best.s.hours > 0){ var h = t.allInHours - t.best.s.allInHours; t.noBest = h > 0 ? (t.hProfit - t.best.s.profit)/h : null; }
  var days = []; LOG.shows.forEach(function(sh){ sh.sales.forEach(function(r){ if(!saleDone(r)) return; var d = dayDiff(r.boughtOn||sh.date, r.soldOn||sh.date); if(d!=null && d>=0) days.push(d); }); });
  t.avgDays = days.length ? days.reduce(function(a,b){ return a+b; },0)/days.length : null;
  return t;
}
function batchName(id, sh){
  var ids = []; sh.sales.forEach(function(r){ if(r.batch && ids.indexOf(r.batch)<0) ids.push(r.batch); });
  var i = Math.max(0, ids.indexOf(id)), m = /^\d{4}-(\d{2})-(\d{2})$/.exec(sh.date||"");
  return "Batch "+(m ? (+m[1])+"/"+(+m[2]) : "")+(i ? " "+String.fromCharCode(65+i) : ""); }
function saleExpected(r){
  if(isNum(r.expected) && Number(r.expected)>0) return {v:Number(r.expected), today:false};
  var c = r.cardId ? cardById(r.cardId) : null; if(!c || !r.to) return null;
  var p = priceAt(c, r.to); return p > 0 ? {v:p*vendorPct()/100, today:true} : null;
}
function showUnits(sh){
  var out = [], byB = {};
  sh.sales.forEach(function(r){ if(!saleDone(r)) return;
    if(r.batch){ if(!byB[r.batch]){ byB[r.batch] = {kind:"batch", id:r.batch, name:batchName(r.batch, sh), sh:sh, items:[]}; out.push(byB[r.batch]); } byB[r.batch].items.push(r); }
    else out.push({kind:"single", id:r.id, name:saleName(r), sh:sh, items:[r]}); });
  out.forEach(function(u){ u.cost = 0; u.got = 0; var ex = 0, exOk = true, today = false;
    u.items.forEach(function(r){ u.cost += Number(r.bought)||0; u.got += Number(r.sold)||0; var e = saleExpected(r); if(e){ ex += e.v; today = today || e.today; } else exOk = false; });
    u.profit = u.got - u.cost; u.roi = u.cost > 0 ? u.profit/u.cost*100 : null;
    u.expected = exOk && ex > 0 ? ex : null; u.expToday = today; });
  return out;
}
function allUnits(){ var a = []; sortedShows(true).forEach(function(sh){ a = a.concat(showUnits(sh)); }); return a; }
function common(vals, none){ var v = vals.filter(function(x){ return x; }); if(v.length < vals.length) return none; return v.every(function(x){ return x===v[0]; }) ? v[0] : "Mixed"; }
function flipLabel(u){ return common(u.items.map(function(r){ return r.from && r.to ? LCONDS[r.from]+" → "+LCONDS[r.to] : ""; }), "Not set"); }
function eraLabel(u){ return common(u.items.map(function(r){ var c = r.cardId ? cardById(r.cardId) : null; return c ? eraName(c.era) || "Unknown era" : "Not on Card Flipz"; }), "Not on Card Flipz"); }
function vendorLabel(u){ return common(u.items.map(function(r){ return (r.vendor||"").trim(); }), "Not set"); }
function groupUnits(units, fn){
  var by = {}, order = [];
  units.forEach(function(u){ var k = fn(u); if(!by[k]){ by[k] = {label:k, n:0, cost:0, profit:0, wins:0}; order.push(k); } var g = by[k]; g.n++; g.cost += u.cost; g.profit += u.profit; if(u.profit > 0) g.wins++; });
  return order.map(function(k){ var g = by[k]; g.roi = g.cost > 0 ? g.profit/g.cost*100 : null; return g; })
    .sort(function(a,b){ var na = /^(Not set|Not on Card Flipz|Mixed)$/.test(a.label), nb = /^(Not set|Not on Card Flipz|Mixed)$/.test(b.label); if(na!==nb) return na ? 1 : -1; return (b.roi==null?-1e9:b.roi) - (a.roi==null?-1e9:a.roi); });
}
function showBreakEven(hours, spent){ var target = LOGSET.bench*(hours + bufferHrs()); return {target:target, roi:spent > 0 ? target/spent*100 : null}; }
function goLog(showId){ state.view = showId ? "show" : "log"; state.showId = showId||null; state.logConfirm = null; state.backupPanel = null;
  render(); var top = document.getElementById("v-log"); if(top) window.scrollTo(0, 0); }
function newShow(name){ var sh = {id:uid("s"), name:name||"Card show", date:todayStr(), hours:"", sales:[]}; LOG.shows.push(sh); saveLog(); return sh; }

/* ---------- chart ---------- */
function niceTicks(lo, hi){
  if(lo===hi){ hi = lo + 10; }
  var span = hi - lo, step = Math.pow(10, Math.floor(Math.log10(span/4))), err = span/4/step;
  step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  var a = Math.floor(lo/step)*step, b = Math.ceil(hi/step)*step, out = [];
  for(var v=a; v<=b+step/2; v+=step) out.push(Math.round(v*100)/100);
  return out;
}
function tickLabel(v){ var a = Math.abs(v); return (v<0?"−":"")+"$"+(a>=1000 ? (a/1000).toFixed(a%1000?1:0)+"k" : a); }
function drawChart(){
  var box = document.getElementById("pchart"); if(!box) return;
  var all = sortedShows(true); if(!all.length) return;
  var rate = chartMode==="rate", B = LOGSET.bench;
  var shows = rate ? all.filter(function(sh){ return showStats(sh).hours > 0; }) : all;
  if(!shows.length){ box.innerHTML = '<p class="sub" style="padding:18px 10px">Add hours to a show to see money per hour.</p>'; return; }
  var W = Math.max(280, box.clientWidth), H = 230, padL = 48, padR = 14, padT = 16, padB = 30, pw = W-padL-padR, ph = H-padT-padB;
  var run = 0, pts = shows.map(function(sh){ var s = showStats(sh); run += s.profit; return {sh:sh, s:s, v:rate ? s.allIn : chartMode==="run" ? run : s.profit}; });
  if(rate) pts.forEach(function(p,i){ var w = pts.slice(Math.max(0,i-2), i+1); p.avg = w.reduce(function(a,q){ return a+q.v; },0)/w.length; });
  var vals = pts.map(function(p){ return p.v; }); if(rate) vals.push(B);
  var lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
  var ticks = niceTicks(lo, hi); lo = ticks[0]; hi = ticks[ticks.length-1];
  function y(v){ return padT + (hi - v)/(hi - lo)*ph; }
  var label = rate ? "All-in money per hour for each card show, with the "+B+" dollar benchmark" : chartMode==="run" ? "Running total of profit" : "Profit for each card show";
  var n = pts.length, band = pw/n, h = '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+label+'">';
  ticks.forEach(function(t){ var yy = Math.round(y(t))+0.5; h += '<line x1="'+padL+'" x2="'+(W-padR)+'" y1="'+yy+'" y2="'+yy+'" class="'+(t===0?'c-zero':'c-grid')+'"/><text x="'+(padL-8)+'" y="'+(yy+4)+'" class="c-tick" text-anchor="end">'+tickLabel(t)+'</text>'; });
  var every = Math.max(1, Math.ceil(n/7));
  pts.forEach(function(p,i){ var cx = padL + band*i + band/2;
    if(i % every === 0 || i === n-1){ var m = /^\d{4}-(\d{2})-(\d{2})$/.exec(p.sh.date||""); h += '<text x="'+cx+'" y="'+(H-10)+'" class="c-tick" text-anchor="middle">'+(m ? (+m[1])+"/"+(+m[2]) : "")+'</text>'; } });
  function bar(p, i, cls){ var bw = Math.min(24, band*0.6), r = Math.min(4, bw/2), y0 = y(0), x = padL + band*i + (band-bw)/2, yv = y(p.v), up = p.v >= 0, hgt = Math.abs(y0 - yv);
    if(hgt < 1) return '<rect x="'+x+'" y="'+(y0-1)+'" width="'+bw+'" height="2" class="c-flat"/>';
    var rr = Math.min(r, hgt);
    return up ? '<path class="'+cls+'" d="M'+x+','+y0+'V'+(yv+rr)+'Q'+x+','+yv+' '+(x+rr)+','+yv+'H'+(x+bw-rr)+'Q'+(x+bw)+','+yv+' '+(x+bw)+','+(yv+rr)+'V'+y0+'Z"/>'
              : '<path class="'+cls+'" d="M'+x+','+y0+'V'+(yv-rr)+'Q'+x+','+yv+' '+(x+rr)+','+yv+'H'+(x+bw-rr)+'Q'+(x+bw)+','+yv+' '+(x+bw)+','+(yv-rr)+'V'+y0+'Z"/>'; }
  if(chartMode==="show"){
    pts.forEach(function(p,i){ h += bar(p, i, p.v >= 0 ? "c-gain" : "c-loss"); });
    var last = pts[n-1], lx = padL + band*(n-1) + band/2, ly = y(last.v);
    h += '<text x="'+lx+'" y="'+(last.v>=0 ? ly-7 : ly+15)+'" class="c-label" text-anchor="middle">'+signed(last.v)+'</text>';
  } else if(rate){
    pts.forEach(function(p,i){ h += bar(p, i, p.v >= B ? "c-gain" : "c-loss"); });
    var by = Math.round(y(B))+0.5;
    h += '<line x1="'+padL+'" x2="'+(W-padR)+'" y1="'+by+'" y2="'+by+'" class="c-bench"/><text x="'+(W-padR-2)+'" y="'+(by-5)+'" class="c-blabel" text-anchor="end">$'+B+'/hr</text>';
    if(n > 1){ var line = pts.map(function(p,i){ return (i?'L':'M')+(padL + band*i + band/2)+','+y(p.avg); }).join(''); h += '<path class="c-avg" d="'+line+'"/>'; }
  } else {
    var xs = pts.map(function(p,i){ return padL + band*i + band/2; });
    var line2 = pts.map(function(p,i){ return (i?'L':'M')+xs[i]+','+y(p.v); }).join('');
    h += '<path class="c-area" d="'+line2+'L'+xs[n-1]+','+y(0)+'L'+xs[0]+','+y(0)+'Z"/><path class="c-line" d="'+line2+'"/>';
    var ex = xs[n-1], ey = y(pts[n-1].v);
    h += '<circle cx="'+ex+'" cy="'+ey+'" r="5" class="c-dot"/><text x="'+Math.min(ex, W-padR-4)+'" y="'+(ey-10)+'" class="c-label" text-anchor="end">'+signed(pts[n-1].v)+'</text>';
  }
  if(chartMode!=="show") h += '<line id="c-cross" x1="0" x2="0" y1="'+padT+'" y2="'+(padT+ph)+'" class="c-cross" style="display:none"/>';
  pts.forEach(function(p,i){ h += '<rect class="c-hit" data-i="'+i+'" x="'+(padL+band*i)+'" y="'+padT+'" width="'+band+'" height="'+ph+'"/>'; });
  h += '</svg><div class="c-tip" id="c-tip" role="status" hidden></div>';
  box.innerHTML = h;
  var tip = document.getElementById("c-tip"), cross = document.getElementById("c-cross");
  function show(i){ var p = pts[i], cx = padL + band*i + band/2;
    tip.innerHTML = '<b>'+esc(p.sh.name||"Card show")+'</b><span>'+fmtDate(p.sh.date)+'</span><span>Profit <b class="num">'+signed(p.s.profit)+'</b></span>'+
      (chartMode==="run" ? '<span>Running total <b class="num">'+signed(p.v)+'</b></span>' : '')+
      (rate ? '<span>All-in <b class="num">'+perHr(p.v)+'</b> · 3-show avg '+perHr(p.avg)+'</span>' : '<span>'+(p.s.allIn!=null ? perHr(p.s.allIn)+' all-in' : 'No hours logged')+' · '+p.s.sold+' sold</span>');
    tip.hidden = false; var tw = tip.offsetWidth; tip.style.left = Math.max(4, Math.min(W - tw - 4, cx - tw/2))+"px"; tip.style.top = "4px";
    if(cross){ cross.setAttribute("x1",cx); cross.setAttribute("x2",cx); cross.style.display = ""; }
    box.querySelectorAll(".c-hit").forEach(function(r){ r.classList.toggle("on", +r.getAttribute("data-i")===i); }); }
  function hide(){ tip.hidden = true; if(cross) cross.style.display = "none"; box.querySelectorAll(".c-hit.on").forEach(function(r){ r.classList.remove("on"); }); }
  box.querySelectorAll(".c-hit").forEach(function(r){ var i = +r.getAttribute("data-i");
    r.addEventListener("pointerenter", function(){ show(i); }); r.addEventListener("pointerdown", function(){ show(i); }); });
  box.querySelector("svg").addEventListener("pointerleave", function(e){ if(e.pointerType==="mouse") hide(); });
}
window.addEventListener("resize", function(){ clearTimeout(resizeTimer); resizeTimer = setTimeout(function(){ if(state.view==="log" && root && root.offsetParent) drawChart(); }, 150); });

/* ---------- backup / restore ---------- */
var BK_MARK = "----- RESTORE DATA (keep this line and everything below it) -----";
function backupText(){
  var t = logStats(), L = [];
  L.push("CHAUNDOO CARD SCAN — PROFIT LOG BACKUP", "Saved: "+todayStr(), "");
  L.push("Total profit: "+signed(t.profit)+"   Card shows: "+t.shows+"   Hours: "+t.hours+"   Per hour: "+perHr(t.perHour)+"   All-in per hour: "+perHr(t.allIn)+"   Return: "+(t.roi==null?"—":pct(t.roi))+"   Average per show: "+(t.avg==null?"—":signed(t.avg)), "");
  sortedShows(false).forEach(function(sh){ var s = showStats(sh);
    L.push(sh.date+" · "+(sh.name||"Card show")+" · "+(s.hours||"?")+" h · profit "+signed(s.profit)+(s.perHour!=null?" · "+perHr(s.perHour):""));
    if(sh.notes) L.push("   Notes: "+sh.notes.replace(/\n/g,"\n   "));
    if(s.costs) L.push("   Fees and gas: $"+s.costs);
    sh.sales.forEach(function(r){ L.push("   "+saleName(r)+" | bought $"+(Number(r.bought)||0)+" | "+(saleDone(r) ? (saleStatus(r)==="traded"?"traded for $":"sold $")+Number(r.sold)+" | "+signed(Number(r.sold)-(Number(r.bought)||0)) : "holding")+(r.batch?" | "+batchName(r.batch, sh):"")); });
    L.push("");
  });
  L.push(BK_MARK, JSON.stringify({v:1, shows:LOG.shows}));
  return L.join("\n");
}
function markBackedUp(){ LOG.lastBackup = todayStr(); save("ccs.lastBackup", LOG.lastBackup); }
function downloadBackup(){
  var b = new Blob([backupText()], {type:"text/plain"}), a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = "chaundoo-profit-log-"+todayStr()+".txt"; document.body.appendChild(a); a.click();
  setTimeout(function(){ a.remove(); }, 1500); markBackedUp(); state.backupPanel = {mode:"done"}; render();
}
function parseBackup(text){
  var i = String(text||"").indexOf(BK_MARK), json = i>=0 ? text.slice(i+BK_MARK.length) : text;
  try{ var d = JSON.parse(json.trim()); if(d && Array.isArray(d.shows)) return d.shows.filter(function(s){ return s && typeof s==="object"; }).map(normShow); }catch(e){}
  return null;
}
function restoreFrom(text){
  var shows = parseBackup(text);
  if(!shows){ state.backupPanel = {mode:"msg", msg:"That doesn’t look like a profit log backup. Use the .txt file from “Save backup”."}; render(); return; }
  if(LOG.shows.length){ state.backupPanel = {mode:"confirm", shows:shows}; render(); return; }
  LOG.shows = shows; markBackedUp(); saveLog(); state.backupPanel = {mode:"msg", msg:"Restored "+shows.length+" card show"+(shows.length===1?"":"s")+"."}; render();
}
function backupPanelHtml(){
  var P = state.backupPanel; if(!P) return '';
  if(P.mode==="done") return '<p class="notice ok-note" role="status">Backup saved. Keep the file somewhere safe (email it to yourself or save it to cloud storage).</p>';
  if(P.mode==="msg") return '<p class="notice" role="status">'+esc(P.msg)+'</p>';
  if(P.mode==="choose") return '<div class="bk-panel"><b>How do you want to save your backup?</b><p class="sub">Both have the same log sheet, and either one can be used to restore your log later.</p>'+
    '<div class="bk-choices"><button class="bk-choice" id="bk-dl"><b>Text file</b><span class="sub">Saves a .txt file to your device</span></button>'+
    '<button class="bk-choice" id="bk-copytxt"><b>Copy and paste</b><span class="sub">Shows the text to paste into Notes, a message or an email</span></button></div>'+
    '<div class="bk-acts"><button class="btn ghost" id="bk-close">Cancel</button></div></div>';
  if(P.mode==="copy") return '<div class="bk-panel"><b>Copy your backup</b><p class="sub">Copy this text and paste it into Notes or an email to yourself. To restore later, paste it back in with Restore.</p><textarea id="bk-text" readonly rows="6">'+esc(P.text)+'</textarea><div class="bk-acts"><button class="btn primary" id="bk-copy">Copy text</button><button class="btn ghost" id="bk-close">Done</button></div></div>';
  if(P.mode==="restore") return '<div class="bk-panel"><b>Restore from a backup</b><p class="sub">Choose the backup .txt file, or paste the backup text below.</p><label class="btn">Choose file<input type="file" id="bk-file" accept=".txt,text/plain,.json" hidden></label><textarea id="bk-paste" rows="4" placeholder="…or paste the backup text here"></textarea><div class="bk-acts"><button class="btn primary" id="bk-paste-go">Restore pasted text</button><button class="btn ghost" id="bk-close">Cancel</button></div></div>';
  if(P.mode==="confirm") return '<div class="bk-panel"><b>Replace your current log?</b><p class="sub">This log has '+LOG.shows.length+' card show'+(LOG.shows.length===1?'':'s')+'. The backup has '+P.shows.length+'. Restoring replaces what’s here.</p><div class="bk-acts"><button class="btn danger" id="bk-replace">Replace with backup</button><button class="btn ghost" id="bk-close">Cancel</button></div></div>';
  return '';
}
function bindBackup(){
  function on(id, fn){ var el = document.getElementById(id); if(el) el.addEventListener("click", fn); }
  on("bk-save", function(){ state.backupPanel = {mode:"choose"}; render(); });
  on("bk-dl", downloadBackup);
  on("bk-copytxt", function(){ state.backupPanel = {mode:"copy", text:backupText()}; render(); });
  on("bk-restore", function(){ state.backupPanel = {mode:"restore"}; render(); });
  on("bk-close", function(){ state.backupPanel = null; render(); });
  on("bk-copy", function(){ var ta = document.getElementById("bk-text"), btn = document.getElementById("bk-copy");
    copyText(ta.value).then(function(){ markBackedUp(); btn.textContent = "Copied"; }, function(){ ta.select(); }); });
  on("bk-replace", function(){ LOG.shows = state.backupPanel.shows; markBackedUp(); saveLog(); state.backupPanel = {mode:"msg", msg:"Restored "+LOG.shows.length+" card shows from the backup."}; render(); });
  on("bk-paste-go", function(){ restoreFrom(document.getElementById("bk-paste").value); });
  var f = document.getElementById("bk-file"); if(f) f.addEventListener("change", function(){ var file = f.files && f.files[0]; if(!file) return; var fr = new FileReader(); fr.onload = function(){ restoreFrom(String(fr.result)); }; fr.readAsText(file); });
}

/* ---------- screens ---------- */
function anTable(head, rows){
  return '<div class="tbl-wrap"><table class="an-tbl"><tr>'+head.map(function(x){ return '<th'+(x.r?' class="r"':'')+'>'+x.t+'</th>'; }).join("")+'</tr>'+
    rows.map(function(r){ return '<tr>'+r.map(function(c,i){ return '<td'+(head[i].r?' class="r num"':'')+'>'+c+'</td>'; }).join("")+'</tr>'; }).join("")+'</table></div>';
}
function pnCls(n){ return n>=0 ? 'pos-t' : 'neg-t'; }
function groupTable(ttl, groups, note){
  if(!groups.length) return '';
  return '<section class="block"><h3>'+ttl+'</h3>'+anTable([{t:"Group"},{t:"Flips",r:1},{t:"Spent",r:1},{t:"Profit",r:1},{t:"Return",r:1},{t:"Made money",r:1}],
    groups.map(function(g){ return ['<b>'+esc(g.label)+'</b>', g.n, money(g.cost,0), '<span class="'+pnCls(g.profit)+'">'+signed(g.profit)+'</span>', g.roi==null?'—':'<span class="'+pnCls(g.roi)+'">'+pct(g.roi)+'</span>', g.wins+' of '+g.n]; }))+
    (note?'<p class="note">'+note+'</p>':'')+'</section>';
}
function renderLock(){
  root.innerHTML = '<form class="flock" id="llock" autocomplete="off"><h2>Profit Log</h2><p>Enter your 4-digit passcode to open your profit log. You only need to do this once on each phone.</p>'+
    '<input id="llock-code" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" aria-label="Passcode">'+
    '<button class="btn primary" type="submit">Unlock</button><div class="msg" id="llock-msg" role="status"></div></form>';
  var f = document.getElementById("llock"), inp = document.getElementById("llock-code"), msg = document.getElementById("llock-msg"), busy = false;
  function tryCode(){
    var v = inp.value.trim(); if(v.length < 4){ msg.textContent = "Enter all 4 digits."; return; }
    if(busy) return; busy = true; msg.textContent = "Unlocking…";
    unlock(v).then(function(){ state.view = "log"; render(); tabBadge(); listeners.forEach(function(fn){ try{ fn(); }catch(e){} }); })
      .catch(function(){ busy = false; msg.textContent = "Wrong passcode."; inp.value = ""; inp.focus(); });
  }
  f.addEventListener("submit", function(e){ e.preventDefault(); tryCode(); });
  inp.addEventListener("input", function(){ inp.value = inp.value.replace(/\D/g,"").slice(0,4); if(!busy) msg.textContent = ""; if(inp.value.length===4) tryCode(); });
}
function logOverview(t){
  var B = LOGSET.bench, h = '', gap = t.allIn==null ? null : t.allIn - B;
  h += '<div class="log-hero"><span class="lbl">Total profit</span><b class="'+(t.profit>=0?'':'neg-t')+'">'+signed(t.profit)+'</b><span class="sub">from '+t.sold+' card'+(t.sold===1?'':'s')+' sold'+(t.costs?' · after '+money(t.costs,0)+' in fees and gas':'')+'</span></div>';
  h += '<div class="log-tiles four">'+
    '<div><span>All-in per hour</span><b>'+perHr(t.allIn)+'</b><small>'+(gap==null ? 'Add hours to a show to see this' : '<span class="'+pnCls(gap)+'">'+(gap>=0?'+':'−')+'$'+Math.abs(gap).toFixed(2)+'/hr</span> vs. $'+B+'/hr')+'</small></div>'+
    '<div><span>Return on spend</span><b>'+(t.roi==null?'—':pct(t.roi))+'</b><small>on '+money(t.base,0)+' spent</small></div>'+
    '<div><span>Average per show</span><b>'+(t.avg==null?'—':signed(t.avg))+'</b><small>'+t.shows+' card show'+(t.shows===1?'':'s')+'</small></div>'+
    '<div><span>In unsold cards</span><b>'+money(t.holdingCost,0)+'</b><small>'+(t.holding ? t.holding+' card'+(t.holding===1?'':'s')+' still holding' : 'Everything sold')+'</small></div></div>';
  if(t.allInHours > 0){
    var mx = Math.max(t.hProfit, t.benchPay, 1);
    h += '<section class="block"><h3>Compared with $'+B+'/hr</h3><div class="bench">'+
      '<div class="bbar"><span>Flipping</span><i style="width:'+Math.max(2, Math.max(0,t.hProfit)/mx*100)+'%" class="'+(t.hProfit>=t.benchPay?'up':'down')+'"></i><b class="num">'+signed(t.hProfit)+'</b></div>'+
      '<div class="bbar"><span>At $'+B+'/hr</span><i style="width:'+Math.max(2, t.benchPay/mx*100)+'%" class="job"></i><b class="num">'+money(t.benchPay,0)+'</b></div>'+
      '<p>Over <b>'+(Math.round(t.allInHours*10)/10)+' hours</b> ('+t.hours+' at shows plus '+LOGSET.buffer+' min extra per show), $'+B+'/hr would have paid <b>'+money(t.benchPay,0)+'</b>. Flipping made <b class="'+pnCls(t.extra)+'">'+(t.extra>=0?money(t.extra,0)+' more':money(-t.extra,0)+' less')+'</b>.</p>'+
      '<p><b>'+t.beat+' of '+t.rated+'</b> show'+(t.rated===1?'':'s')+' beat $'+B+'/hr.'+
      (t.noBest!=null ? ' Without your best show ('+esc(t.best.sh.name||'Card show')+', '+fmtDate(t.best.sh.date)+'): <b class="'+pnCls(t.noBest-B)+'">'+perHr(t.noBest)+'</b>'+(t.noBest>=B?', still above.':', below the benchmark.') : '')+'</p>'+
      (t.avgDays!=null ? '<p>Average time from buying to selling: <b>'+(t.avgDays<0.5?'same day':Math.round(t.avgDays)+' day'+(Math.round(t.avgDays)===1?'':'s'))+'</b>.</p>' : '')+
      '</div></section>';
  }
  h += '<section class="block"><h3>Before you leave a show</h3><div class="calc"><div class="calc-in"><label class="f">Hours there so far<input id="be-h" type="number" min="0" step="0.25" inputmode="decimal" placeholder="e.g. 2"></label><label class="f">Spent so far<input id="be-s" type="number" min="0" step="1" inputmode="decimal" placeholder="e.g. 150"></label></div><p class="calc-out" id="be-out" aria-live="polite">Enter your hours to see the profit you need to beat $'+B+'/hr.</p></div></section>';
  h += '<section class="block"><div class="c-head"><h3>'+(chartMode==="run"?'Running total':chartMode==="rate"?'All-in per hour':'Profit by show')+'</h3><div class="seg" role="group" aria-label="Chart view"><button id="cm-show" aria-pressed="'+(chartMode==="show")+'">Each show</button><button id="cm-run" aria-pressed="'+(chartMode==="run")+'">Running total</button><button id="cm-rate" aria-pressed="'+(chartMode==="rate")+'">Per hour</button></div></div><div class="chart-box" id="pchart"></div>'+
    (chartMode==="rate"?'<p class="note">Bars are all-in money per hour (show time plus '+LOGSET.buffer+' min). Blue beats $'+B+'/hr, red falls short. The line is the average of the last 3 shows.</p>':'')+'</section>';
  var hold = []; LOG.shows.forEach(function(sh){ sh.sales.forEach(function(r){ if(!saleDone(r)) hold.push({sh:sh, r:r, d:dayDiff(r.boughtOn||sh.date, todayStr())}); }); });
  if(hold.length){ hold.sort(function(a,b){ return (b.d||0)-(a.d||0); });
    h += '<section class="block"><h3>Still holding ('+hold.length+')</h3><div class="plist">'+hold.map(function(x){ return '<button class="show-row" data-show="'+esc(x.sh.id)+'"><span class="show-date">'+(x.d==null?'—':x.d+' day'+(x.d===1?'':'s'))+'</span><span class="show-main"><b>'+esc(saleName(x.r))+'</b><span class="sub">Bought at '+esc(x.sh.name||'Card show')+', '+fmtDate(x.sh.date)+'</span></span><span class="show-num"><b class="num">'+money(Number(x.r.bought)||0,0)+'</b><span class="sub">paid</span></span></button>'; }).join("")+'</div></section>'; }
  h += '<section class="block"><h3>Card shows</h3><div class="plist">'+sortedShows(false).map(function(sh){ var s = showStats(sh);
    return '<button class="show-row" data-show="'+esc(sh.id)+'"><span class="show-date">'+fmtDate(sh.date)+'</span><span class="show-main"><b>'+esc(sh.name||"Card show")+'</b><span class="sub">'+(s.hours? s.hours+' h · ' : '')+s.sold+' sold'+(s.unsold? ' · '+s.unsold+' holding':'')+(s.roi!=null?' · '+pct(s.roi)+' return':'')+'</span>'+(sh.notes ? '<span class="show-note">📝 '+esc(sh.notes.replace(/\s+/g," ").slice(0,90))+'</span>' : '')+'</span>'+
      '<span class="show-num"><b class="num '+(s.profit>=0?'':'neg-t')+'">'+signed(s.profit)+'</b><span class="sub'+(s.beats==null?'':s.beats?' pos-t':' neg-t')+'">'+(s.allIn!=null?perHr(s.allIn)+' all-in':'')+'</span></span></button>'; }).join("")+'</div></section>';
  h += '<details class="lset"><summary>Benchmark: $'+B+'/hr · '+LOGSET.buffer+' min extra per show</summary><div class="lset-in"><label class="f">Pay to beat ($/hr)<input id="ls-bench" type="number" min="1" step="0.5" inputmode="decimal" value="'+B+'"></label><label class="f">Extra time per show (min)<input id="ls-buf" type="number" min="0" step="5" inputmode="numeric" value="'+LOGSET.buffer+'"></label></div><p class="note">Extra time covers rounding, breaks and traffic. It’s added to every show with hours. Saved on this device only.</p></details>';
  return h;
}
function logBreakdowns(){
  var units = allUnits(), h = '';
  if(!units.length) return '<div class="empty">Sell a card to see breakdowns.</div>';
  h += groupTable("Batches vs. single cards", groupUnits(units, function(u){ return u.kind==="batch" ? "Batches" : "Single cards"; }), 'A batch is judged on its total: everything you paid for the cards together against everything they sold for.');
  var batches = units.filter(function(u){ return u.kind==="batch"; });
  if(batches.length){
    h += '<section class="block"><h3>Each batch</h3>'+anTable([{t:"Batch"},{t:"Cards",r:1},{t:"Spent",r:1},{t:"Profit",r:1},{t:"Return",r:1},{t:"Lowest-earning card"}],
      batches.map(function(u){ var w = null; u.items.forEach(function(r){ var p = saleProfit(r); if(w==null || p < w.p) w = {r:r, p:p}; });
        return ['<b>'+esc(u.name)+'</b><br><span class="sub">'+fmtDate(u.sh.date)+'</span>', u.items.length, money(u.cost,0), '<span class="'+pnCls(u.profit)+'">'+signed(u.profit)+'</span>', u.roi==null?'—':'<span class="'+pnCls(u.roi)+'">'+pct(u.roi)+'</span>',
          u.items.length > 1 && w ? esc(saleName(w.r))+' <span class="'+pnCls(w.p)+'">'+signed(w.p)+'</span>' : '—']; }))+
      '<p class="note">The lowest-earning card uses how you split the batch price between cards. Before you agree to a bundle, check that every card would be a flip on its own.</p></section>';
  }
  h += groupTable("By flip type", groupUnits(units, flipLabel), '“Not set” means the condition you bought and sold it as isn’t filled in. Open a show and tap <b>More details</b> on a card to add it.');
  h += groupTable("By era", groupUnits(units, eraLabel), null);
  h += groupTable("By vendor", groupUnits(units, vendorLabel), 'Add the vendor under <b>More details</b> on each card to see who pays best.');
  return h;
}
function logAccuracy(){
  var units = allUnits().filter(function(u){ return u.expected!=null && u.got > 0; }), h = '';
  if(!units.length) return '<div class="empty">No flips to compare yet.<br><span class="sub">A flip needs an expected sale price: set the condition you sold it as under <b>More details</b>, or add it from a card page in Card Scan.</span></div>';
  var ex = 0, got = 0, abs = 0, today = false;
  units.forEach(function(u){ ex += u.expected; got += u.got; abs += Math.abs(u.got-u.expected)/u.expected; today = today || u.expToday; });
  var bias = (got-ex)/ex*100, mape = abs/units.length*100;
  h += '<div class="psum"><div class="psum-main"><span class="lbl">Sold vs. what you expected</span><b class="num '+pnCls(bias)+'">'+pct(bias)+'</b></div>'+
    '<p class="sub">Across '+units.length+' flip'+(units.length===1?'':'s')+' you sold for <b>'+money(got,0)+'</b> against <b>'+money(ex,0)+'</b> expected. A typical flip landed <b>'+Math.round(mape)+'%</b> away from the estimate'+(Math.abs(bias)<3?', so the estimates are close to what you actually get.':bias>0?', and the estimates tend to run low for you.':', and the estimates tend to run high for you.')+'</p></div>';
  h += '<section class="block"><h3>Each flip</h3>'+anTable([{t:"Flip"},{t:"Type"},{t:"Expected",r:1},{t:"Sold for",r:1},{t:"Difference",r:1}],
    units.slice().reverse().map(function(u){ var d = u.got - u.expected;
      return ['<b>'+esc(u.name)+'</b><br><span class="sub">'+fmtDate(u.sh.date)+'</span>', esc(flipLabel(u)), money(u.expected,0)+(u.expToday?'*':''), money(u.got,0), '<span class="'+pnCls(d)+'">'+signed(d)+' ('+pct(d/u.expected*100)+')</span>']; }))+
    '<p class="note">Expected = the market price for the condition you sold it as × your vendor rate ('+vendorPct()+'%), saved when you logged it.'+(today?' * Uses today’s Card Flipz price, because no estimate was saved when you logged it.':'')+'</p></section>';
  var g = {}; units.forEach(function(u){ var k = flipLabel(u); (g[k] = g[k] || {ex:0, got:0, n:0}); g[k].ex += u.expected; g[k].got += u.got; g[k].n++; });
  var keys = Object.keys(g); if(keys.length > 1) h += '<section class="block"><h3>By flip type</h3>'+anTable([{t:"Type"},{t:"Flips",r:1},{t:"Expected",r:1},{t:"Sold for",r:1},{t:"Difference",r:1}],
    keys.map(function(k){ var x = g[k], d = (x.got-x.ex)/x.ex*100; return ['<b>'+esc(k)+'</b>', x.n, money(x.ex,0), money(x.got,0), '<span class="'+pnCls(d)+'">'+pct(d)+'</span>']; }))+'</section>';
  return h;
}
function renderLog(){
  var t = logStats(), tab = state.logTab || load("ccs.logtab", "overview"), h = '';
  h += '<div class="pair-intro"><div><h2>Profit Log</h2><p class="sub">Log each card show: what you paid, what you sold for, and how long you were there. Changes save on your phone right away; tap <b>Save to GitHub</b> to keep them for good. On GitHub the log is saved scrambled, so only someone with your passcode can read it.</p></div><button class="btn primary" id="newshow">+ Log a card show</button></div>';
  if(!logStorageOk) h += '<p class="notice">This browser is blocking storage for the site, so unsaved changes are lost if you close it. Tap Save to GitHub before leaving.</p>';
  if(state.notice) h += '<p class="notice" role="status">'+esc(state.notice)+'</p>';
  h += backupPanelHtml();
  if(!LOG.shows.length){
    h += '<div class="empty log-empty"><b>No card shows logged yet.</b><br>Tap <b>Log a card show</b>, add the cards you bought and what they sold for, and your profit, money per hour and chart show up here.<br><span class="sub">Tip: on a card page, <b>Add to Profit Log</b> logs the card you just scanned.</span></div>';
  } else {
    h += '<div class="seg log-tabs" role="tablist" aria-label="Profit log views">'+[["overview","Overview"],["breakdowns","Breakdowns"],["accuracy","Price accuracy"]].map(function(x){ return '<button role="tab" data-ltab="'+x[0]+'" aria-pressed="'+(tab===x[0])+'" aria-selected="'+(tab===x[0])+'">'+x[1]+'</button>'; }).join("")+'</div>';
    h += tab==="breakdowns" ? logBreakdowns() : tab==="accuracy" ? logAccuracy() : logOverview(t);
  }
  h += '<div class="log-lockrow"><button class="btn ghost" id="loglock">🔒 Lock on this device</button></div>';
  h += '<div class="bk-foot"><span class="sub">Backup: '+(LOG.lastBackup ? 'last saved '+fmtDate(LOG.lastBackup) : 'never saved')+'</span><button class="btn ghost" id="bk-save">Save backup</button><button class="btn ghost" id="bk-restore">Restore</button></div>';
  root.innerHTML = h;
  document.getElementById("newshow").addEventListener("click", function(){ var sh = newShow(); goLog(sh.id); });
  bindBackup();
  document.getElementById("loglock").addEventListener("click", function(){
    if(pendingCount() && !confirm("You have changes not on GitHub yet. They stay on this phone and come back when you unlock. Lock now?")) return; lockLog(); });
  root.querySelectorAll("[data-ltab]").forEach(function(b){ b.addEventListener("click", function(){ state.logTab = b.getAttribute("data-ltab"); save("ccs.logtab", state.logTab); render(); }); });
  root.querySelectorAll("[data-show]").forEach(function(b){ b.addEventListener("click", function(){ goLog(b.getAttribute("data-show")); }); });
  [["cm-show","show"],["cm-run","run"],["cm-rate","rate"]].forEach(function(x){ var el = document.getElementById(x[0]); if(el) el.addEventListener("click", function(){ chartMode = x[1]; render(true); }); });
  var bh = document.getElementById("be-h"), bs = document.getElementById("be-s"), bo = document.getElementById("be-out");
  if(bh){ var upd = function(){ var hv = parseFloat(bh.value), sv = parseFloat(bs.value);
      if(!(hv>=0)){ bo.innerHTML = 'Enter your hours to see the profit you need to beat $'+LOGSET.bench+'/hr.'; return; }
      var r = showBreakEven(hv, sv>0 ? sv : 0);
      bo.innerHTML = 'To beat <b>$'+LOGSET.bench+'/hr</b>, leave with at least <b class="pos-t">'+signed(r.target)+'</b> profit'+(r.roi!=null ? ', a <b>'+pct(r.roi)+'</b> return on what you spent.' : '.'); };
    bh.addEventListener("input", upd); bs.addEventListener("input", upd); }
  var lb = document.getElementById("ls-bench"), lf = document.getElementById("ls-buf");
  if(lb){ lb.addEventListener("change", function(){ var v = parseFloat(lb.value); if(v>0){ LOGSET.bench = v; saveLogSet(); render(true); } });
    lf.addEventListener("change", function(){ var v = parseFloat(lf.value); if(v>=0){ LOGSET.buffer = v; saveLogSet(); render(true); } }); }
  drawChart();
}
function saleImg(r){ var c = r.cardId ? cardById(r.cardId) : null; return c && c.image ? thumb(c) : (r.img || ""); }
function renderShow(){
  var sh = showById(state.showId); if(!sh){ state.view = "log"; return renderLog(); }
  var s = showStats(sh), B = LOGSET.bench, h = '';
  h += '<div class="back"><button class="btn ghost" id="sback">← All card shows</button></div>';
  h += '<div class="pair-head"><label class="pname"><span class="sub">Show name</span><input id="sname" value="'+esc(sh.name||"")+'" maxlength="60" placeholder="e.g. Ontario Card Show"></label><div class="confirm">'+
    (state.logConfirm==="del" ? '<span>Delete this show and its log?</span><button class="btn danger" id="sdel-yes">Delete</button><button class="btn" id="sdel-no">Keep</button>' : '<button class="btn ghost" id="sdel">Delete show</button>')+'</div></div>';
  h += '<div class="show-fields"><label class="f">Date<input type="date" id="sdate" value="'+esc(sh.date||"")+'"></label><label class="f">Hours at the show<input type="number" id="shours" min="0" step="0.25" inputmode="decimal" placeholder="e.g. 5.5" value="'+esc(isNum(sh.hours)?sh.hours:"")+'"></label><label class="f">Fees and gas<input type="number" id="scosts" min="0" step="0.01" inputmode="decimal" placeholder="$0" value="'+esc(isNum(sh.costs)?sh.costs:"")+'"></label></div>';
  h += '<div class="psum"><div class="psum-main"><span class="lbl">Profit from this show</span><b class="num '+(s.profit>=0?'pos-t':'neg-t')+'">'+signed(s.profit)+'</b>'+(s.allIn!=null?'<span class="pill '+(s.beats?'pos':'neg')+'">'+perHr(s.allIn)+' all-in</span>':'')+(s.roi!=null?'<span class="pill est">'+pct(s.roi)+' return</span>':'')+'</div>'+
    '<div class="psum-stats"><div><span>You paid</span><b class="num">'+money(s.spent,0)+'</b><small>'+sh.sales.length+' card'+(sh.sales.length===1?'':'s')+(s.costs?' · '+money(s.costs,0)+' fees and gas':'')+'</small></div><div class="v"><span>You sold for</span><b class="num">'+money(s.got,0)+'</b><small>'+s.sold+' sold'+(s.traded?' ('+s.traded+' traded)':'')+'</small></div><div><span>Still holding</span><b class="num">'+s.unsold+'</b><small>'+(s.unsold? money(s.unsoldCost,0)+' paid, not counted yet' : 'Everything sold')+'</small></div></div>';
  if(s.hours > 0){ var need = s.target, prog = need > 0 ? Math.max(0, Math.min(1, s.profit/need)) : 1;
    h += '<div class="be-row"><div class="meter" role="img" aria-label="'+Math.round(prog*100)+' percent of the profit needed to beat '+B+' dollars an hour"><i class="'+(s.profit>=need?'up':'down')+'" style="width:'+(prog*100)+'%"></i></div>'+
      '<p class="sub">To beat <b>$'+B+'/hr</b> over '+(Math.round(s.allInHours*100)/100)+' hours ('+s.hours+' here plus '+LOGSET.buffer+' min), this show needs <b>'+signed(need)+'</b>'+(s.spent>0?', a '+pct(need/s.spent*100)+' return on what you paid':'')+'. '+(s.profit>=need?'<b class="pos-t">Beat it by '+money(s.profit-need,0)+'.</b>':'<b class="neg-t">'+money(need-s.profit,0)+' short.</b>')+'</p></div>'; }
  else h += '<p class="sub">Add your hours above to see money per hour and the profit you need to beat $'+B+'/hr.</p>';
  h += '</div>';
  var nlen = (sh.notes||"").length;
  h += '<section class="block"><h3>Notes</h3><textarea id="snotes" class="snotes" maxlength="'+NOTES_MAX+'" rows="6" placeholder="Your thoughts on this show: how it went, vendors who paid well, cards people were asking for, what to bring next time…">'+esc(sh.notes||"")+'</textarea>'+
    '<div class="notes-meta sub"><span id="snotes-st">'+(nlen?'Saved on this phone. Tap Save to GitHub to keep it for good.':'Notes save as you type.')+'</span><span id="snotes-n">'+nlen+' / '+NOTES_MAX+'</span></div></section>';
  var vendors = {}; LOG.shows.forEach(function(x){ x.sales.forEach(function(r){ if(r.vendor) vendors[r.vendor.trim()] = 1; }); });
  var bids = []; sh.sales.forEach(function(r){ if(r.batch && bids.indexOf(r.batch)<0) bids.push(r.batch); });
  var condOpts = function(v){ return '<option value="">Not set</option>'+Object.keys(LCONDS).map(function(k){ return '<option value="'+k+'"'+(v===k?' selected':'')+'>'+LCONDS[k]+'</option>'; }).join(""); };
  h += '<section class="block"><h3>Cards ('+sh.sales.length+')</h3>';
  if(!sh.sales.length) h += '<div class="empty">No cards yet. Add the cards you bought or sold at this show below, or use <b>Add to Profit Log</b> on a card page.</div>';
  else h += '<datalist id="vendor-list">'+Object.keys(vendors).sort().map(function(v){ return '<option value="'+esc(v)+'">'; }).join("")+'</datalist><div class="plist pitems">'+sh.sales.map(function(r,i){
      var st = saleStatus(r), p = saleProfit(r), im = saleImg(r), ex = saleExpected(r);
      var tags = []; if(r.batch) tags.push(batchName(r.batch, sh)); if(r.from && r.to) tags.push(LCONDS[r.from]+' → '+LCONDS[r.to]); if(r.vendor) tags.push(r.vendor);
      return '<div class="prow2 srow"><div class="top2"><span class="ccell">'+(im?'<span class="pmini"><img src="'+esc(im)+'" alt="" loading="lazy" onerror="this.parentNode.remove()"></span>':'')+'<b>'+esc(saleName(r))+'</b></span><button class="xbtn" data-sx="'+i+'" aria-label="Remove '+esc(saleName(r))+'">×</button></div>'+
        '<div class="pfields three"><label>Status<select class="sst" data-i="'+i+'"><option value="sold"'+(st==="sold"?' selected':'')+'>Sold</option><option value="holding"'+(st==="holding"?' selected':'')+'>Holding</option><option value="traded"'+(st==="traded"?' selected':'')+'>Traded</option></select></label>'+
        '<label>Bought for<input class="sb" data-i="'+i+'" type="number" step="0.01" min="0" inputmode="decimal" value="'+esc(isNum(r.bought)?r.bought:"")+'"></label>'+
        '<label>'+(st==="traded"?'Trade value':'Sold for')+'<input class="ss" data-i="'+i+'" type="number" step="0.01" min="0" inputmode="decimal" placeholder="'+(st==="holding"?'Not sold yet':'')+'" value="'+esc(st!=="holding"&&isNum(r.sold)?r.sold:"")+'"></label></div>'+
        '<div class="meta">'+(p==null?(st==="holding"?'Holding · not counted yet':'Add the '+(st==="traded"?'trade value':'sale price')+' to count it'):'Profit <b class="num '+(p>=0?'pos-t':'neg-t')+'">'+signed(p)+'</b>')+(tags.length?' · '+esc(tags.join(' · ')):'')+'</div>'+
        '<details class="sx" data-sid="'+esc(r.id)+'"'+(state.sxOpen[r.id]?' open':'')+'><summary>More details</summary><div class="pfields sx-grid">'+
          '<label>Vendor<input class="sv" data-i="'+i+'" list="vendor-list" maxlength="40" placeholder="Who you sold to" value="'+esc(r.vendor||"")+'"></label>'+
          '<label>Batch<select class="sbt" data-i="'+i+'"><option value="">Not in a batch</option>'+bids.map(function(b){ return '<option value="'+esc(b)+'"'+(r.batch===b?' selected':'')+'>'+esc(batchName(b, sh))+'</option>'; }).join("")+'<option value="__new">New batch</option></select></label>'+
          '<label>Bought as<select class="sfr" data-i="'+i+'">'+condOpts(r.from)+'</select></label>'+
          '<label>Sold as<select class="sto" data-i="'+i+'">'+condOpts(r.to)+'</select></label>'+
          '<label>Bought on<input class="sbo" data-i="'+i+'" type="date" value="'+esc(r.boughtOn||sh.date||"")+'"></label>'+
          '<label>Sold on<input class="sso" data-i="'+i+'" type="date" value="'+esc(r.soldOn||(st==="holding"?"":sh.date)||"")+'"></label>'+
          '<label class="pf-paid">Expected sale<input class="sex" data-i="'+i+'" type="number" step="0.01" min="0" inputmode="decimal" placeholder="'+(ex?'Estimate '+money(ex.v,0):'What you expected to get')+'" value="'+esc(isNum(r.expected)?r.expected:"")+'"></label>'+
        '</div></details></div>'; }).join("")+'</div>';
  h += '<p class="note">Set a card to <b>Holding</b> until it sells; holding cards don’t count toward profit yet. Cards in the same batch are judged together in Breakdowns.</p></section>';
  h += '<div class="padd"><label class="search"><span class="sub">Add a card</span><input id="sadd-q" type="search" placeholder="Type a card name" autocomplete="off"></label><div class="padd-res" id="sadd-res"></div></div>';
  root.innerHTML = h;
  function redraw(){ saveLog(); var y = window.scrollY; render(); window.scrollTo(0,y); }
  var nt = document.getElementById("snotes"), nst = document.getElementById("snotes-st"), nn = document.getElementById("snotes-n"), ntimer = null;
  function flushNotes(){ clearTimeout(ntimer); ntimer = null; if(sh.notes !== nt.value){ sh.notes = nt.value.slice(0,NOTES_MAX); saveLog(); } nst.textContent = "Saved on this phone. Tap Save to GitHub to keep it for good."; }
  nt.addEventListener("input", function(){ nn.textContent = nt.value.length+" / "+NOTES_MAX; nst.textContent = "Saving…"; clearTimeout(ntimer); ntimer = setTimeout(flushNotes, 600); });
  nt.addEventListener("blur", flushNotes);
  document.getElementById("sback").addEventListener("click", function(){ flushNotes(); goLog(null); });
  var nm = document.getElementById("sname"); nm.addEventListener("change", function(){ sh.name = nm.value.trim() || "Card show"; saveLog(); });
  var dt = document.getElementById("sdate"); dt.addEventListener("change", function(){ sh.date = dt.value; redraw(); });
  var hr = document.getElementById("shours"); hr.addEventListener("change", function(){ var v = parseFloat(hr.value); sh.hours = isNaN(v)||v<0 ? "" : v; redraw(); });
  var co = document.getElementById("scosts"); co.addEventListener("change", function(){ var v = parseFloat(co.value); sh.costs = isNaN(v)||v<=0 ? "" : v; redraw(); });
  var d1 = document.getElementById("sdel"); if(d1) d1.addEventListener("click", function(){ state.logConfirm = "del"; render(); });
  var d2 = document.getElementById("sdel-no"); if(d2) d2.addEventListener("click", function(){ state.logConfirm = null; render(); });
  var d3 = document.getElementById("sdel-yes"); if(d3) d3.addEventListener("click", function(){ LOG.shows = LOG.shows.filter(function(x){ return x!==sh; }); saveLog(); goLog(null); });
  function row(el){ return sh.sales[+el.getAttribute("data-i")]; }
  function num(el){ var v = parseFloat(el.value); return isNaN(v)||v<0 ? "" : v; }
  root.querySelectorAll("input.sb").forEach(function(inp){ inp.addEventListener("change", function(){ row(inp).bought = num(inp); redraw(); }); });
  root.querySelectorAll("input.ss").forEach(function(inp){ inp.addEventListener("change", function(){ var r = row(inp); r.sold = num(inp); if(isNum(r.sold) && r.status==="holding") r.status = "sold"; if(!isNum(r.sold) && r.status!=="traded") r.status = "holding"; redraw(); }); });
  root.querySelectorAll("select.sst").forEach(function(sel){ sel.addEventListener("change", function(){ var r = row(sel); r.status = sel.value; if(sel.value==="holding"){ r.sold = ""; r.soldOn = ""; } redraw(); }); });
  root.querySelectorAll("input.sv").forEach(function(inp){ inp.addEventListener("change", function(){ row(inp).vendor = inp.value.trim().slice(0,40); redraw(); }); });
  root.querySelectorAll("select.sbt").forEach(function(sel){ sel.addEventListener("change", function(){ var r = row(sel); r.batch = sel.value==="__new" ? uid("b") : sel.value; redraw(); }); });
  root.querySelectorAll("select.sfr").forEach(function(sel){ sel.addEventListener("change", function(){ row(sel).from = sel.value; redraw(); }); });
  root.querySelectorAll("select.sto").forEach(function(sel){ sel.addEventListener("change", function(){ row(sel).to = sel.value; redraw(); }); });
  root.querySelectorAll("input.sbo").forEach(function(inp){ inp.addEventListener("change", function(){ var r = row(inp); r.boughtOn = inp.value===sh.date ? "" : inp.value; redraw(); }); });
  root.querySelectorAll("input.sso").forEach(function(inp){ inp.addEventListener("change", function(){ var r = row(inp); r.soldOn = inp.value===sh.date ? "" : inp.value; redraw(); }); });
  root.querySelectorAll("input.sex").forEach(function(inp){ inp.addEventListener("change", function(){ row(inp).expected = num(inp); redraw(); }); });
  root.querySelectorAll("details.sx").forEach(function(d){ d.addEventListener("toggle", function(){ state.sxOpen[d.getAttribute("data-sid")] = d.open; }); });
  root.querySelectorAll("[data-sx]").forEach(function(b){ b.addEventListener("click", function(){ sh.sales.splice(+b.getAttribute("data-sx"),1); redraw(); }); });
  var q = document.getElementById("sadd-q"), res = document.getElementById("sadd-res");
  function addRow(r){ sh.sales.push(r); saveLog(); render(); var n = document.getElementById("sadd-q"); if(n) n.focus(); }
  q.addEventListener("input", function(){
    var raw = q.value.trim(); if(!raw){ res.innerHTML = ""; return; }
    var hits = searchCards(raw);
    res.innerHTML = hits.map(function(c){ return '<button data-sadd="'+esc(c.id)+'"><span><span class="rthumb">'+(c.image?'<img src="'+esc(thumb(c))+'" alt="" loading="lazy" onerror="this.remove()">':'')+'</span><span><b>'+esc(title(c))+'</b> <span class="sub">'+esc(c.set||"")+(c.number?' · #'+esc(c.number):'')+'</span></span></span><span class="sub">+ Add</span></button>'; }).join("")+
      '<button data-snew="1"><span>Add “<b>'+esc(raw)+'</b>”</span><span class="sub">+ Add</span></button>';
    res.querySelectorAll("[data-sadd]").forEach(function(b){ b.addEventListener("click", function(){ addRow({id:uid("r"), cardId:b.getAttribute("data-sadd"), label:"", bought:"", sold:"", status:"holding"}); }); });
    res.querySelector("[data-snew]").addEventListener("click", function(){ addRow({id:uid("r"), cardId:null, label:raw.slice(0,80), bought:"", sold:"", status:"holding"}); });
  });
}
function render(keepScroll){
  if(!root) return; var y = window.scrollY;
  if(STATUS==="loading"){ root.innerHTML = '<p class="sub" style="padding:20px 4px">Loading your profit log…</p>'; }
  else if(STATUS==="error"){ root.innerHTML = '<div class="empty">Couldn’t load the profit log: '+esc(ERR)+'<br><button class="btn" id="log-retry" style="margin-top:10px">Try again</button></div>';
    document.getElementById("log-retry").onclick = function(){ STATUS = "loading"; render(); init(); }; }
  else if(STATUS==="locked") renderLock();
  else if(state.view==="show") renderShow();
  else { state.view = "log"; renderLog(); }
  renderBar();
  if(keepScroll) window.scrollTo(0, y);
}

/* ---------- start ---------- */
var initP = null;
function init(){
  initP = fetchLog().then(open).catch(function(e){ STATUS = "error"; ERR = e.message||String(e); })
    .then(function(){ if(STATUS==="locked") state.view = "lock"; render(); tabBadge(); listeners.forEach(function(f){ try{ f(); }catch(e){} }); });
  return initP;
}
function boot(){
  root = document.getElementById("log-root"); if(!root) return;
  init();
  document.addEventListener("visibilitychange", function(){ if(!document.hidden && STATUS==="open" && SYNC.sentAt) reloadRemote(); });
}
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot); else boot();

/* ---------- for the card page: see this card's history and add a sale ---------- */
window.CCSLOG = {
  ready:function(){ return initP || Promise.resolve(); },
  status:function(){ return STATUS; },
  shows:function(){ return STATUS==="open" ? sortedShows(false) : []; },
  catalog:function(){ return loadCatalog().then(function(){ return cardIdx; }); },
  saleName:saleName, saleDone:saleDone, todayStr:todayStr,
  addSale:function(showId, newName, sale){
    if(STATUS!=="open") return null;
    var sh = showId ? showById(showId) : null;
    if(!sh) sh = newShow(newName || "Card show");
    sh.sales.push(normSale(sale)); saveLog(); if(root && STATUS==="open") render(true); return sh;
  },
  open:function(showId){ goLog(showId||null); },
  onChange:function(f){ listeners.push(f); }
};
})();
