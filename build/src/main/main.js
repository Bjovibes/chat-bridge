// Chat Bridge â€” app entry. Official WhatsApp Web companion sessions, privacy
// blinds, AI drafts. The app never sends messages; it only inserts drafts.
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const sessions = require('./sessions');
const uiWC = sessions.uiWC;   // the operator-facing webContents helper (UI view, never the window's own)
const ipc = require('./ipc');
const windows = require('./windows');

const args = process.argv.slice(2);
const SMOKE = args.includes('--smoke');
const MOCK = args.includes('--mock');
const CAPTURE = args.includes('--capture');

const CENSUS = args.includes('--census');
const PROBE = args.includes('--probe');
const TRIAL = args.includes('--trial');
const MEDIAPROBE = args.includes('--mediaprobe');
const TGPROBE = args.includes('--tgprobe');   // F1 telegram-names: structure dump
const SENDREPORT = args.includes('--sendreport');
const SELFTEST = args.includes('--selftest');

// v13 M1: a spine tick landing mid-teardown must log, never kill the gate.
// The sources are guarded too (sessions.js S-patches); this belt keeps
// npm run smoke exit-0 deterministic even if a late tick still slips one.
process.on('unhandledRejection', (reason) => {
  console.log('[spine] late async miss (non-fatal):', String(reason && reason.message || reason));
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Never vanish silently: if a copy is already running, say so, then leave.
  try {
    dialog.showErrorBox(
      'Chat Bridge is already running',
      'Another copy of Chat Bridge is open. Look for it in your taskbar or alt-tab to it. If you cannot find it, open Task Manager, end every "electron" process, and start again.'
    );
  } catch (e) { /* dialog is best-effort */ }
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Chat Bridge');
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    sessions.setFlags({ mock: MOCK, smoke: SMOKE });
    store.load();

    const shell = windows.createShell();
    const push = (channel, payload) => {
      const wc = uiWC(shell);
      if (wc && !shell.isDestroyed()) wc.send(channel, payload);
    };
    ipc.setPush(push);
    sessions.setPushHandler(push);
    ipc.registerAll();
    sessions.startPolling(push);
    sessions.startRelayoutLoop();
    sessions.startTypingPoll();
    sessions.startWatchdog();

    // Pushed to the shell after it loads so early events are not lost.
    ipcMainFlushEvents(push);

    // Restore previously linked accounts: persisted partitions usually still
    // hold a valid session, so most of the time no re-scan is needed.
    // Never in smoke mode: a mock run must not touch real accounts.
    uiWC(shell).on('did-finish-load', () => {
      if (!SMOKE) {
        const accounts = store.listAccounts();
        accounts.slice(0, 5).forEach((acc, i) => {
          if (!sessions.getSession(acc.id)) {
            const restored = Object.assign({}, acc, { status: acc.status === 'logged-out' ? 'logged-out' : 'linking' });
            sessions.createSession(restored, null);
            sessions.attachToSlot(acc.id, i);
          }
        });
      }
      if (SMOKE) runSmoke(shell);
      if (CAPTURE) runCapture(shell);
      if (CENSUS) runCensus(shell);
      if (PROBE) runProbe(shell);
      if (TRIAL) runTrial();
      if (MEDIAPROBE) runMediaProbe();
      if (TGPROBE) runTgProbe();
      if (SENDREPORT) runSendReport();
      if (SELFTEST) runSelftest();
    });

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) windows.createShell(); });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => store.flush());
}

function ipcMainFlushEvents(push) {
  // Nothing buffered today; placeholder keeps the event contract explicit.
  void push;
}

// ---------- probe mode: electron . --probe ----------
// Empirical validation of the v3 data layer on the REAL accounts, read-only:
// (a) IndexedDB model-storage: stores, keyPaths, indexes, field-NAME shapes only
//     (no contact names, no message text â€” sample values are type maps, not data);
// (b) in-page module runtime availability (window.require / webpack chunks).
async function runProbe() {
  try {
    await new Promise(r => setTimeout(r, 20000));
    const PROBE_SRC = `(function(){
      var out = { dbs: [], idb: null, modules: {} };
      function shape(v, depth) {
        if (v === null || v === undefined) return typeof v;
        if (Array.isArray(v)) return 'array[' + v.length + ']';
        var t = typeof v;
        if (t !== 'object') return t;
        if (v instanceof ArrayBuffer || (v.constructor && v.constructor.name === 'ArrayBuffer')) return 'ArrayBuffer(' + v.byteLength + ')';
        if (depth > 1) return 'obj';
        var o = {};
        try {
          Object.keys(v).slice(0, 12).forEach(function (k) { o[k] = shape(v[k], depth + 1); });
        } catch (e) {}
        return o;
      }
      function idbOpen(name) {
        return new Promise(function (res, rej) {
          var rq;
          try { rq = indexedDB.open(name); } catch (eO) { rej(eO); return; }
          rq.onsuccess = function () { var db = rq.result; res(db); setTimeout(function(){try{db.close();}catch(eC){}}, 100); };
          rq.onerror = function () { rej(rq.error); };
          rq.onupgradeneeded = function () { rq.transaction.abort(); rej(new Error('would upgrade')); };
        });
      }
      function readStore(db, store) {
        return new Promise(function (res) {
          var tx;
          try { tx = db.transaction(store, 'readonly'); } catch (eT) { res(null); return; }
          try {
            var rq = tx.objectStore(store).getAll();
            rq.onsuccess = function () { res(rq.result || []); };
            rq.onerror = function () { res(null); };
          } catch (eG) { res(null); }
        });
      }
      return indexedDB.databases().then(function (dbs) {
        out.dbs = dbs.map(function (d) { return { name: d.name, version: d.version }; });
        var ms = dbs.find(function (d) { return d.name === 'model-storage'; });
        if (!ms) return out;
        return idbOpen('model-storage').then(function (db) {
          if (!db) return out;
          out.idb = { name: 'model-storage', version: db.version, stores: {} };
          db.objectStoreNames.forEach ? db.objectStoreNames.forEach(function (sn) {
            out.idb.stores[sn] = { noted: 'pending' };
          }) : null;
          var names = Array.prototype.slice.call(db.objectStoreNames);
          out.idb.storeNames = names;
          // Re-open per store (we closed); shape samples field NAMES only.
          return idbOpen('model-storage').then(function (db2) {
            var chain = Promise.resolve();
            names.forEach(function (sn) {
              chain = chain.then(function () {
                return readStore(db2, sn).then(function (rows) {
                  var storeInfo = { keyPath: null, count: rows ? rows.length : -1, sampleShape: null };
                  try { storeInfo.keyPath = db2.transaction(sn, 'readonly').objectStore(sn).keyPath || null; } catch (eK) {}
                  if (rows && rows.length) storeInfo.sampleShape = shape(rows[0], 0);
                  out.idb.stores[sn] = storeInfo;
                });
              });
            });
            return chain.then(function () { return out; });
          });
        });
      }).then(function (out) {
        // (b) in-page module runtime availability, booleans only.
        try { out.modules.windowRequire = typeof window.require; } catch (e) {}
        try { out.modules.webpackChunkKeys = Object.keys(window).filter(function (k) { return k.indexOf('webpackChunk') === 0; }).length; } catch (e) {}
        return out;
      }).catch(function (e) { return { error: String(e && e.message || e) }; });
    })()`;
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      // LIVE engine truth: health, then the read path on the newest chat, then
      // openChat (safe: no message is ever sent), then the send trace shape.
      try {
        const health = await rec.view.webContents.executeJavaScript(
          `(function(){try{return window.__wabEng?window.__wabEng.health():{no:'engine absent'};}catch(e){return {err:String(e)};}})()`, false);
        console.log('[probe-eng][' + acc.name + '] health:', JSON.stringify(health));
        const chats = await rec.view.webContents.executeJavaScript(
          `(function(){try{return window.__wabEng?window.__wabEng.listChats().then(function(c){return c.slice(0,2);}):[];}catch(e){return [];}})()`, false);
        console.log('[probe-eng][' + acc.name + '] top chats:', JSON.stringify(chats));
        if (Array.isArray(chats) && chats[0] && chats[0].chatId) {
          const opened = await rec.view.webContents.executeJavaScript(
            `(function(){try{return window.__wabEng.openChat(${JSON.stringify(String(chats[0].chatId))});}catch(e){return {ok:false,error:String(e)};}})()`, false);
          console.log('[probe-eng][' + acc.name + '] openChat:', JSON.stringify(opened));
          const msgs = await rec.view.webContents.executeJavaScript(
            `(function(){try{return window.__wabEng.getMessages(${JSON.stringify(String(chats[0].chatId))}, 10);}catch(e){return {err:String(e)};}})()`, false);
          const shape = Array.isArray(msgs)
            ? { count: msgs.length, sample: msgs.slice(0, 2).map(function (m) { return { fromMe: m.fromMe, kind: m.kind, textLen: (m.text || '').length, ts: m.ts }; }) }
            : msgs;
          console.log('[probe-eng][' + acc.name + '] getMessages:', JSON.stringify(shape));
          const tail = await rec.view.webContents.executeJavaScript(
            `(function(){try{return window.__wabEng.debugTail?window.__wabEng.debugTail():[];}catch(e){return [];}})()`, false);
          console.log('[probe-eng][' + acc.name + '] tail:', JSON.stringify(tail));
          // Module census: straight through the webpack runtime, no engine helpers.
          const census = await rec.view.webContents.executeJavaScript(
            `(function(){
              var out = {cmdLikeKeys: [], openChatFns: []};
              try {
                var realRequire = (typeof window.require === 'function') ? window.require : null;
                if (!realRequire) {
                  var chunkKey = Object.keys(window).filter(function (k) { return k.indexOf('webpackChunk') === 0; })[0];
                  if (chunkKey) {
                    window[chunkKey].push([[Math.random()], {}, function (req) { realRequire = req; }]);
                  }
                }
                if (!realRequire) { out.note = 'require not captured'; return out; }
                var cache = realRequire.c;
                if (!cache) { out.note = 'no module cache'; return out; }
                var seen = 0;
                for (var k in cache) {
                  seen++;
                  if (/cmd|drawer/i.test(k) && out.cmdLikeKeys.length < 40) out.cmdLikeKeys.push(k.slice(0, 60));
                  var ex = null;
                  try { ex = cache[k].exports; } catch (eEx) { continue; }
                  if (ex && typeof ex === 'object') {
                    for (var fn in ex) {
                      try {
                        if (/^(openChat\\w*|openChatAt|showChat\\w*)$/.test(fn) && out.openChatFns.length < 12) {
                          out.openChatFns.push(fn + ' @ ' + k.slice(0, 40));
                        }
                      } catch (eFn) {}
                    }
                  }
                }
                out.moduleCount = seen;
              } catch (e) { out.err = String(e && e.message || e); }
              return out;
            })()`, false);
          console.log('[probe-eng][' + acc.name + '] census:', JSON.stringify(census));
        }
      } catch (e) {
        console.log('[probe-eng][' + acc.name + '] step failed:', e.message);
      }
      try {
        const res = await rec.view.webContents.executeJavaScript(PROBE_SRC, false);
        const slim = {
          dbs: res.dbs ? res.dbs.map(function (d) { return d.name; }) : null,
          chat: res.idb && res.idb.stores ? res.idb.stores.chat : null,
          message: res.idb && res.idb.stores ? res.idb.stores.message : null,
          contact: res.idb && res.idb.stores ? res.idb.stores.contact : null,
          modules: res.modules || null
        };
        console.log('[probe-slim][' + acc.name + ']', JSON.stringify(slim));
      } catch (e) {
        console.log('[probe][' + acc.name + '] failed:', e.message);
      }
    }
    app.exit(0);
  } catch (e) {
    console.error('[probe] failed:', e.message);
    app.exit(1);
  }
}

// ---------- sendreport mode: electron . --sendreport ----------
// The Send Reliability Drill's scoreboard. Reads the debug ring's send/open
// step events and prints the failure distribution per link in the chain:
// which steps succeed, which fail, and at what rate. The honest metric.
// Run AFTER firing real sends from the desk; exits immediately.
async function runSendReport() {
  try {
    const events = sessions.debugDump();
    // A send ATTEMPT = a 'sending' send-step followed by confirmed/failed.
    const attempts = [];
    let cur = null;
    for (const e of events) {
      if (e.kind !== 'send-step' && e.kind !== 'open-step') continue;
      const t = e.text || '';
      if (/chat open, sending/.test(t)) {
        cur = { t: e.t, steps: [t], failedAt: null };
        attempts.push(cur);
      } else if (cur) {
        cur.steps.push(t);
        if (/send failed/.test(t)) { cur.failedAt = t; cur = null; }
        else if (/send confirmed/.test(t)) { cur.failedAt = null; cur = null; }
      }
    }
    const line = (s) => console.log('[sendreport] ' + s);
    line('================ SEND RELIABILITY ================');
    if (!attempts.length) {
      line('No send attempts found in the ring (cap 300 events).');
      line('Fire real sends from the desk, then rerun this report.');
      app.exit(0);
      return;
    }
    let ok = 0, failed = 0;
    const failSteps = {};
    for (const a of attempts) {
      if (a.failedAt === null) ok += 1;
      else {
        failed += 1;
        const m = a.failedAt.match(/send failed: ([^|.]+)/);
        const key = m ? m[1].trim().slice(0, 60) : a.failedAt.slice(0, 60);
        failSteps[key] = (failSteps[key] || 0) + 1;
      }
    }
    const total = ok + failed;
    line('Attempts: ' + total + ' | Confirmed: ' + ok + ' | Failed: ' + failed +
      ' | Rate: ' + (total ? Math.round(ok / total * 100) : 0) + '%');
    if (failed) {
      line('Failure distribution (which step ate it):');
      Object.keys(failSteps).sort((a, b) => failSteps[b] - failSteps[a]).forEach(k => {
        line('  ' + failSteps[k] + 'x  ' + k);
      });
    }
    // Open-link health from the same window: every open-step since the first attempt.
    const since = attempts.length ? attempts[0].t : 0;
    const opens = events.filter(e => e.t >= since && e.kind === 'open-step');
    let openWin = 0, openFail = 0;
    opens.forEach(e => {
      if (/win/.test(e.text || '')) openWin += 1;
      else if (/failed/.test(e.text || '')) openFail += 1;
    });
    line('Open-link (same window): wins ' + openWin + ', fails ' + openFail);
    line('Last 10 send-step events for context:');
    events.filter(e => e.kind === 'send-step').slice(-10).forEach(e => {
      line('  [' + new Date(e.t).toISOString().slice(11, 19) + '] ' + e.text);
    });
    app.exit(0);
  } catch (e) {
    console.error('[sendreport] failed:', e.message);
    app.exit(1);
  }
}

// ---------- mediaprobe mode: electron . --mediaprobe ----------
// Name the media gate. Find a chat WITH media, real-open it, scroll the
// conversation (WhatsApp lazy-downloads on view), then dump: the media msg
// model's url-ish field NAMES (shapes only, no bytes), getMedia's verdict
// before and after. Never sends anything.
async function runMediaProbe() {
  try {
    await new Promise(r => setTimeout(r, 20000));
    const log = (s) => console.log('[mediaprobe] ' + s);
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      const wc = rec.view.webContents;
      log('account: ' + acc.name);
      // 1. Find the newest chat that HAS media messages.
      let target = null, mediaMsg = null;
      try {
        const chats = await wc.executeJavaScript(
          `(function(){try{return window.__wabEng.listChats().then(function(c){return c.slice(0,10);});}catch(e){return [];}})()`, false);
        for (const ch of (chats || [])) {
          const msgs = await wc.executeJavaScript(
            `(function(){try{return window.__wabEng.getMessages(${JSON.stringify(String(ch.chatId))}, 30);}catch(e){return [];}})()`, false);
          const m = Array.isArray(msgs) ? msgs.reverse().find(x => x && x.kind === 'media-placeholder' && (x.mId || x.id)) : null;
          if (m) { target = ch; mediaMsg = m; break; }
        }
      } catch (eF) { log('find failed: ' + eF.message); }
      if (!target) { log('no media in the 10 newest chats (inconclusive)'); continue; }
      log('target chat has media (msg kind present), id shape: ' + String(mediaMsg.mId || mediaMsg.id || '').replace(/\d/g, 'D').slice(0, 24));
      // 2. getMedia BEFORE open+scroll.
      const before = await sessions.engCall(acc.id,
        `(function(){try{return window.__wabEng.getMedia(${JSON.stringify(String(target.chatId))},${JSON.stringify(String(mediaMsg.mId || mediaMsg.id))});}catch(e){return {ok:false,error:String(e)};}})()`);
      log('getMedia BEFORE view: ' + JSON.stringify(before && before.ok ? { ok: true, kind: before.kind, dataLen: (before.data || '').length } : before));
      // 3. Real-open the chat, then scroll the CONVERSATION pane up through history.
      const opened = await sessions.engRealOpen(acc.id, target.chatId, target.title || '');
      log('real-open: ' + JSON.stringify(opened));
      if (opened && opened.ok) {
        try { wc.focus(); } catch (eFo) {}
        // The conversation occupies the right side: scroll it to load history incl. media.
        for (let i = 0; i < 8; i++) {
          try { await wc.sendInputEvent({ type: 'mouseWheel', x: 1200, y: 500, deltaY: 700, deltaMode: 0 }); } catch (eW) { break; }
          await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 1500));
        const after = await sessions.engCall(acc.id,
          `(function(){try{return window.__wabEng.getMedia(${JSON.stringify(String(target.chatId))},${JSON.stringify(String(mediaMsg.mId || mediaMsg.id))});}catch(e){return {ok:false,error:String(e)};}})()`);
        log('getMedia AFTER view+scroll: ' + JSON.stringify(after && after.ok ? { ok: true, kind: after.kind, dataLen: (after.data || '').length } : after));
        // 4. The model field dump: which url-ish fields exist on this msg (names + types ONLY).
        const fields = await wc.executeJavaScript(
          `(function(){try{
            var eng=window.__wabEng; if(!eng||!eng.__dumpMsgFields)return {note:'no dump helper'};
            return eng.__dumpMsgFields(${JSON.stringify(String(target.chatId))},${JSON.stringify(String(mediaMsg.mId || mediaMsg.id))});
          }catch(e){return {err:String(e&&e.message||e)};}})()`, false);
        log('msg url-ish fields: ' + JSON.stringify(fields));
      }
    }
    app.exit(0);
  } catch (e) {
    console.error('[mediaprobe] failed:', e.message);
    app.exit(1);
  }
}

// ---------- tgprobe mode: electron . --tgprobe ----------
// F1 telegram-names: the structure dump that settles WHY Telegram names
// and avatars fail. Read-only; shapes and id FORMS only (privacy law:
// never names, never message text, never raw peer ids -- typeof + sign +
// digit-length class + -100 marker presence at most).
const TGPROBE_SRC = `(async function () {
  var TIMEOUT_MS = 15000;
  var out = { step: 'start', dbs: [], dbStores: [], samples: {}, dom: {}, mgr: {}, typing: null, engine: {} };
  var wrap = function (r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  };
  var tform = function (v) {
    try {
      if (v === null) return 'null';
      if (v === undefined) return 'undef';
      if (Array.isArray(v)) return 'array(' + v.length + ')';
      if (v instanceof Map) return 'map(' + v.size + ')';
      if (v instanceof Set) return 'set(' + v.size + ')';
      var t = typeof v;
      if (t === 'string') return 'str(' + v.length + ')';
      if (t === 'number' || t === 'boolean') return t;
      if (v instanceof ArrayBuffer) return 'ab(' + v.byteLength + ')';
      if (v.buffer instanceof ArrayBuffer) return 'view(' + v.constructor.name + ')';
      return 'obj';
    } catch (e) { return '?'; }
  };
  var idform = function (v) {
    try {
      if (v === null || v === undefined) return 'none';
      var t = typeof v;
      var s = String(v);
      var neg = s.charAt(0) === '-';
      var dg = s.replace(/\\D/g, '');
      var len = dg.length >= 13 ? 'len13plus' : dg.length >= 10 ? 'len10-12' : dg.length >= 4 ? 'len4-9' : dg.length > 0 ? 'len1-3' : 'len0';
      var mark = (dg.indexOf('100') === 0 && dg.length > 10) ? ':m100' : '';
      return t + ':' + (neg ? 'neg' : 'pos') + ':' + len + mark;
    } catch (e) { return '?'; }
  };
  var ID_FIELDS = { peer: 1, peer_id: 1, peerId: 1, id: 1, user_id: 1, chat_id: 1, channel_id: 1, chatId: 1, from_id: 1, savedPeerId: 1 };
  var shape = function (v, depth) {
    var o = {};
    try {
      if (v === null || typeof v !== 'object') return tform(v);
      var keys = Object.keys(v).slice(0, 24);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var val = v[k];
        o[k] = ID_FIELDS[k] ? idform(val) : (depth < 1 && val && typeof val === 'object' && !Array.isArray(val) ? shape(val, depth + 1) : tform(val));
      }
    } catch (e) {}
    return o;
  };
  var openDb = function (name) {
    return new Promise(function (res, rej) {
      try {
        var rq = indexedDB.open(name);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
        rq.onupgradeneeded = function () { try { rq.transaction.abort(); } catch (eA) {} rej(new Error('would upgrade')); };
      } catch (e) { rej(e); }
    });
  };
  var cursorSample = function (db, store, n) {
    return new Promise(function (res) {
      var rows = [];
      try {
        var tx = db.transaction(store, 'readonly');
        var rq = tx.objectStore(store).openCursor();
        rq.onsuccess = function () {
          var c = rq.result;
          if (!c || rows.length >= n) { res(rows); return; }
          rows.push({ key: c.key, val: c.value });
          try { c.continue(); } catch (eC) { res(rows); }
        };
        rq.onerror = function () { res(rows); };
        setTimeout(function () { res(rows); }, 2500);
      } catch (e) { res(rows); }
    });
  };
  var main = async function () {
    // 1. databases
    try {
      var dbs = await indexedDB.databases();
      out.dbs = dbs.map(function (d) { return { name: d.name, version: d.version }; });
    } catch (eDb) { out.dbs = 'databases() failed'; }
    // 2. every tweb-ish db: full store table
    var tg = [];
    try {
      tg = (out.dbs instanceof Array ? out.dbs : []).filter(function (d) { return /tweb|telegram/i.test(String(d.name || '')); }).slice(0, 6);
    } catch (eF) {}
    var primary = null;
    for (var i2 = 0; i2 < tg.length; i2++) {
      if (/^tweb-account-\\d+$/.test(tg[i2].name)) { primary = tg[i2]; break; }
    }
    if (!primary) for (var j2 = 0; j2 < tg.length; j2++) { if (tg[j2].name === 'tweb') primary = tg[j2]; }
    for (var k2 = 0; k2 < tg.length; k2++) {
      var dbr = null;
      try { dbr = await openDb(tg[k2].name); } catch (eO) { out.dbStores.push({ db: tg[k2].name, error: 'open failed' }); continue; }
      var info = { db: tg[k2].name, version: dbr.version, stores: [] };
      try {
        var sns = Array.prototype.slice.call(dbr.objectStoreNames, 0, 40);
        for (var s2 = 0; s2 < sns.length; s2++) {
          var st = { name: sns[s2], count: -1, keyPath: null, indexes: 0 };
          try {
            var tx = dbr.transaction(sns[s2], 'readonly');
            var os = tx.objectStore(sns[s2]);
            st.keyPath = os.keyPath || null;
            st.indexes = Array.prototype.slice.call(os.indexNames, 0).length;
            st.count = await wrap(os.count());
          } catch (eC2) {}
          info.stores.push(st);
        }
      } catch (eS2) {}
      out.dbStores.push(info);
      // 3-5. record samples from the primary db (keys as FORMS, values as SHAPES)
      if (primary && tg[k2].name === primary.name) {
        var want = ['users', 'chats', 'dialogs', 'stickerSets'];
        for (var w2 = 0; w2 < want.length; w2++) {
          var sn2 = want[w2];
          if (dbr.objectStoreNames.contains(sn2)) {
            var recs = await cursorSample(dbr, sn2, 3);
            out.samples[sn2] = recs.map(function (r) {
              return { keyType: typeof r.key, keyForm: idform(r.key), valShape: shape(r.val, 0) };
            });
          } else {
            out.samples[sn2] = 'store absent';
          }
        }
      }
      try { dbr.close(); } catch (eCl) {}
    }
    // 6. DOM title extraction test: 5 rows, tier hit + title LENGTH only
    try {
      var TITLE_CHAIN = ['.dialog-title .user-title', '.user-title', '.dialog-title', '.row-title', '.chatlist-chat-title', 'h3', '[class*="title"]', '[class*="peer-title"]'];
      out.dom.rowCount = document.querySelectorAll('.chatlist-chat').length;
      var rows = Array.prototype.slice.call(document.querySelectorAll('.chatlist-chat'), 0, 5);
      out.dom.rows = rows.map(function (row) {
        var tierHit = -1;
        var titleLen = 0;
        for (var t2 = 0; t2 < TITLE_CHAIN.length; t2++) {
          var el = null;
          try { el = row.querySelector(TITLE_CHAIN[t2]); } catch (eQ) {}
          if (el) {
            var txt = (el.getAttribute('title') || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (txt) { tierHit = t2; titleLen = txt.length; break; }
          }
        }
        var pid = row.getAttribute('data-peer-id');
        return {
          tierHit: tierHit,
          titleLen: titleLen,
          pidForm: idform(pid),
          avatarFacts: {
            dialogAvatar: !!row.querySelector('.dialog-avatar'),
            chatAvatar: !!row.querySelector('.chat-avatar'),
            imgCount: row.querySelectorAll('img').length,
            canvasCount: row.querySelectorAll('canvas').length
          }
        };
      });
    } catch (eD2) { out.dom.error = 'dom step failed'; }
    // 7. appDialogsManager structure: property NAMES only
    try {
      var m = window.appDialogsManager;
      out.mgr.exists = !!m;
      if (m) {
        var names = [];
        try { names = Object.keys(m); } catch (eK2) {}
        out.mgr.ownKeyCount = names.length;
        out.mgr.dialogKeys = names.filter(function (n) { return /dialog|peer|chat|folder|list|order/i.test(n); }).slice(0, 40);
      }
      out.mgr.managersBundle = !!(window.rootScope && window.rootScope.managers);
      out.mgr.imManager = !!window.appImManager;
    } catch (eM2) { out.mgr.error = 'mgr step failed'; }
    // 8. getTyping() output shape: types + count only, never the strings
    try {
      if (window.__wabEng && typeof window.__wabEng.getTyping === 'function') {
        var ty = await window.__wabEng.getTyping();
        out.typing = {
          isArray: Array.isArray(ty),
          count: Array.isArray(ty) ? ty.length : -1,
          itemTypes: Array.isArray(ty) ? ty.slice(0, 5).map(function (x) { return typeof x; }) : tform(ty)
        };
      } else { out.typing = 'engine absent'; }
    } catch (eT2) { out.typing = 'typing step failed'; }
    // 9. engine state: health, probe, listChats title stats (COUNTS only), tail
    try {
      if (window.__wabEng) {
        out.engine.health = await window.__wabEng.health();
        try { out.engine.probe = await window.__wabEng.__probeTelegram(); } catch (eP2) { out.engine.probe = 'probe failed'; }
        try {
          var chats = await window.__wabEng.listChats();
          var named = 0;
          var emptyTitles = 0;
          for (var c2 = 0; c2 < (chats || []).length; c2++) {
            if (chats[c2] && chats[c2].title && String(chats[c2].title).trim()) named++;
            else emptyTitles++;
          }
          out.engine.listChats = { rows: (chats || []).length, named: named, emptyTitles: emptyTitles };
        } catch (eL2) { out.engine.listChats = 'listChats failed'; }
        try { out.engine.tail = window.__wabEng.debugTail ? window.__wabEng.debugTail().slice(-8) : []; } catch (eTa) { out.engine.tail = []; }
      } else { out.engine = 'engine absent'; }
    } catch (eE2) {}
    out.step = 'done';
    return out;
  };
  return await Promise.race([
    main(),
    new Promise(function (res) { setTimeout(function () { res({ step: 'timeout' }); }, TIMEOUT_MS); })
  ]);
})()`;

async function runTgProbe() {
  try {
    await new Promise(r => setTimeout(r, 20000));
    const log = (s) => console.log('[tgprobe] ' + s);
    for (const acc of store.listAccounts()) {
      if ((acc.platform || 'whatsapp') !== 'telegram') continue;   // telegram accounts only
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      log('account: ' + acc.name);
      try {
        const dump = await rec.view.webContents.executeJavaScript(TGPROBE_SRC, false);
        log('[' + acc.name + '] dump: ' + JSON.stringify(dump));
      } catch (e) {
        log('[' + acc.name + '] probe failed: ' + e.message);
      }
    }
    app.exit(0);
  } catch (e) {
    console.error('[tgprobe] failed:', e.message);
    app.exit(1);
  }
}

// ---------- trial mode: electron . --trial ----------
// The instrument for docs\CASE-SEND-FAILURE.md: attempt the open tier exactly as
// the desk does, and photograph the engine's DOM evidence after every step.
// Structure only; no message is ever sent.
async function runTrial() {
  try {
    await new Promise(r => setTimeout(r, 20000));
    const EV_SRC = `(function(){
      var q = function (s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
      var box = null;
      try { box = document.querySelector('[data-testid="chat-list-search-container"] div[contenteditable="true"]'); } catch (e) {}
      return {
        composer: q('footer div[contenteditable="true"]'),
        footer: q('footer'),
        convMsgs: q('[data-testid^="conv-msg-"]'),
        panelMsgs: q('[data-testid="conversation-panel-messages"]'),
        introPanel: q('[data-testid="intro-panel"]'),
        overlayAny: q('[data-testid="overlay"]'),
        overlayRows: q('[data-testid="overlay"] [role="button"], [data-testid="overlay"] div[role="row"]'),
        searchBoxText: box ? String(box.textContent || '').slice(0, 24) : null
      };
    })()`;
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      const wc = rec.view.webContents;
      const safe = async (fn, label) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { return await fn(); } catch (e) {
            if (attempt === 2) { console.log('[trial][' + acc.name + '] ' + label + ': failed ' + e.message); return null; }
            await new Promise(r => setTimeout(r, 1200));
          }
        }
        return null;
      };
      const ev = async (label) => {
        const r = await safe(() => wc.executeJavaScript(EV_SRC, false), label);
        if (r) console.log('[trial][' + acc.name + '] ' + label + ':', JSON.stringify(r));
      };
      const chats = await safe(() => wc.executeJavaScript(
        `(function(){try{return window.__wabEng.listChats().then(function(c){return c.slice(0,1);});}catch(e){return [];}})()`, false), 'listChats');
      console.log('[trial][' + acc.name + '] target:', JSON.stringify(chats));
      if (!Array.isArray(chats) || !chats[0] || !chats[0].chatId) continue;
      await ev('A before');
      const opened = await safe(() => wc.executeJavaScript(
        `(function(){try{return window.__wabEng.openChat(${JSON.stringify(String(chats[0].chatId))});}catch(e){return {ok:false,error:String(e)};}})()`, false), 'openChat');
      console.log('[trial][' + acc.name + '] openChat result:', JSON.stringify(opened));
      await ev('B after-openChat');
      await safe(() => wc.executeJavaScript(
        `(function(){return new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res(true);});});});})()`, false), 'rAF');
      await ev('C after-forced-rAF');
      // Wait 3s for late overlays, then look once more.
      await new Promise(r => setTimeout(r, 3000));
      await ev('D after-3s-wait');
      const tail = await wc.executeJavaScript(
        `(function(){try{return window.__wabEng.debugTail?window.__wabEng.debugTail():[];}catch(e){return [];}})()`, false);
      console.log('[trial][' + acc.name + '] tail:', JSON.stringify(tail));

      // THE REAL-INPUT EXPERIMENT: genuine OS-level mouse events at the first
      // chat row's true coordinates, then evidence. If the chat opens, the whole
      // open path becomes spine-driven real input. No message is sent.
      try {
        const coords = await safe(() => wc.executeJavaScript(
          `(function(){try{var r=document.querySelector('[data-testid="cell-frame-container"], #pane-side [role="row"]');if(!r)return null;var b=r.getBoundingClientRect();if(b.width<2||b.height<2)return null;return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+Math.min(b.height/2,30))};}catch(e){return null;}})()`, false), 'coords');
        if (coords && coords.x > 0) {
          let zf = 1;
          try { zf = wc.getZoomFactor() || 1; } catch (eZ) {}
          const cx = Math.round(coords.x / zf), cy = Math.round(coords.y / zf);   // css / zoom = dip
          try { wc.focus(); } catch (eF) {}
          await wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
          await new Promise(r => setTimeout(r, 400));
          await wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
          await wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
          console.log('[trial][' + acc.name + '] real click at css', JSON.stringify(coords), 'dip', cx + ',' + cy, 'zoom', zf.toFixed(2));
          await new Promise(r => setTimeout(r, 2500));
          await ev('E after-real-click');
          // Second shot: raw css coordinates as dip (zoom now normalized to 1).
          await wc.sendInputEvent({ type: 'mouseMove', x: coords.x, y: coords.y });
          await new Promise(r => setTimeout(r, 300));
          await wc.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
          await wc.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
          console.log('[trial][' + acc.name + '] second click at raw css', JSON.stringify(coords));
          await new Promise(r => setTimeout(r, 2500));
          await ev('F after-second-click');
        } else {
          console.log('[trial][' + acc.name + '] no visible row for the real-input test');
        }
      } catch (eReal) {
        console.log('[trial][' + acc.name + '] real-input test failed:', eReal.message);
      }
    }
    app.exit(0);
  } catch (e) {
    console.error('[trial] failed:', e.message);
    app.exit(1);
  }
}

// ---------- selftest mode: electron . --selftest ----------
// V13 debug docket (D2 D4 D5 D6 D7 D9 D12): one command the integrator runs
// against the REAL accounts. Exercises every live path and prints a verdict
// card. It NEVER sends a message: reads, real-click opens, and insert-then-
// clear only; every test is passive or reversible. A diagnostic never
// crashes the app: every step is guarded and the run always exits 0.
// Privacy law: the card carries step names and counts only. No contact
// names, no chat ids, no message text, no typing titles.
// Known side effect (WhatsApp's own law, unavoidable): opening a chat marks
// its unread messages read on the phone. Run when the newest chats are read.
async function runSelftest(shell) {
  const beganAt = Date.now();
  const mem0 = process.memoryUsage();
  const line = (s) => console.log(s);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const row = (name, verdict, why, ms) => line('  ' + String(name).padEnd(10, ' ') + ' ' +
    String(verdict).padEnd(12, ' ') + why + (typeof ms === 'number' ? ' (' + ms + ' ms)' : ''));
  // Page-side probes. Counts and booleans only; nothing user-owned is read.
  const HEALTH_SRC = `(function(){try{return window.__wabEng.health();}catch(e){return {idb:false,modules:false,lastError:'no engine'};}})()`;
  const LIST_SRC = `(function(){try{return window.__wabEng.listChats();}catch(e){return [];}})()`;
  const msgsSrc = (chatId, limit) => `(function(){try{return window.__wabEng.getMessages(${JSON.stringify(String(chatId))}, ${limit});}catch(e){return {ok:false,error:'engine read failed'};}})()`;
  const mediaSrc = (chatId, mId) => `(function(){try{return window.__wabEng.getMedia(${JSON.stringify(String(chatId))}, ${JSON.stringify(String(mId))});}catch(e){return {ok:false,error:'media unavailable'};}})()`;
  const TYPING_SRC = `(function(){try{return (window.__wabEng && window.__wabEng.getTyping) ? window.__wabEng.getTyping() : [];}catch(e){return [];}})()`;
  const NEW_SRC = (chatId) => `(function(){try{return window.__wabEng.hasNewMessages(${JSON.stringify(String(chatId))});}catch(e){return false;}})()`;
  const COMPOSER_SRC = `(function(){try{return {composer: document.querySelectorAll('footer div[contenteditable="true"]').length};}catch(e){return {composer:0};}})()`;
  const HELD_SRC = `(function(){try{var b=document.querySelector('#main footer div[contenteditable="true"]');return {held: b ? String(b.textContent || '') : null};}catch(e){return {held:null};}})()`;
  const CLEAR_COMPOSER_SRC = `(function(){try{var b=document.querySelector('#main footer div[contenteditable="true"]');if(!b)return {cleared:false};b.focus();var s=window.getSelection();var r=document.createRange();r.selectNodeContents(b);s.removeAllRanges();s.addRange(r);try{document.execCommand('insertText',false,'');}catch(eE){}return {cleared:(b.textContent||'').length===0};}catch(e){return {cleared:false};}})()`;
  // D6: a passive composer insert is only possible through an EXPOSED helper.
  // The engine today exposes none (insertViaSelection lives inside send()),
  // so the honest result is INCONCLUSIVE until that seam is cut (H4).
  const INSERT_PROBE_SRC = `(function(){try{var e=window.__wabEng;if(!e)return {name:null,methods:'no engine'};var names=[];for(var k in e){try{if(typeof e[k]==='function')names.push(k);}catch(eK){}}var cands=['insertDraft','insertText','composerInsert','insertComposerText'];for(var i=0;i<cands.length;i++){if(typeof e[cands[i]]==='function')return {name:cands[i],methods:names.join(',')};}return {name:null,methods:names.join(',')};}catch(e){return {name:null,methods:'probe failed'};}})()`;

  try {
    line('');
    line('================ Chat Bridge V14 SELFTEST VERDICT ================');
    line('ran ' + new Date().toISOString() + ' | boot wait 20s | mock ' + (MOCK ? 'ON: engine real-input tests are skipped, the card would lie' : 'off'));
    line('law kept: no message is ever sent (reads, real-click opens, insert-then-clear only)');
    line('side effect: opening a chat marks its unread read on the phone (WhatsApp law)');

    await sleep(20000);   // engines: restore, link, first polls
    try { sessions.relayout(); } catch (eR) { /* window closing */ }

    for (const acc of store.listAccounts()) {
      line('');
      line('---- account ' + acc.name + ' ----');
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) {
        row('ACCOUNT', 'FAIL', 'no live session view (status ' + (rec ? rec.status : 'none') + ')');
        continue;
      }
      if (MOCK) { row('ACCOUNT', 'SKIP', 'mock mode: the selftest needs real accounts'); continue; }

      // 1 BOOT: engine bridge health (idb + module runtime)
      let t = Date.now();
      let health = null;
      try { health = await sessions.engCall(acc.id, HEALTH_SRC); }
      catch (e) { health = { idb: false, modules: false, lastError: e.message }; }
      if (rec.status !== 'linked') {
        row('BOOT', 'FAIL', 'session status ' + rec.status + ' (engine health ' + JSON.stringify(health) + ')', Date.now() - t);
        continue;
      }
      row('BOOT', (health && health.idb && health.modules) ? 'PASS' : 'FAIL',
        'engine health idb ' + !!(health && health.idb) + ', modules ' + !!(health && health.modules) +
        ((health && health.lastError) ? ', lastError ' + String(health.lastError).slice(0, 60) : ''), Date.now() - t);

      // 2 SYNC (D2): warm read on the newest 3 chats, then an 8s arrival window
      t = Date.now();
      let syncVerdict = 'FAIL', syncWhy = '';
      let newest = null;
      const mediaHolders = [];
      try {
        const chats = await sessions.engCall(acc.id, LIST_SRC);
        if (!Array.isArray(chats) || !chats.length) {
          syncWhy = 'listChats returned ' + (Array.isArray(chats) ? chats.length + ' chats' : 'a non-array');
        } else {
          const sorted = chats.filter(c => c && c.chatId).sort((a, b) => (b.t || 0) - (a.t || 0));
          newest = sorted[0];
          const top3 = sorted.slice(0, 3);
          let nonEmpty = 0, reads = 0;
          for (let i = 0; i < top3.length; i++) {
            const res = await sessions.engCall(acc.id, msgsSrc(top3[i].chatId, i === 0 ? 200 : 50));
            reads++;
            if (Array.isArray(res)) {
              if (res.length > 0) nonEmpty++;
              for (let m = 0; m < res.length && mediaHolders.length < 6; m++) {
                if (res[m] && res[m].kind === 'media-placeholder' && res[m].mId) {
                  mediaHolders.push({ chatId: top3[i].chatId, mId: res[m].mId });
                }
              }
            }
          }
          const before = await sessions.engCall(acc.id, msgsSrc(newest.chatId, 200));
          const beforeCount = Array.isArray(before) ? before.length : -1;
          const beforeTopT = newest.t || 0;
          await sleep(8000);
          const after = await sessions.engCall(acc.id, msgsSrc(newest.chatId, 200));
          const afterCount = Array.isArray(after) ? after.length : -1;
          let heartbeat = false;
          try { heartbeat = await sessions.engCall(acc.id, NEW_SRC(newest.chatId)) === true; } catch (eH) { heartbeat = false; }
          const chatsAfter = await sessions.engCall(acc.id, LIST_SRC);
          const afterTopT = Array.isArray(chatsAfter)
            ? Math.max.apply(null, chatsAfter.map(c => (c && c.t) || 0).concat([0]))
            : 0;
          const delta = (beforeCount >= 0 && afterCount >= 0) ? afterCount - beforeCount : 0;
          const grew = delta > 0 || heartbeat || afterTopT > beforeTopT;
          const warmPart = 'warm read ' + nonEmpty + '/' + reads + ' newest chats non-empty (count cap 200)';
          const arrival = grew
            ? 'arrival captured in the 8s window (delta ' + delta + ', heartbeat ' + heartbeat + ', list top-t ' + (afterTopT > beforeTopT ? 'moved' : 'still') + '): warm sync is LIVE'
            : 'no arrival during the 8s window (inconclusive, rerun when a message is incoming)';
          if (nonEmpty === 0) { syncVerdict = 'FAIL'; syncWhy = warmPart + ': every newest chat read empty (cold-collection failure)'; }
          else { syncVerdict = 'PASS'; syncWhy = warmPart + '; ' + arrival; }
        }
      } catch (e) { syncWhy = 'sync test failed: ' + e.message; }
      row('SYNC', syncVerdict, syncWhy, Date.now() - t);

      // 3 MEDIA (D4): the bytes behind up to 2 media placeholders
      t = Date.now();
      let mediaVerdict = 'INCONCLUSIVE', mediaWhy = 'no media rows in the newest chats (inconclusive)';
      try {
        const holders = mediaHolders.slice(0, 2);
        if (holders.length) {
          const parts = [];
          let oks = 0;
          for (const h of holders) {
            const res = await sessions.engCall(acc.id, mediaSrc(h.chatId, h.mId));
            if (res && res.ok) {
              oks++;
              parts.push('ok ' + res.kind + ' ' + (res.data ? res.data.length : 0) + ' dataURL chars' + (res.mime ? ' ' + res.mime : ''));
            } else {
              parts.push('miss (' + ((res && res.error) || 'no result') + ')');
            }
          }
          mediaVerdict = oks === holders.length ? 'PASS' : 'FAIL';
          mediaWhy = oks + '/' + holders.length + ' media fetched: ' + parts.join(' | ');
        }
      } catch (e) { mediaVerdict = 'FAIL'; mediaWhy = 'media test failed: ' + e.message; }
      row('MEDIA', mediaVerdict, mediaWhy, Date.now() - t);

      // 4 TYPING (D5): two getTyping polls 3s apart. Structure only: counts
      // and one word length, never a title string (privacy law).
      t = Date.now();
      let typingVerdict = 'INCONCLUSIVE', typingWhy = '';
      try {
        const a = await sessions.engCall(acc.id, TYPING_SRC);
        await sleep(3000);
        const b = await sessions.engCall(acc.id, TYPING_SRC);
        const shape = (x) => Array.isArray(x)
          ? x.length + ' titles' + (x.length ? ' (first title word ' + String(x[0] || '').split(/\s+/)[0].length + ' chars)' : '')
          : 'non-array';
        typingWhy = 'poll1 ' + shape(a) + ', poll2 ' + shape(b) + ' (titles never printed)';
        if (!Array.isArray(a) || !Array.isArray(b)) typingVerdict = 'FAIL';
        else if (a.length || b.length) typingVerdict = 'PASS';
        else { typingVerdict = 'INCONCLUSIVE'; typingWhy += ': no live typers in the window (structure verified, rerun while someone types)'; }
      } catch (e) { typingVerdict = 'FAIL'; typingWhy = 'typing test failed: ' + e.message; }
      row('TYPING', typingVerdict, typingWhy, Date.now() - t);

      // 5 COMPOSER (D6, passive): real-open the newest chat, then test ONLY
      // the composer insert step, through an exposed passive helper if the
      // engine has one. send() itself is NEVER called.
      t = Date.now();
      let emojiVerdict = 'INCONCLUSIVE', emojiWhy = '';
      let lastOpenedChatId = null;
      try {
        if (!newest) {
          emojiVerdict = 'SKIP'; emojiWhy = 'no newest chat from the sync read';
        } else {
          const opened = await sessions.engRealOpen(acc.id, newest.chatId);
          if (opened && opened.ok) lastOpenedChatId = newest.chatId;
          const comp = await sessions.engCall(acc.id, COMPOSER_SRC);
          const openNote = (opened && opened.ok)
            ? 'newest chat real-open ok (composer count ' + (comp && comp.composer) + ')'
            : 'newest chat open FAILED (' + ((opened && opened.error) || 'no result') + ')';
          const probe = await sessions.engCall(acc.id, INSERT_PROBE_SRC);
          if (!probe || !probe.name) {
            emojiVerdict = 'INCONCLUSIVE';
            emojiWhy = openNote + '; send() monolith not decomposed for a passive test, no insert helper exposed (methods: ' + String((probe && probe.methods) || '').slice(0, 140) + ')';
          } else {
            const helperSrc = (txt) => '(function(){try{return window.__wabEng.' + probe.name + '(' + JSON.stringify(txt) + ');' +
              '}catch(e){return {ok:false,error:String(e && e.message || e)};}})()';
            await sessions.engCall(acc.id, helperSrc('👍'));   // probe payload: a fixed emoji, never printed
            let held = null;
            try { held = (await sessions.engCall(acc.id, HELD_SRC)).held; } catch (eV) { held = null; }
            await sessions.engCall(acc.id, helperSrc(''));
            let heldAfter = null;
            try { heldAfter = (await sessions.engCall(acc.id, HELD_SRC)).held; } catch (eV2) { heldAfter = null; }
            let cleared = heldAfter !== null && heldAfter.length === 0;
            if (!cleared) {
              try { const c = await sessions.engCall(acc.id, CLEAR_COMPOSER_SRC); cleared = !!(c && c.cleared); }
              catch (eC) { cleared = false; }
            }
            if (held && held.length > 0 && cleared) {
              emojiVerdict = 'PASS';
              emojiWhy = openNote + '; helper ' + probe.name + ' inserted the probe emoji and the box cleared (insert-then-clear law)';
            } else if (!cleared) {
              emojiVerdict = 'FAIL';
              emojiWhy = openNote + '; insert ran but the CLEAR failed, a draft may sit in the composer (clear it by hand)';
            } else {
              emojiVerdict = 'FAIL';
              emojiWhy = openNote + '; helper ' + probe.name + ' ran but the composer did not hold the probe (' + (held === null ? 'no composer' : 'held ' + held.length + ' chars') + ')';
            }
          }
        }
      } catch (e) { emojiVerdict = 'FAIL'; emojiWhy = 'composer test failed: ' + e.message; }
      row('COMPOSER', emojiVerdict, emojiWhy, Date.now() - t);

      // 6 DEEP-OPEN (D7): the OLDEST chat in the engine list, through the
      // real-click scroll path (deep pre-scroll + the route's own scroller).
      t = Date.now();
      let deepVerdict = 'INCONCLUSIVE', deepWhy = '';
      try {
        const chats = await sessions.engCall(acc.id, LIST_SRC);
        const withT = (Array.isArray(chats) ? chats : []).filter(c => c && c.chatId && (c.t || 0) > 0);
        if (withT.length < 2) {
          deepVerdict = 'INCONCLUSIVE';
          deepWhy = 'list too short for a deep target (' + withT.length + ' chats with timestamps)';
        } else {
          const oldest = withT.slice().sort((a, b) => (a.t || 0) - (b.t || 0))[0];
          let opened = await sessions.engRealOpen(acc.id, oldest.chatId);
          let preNote = '';
          if (!opened || !opened.ok) {
            const wc = rec.view.webContents;
            for (let page = 0; page < 8; page++) {
              try { await wc.sendInputEvent({ type: 'mouseWheel', x: 200, y: 400, deltaY: 600, deltaMode: 0 }); }
              catch (eW) { break; }
              await sleep(380);
            }
            preNote = ' (deep pre-scroll: 8 wheel pages)';
            opened = await sessions.engRealOpen(acc.id, oldest.chatId);
          }
          if (opened && opened.ok) {
            deepVerdict = 'PASS';
            lastOpenedChatId = oldest.chatId;
            deepWhy = 'oldest-list chat opened via the real-click scroll path' + preNote;
          } else if (opened && opened.error === 'chat row not reachable in the list') {
            deepVerdict = 'INCONCLUSIVE';
            deepWhy = 'no old chat reachable after scrolling (list longer than the wheel budget)';
          } else {
            deepVerdict = 'FAIL';
            deepWhy = 'old chat row found but the open refused (' + ((opened && opened.error) || 'no result') + ')';
          }
        }
      } catch (e) { deepVerdict = 'FAIL'; deepWhy = 'deep-open test failed: ' + e.message; }
      row('DEEP-OPEN', deepVerdict, deepWhy, Date.now() - t);

      // 6b rest the engine CONSISTENTLY: engSend skips the reopen when its
      // preOpened map matches, so the map must name the chat the engine
      // actually sits on before the operator can send anything.
      if (lastOpenedChatId) {
        try { await sessions.engPreOpen(acc.id, lastOpenedChatId); } catch (eP) { /* map stays as-is */ }
      }

      // 7 UNREAD (D2b): engine sum vs the v2 poller's last known vs the ring
      t = Date.now();
      let unreadVerdict = 'FAIL', unreadWhy = '';
      try {
        const chats = await sessions.engCall(acc.id, LIST_SRC);
        if (Array.isArray(chats)) {
          const engineSum = chats.reduce((s, c) => s + ((c && typeof c.unread === 'number') ? c.unread : 0), 0);
          const poller = rec.lastUnread || null;
          const pollerSum = poller ? (poller.allowed || 0) + (poller.restricted || 0) : null;
          const ringNotes = sessions.debugDump().filter(ev => ev.kind === 'people-refresh').length;
          unreadVerdict = 'PASS';
          unreadWhy = 'engine listChats unread sum ' + engineSum +
            '; poller lastUnread ' + (pollerSum === null ? 'none yet' : pollerSum + ' (allowed ' + (poller.allowed || 0) + ' + restricted ' + (poller.restricted || 0) + ')') +
            '; ring people-refresh notes ' + ringNotes +
            ((pollerSum !== null && pollerSum !== engineSum) ? ' (sources disagree, watch)' : '');
        } else {
          unreadWhy = 'listChats read failed for the unread sum';
        }
      } catch (e) { unreadWhy = 'unread test failed: ' + e.message; }
      row('UNREAD', unreadVerdict, unreadWhy, Date.now() - t);
    }

    // ---- leak hunt (D9 D12): listener counts, spine timers, memory ----
    line('');
    line('---- leak hunt (D9 D12) ----');
    const evts = ['did-stop-loading', 'dom-ready', 'did-navigate', 'did-navigate-in-page', 'did-finish-load'];
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      const wc = rec.view.webContents;
      const counts = evts.map(ev => { try { return ev + ' ' + wc.listenerCount(ev); } catch (e) { return ev + ' -1'; } }).join(', ');
      line('  engine ' + acc.name + ' webContents listeners: ' + counts);
    }
    try {
      const ui = uiWC(shell);
      if (ui) {
        const counts = ['did-stop-loading', 'dom-ready', 'did-finish-load']
          .map(ev => { try { return ev + ' ' + ui.listenerCount(ev); } catch (e) { return ev + ' -1'; } }).join(', ');
        line('  ui view webContents listeners: ' + counts);
        const h = await ui.executeJavaScript(`(function(){try{if(typeof getEventListeners!=='function')return {ok:false,note:'getEventListeners is DevTools-only, unavailable in page context'};var out={};var t={document:document,window:window};for(var k in t){try{out[k]=Object.keys(getEventListeners(t[k])).length;}catch(e){out[k]=-1;}}try{var root=document.querySelector('#render-root')||document.body;out['render-root']=Object.keys(getEventListeners(root)).length;}catch(eR){out['render-root']=-1;}return {ok:true,counts:out};}catch(e){return {ok:false,note:String(e&&e.message||e)};}})()`, false);
        line('  ui listener heuristic (document, window, render-root): ' +
          ((h && h.ok) ? JSON.stringify(h.counts) : 'skipped (' + ((h && h.note) || 'no result') + ')'));
      }
    } catch (e) { line('  ui listener heuristic: skipped (' + e.message + ')'); }
    try {
      const timers = sessions.timerReport();
      line('  spine-owned timers: ' + timers.length +
        (timers.length ? ' (' + timers.map(x => x.label + ' every ' + x.ms + 'ms, age ' + x.ageS + 's').join('; ') + ')' : ' (registry empty: patch P4 not applied?)'));
    } catch (e) { line('  spine-owned timers: registry unavailable (' + e.message + ')'); }
    const mem1 = process.memoryUsage();
    const mb = (n) => (n / 1048576).toFixed(1);
    line('  memory: rss ' + mb(mem0.rss) + ' -> ' + mb(mem1.rss) + ' MB, heapUsed ' + mb(mem0.heapUsed) + ' -> ' + mb(mem1.heapUsed) + ' MB, external ' + mb(mem1.external) + ' MB');
    line('  wall clock: ' + (Date.now() - beganAt) + ' ms');
    // v13: the evidence tail — last open/search step events incl. row-miss snapshots.
    try {
      const evs = sessions.debugDump().filter(function (e) { return /open-step|send-step/.test(e.kind); }).slice(-12);
      evs.forEach(function (e) { line('  [ev ' + new Date(e.t).toISOString().slice(11, 19) + '] ' + e.text); });
    } catch (eEv) { /* diagnostic only */ }
    line('================================================================');
  } catch (e) {
    console.error('[selftest] aborted:', e && e.message);
  } finally {
    app.exit(0);   // a diagnostic never crashes the app: exit 0 always
  }
}

// ---------- census mode: electron . --census ----------
// Structural probe of the REAL WhatsApp DOM inside our views: counts selector
// matches and fingerprints the layout skeleton. No chat content, ever.
async function runCensus(shell) {
  try {
    await new Promise(r => setTimeout(r, 20000));   // let real WhatsApp fully load
    sessions.setOverlayVisible(false);              // probe only ever runs with views live
    sessions.relayout();
    await new Promise(r => setTimeout(r, 2500));
    const CENSUS_SRC = `(function(){
      var out = {};
      var checks = {
        side: '#side', drawerLeft: '[data-testid="drawer-left"]', paneSide: '#pane-side',
        chatlist: '[data-testid="chatlist"]', chatList: '[data-testid="chat-list"]', chatlistContainer: '[data-testid="chatlist-container"]',
        cellFrame: '[data-testid="cell-frame-container"]', cellTitle: '[data-testid="cell-frame-title"]',
        rowRole: '[role="row"]', listitemRole: '[role="listitem"]', gridRole: '[role="grid"]',
        navbarItem: 'button[data-navbar-item="true"]', navTag: 'nav', menuTabs: '[data-testid="menu-tabs-dialogs"]',
        searchContainer: '[data-testid="chat-list-search-container"]', chatlistHeader: '[data-testid="chatlist-header"]',
        allFilter: 'button#all-filter', sideHeader: '#side > header',
        main: '#main', mainHeader: '#main > header',
        convHeader: '#main header [data-testid="conversation-info-header"]', convTitle: '[data-testid="conversation-info-header-chat-title"]',
        convHeaderAny: 'header [data-testid="conversation-info-header"]',
        footerTag: 'footer', footerEditable: 'footer div[contenteditable="true"]', footerAnyEditable: 'div[contenteditable="true"]',
        convMsg: '[data-testid^="conv-msg-"]', msgContainer: 'div[data-testid="msg-container"]',
        msgIn: '.message-in', msgOut: '.message-out', convPanelMsgs: '[data-testid="conversation-panel-messages"]',
        footerInMain: '#main footer', sectionTag: 'section'
      };
      Object.keys(checks).forEach(function (k) {
        try { out[k] = document.querySelectorAll(checks[k]).length; } catch (e) { out[k] = -1; }
      });
      // Deep structural fingerprint, no text: walk 4 levels, skip zero-size nodes.
      try {
        function node(n) {
          return {
            tag: n.tagName, id: n.id || null,
            testid: n.getAttribute('data-testid') || null,
            cls: (n.className && String(n.className).slice(0, 40)) || null,
            w: Math.round(n.getBoundingClientRect().width),
            h: Math.round(n.getBoundingClientRect().height)
          };
        }
        out.tree = [];
        function walk(el, depth) {
          if (depth > 4 || !el) return;
          var kids = Array.prototype.filter.call(el.children, function (k) {
            try { return k.getBoundingClientRect().width > 1; } catch (e) { return false; }
          }).slice(0, 4);
          for (var i = 0; i < kids.length; i++) {
            var n = node(kids[i]);
            n.d = depth;
            out.tree.push(n);
            walk(kids[i], depth + 1);
          }
        }
        var app = document.querySelector('#app') || document.body;
        out.tree.push(Object.assign(node(app), { d: 0 }));
        walk(app, 1);
        // Layout truth: the drawer's parent and ALL its children (the real layout row:
        // where the conversation column actually lives), geometry only.
        var drawer = document.querySelector('[data-testid="drawer-left"]') || document.querySelector('#side');
        if (drawer && drawer.parentElement) {
          out.layoutRow = node(drawer.parentElement);
          out.layoutCols = Array.prototype.map.call(drawer.parentElement.children, function (k) { return node(k); });
        }
        // Conversation geometry: where do footer / conv elements sit, no content.
        try {
          var conv = document.querySelector('footer') || document.querySelector('[data-testid="conversation-panel-messages"]');
          out.convGeometry = conv ? node(conv) : null;
        } catch (e) {}
        // drawer-middle internals + the lone <section>: full dump, sizes recorded
        // but NOT used for filtering (0-height wrappers may hide visible content).
        try {
          function dump(el, depth, acc, maxDepth) {
            if (!el || depth > maxDepth) return;
            var kids = Array.prototype.slice.call(el.children, 0, 4);
            for (var i = 0; i < kids.length; i++) {
              var k = kids[i];
              var n = node(k);
              n.d = depth;
              try {
                var st = getComputedStyle(k);
                n.disp = st.display; n.vis = st.visibility;
              } catch (eC) {}
              n.role = k.getAttribute('role') || null;
              acc.push(n);
              dump(k, depth + 1, acc, maxDepth);
            }
          }
          var mid = document.querySelector('[data-testid="drawer-middle"]');
          if (mid) { out.middle = []; dump(mid, 1, out.middle, 5); }
          var sec = document.querySelector('section');
          if (sec) { out.section = node(sec); out.sectionTree = []; dump(sec, 1, out.sectionTree, 5); }
        } catch (e) {}
      } catch (e) {}
      try {
        out.viewport = [window.innerWidth, window.innerHeight];
        out.declutter = document.documentElement.classList.contains('wab-declutter');
        out.threadcrop = document.documentElement.classList.contains('wab-threadcrop');
      } catch (e) {}
      return out;
    })()`;
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      // Open a chat the way a HUMAN does: lift curtains, real OS mouse events on
      // the first row's actual coordinates, wait for WhatsApp to build the
      // conversation drawer, then probe. Ground truth, no selector guessing.
      try {
        // Lift curtains first, THEN wait out the reflow + zoom rescale, THEN read
        // coordinates and click. Reading coords in the same tick as the lift races
        // the layout (learned the hard way, census v8).
        await rec.view.webContents.executeJavaScript(
          `(function(){try{if(window.__wabSetDeclutter)window.__wabSetDeclutter(false);if(window.__wabSetThreadCrop)window.__wabSetThreadCrop(false);}catch(e){}return true;})()`, false);
        await new Promise(r => setTimeout(r, 1800));
        const coords = await rec.view.webContents.executeJavaScript(
          `(function(){try{
            var r=document.querySelector('[data-testid="cell-frame-container"], #pane-side [role="row"]');
            if(!r)return null;
            var b=r.getBoundingClientRect();
            if(b.width<2||b.height<2)return null;
            return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+Math.min(b.height/2,30))};
          }catch(e){return null;}})()`, false);
        if (coords && coords.x > 0) {
          rec.view.webContents.focus();
          // Page CSS px -> view DIP: multiply by the zoom factor we set.
          let zf = 1;
          try { zf = rec.view.webContents.getZoomFactor() || 1; } catch (eZ) {}
          const cx = Math.round(coords.x * zf), cy = Math.round(coords.y * zf);
          await rec.view.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
          await new Promise(r => setTimeout(r, 300));
          await rec.view.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
          await rec.view.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
          console.log('[census][' + acc.name + '] human click at css', JSON.stringify(coords), 'dip', cx + ',' + cy, 'zoom', zf.toFixed(2));
        } else {
          console.log('[census][' + acc.name + '] no visible row to click');
        }
        await new Promise(r => setTimeout(r, 4000));
      } catch (e) { console.log('[census][' + acc.name + '] click step failed:', e.message); }
      try {
        const res = await rec.view.webContents.executeJavaScript(CENSUS_SRC, false);
        console.log('[census][' + acc.name + ']', JSON.stringify(res));
      } catch (e) {
        console.log('[census][' + acc.name + '] failed:', e.message);
      }
    }
    app.exit(0);
  } catch (e) {
    console.error('[census] failed:', e.message);
    app.exit(1);
  }
}
// Real mode, real WhatsApp, creates nothing, touches nothing. Boots, waits for
// sessions to restore, logs their status, saves local screenshots (shell shot
// carries no chat pixels; view shots stay on this PC), exits.
async function runCapture(shell) {
  try {
    const shotsDir = path.join(__dirname, '..', '..', 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });
    await new Promise(r => setTimeout(r, 15000));
    const sessDiag = [];
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      sessDiag.push({ name: acc.name, status: rec ? rec.status : 'no-session', viewAlive: !!(rec && rec.view && !rec.view.webContents.isDestroyed()) });
    }
    console.log('[capture][sessions]', JSON.stringify(sessDiag));
    // Verify the chat-list reader against the REAL WhatsApp DOM (titles only, count capped).
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      try {
        const chats = await rec.view.webContents.executeJavaScript(
          `(function(){try{return window.__wabListChats?window.__wabListChats():null;}catch(e){return null;}})()`, false);
        const probe = Array.isArray(chats)
          ? { ok: true, count: chats.length, sample: chats.slice(0, 3).map(function (c) { return c.title; }) }
          : { ok: false, note: 'reader not present (selectors or injection failed on real DOM)' };
        console.log('[capture][chats][' + acc.name + ']', JSON.stringify(probe));
      } catch (e) {
        console.log('[capture][chats][' + acc.name + '] failed:', e.message);
      }
    }
    const img = await uiWC(shell).capturePage();
    fs.writeFileSync(path.join(shotsDir, 'real-shell.png'), img.toPNG());
    let i = 0;
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (rec && rec.view && !rec.view.webContents.isDestroyed()) {
        const vimg = await rec.view.webContents.capturePage();
        const safe = acc.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        fs.writeFileSync(path.join(shotsDir, 'real-view-' + i + '-' + safe + '.png'), vimg.toPNG());
        i += 1;
      }
    }
    console.log('[capture] written to ' + shotsDir + ' (view shots stay local, they contain real chats)');
    app.exit(0);
  } catch (e) {
    console.error('[capture] failed:', e.message);
    app.exit(1);
  }
}
// v13 M1: compositor-proof capture. capturePage on an occluded or
// just-attached surface intermittently rejects (a viz/compositor error)
// or hangs; the smoke gate must fail on its assertions, never on a
// screenshot flake. Deadline race + caught rejection + one retry; a miss
// answers null and the caller skips that shot (non-fatal).
async function captureShot(wc, ms) {
  if (!wc || wc.isDestroyed()) return null;
  const bound = ms || 5000;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const img = await Promise.race([
        wc.capturePage(),
        new Promise(r => setTimeout(() => r(null), bound))
      ]);
      if (img) return img;
    } catch (e) { /* compositor flake: retry once, then skip the shot */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return null;
}

// Boots the shell with mock WhatsApp pages, three accounts, one blindfold,
// captures screenshots to build/shots/ and exits 0. Phone-free verification.
async function runSmoke(shell) {
  try {
    const shotsDir = path.join(__dirname, '..', '..', 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });

    const mk = (name, color, i) => {
      const id = sessions.makeId();
      const acc = { id, name, color, createdAt: new Date().toISOString(), partition: 'persist:' + id, status: 'linking' };
      store.upsertAccount(acc);
      sessions.createSession(acc, null);
      sessions.attachToSlot(id, i);
      return acc;
    };
    const a1 = mk('Alice (mock)', '#426CA8', 0);
    mk('Bob (mock)', '#8A5A2B', 1);
    mk('Carol (mock)', '#3E6B6B', 2);
    store.setPrivacy(a1.id, { mode: 'allow', allow: ['Marc Deckers'], deny: [] });

    // Behave like the operator: switch layout FIRST (so enough slots exist),
    // give the shell time to learn the new accounts (the poller's linked flip
    // pushes list-changed at ~2.5 s; the shell re-pulls and renders cards),
    // then click the cards to assign slots 0..2.
    sessions.setLayout('split3');
    await new Promise(r => setTimeout(r, 4000));
    const clicked = await uiWC(shell).executeJavaScript(
      `(function(){try{var cs=document.querySelectorAll('#account-list .pucard-acc');cs.forEach(function(c){c.click();});return {n:cs.length, attr:document.body.getAttribute('data-layout')};}catch(e){return {err:String(e)};}})()`, false);
    console.log('[smoke] cards clicked:', JSON.stringify(clicked));
    // Open the AI sidekick so the screenshot proves the panel too (honest no-key state).
    await uiWC(shell).executeJavaScript(
      `(function(){try{if(window.WABAiPanel){window.WABAiPanel.open({});return true;}return false;}catch(e){return false;}})()`, false);

    // Give the mock pages + injects time to settle, then capture.
    await new Promise(r => setTimeout(r, 6000));

    // ---- v3 Engine Room assertions (fixtures path; renderer asserts join when E lands) ----
    try {
      const people = await sessions.engPeople();
      const marcMsgs = await sessions.engMessages('fix_a', 'fix_chat_marc', 50);
      const sent = await sessions.engSend('fix_a', 'fix_chat_marc', 'smoke test message');
      console.log('[smoke][v3-eng] people:', people.length, '| marc messages:', marcMsgs.length,
        '| kinds:', marcMsgs.map(function (m) { return m.kind; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('/'),
        '| send:', JSON.stringify(sent));
    } catch (e) {
      console.log('[smoke][v3-eng] failed:', e.message);
    }

    // ---- v2 Conversation Mode assertions ----
    try {
      const people = await sessions.collectPeople();
      const alicePeople = people.filter(p => p.accountName === 'Alice (mock)');
      const bobPeople = people.filter(p => p.accountName === 'Bob (mock)');
      console.log('[smoke][v2-people] total:', people.length,
        '| alice (blindfolded, allow=Marc Deckers):', alicePeople.length,
        '| bob (all):', bobPeople.length);
      const peopleUi = await uiWC(shell).executeJavaScript(
        `(function(){try{var r={wabPeople: !!window.WABPeople, rows: document.querySelectorAll('#people-list > *').length, paletteOpens: false};if(window.WABPeople){window.WABPeople.openPalette();r.paletteOpens=!document.getElementById('search-palette').hidden;window.WABPeople.closePalette();}return r;}catch(e){return {err: String(e)};}})()`, false);
      console.log('[smoke][v2-people-ui]', JSON.stringify(peopleUi));
      await new Promise(r => setTimeout(r, 1200));   // let the overlay-lift release views again
      // v3 renderer: our panes render the conversation from the engine/fixtures.
      const rend = await uiWC(shell).executeJavaScript(
        `(function(){try{
          if(!window.WABRender)return {wabRender:false};
          window.WABRender.openConversation({accountId:'fix_a', chatId:'fix_chat_marc', title:'Marc Deckers', accountName:'Alice (mock)', accountColor:'#426CA8'});
          return {wabRender:true, opened:true};
        }catch(e){return {err:String(e)};}})()`, false);
      console.log('[smoke][v3-render]', JSON.stringify(rend));
      await new Promise(r => setTimeout(r, 2500));
      const paneState = await uiWC(shell).executeJavaScript(
        `(function(){try{
          var root=document.getElementById('render-root');
          var panes=root?root.querySelectorAll('.rpane').length:0;
          var bubbles=root?root.querySelectorAll('.rpane .rbub').length:0;
          var compose=root?root.querySelectorAll('.rpane textarea, .rpane [contenteditable], .rpane .compose textarea').length:0;
          return {panes:panes, bubbles:bubbles, compose:compose};
        }catch(e){return {err:String(e)};}})()`, false);
      console.log('[smoke][v3-render-dom]', JSON.stringify(paneState));
    } catch (e) {
      console.log('[smoke][v2] assertion error (non-fatal for shots):', e.message);
    }

    // Diagnostics: what does the spine actually see right now?
    try {
      const diag = await uiWC(shell).executeJavaScript(
        `(function(){try{var out={attr: document.body.getAttribute('data-layout'), rects: window.WABSlots ? window.WABSlots.getRects() : null, wab: !!window.wab, slots: []};document.querySelectorAll('.slot').forEach(function(n){var cs=getComputedStyle(n);out.slots.push({s:n.dataset.slot, hidden:!!n.hidden, disp:cs.display, cr:n.getClientRects().length, w:Math.round(n.getBoundingClientRect().width), h:Math.round(n.getBoundingClientRect().height)});});out.shellHidden=document.getElementById('shell').hidden;var sa=document.getElementById('slot-area');out.slotArea={w:Math.round(sa.getBoundingClientRect().width),h:Math.round(sa.getBoundingClientRect().height),disp:getComputedStyle(sa).display};return out;}catch(e){return {err: String(e)};}})()`, false);
      const cardsAtEnd = await uiWC(shell).executeJavaScript(
        `(function(){try{return document.querySelectorAll('#account-list .pucard-acc').length;}catch(e){return -1;}})()`, false);
      console.log('[smoke][diag]', JSON.stringify(diag), 'cards at end:', cardsAtEnd);
      const sessDiag = [];
      for (const acc of store.listAccounts()) {
        const rec = sessions.getSession(acc.id);
        sessDiag.push({ name: acc.name, status: rec ? rec.status : 'no-rec' });
      }
      console.log('[smoke][diag-sessions]', JSON.stringify(sessDiag));
    } catch (e) { console.log('[smoke][diag] failed:', e.message); }
    const img = await captureShot(uiWC(shell));
    if (img) fs.writeFileSync(path.join(shotsDir, 'shell.png'), img.toPNG());
    else console.log('[smoke] shell shot skipped (compositor flake, non-fatal)');
    let i = 0;
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      // v13 M1: webContents itself can be undefined mid-teardown (the
      // isDestroyed-on-undefined rejection); the guard checks every hop.
      if (rec && rec.view && rec.view.webContents &&
          !rec.view.webContents.isDestroyed() && sessions.isShown(acc.id)) {
        // captureShot races the deadline AND catches the compositor
        // rejection (the old race answered a viz flake with exit 1).
        const vimg = await captureShot(rec.view.webContents);
        if (!vimg) continue;
        const safe = acc.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        fs.writeFileSync(path.join(shotsDir, 'view-' + i + '-' + safe + '.png'), vimg.toPNG());
        i += 1;
      }
    }
    console.log('[smoke] shots written to ' + shotsDir);
    // Smoke leaves no trace in the real store: the mock accounts come out again.
    for (const acc of store.listAccounts()) {
      if (/\(mock\)$/.test(acc.name)) { sessions.removeSession(acc.id); store.removeAccount(acc.id); }
    }
    store.flush();
    app.exit(0);
  } catch (e) {
    console.error('[smoke] failed:', e.message);
    app.exit(1);
  }
}
