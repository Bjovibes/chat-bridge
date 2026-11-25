// telegram-inject.js - Chat Bridge v12 Telegram engine-room bridge (stage T2, contract = engine-inject.js surface, platform #2).
// NOT a CommonJS module. The spine reads this file as TEXT and runs it via
// webContents.executeJavaScript in the Telegram engine WebContentsView (the
// web.telegram.org page, own isolated partition), main world. Idempotent
// (double-injection guard). Everything is guarded: no path throws and no
// returned promise ever rejects.
//
// Defines in the page world, exactly (same names and return shapes as the
// WhatsApp engine, so the spine needs zero platform-specific code):
//   window.__wabEng = {
//     ready(): Promise<bool>,                                  // a data tier that can serve listChats is live
//     listChats(): Promise<[{chatId, title, unread, t, archived}]>,
//     getContact(chatId): Promise<{name, phone}|null>,
//     getMessages(chatId, limit?): Promise<[{id, fromMe, text, ts, kind, mId?}]>,  // kind: text|system|media-placeholder; media rows carry mId for getMedia
//     openChat(chatId): Promise<{ok, error}>,
//     send(text): Promise<{ok, error}>,                        // guarded legacy synthetic attempt; the NORMATIVE send is the spine real-input route
//     getAvatars(limit?): Promise<[{title, avatar}]>,          // chat-list photos as dataURLs
//     getTyping(): Promise<[title, ...]>,                      // chat titles with a live typing indicator
//     getMedia(chatId, msgId): Promise<{ok, kind, data, mime} | {ok:false, error}>,
//     getMessagesHistory(chatId, pages?): Promise<{ok, messages, grewBy, hasMore, pagesRun}|{ok:false,error}>,
//     hasMoreHistory(chatId): Promise<bool>,
//     insertDraft(text): Promise<{ok, verified, cleared}>,     // passive composer insert + immediate clear; never the send button
//     health(): Promise<{idb, modules, lastError}>,
//     debugTail(): [string]
//   }
//   Telegram additions for the spine's REAL-INPUT route (the WhatsApp lesson:
//   synthetic input is dead on modern platforms; the spine drives real
//   keystrokes at engine-provided css-px coordinates via sendInputEvent):
//     composerCoords(): Promise<{ok, x, y, w, h}|{ok:false, error}>,
//     sendButtonCoords(): Promise<{ok, x, y}|{ok:false, error}>,
//     chatRowCoords(chatId, title?): Promise<{ok, x, y}|{ok:false, error}>,
//     searchBoxCoords(): Promise<{ok, x, y}|{ok:false, error}>,
//     hasNewMessages(chatId): Promise<bool>
//
// Laws honored (mirrors of the WhatsApp engine laws, adapted):
// - T1 research (notes\research\T-TELEGRAM-WEB.md) HAS landed (D3). The Web K
//   window managers (appImManager, appDialogsManager, rootScope,
//   apiManagerProxy) are tier 0 for every data path; the Tiptap composer
//   setter (setValueSilently) and .btn-send-container .btn-circle.btn-send
//   are the exact send anchors. IDB and DOM stay as fallbacks (candidate
//   chains, record-shape classification). Tail tiers (E1): 0 = window
//   managers (getHistory options-object contract + per-mid
//   getMessageByPeer, tweb master), 1 = strict open-chat DOM reader
//   (.bubble[data-mid] contract, render-waited), 2 = IDB message stores
//   (no writer on Web K), 3 = legacy fuzzy DOM. __probeTelegram() is the
//   structure-only diagnostic that settles any drift.
// - IndexedDB: READ-ONLY. Existence check via indexedDB.databases() BEFORE
//   any open (a versionless open creates the DB if absent, so never open a
//   missing DB). Versionless open (never upgrades an existing DB). Close on
//   onversionchange so Telegram's own upgrades are never blocked. Every read
//   is its own short readonly transaction; nothing is ever written.
// - Partition law: the Telegram engine view runs in its OWN partition, so
//   every IndexedDB database visible from this page belongs to Telegram
//   (web.telegram.org and its login iframe). Database enumeration is
//   therefore safe to probe generically; classification is still by content.
// - Covered-page law: the engine view is a WebContentsView permanently
//   covered by the UI view. Covered elements still lay out (client rects
//   exist) and still take programmatic .click() and programmatic scrolling,
//   so every DOM tier works blind. All "visible" checks are layout checks.
// - Privacy: no plaintext contact names or message text in ANY error, step,
//   or tail string. Errors and debugTail entries carry fixed step names,
//   tier numbers and counts ONLY (an exception contributes at most its
//   .name, and only browser-generated ones ever reach that path). No
//   console output at all.
// - Send law (the WhatsApp lesson): the NORMATIVE send route is real input
//   driven by the SPINE at composerCoords()/sendButtonCoords(). The engine's
//   own send(text) is a guarded legacy synthetic attempt that keeps the API
//   contract honest: exact-match text verify BEFORE any button click, click
//   registration poll, one fresh-node retry only when the draft provably
//   never left the box, delivery ack via the data tiers. A false "sent"
//   remains worse than slow. It NEVER synthesizes Enter.
// - IDB first, DOM second: every data method tries the IndexedDB tier (the
//   partition's Telegram stores, plaintext if Telegram does not encrypt at
//   rest) and falls back to DOM scraping of the rendered client. Which tier
//   answered is recorded in the tail as a tier number only.
(function () {
  'use strict';
  try {
    if (typeof window === 'undefined' || !window.document) return;
    var W = window;
    var D = window.document;
    if (W.__wabEngInstalled) return; // double-injection guard
    W.__wabEngInstalled = true;

    // ============================ budgets (ms) ============================
    var IDB_PROBE_TIMEOUT = 2500;   // one whole IDB classification pass
    var IDB_OK_TTL = 30000;         // re-probe spacing after a good pass
    var IDB_FAIL_TTL = 10000;       // re-probe spacing after a bad pass
    var PROBE_TIMEOUT = 2500;       // module runtime probe
    var PROBE_RETRY_MS = 5000;      // min spacing between failed probes
    var OPEN_TIMEOUT = 6000;        // whole openChat budget
    var MODULE_PHASE_MS = 1200;     // module-manager open tier cap
    var DOM_ROUTE_MS = 4000;        // DOM row-click route cap
    var FAST_LIVENESS_MS = 300;     // open fast-path liveness probe
    var OPEN_VERIFY_MS = 2000;      // composer-after-click verify window
    var VERIFY_STEP_MS = 150;
    var BUTTON_TRIES = 12;          // send button poll: 12 x 100 ms
    var BUTTON_STEP_MS = 100;
    var ACK_TIMEOUT = 2500;         // delivery ack poll cap
    var ACK_STEP_MS = 150;
    var CLICK_REGISTRATION_MS = 800;// click-registration window cap
    var CLICK_REG_STEP_MS = 100;
    var TAIL_CAP = 20;              // debugTail ring size
    var ROSTER_CAP = 500;           // listChats cap
    var MSG_CAP = 500;              // getMessages limit clamp
    var MSG_SCAN_CAP = 5000;        // IDB message cursor steps per read
    var MSG_CACHE_MS = 1500;        // getMessages result micro-cache
    var MSG_WARM_RETRY_MS = 10000;  // spacing after a flat history probe
    var HIST_TOTAL_MS = 25000;      // whole getMessagesHistory budget
    var HIST_PAGE_MAX = 20;         // hard page-loop cap per call
    var HIST_SETTLE_MS = 700;       // post-scroll growth settle per page
    var HIST_STEP_MS = 150;
    var MEDIA_CAP = 1572864;        // dataURL cap (1.5 MB, same as WA)
    var MEDIA_FETCH_MS = 8000;      // in-page media fetch bound
    var MEDIA_BLOB_MS = 2500;       // blob() / FileReader bound
    var TYPING_CACHE_MS = 1000;     // getTyping result cache
    var TYPING_ROW_CAP = 100;       // DOM rows scanned per typing pass
    var AVATAR_CAP = 120;           // getAvatars row cap
    var IDB_TX_MS = 2000;           // one readonly transaction bound
    var DB_CAP = 10;                // databases probed per pass
    var STORE_CAP = 40;             // stores classified per database
    var STORE_SAMPLE = 3;           // records sampled per store
    var MOD_CACHE_CAP = 4000;       // module-cache entries walked per probe
    var MOD_TIER_CALLS = 6;         // module open-tier call attempts
    var WK_HIST_TOTAL_MS = 4000;    // whole wkReadHistory budget (all managers + shapes share it)
    var MSG_RENDER_WAIT_MS = 2500;  // open-chat DOM reader: wait out the async history render
    var DIALOG_SCAN_CAP = 16000;    // F1: dialog records read per listChats. 4000
                                    // was a key-order prefix, and '-' sorts before
                                    // digits, so on a 13k store it was 100% group/
                                    // channel dialogs (tweb keys dialogs by signed
                                    // internal peerId). 16000 covers the live store.
    var NAME_SAMPLE_CAP = 2000;     // users/chats base-map value-scan sample (fallback)
    var NAME_GET_CAP = 1500;        // targeted single-key name gets per listChats
    var PROBE_TOTAL_MS = 6000;      // whole __probeTelegram budget

    // ============================ health record ============================
    var HEALTH = { idb: false, modules: false, lastError: null };
    // step is a fixed string. An exception contributes ONLY its class name
    // (e.name), never its message text, so even a Telegram-thrown exception
    // can never carry a contact name or message text into health.lastError.
    function noteError(step, e) {
      try {
        var why = '';
        if (e) {
          if (typeof e === 'string') why = e;
          else if (e.name) why = String(e.name);
        }
        HEALTH.lastError = why ? (step + ': ' + why) : step;
        if (HEALTH.lastError.length > 100) HEALTH.lastError = HEALTH.lastError.slice(0, 100);
      } catch (e2) { HEALTH.lastError = step; }
    }

    // ============================ step tail ============================
    // debugTail() ring: fixed step names + tier numbers + counts ONLY
    // (privacy law). Cleared at the start of every openChat / send /
    // history / draft call so the tail always describes the latest op.
    var TAIL = [];
    function tailReset() {
      try { TAIL = []; } catch (eT) { TAIL = []; }
    }
    function tail(s) {
      try {
        TAIL.push(String(s));
        while (TAIL.length > TAIL_CAP) TAIL.shift();
      } catch (eP) {}
    }

    // ============================ small utils ============================
    function firstStr() {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (typeof v === 'string' && v.replace(/\s+/g, '').length) return v;
      }
      return '';
    }
    function firstNum() {
      for (var i = 0; i < arguments.length; i++) {
        if (typeof arguments[i] === 'number' && isFinite(arguments[i])) return arguments[i];
      }
      return 0;
    }
    function normWs(s) {
      try { return String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
      catch (e) { return ''; }
    }
    function digitsOnly(v) {
      try { return String(v == null ? '' : v).replace(/\D/g, ''); }
      catch (e) { return ''; }
    }
    function qsa(sel, root) {
      try { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }
      catch (e) { return []; }
    }
    function collapsed(el) {
      try { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
      catch (e) { return ''; }
    }
    function sleep(ms) {
      return new W.Promise(function (res) { W.setTimeout(res, ms); });
    }
    function pollUntil(deadline, fn, stepMs) {
      return new W.Promise(function (resolve) {
        var tick = function () {
          var v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) { resolve(v); return; }
          if (Date.now() >= deadline) { resolve(null); return; }
          W.setTimeout(tick, stepMs || 150);
        };
        tick();
      });
    }
    function pollTries(fn, tries, ms) {
      return new W.Promise(function (resolve) {
        var n = 0;
        var tick = function () {
          var v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) { resolve(v); return; }
          n++;
          if (n >= tries) { resolve(null); return; }
          W.setTimeout(tick, ms);
        };
        tick();
      });
    }
    function raceDeadline(p, deadline) {
      var remain = deadline - Date.now();
      if (remain <= 0) return W.Promise.resolve(null);
      return W.Promise.race([
        W.Promise.resolve(p),
        sleep(remain).then(function () { return null; })
      ]);
    }
    // covered-page law: layout check only, never eyes
    function laidOut(el) {
      try { return !!(el && el.getClientRects && el.getClientRects().length); }
      catch (e) { return false; }
    }
    // css-px center of an element, for the spine's sendInputEvent route
    function centerOf(el) {
      try {
        if (!laidOut(el)) return null;
        var r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return null;
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          w: Math.round(r.width),
          h: Math.round(r.height)
        };
      } catch (e) { return null; }
    }

    // ============================ peer / id canonicalization ============================
    // Telegram peer shapes: {_: 'peerUser', user_id}, {_: 'peerChat',
    // chat_id}, {_: 'peerChannel', channel_id}. Canonical chatId strings
    // (MTProto convention): bare positive user id, negative for legacy
    // groups, '-100' + id for channels/supergroups. The spine treats them
    // as opaque; only internal consistency matters.
    function peerKeyOf(peer) {
      try {
        if (!peer || typeof peer !== 'object') return '';
        if (peer.user_id !== undefined && peer.user_id !== null) return String(Number(peer.user_id));
        if (peer.chat_id !== undefined && peer.chat_id !== null) return String(-Number(peer.chat_id));
        if (peer.channel_id !== undefined && peer.channel_id !== null) return '-100' + String(Number(peer.channel_id));
        if (typeof peer.id !== 'undefined') return String(peer.id); // webk internal peer
      } catch (e) {}
      return '';
    }
    function dialogId(d) {
      try {
        if (!d || typeof d !== 'object') return '';
        var pk = peerKeyOf(d.peer) || peerKeyOf(d.peer_id);
        if (pk) return pk;
        if (typeof d.chatId === 'string' && d.chatId) return d.chatId;   // webk-ish internal key
        if (typeof d.id === 'string' && d.id && isNaN(Number(d.id))) return d.id;
        if (typeof d.id === 'number') return String(d.id);
        // tweb's own Dialog wrapper (what DialogsStorage persists): numeric
        // internal peerId -- users positive, groups AND channels negative
        // with NO -100 marker (peerIdPolyfill), the same space as
        // data-peer-id; pushDialog's join handles the negative forms
        if (typeof d.peerId === 'number' && isFinite(d.peerId)) return String(d.peerId);
      } catch (e) {}
      return '';
    }
    // F1: store-key fallback id. tweb keys the dialogs store by '' + peerId
    // in its INTERNAL space (users positive; basic groups AND channels
    // negative with NO -100 marker -- lib/storages/dialogs.ts
    // storage.set({[peerId]: dialog})). Our canonical chatId marks channels
    // with -100; tweb channel ids are 10+ digits and basic group ids never
    // reached 10, so digit length is the marker discriminator.
    function keyToChatId(key) {
      try {
        var s = String(key == null ? '' : key);
        var m = s.match(/^(-?)(\d+)$/);
        if (!m) return '';
        if (m[1] === '-') {
          var dg = m[2];
          if (dg.length >= 10 && dg.indexOf('100') !== 0) return '-100' + dg;
          return '-' + dg;
        }
        return s;
      } catch (e) { return ''; }
    }
    function msgPeerId(m) {
      try {
        if (!m || typeof m !== 'object') return '';
        return peerKeyOf(m.peer_id) || peerKeyOf(m.peer) || '';
      } catch (e) { return ''; }
    }
    // digit-tail compare for keyed stores whose keys may carry webk forms
    // ('u123', 'c123', '-100...'): same digits tail = same dialog
    function keyMatchesChat(keyStr, chatId) {
      try {
        var a = digitsOnly(keyStr);
        var b = digitsOnly(chatId);
        if (a.length < 3 || b.length < 3) return false;
        return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
      } catch (e) { return false; }
    }

    // ============================ record classifiers (shape, not name) ============================
    function looksLikeDialog(rec) {
      try {
        if (!rec || typeof rec !== 'object') return false;
        if (rec._ === 'dialog') return true;
        if (rec.peer && typeof rec.peer === 'object' && rec.peer._) return true;
        if (rec.peer_id && typeof rec.peer_id === 'object' && rec.peer_id._) return true;
        if (typeof rec.top_message === 'number' && typeof rec.date === 'number') return true;
      } catch (e) {}
      return false;
    }
    function looksLikeUser(rec) {
      try {
        if (!rec || typeof rec !== 'object') return false;
        if (rec._ === 'user') return true;
        // F1 impostor guard: a record that declares a DIFFERENT MTProto type
        // can never be a user; without this, any id-bearing record from an
        // unrelated store could win the shape walk
        if (rec._ && rec._ !== 'user') return false;
        if (typeof rec.id !== 'undefined' && (typeof rec.first_name === 'string' || typeof rec.username === 'string' || typeof rec.phone === 'string')) return true;
      } catch (e) {}
      return false;
    }
    function looksLikeChat(rec) {
      try {
        if (!rec || typeof rec !== 'object') return false;
        if (rec._ === 'chat' || rec._ === 'channel') return true;
        // F1 impostor guard: sticker-set records carry id + title and were
        // winning this test in the shape walk (tweb creates the stickerSets
        // store BEFORE chats in every tweb-account DB), stealing the chats
        // role and killing every group/channel name. A record that declares
        // another MTProto type is never a chat.
        if (rec._ && rec._ !== 'chat' && rec._ !== 'channel') return false;
        if (typeof rec.id !== 'undefined' && typeof rec.title === 'string' && rec.first_name === undefined && rec.username === undefined) return true;
      } catch (e) {}
      return false;
    }
    function looksLikeMessage(rec) {
      try {
        if (!rec || typeof rec !== 'object') return false;
        if (rec._ === 'message' || rec._ === 'messageService') return true;
        if (typeof rec.message === 'string' && typeof rec.date === 'number' && typeof rec.id !== 'undefined') return true;
      } catch (e) {}
      return false;
    }
    function isMsgOut(rec) {
      try {
        if (rec.out === true) return true;
        if (rec.pFlags && rec.pFlags.out === true) return true;
        if (rec.flags !== undefined && (rec.flags & 2) === 2) return true; // POST flag family, weak
      } catch (e) {}
      return false;
    }
    function userName(u) {
      try {
        if (!u || typeof u !== 'object') return '';
        var nm = firstStr(u.first_name, u.last_name);
        var joined = '';
        if (typeof u.first_name === 'string' && u.first_name.trim()) joined += u.first_name.trim();
        if (typeof u.last_name === 'string' && u.last_name.trim()) joined += (joined ? ' ' : '') + u.last_name.trim();
        if (joined) return joined;
        return firstStr(nm, u.username, u.name, u.title);
      } catch (e) { return ''; }
    }
    function msgKind(rec) {
      try {
        if (rec._ === 'messageService' || rec.action) return 'system';
        if (rec.media && typeof rec.media === 'object') return 'media-placeholder';
      } catch (e) {}
      return 'text';
    }
    function mapMsg(rec, idx) {
      var ts = (typeof rec.date === 'number' && rec.date > 0) ? rec.date : 0; // seconds epoch
      var kind = msgKind(rec);
      var text = '';
      if (kind === 'text' && typeof rec.message === 'string') text = rec.message;
      var id = '';
      try { id = String(rec.id != null ? rec.id : ''); } catch (eI) { id = ''; }
      if (!id) id = 'idx_' + idx + '_' + ts;
      var out = {
        id: id,
        fromMe: isMsgOut(rec),
        text: text,
        ts: ts,
        kind: kind
      };
      if (kind === 'media-placeholder') out.mId = id;
      return out;
    }

    // ============================ IDB layer (READ-ONLY) ============================
    // IDB = the classified map of the partition's Telegram databases:
    //   { ok, at, db, name, dialogs, users, chats, msgs } where each role is
    //   an objectStore NAME on the primary database. Databases are chosen by
    //   content classification (record shapes), never by name; name
    //   candidates only set the probe ORDER. Nothing is ever written.
    var IDB = { ok: false, at: 0, db: null, name: '', dialogs: '', users: '', chats: '', msgs: [] };
    var DB_NAME_PREFER = /tweb|telegram|webk|webgram|gramjs|tg/i; // order hint only
    var NAME_KEY_MODE = '';          // F1: '' = name-store keys are '' + id strings
                                     // (tweb master contract); 'num' = keys are typed
                                     // numbers on this build (drift fallback, latched
                                     // per page session by the listChats drift guard)

    function idbDatabases() {
      return new W.Promise(function (resolve) {
        try {
          if (!W.indexedDB || typeof W.indexedDB.databases !== 'function') { resolve([]); return; }
          W.indexedDB.databases().then(function (list) {
            resolve(Array.isArray(list) ? list : []);
          }).then(null, function () { resolve([]); });
        } catch (e) { resolve([]); }
      });
    }
    function openDbVersionless(name) {
      return new W.Promise(function (resolve) {
        var done = false;
        var fin = function (db) {
          if (done) return; done = true; resolve(db);
        };
        try {
          var req = W.indexedDB.open(name); // versionless: no upgrade attempt
          req.onsuccess = function () {
            var db = req.result;
            if (!db) { fin(null); return; }
            db.onversionchange = function () {
              try { db.close(); } catch (eV) {}
              if (IDB.db === db) { IDB.db = null; IDB.ok = false; HEALTH.idb = false; }
            };
            fin(db);
          };
          req.onerror = function () { fin(null); };
          req.onblocked = function () { /* versionless opens never queue an upgrade */ };
          W.setTimeout(function () { fin(null); }, IDB_TX_MS);
        } catch (eO) { fin(null); }
      });
    }
    function storeSample(db, store) {
      // tiny CURSOR sample (STORE_SAMPLE records, then stop): never getAll(),
      // which on a big message store would read the whole store just to
      // classify it
      return new W.Promise(function (resolve) {
        var out = [];
        var done = false;
        var fin = function () {
          if (done) return; done = true; resolve(out);
        };
        try {
          if (!db || !db.objectStoreNames || !db.objectStoreNames.contains(store)) { fin(); return; }
          var tx = db.transaction(store, 'readonly');
          var rq = tx.objectStore(store).openCursor();
          rq.onsuccess = function () {
            var cur = rq.result;
            if (!cur) { fin(); return; }
            out.push(cur.value);
            if (out.length >= STORE_SAMPLE) { fin(); return; }
            try { cur.continue(); } catch (eC) { fin(); }
          };
          rq.onerror = fin;
          W.setTimeout(fin, IDB_TX_MS);
        } catch (eS) { fin(); }
      });
    }
    function idbGetAll(store, cap) {
      return new W.Promise(function (resolve) {
        var out = [];
        var done = false;
        var fin = function () {
          if (done) return; done = true; resolve(out);
        };
        try {
          if (!IDB.db || !IDB.name || !IDB.db.objectStoreNames.contains(store)) { fin(); return; }
          var tx = IDB.db.transaction(store, 'readonly');
          var rq = tx.objectStore(store).getAll();
          rq.onsuccess = function () {
            var v = rq.result;
            if (Array.isArray(v)) out = (cap && v.length > cap) ? v.slice(0, cap) : v;
            fin();
          };
          rq.onerror = fin;
          W.setTimeout(fin, IDB_TX_MS);
        } catch (eG) { fin(); }
      });
    }
    function idbGetKey(store, key) {
      // single-record readonly get (T1 3.1: stores are keyed by '' + id);
      // the name join's targeted lookups. Same read-only laws: one short
      // readonly transaction, never writes, never throws
      return new W.Promise(function (resolve) {
        var done = false;
        var fin = function (v) {
          if (!done) { done = true; resolve(v == null ? null : v); }
        };
        try {
          if (!IDB.db || !IDB.name || !IDB.db.objectStoreNames.contains(store)) { fin(null); return; }
          var tx = IDB.db.transaction(store, 'readonly');
          var rq = tx.objectStore(store).get(key);
          rq.onsuccess = function () { fin(rq.result); };
          rq.onerror = fin;
          W.setTimeout(function () { fin(null); }, IDB_TX_MS);
        } catch (eG) { fin(null); }
      });
    }
    function idbGetMany(store, keys) {
      // F1: batched single-record gets -- ONE readonly transaction for the
      // whole chunk instead of one transaction per key (the name join runs
      // hundreds of point lookups per roster pass; hundreds of separate
      // transactions serialized into seconds). Resolves values aligned to
      // keys; null on any miss. Same read-only laws: never writes, never
      // throws, resolves on complete/error/abort/timeout whatever it has.
      return new W.Promise(function (resolve) {
        var out = new Array(keys.length);
        var done = false;
        var fin = function () {
          if (!done) { done = true; resolve(out); }
        };
        try {
          if (!IDB.db || !IDB.name || !IDB.db.objectStoreNames.contains(store) || !keys.length) { fin(); return; }
          for (var i = 0; i < keys.length; i++) out[i] = null;
          var tx = IDB.db.transaction(store, 'readonly');
          var os = tx.objectStore(store);
          for (var j = 0; j < keys.length; j++) {
            (function (idx) {
              try {
                var rq = os.get(keys[idx]);
                rq.onsuccess = function () {
                  try { out[idx] = rq.result == null ? null : rq.result; } catch (eS) {}
                };
                rq.onerror = null;
              } catch (eI) {}
            })(j);
          }
          tx.oncomplete = fin;
          tx.onerror = fin;
          tx.onabort = fin;
          W.setTimeout(fin, IDB_TX_MS * 2);
        } catch (eG) { fin(); }
      });
    }
    function idbWalk(store, cap, visit, txMs) {
      // cursor walk with a hard step cap; visit(value, key) may return false
      // to stop early. Values that are arrays are flattened (keyed-by-chat
      // stores hold message arrays). txMs defaults IDB_TX_MS; message walks
      // pass a wider bound (many steps).
      return new W.Promise(function (resolve) {
        var done = false;
        var steps = 0;
        var stop = false;
        var fin = function () {
          if (done) return; done = true; resolve(steps);
        };
        try {
          if (!IDB.db || !IDB.name || !IDB.db.objectStoreNames.contains(store)) { fin(); return; }
          var tx = IDB.db.transaction(store, 'readonly');
          var rq = tx.objectStore(store).openCursor();
          rq.onsuccess = function () {
            if (done) return;
            var cur = rq.result;
            if (!cur || stop || steps >= cap) { fin(); return; }
            var val = cur.value;
            var key = cur.key;
            steps++;
            try {
              if (Array.isArray(val)) {
                for (var i = 0; i < val.length; i++) {
                  if (visit(val[i], key) === false) { stop = true; break; }
                }
              } else if (visit(val, key) === false) { stop = true; }
            } catch (eV) {}
            if (stop) { fin(); return; }
            try { cur.continue(); } catch (eC) { fin(); }
          };
          rq.onerror = fin;
          W.setTimeout(fin, txMs || IDB_TX_MS);
        } catch (eW) { fin(); }
      });
    }

    async function probeIdb(force) {
      if (IDB.ok && !force && (Date.now() - IDB.at) < IDB_OK_TTL) return true;
      if (!IDB.ok && !force && (Date.now() - IDB.at) < IDB_FAIL_TTL) return false;
      IDB.at = Date.now();
      var deadline = Date.now() + IDB_PROBE_TIMEOUT;
      try {
        var list = await idbDatabases();
        var names = [];
        for (var i = 0; i < list.length && i < DB_CAP; i++) {
          if (list[i] && list[i].name) names.push(String(list[i].name));
        }
        // preference order first (order hint only; partition law: all are Telegram's)
        // F1: the old two-bucket sort left legacy `tweb` and the session-only
        // `telegram` DB able to sort ahead of the live tweb-account-N DB (same
        // bucket, stable order = enumeration order). Rank explicitly instead.
        var dbRank = function (n) {
          if (/^tweb-account-\d+$/.test(n)) return 0; // the live per-account DB
          if (/^tweb$/.test(n)) return 1;             // legacy pre-multi-account
          if (/^tweb-common$/.test(n)) return 3;      // cross-account: no dialogs
          if (/^telegram/.test(n)) return 4;          // MTProto session DB
          return DB_NAME_PREFER.test(n) ? 2 : 5;
        };
        names.sort(function (a, b) { return dbRank(a) - dbRank(b); });
        var best = null; // {db, name, roles}
        for (var d = 0; d < names.length; d++) {
          if (Date.now() >= deadline) break;
          if (names[d].indexOf('firebase') !== -1 || names[d].indexOf('playroom') !== -1) continue; // known non-app noise names
          var db = await openDbVersionless(names[d]);
          if (!db) continue;
          var storeNames = [];
          try {
            storeNames = Array.prototype.slice.call(db.objectStoreNames || [], 0, STORE_CAP);
          } catch (eN) { storeNames = []; }
          var roles = { dialogs: '', users: '', chats: '', msgs: [] };
          var hits = 0;
          // F1 name-first pass: tweb's store names are public constants
          // (config/databases/state.ts: users, chats, dialogs exist in every
          // tweb-account DB), so an exact-name store whose sample passes a
          // STRICT MTProto `_` check is conclusive. The shape-only walk
          // below assigned roles to the FIRST store whose sample fit a loose
          // shape -- live, stickerSets (created before chats, records carry
          // id+title) stole the chats role and every group/channel title
          // died as "Unknown".
          try {
            if (storeNames.indexOf('dialogs') !== -1) {
              var ndlg = await storeSample(db, 'dialogs');
              var nd = 0;
              for (var q0 = 0; q0 < ndlg.length; q0++) {
                if (ndlg[q0] && ndlg[q0]._ === 'dialog') nd++;
              }
              if (nd) {
                roles.dialogs = 'dialogs'; hits++;
                if (storeNames.indexOf('users') !== -1) {
                  var nusr = await storeSample(db, 'users');
                  var nu = 0;
                  for (var q1 = 0; q1 < nusr.length; q1++) {
                    if (nusr[q1] && nusr[q1]._ === 'user') nu++;
                  }
                  if (nu) { roles.users = 'users'; hits++; }
                }
                if (storeNames.indexOf('chats') !== -1) {
                  var ncht = await storeSample(db, 'chats');
                  var nc = 0;
                  for (var q2 = 0; q2 < ncht.length; q2++) {
                    var ncr = ncht[q2];
                    if (ncr && (ncr._ === 'chat' || ncr._ === 'channel')) nc++;
                  }
                  if (nc) { roles.chats = 'chats'; hits++; }
                }
              }
            }
          } catch (eNamed) {}
          if (!roles.dialogs) for (var s = 0; s < storeNames.length; s++) {
            if (Date.now() >= deadline) break;
            var sn = storeNames[s];
            var sample = await storeSample(db, sn);
            var dlg = 0, usr = 0, cht = 0, msg = 0;
            for (var r = 0; r < sample.length; r++) {
              if (looksLikeDialog(sample[r])) dlg++;
              else if (looksLikeMessage(sample[r])) msg++;
              else if (looksLikeUser(sample[r])) usr++;
              else if (looksLikeChat(sample[r])) cht++;
            }
            if (dlg && !roles.dialogs) { roles.dialogs = sn; hits++; }
            else if (msg) { roles.msgs.push(sn); hits++; }
            else if (usr && !roles.users) { roles.users = sn; hits++; }
            else if (cht && !roles.chats) { roles.chats = sn; hits++; }
          }
          if (roles.dialogs && hits >= 2) { best = { db: db, name: names[d], roles: roles }; break; }
          // not a fit: close and keep looking
          try { db.close(); } catch (eCl) {}
        }
        if (best) {
          if (IDB.db && IDB.db !== best.db) { try { IDB.db.close(); } catch (eC2) {} }
          IDB.db = best.db; IDB.name = best.name;
          IDB.dialogs = best.roles.dialogs; IDB.users = best.roles.users;
          IDB.chats = best.roles.chats; IDB.msgs = best.roles.msgs.slice(0, 4);
          IDB.ok = true;
          HEALTH.idb = true;
          return true;
        }
        IDB.ok = false;
        HEALTH.idb = false;
        return false;
      } catch (eP) {
        IDB.ok = false;
        HEALTH.idb = false;
        noteError('idb probe', eP);
        return false;
      }
    }

    // ============================ DOM chains (candidate ladders) ============================
    // T1 research pending: every chain covers Telegram Web K and Web A
    // vocabulary plus generics; tier numbers record which rung answered.
    var CHATLIST_CHAIN = [
      'li.chatlist-chat[data-peer-id]',                        // T1 2.1: the Web K row
      '.chatlist-chat',
      'a.chatlist-chat',
      '.chatlist a',
      '.sidebar [class*="chatlist"] a',
      '[class*="dialog"] a[href]'
    ];
    var ROW_TITLE_CHAIN = ['.dialog-title .user-title', '.user-title', '.dialog-title', '.row-title', '.chatlist-chat-title', 'h3', '[class*="title"]', '[class*="peer-title"]'];
    var ROW_SUB_CHAIN = ['.dialog-subtitle', '.row-subtitle', '[class*="subtitle"]', '[class*="last-message"]'];
    var ROW_UNREAD_CHAIN = ['.dialog-subtitle-badge-unread', '.unread-badge', '.dialog-unread', '[class*="unread"]'];
    var COMPOSER_CHAIN = [
      '.input-message-input',                                  // T1 6: the Tiptap editable keeps the classic class
      '.input-message-container .input-message-input',
      '.ProseMirror[contenteditable="true"]',                  // Tiptap/ProseMirror root
      'div.input-message-input[contenteditable="true"]',
      '.input-container div[contenteditable="true"]',
      '.composer-wrapper div[contenteditable="true"]',
      'form div[contenteditable="true"]',
      'div[contenteditable="true"]'
    ];
    var SEND_BTN_CHAIN = [
      '.btn-send-container .btn-circle.btn-send',              // T1 6: the Web K send button, exact
      'button.btn-send',
      '[class*="btn-send"]',
      'button[aria-label="Send"]',
      'button[aria-label*="Send" i]',
      'button[class*="send"]'
    ];
    var VOICE_RE = /record|mic|voice|audio/i; // never the voice-note button
    var BUBBLE_CHAIN = ['.bubble', '[class*="bubble"][class*="is-in"], [class*="bubble"][class*="is-out"]'];
    var BUBBLE_TEXT_CHAIN = ['.message', '.translatable-message', '.message-text', '.text-content'];
    var BUBBLE_TIME_CHAIN = ['.time', '[class*="time"]'];
    var MSG_SCROLLER_CHAIN = ['.bubbles', '.bubbles-inner', '.messages-container', '[class*="chat-container"]'];
    var SEARCH_CHAIN = [
      'input.input-search',
      'input[type="search"]',
      '.search-input input',
      'input[placeholder]',
      'input[aria-label*="Search" i]'
    ];
    var TYPING_TEXT_RE = /^typing[….]*$/i;

    function chainFirst(chain, root) {
      for (var i = 0; i < chain.length; i++) {
        try {
          var el = (root || D).querySelector(chain[i]);
          if (el) return el;
        } catch (e) {}
      }
      return null;
    }
    function domChatRows() {
      for (var i = 0; i < CHATLIST_CHAIN.length; i++) {
        try {
          var rows = qsa(CHATLIST_CHAIN[i]);
          if (rows.length) {
            var out = [];
            for (var r = 0; r < rows.length && r < ROSTER_CAP; r++) {
              var row = rows[r];
              var tEl = chainFirst(ROW_TITLE_CHAIN, row);
              var title = tEl ? (tEl.getAttribute('title') || collapsed(tEl)) : collapsed(row);
              title = normWs(title);
              if (!title) continue;
              var unread = 0;
              for (var u = 0; u < ROW_UNREAD_CHAIN.length; u++) {
                try {
                  var bEl = row.querySelector(ROW_UNREAD_CHAIN[u]);
                  if (bEl) {
                    var n = parseInt(digitsOnly(collapsed(bEl)), 10);
                    unread = isFinite(n) && n > 0 ? n : 1;
                    break;
                  }
                } catch (eU) {}
              }
              if (!unread) {
                try {
                  if (/(^|\s)unread(\s|$)/.test(row.className || '')) unread = 1;
                } catch (eC) {}
              }
              var pid = '';
              try { pid = String(row.getAttribute('data-peer-id') || ''); } catch (eP2) {}
              out.push({ el: row, title: title, unread: unread, tier: i + 1, pid: pid });
            }
            if (out.length) return out;
          }
        } catch (eR) {}
      }
      return [];
    }
    function domChatListLive() {
      try { return domChatRows().length > 0; } catch (e) { return false; }
    }

    // ============================ module runtime (opportunistic) ============================
    // Telegram's web clients are webpack bundles. Same capture technique as
    // the WhatsApp engine (shim chunk, cached require, cache walk), but the
    // hunt is for MANAGERS (objects exposing openChat/openPeerDialog/
    // getHistory/sendText-ish callables), used ONLY to help openChat and
    // getMessagesHistory. Absence degrades silently; HEALTH.modules reports
    // the truth. Never required by any data path.
    var RUNTIME = { ok: false, lastTry: 0, req: null, openFns: [], histFns: [] };
    function chunkArrays() {
      try {
        var out = [];
        for (var k in W) {
          try {
            if (/^webpack/i.test(k) && W[k] && typeof W[k].push === 'function' && W[k].length) out.push(W[k]);
          } catch (eI) {}
        }
        return out;
      } catch (e) { return []; }
    }
    function captureViaShim(arr) {
      var captured = null;
      try {
        arr.push([[Math.floor(Math.random() * 1e9) + 1], {}, function () {
          if (captured) return;
          for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            try {
              if (typeof a === 'function' && a.c) { captured = a; return; }
              if (a && typeof a === 'object' && typeof a.c === 'object' && typeof a.m === 'object') { captured = a; return; }
            } catch (e) {}
          }
          for (var j = arguments.length - 1; j >= 0; j--) {
            try { if (typeof arguments[j] === 'function') { captured = arguments[j]; return; } } catch (e2) {}
          }
        }]);
      } catch (eP) {}
      return captured;
    }
    function fnMatches(name, re) {
      try { return re.test(String(name)); } catch (e) { return false; }
    }
    function walkManagers(req) {
      var cache = null;
      try { cache = req.c; } catch (e0) { cache = null; }
      if (!cache) return false;
      var openFns = [];
      var histFns = [];
      var seen = 0;
      try {
        for (var k in cache) {
          if (seen >= MOD_CACHE_CAP) break;
          var exp;
          try { exp = cache[k] && cache[k].exports; } catch (e1) { continue; }
          seen++; // counts every walked cache entry, hit or miss (cap is honest)
          if (!exp || typeof exp !== 'object') continue;
          var probe = [exp];
          try { if (exp.default && exp.default !== exp && typeof exp.default === 'object') probe.push(exp.default); } catch (e2) {}
          for (var p = 0; p < probe.length; p++) {
            var o = probe[p];
            for (var fn in o) {
              try {
                if (typeof o[fn] !== 'function') continue;
                if (!openFns.length && fnMatches(fn, /^open(chat|peer|dialog)/i)) openFns.push({ obj: o, fn: fn });
                else if (!histFns.length && fnMatches(fn, /^gethistory|^loadhistory/i)) histFns.push({ obj: o, fn: fn });
              } catch (e3) {}
            }
            if (openFns.length && histFns.length) break;
          }
          if (openFns.length && histFns.length) break;
        }
      } catch (eW) {}
      RUNTIME.openFns = openFns.slice(0, 3);
      RUNTIME.histFns = histFns.slice(0, 3);
      return RUNTIME.openFns.length > 0;
    }
    function probeRuntime(force) {
      if (RUNTIME.ok && !force) return W.Promise.resolve(true);
      var now = Date.now();
      if (!force && now - RUNTIME.lastTry < PROBE_RETRY_MS) return W.Promise.resolve(false);
      RUNTIME.lastTry = now;
      if (wkLive()) {
        // T1 4: the Web K window managers ARE the module tier; the webpack
        // hunt below exists for clients that hide their runtime. Web K does
        // not. openFns stay empty so openChat skips straight to its tiers.
        RUNTIME.ok = true;
        HEALTH.modules = true;
        return W.Promise.resolve(true);
      }
      return new W.Promise(function (resolve) {
        var settled = false;
        var timer = W.setTimeout(function () {
          if (settled) return; settled = true;
          RUNTIME.ok = false; HEALTH.modules = false;
          resolve(false);
        }, PROBE_TIMEOUT);
        var finish = function (ok) {
          if (settled) return; settled = true;
          try { W.clearTimeout(timer); } catch (eT) {}
          RUNTIME.ok = ok;
          HEALTH.modules = ok;
          resolve(ok);
        };
        try {
          var arrs = chunkArrays();
          for (var i = 0; i < arrs.length; i++) {
            var req = captureViaShim(arrs[i]);
            if (!req) continue;
            try { RUNTIME.req = req; } catch (eSt) {}
            try {
              if (walkManagers(req)) { finish(true); return; }
            } catch (eWk) {}
          }
          finish(false);
        } catch (eP) { finish(false); }
      });
    }

    // ============================ Web K runtime globals (T1: notes\research\T-TELEGRAM-WEB.md) ============================
    // T1 landed: Web K mounts its whole app runtime on window (MOUNT_CLASS_TO)
    // and its own Playwright e2e suite drives the live client through those
    // globals, so they are the sanctioned surface, tier 0 for every data path.
    //   appImManager.setInnerPeer({peerId}) opens a chat (e2e-documented)
    //   appDialogsManager owns the chat list; rootScope is the app event bus
    //   apiManagerProxy / rootScope.managers front the worker-held managers
    //   (the full message cache lives in the Shared Worker, NOT in IDB)
    //   the composer is Tiptap 3.31.3: InputField.setValueSilently(text, entities)
    // Everything here is a property read or one documented call; absence
    // degrades silently to the IDB / DOM tiers.
    function wkGlobals() {
      try {
        return {
          im: W.appImManager || null,
          dialogsMgr: W.appDialogsManager || null,
          root: W.rootScope || null,
          api: W.apiManagerProxy || null
        };
      } catch (e) { return { im: null, dialogsMgr: null, root: null, api: null }; }
    }
    function wkLive() {
      var g = wkGlobals();
      return !!(g.im || g.dialogsMgr || g.root);
    }
    // canonical chatId == the tweb peerId string (bare user id, -group,
    // -100channel; peerKeyOf law). Rows carry it as data-peer-id and the
    // dialogs store keys by it, so one id space spans every tier.
    function wkPid(chatId) {
      try {
        var s = String(chatId == null ? '' : chatId).trim();
        if (!s) return '';
        if (s.charAt(0) === 'u' || s.charAt(0) === 'p') s = s.slice(1);
        else if (s.charAt(0) === 'c') s = '-100' + s.slice(1);
        var m = s.match(/^(-?\d+)/);
        return m ? m[1] : '';
      } catch (e) { return ''; }
    }
    function domRowByPid(pid) {
      // T1 2.1: rows are li.chatlist-chat with data-peer-id. The attribute
      // carries tweb-internal ids (no -100 marker) while our chatId is
      // MTProto-marked, so the compare runs through wkPeerNum (exact
      // numeric equality in tweb's own space; NO substring fuzz -- a
      // wrong-row click is worse than no row)
      try {
        if (!pid) return null;
        var want = wkPeerNum(pid);
        var els = qsa('.chatlist-chat[data-peer-id]');
        var rows2 = domChatRows();
        for (var i = 0; i < els.length; i++) {
          try {
            var rid = els[i].getAttribute('data-peer-id') || '';
            var hit = rid === pid;
            if (!hit && isFinite(want)) hit = (wkPeerNum(rid) === want);
            if (hit) {
              for (var r = 0; r < rows2.length; r++) {
                if (rows2[r].el === els[i]) return rows2[r];
              }
            }
          } catch (eR) {}
        }
      } catch (e) { return null; }
      return null;
    }
    function wkPeerNum(chatId) {
      // tweb-internal NUMERIC peerId (peerIdPolyfill, tweb master): users
      // are positive ids; BOTH basic groups and channels are -abs(id) --
      // there is no -100 marker in tweb's space. Our canonical id is
      // MTProto-marked, so the channel marker is stripped. Tolerates the
      // 'u123'/'c123' string forms too (getPeerId accepts them).
      try {
        var s = String(chatId == null ? '' : chatId).trim();
        if (!s) return NaN;
        var neg = false;
        if (s.charAt(0) === 'u' || s.charAt(0) === 'p') s = s.slice(1);
        else if (s.charAt(0) === 'c') { neg = true; s = s.slice(1); }
        var m = s.match(/^(-?)(\d+)/);
        if (!m) return NaN;
        if (m[1] === '-') neg = true;
        var digits = m[2];
        // strip the -100 channel marker ONLY in the marked negative form
        // (marked ids are 1e12-family: '100' + a >= 10-digit channel id)
        if (neg && digits.length > 10 && digits.indexOf('100') === 0) digits = digits.slice(3);
        var n = parseInt(digits, 10);
        return neg ? -n : n;
      } catch (e) { return NaN; }
    }
    function wkMsgsManager() {
      // the worker-held managers reach the tab through rootScope.managers
      // (and its .all bundle) and apiManagerProxy (T1 4); every candidate
      // found is tried, first hit wins
      var g = wkGlobals();
      var out = [];
      try { if (g.root && g.root.managers && g.root.managers.appMessagesManager) out.push(g.root.managers.appMessagesManager); } catch (e) {}
      try { if (g.root && g.root.managers && g.root.managers.all && g.root.managers.all.appMessagesManager) out.push(g.root.managers.all.appMessagesManager); } catch (eA) {}
      try { if (g.api && g.api.appMessagesManager) out.push(g.api.appMessagesManager); } catch (e2) {}
      return out;
    }
    async function wkReadHistory(pid, lim) {
      // T1 3.2/5 + tweb master (fetched 2026-11-22): message bodies live in
      // the worker memory cache, not in IDB. The LIVE contract is
      //   getHistory({peerId: <number>, limit: n})
      //     -> {count, history: ['peerId_mid' strings], isEnd, offsetIdOffset}
      // ('messages' is only filled for isCacheableSearch) and bodies come
      // per-mid from getMessageByPeer(peerId, mid), async over the tab
      // proxy. The marked/string rungs stay as tolerance. One shared
      // budget, read-only, silent miss, never throws. An UNFETCHED chat
      // makes the manager do its own sanctioned history request -- the
      // same read the app performs when a human opens the chat.
      if (!pid) return [];
      var mgrs = wkMsgsManager();
      if (!mgrs.length) return [];
      var num = wkPeerNum(pid);
      var deadline = Date.now() + WK_HIST_TOTAL_MS;
      for (var m = 0; m < mgrs.length; m++) {
        var mgr = mgrs[m];
        try { if (typeof mgr.getHistory !== 'function') continue; } catch (eC) { continue; }
        var shapes = [];
        if (isFinite(num)) {
          shapes.push({ peerId: num, limit: lim });            // the master contract
          shapes.push({ peerId: String(num), limit: lim });    // numeric string (isPeerId-legal)
        }
        shapes.push({ peerId: pid, limit: lim });              // marked string tolerance
        for (var s = 0; s < shapes.length; s++) {
          if (Date.now() >= deadline) return [];
          var res = null;
          try {
            var p = mgr.getHistory(shapes[s]);
            if (p && typeof p.then === 'function') res = await raceDeadline(p, deadline);
            else res = p;
          } catch (eP) { continue; }
          var out = await wkHistoryToRows(mgr, res, num, lim);
          if (out.length) return out;
        }
      }
      return [];
    }
    async function wkHistoryToRows(mgr, res, num, lim) {
      // maps every history result shape to our rows: (a) the master
      // contract -- history = mid strings, bodies via getMessageByPeer;
      // (b) {messages: [...]} array (cached search / older builds);
      // (c) a Map container (survives the structured-clone mirror);
      // (d) a bare array of message records. Shape-gated, silent miss.
      // Acceptance is >= 1 row: the old > 1 gate rejected honest
      // single-message chats.
      var msgs = null;
      try {
        if (Array.isArray(res)) msgs = res;
        else if (res && Array.isArray(res.messages)) msgs = res.messages;
        else if (res && res.messages && typeof res.messages.forEach === 'function' && typeof res.messages.get === 'function') {
          msgs = [];
          res.messages.forEach(function (x) { if (msgs.length < MSG_CAP) msgs.push(x); });
        }
      } catch (eR) { msgs = null; }
      var out = [];
      if (msgs) {
        for (var i = 0; i < msgs.length && out.length < MSG_CAP; i++) {
          try { if (msgs[i] && looksLikeMessage(msgs[i])) out.push(mapMsg(msgs[i], i)); } catch (eM) {}
        }
        if (lim && out.length > lim) out = out.slice(out.length - lim);
        return out;
      }
      try {
        if (res && Array.isArray(res.history) && typeof mgr.getMessageByPeer === 'function') {
          var pidNum = num;
          for (var h = 0; h < res.history.length && out.length < MSG_CAP; h++) {
            var hs = String(res.history[h]);
            var midNum = NaN;
            var pidUse = pidNum;
            var us = hs.indexOf('_');
            if (us >= 0) {
              midNum = parseInt(hs.slice(us + 1), 10);
              var pp = parseInt(hs.slice(0, us), 10);
              if (isFinite(pp) && pp !== 0) pidUse = pp; // full mids carry their own pid
            } else {
              midNum = parseInt(hs, 10);
            }
            if (!isFinite(midNum)) continue;
            var rec = null;
            try {
              var gp = mgr.getMessageByPeer(pidUse, midNum);
              if (gp && typeof gp.then === 'function') gp = await raceDeadline(gp, Date.now() + 800);
              rec = gp;
            } catch (eG) { rec = null; }
            try { if (rec && looksLikeMessage(rec)) out.push(mapMsg(rec, out.length)); } catch (eM2) {}
          }
        }
      } catch (eH) {}
      if (lim && out.length > lim) out = out.slice(out.length - lim);
      return out;
    }
    function wkDialogRecords() {
      // named-prop probe only (no generic key walks, no side-effecty scans):
      // an in-memory dialogs cache exposed on the window managers, arrays or
      // Maps, shape-checked with looksLikeDialog. Absence is silent and the
      // IDB tier (which serves the roster today) keeps the load.
      var g = wkGlobals();
      var holders = [g.dialogsMgr, g.root].concat(wkMsgsManager());
      var names = ['dialogs', 'orderedDialogs', 'dialogsStorage'];
      var out = [];
      for (var h = 0; h < holders.length && out.length < ROSTER_CAP; h++) {
        var holder = holders[h];
        if (!holder || typeof holder !== 'object') continue;
        for (var n = 0; n < names.length; n++) {
          var v;
          try { v = holder[names[n]]; } catch (eV) { continue; }
          var vals = null;
          if (Array.isArray(v)) vals = v;
          else if (v && typeof v.forEach === 'function' && typeof v.get === 'function') {
            vals = [];
            try { v.forEach(function (x) { if (vals.length < ROSTER_CAP) vals.push(x); }); } catch (eM) { vals = null; }
          }
          if (!vals || !vals.length) continue;
          var dlg = 0;
          for (var s2 = 0; s2 < vals.length && s2 < 5; s2++) { if (looksLikeDialog(vals[s2])) dlg++; }
          if (dlg >= Math.min(2, vals.length)) {
            for (var p2 = 0; p2 < vals.length && out.length < ROSTER_CAP; p2++) out.push(vals[p2]);
          }
        }
      }
      return out;
    }
    function wkComposerApi() {
      // T1 6: the composer is Tiptap on ProseMirror and setValueSilently is
      // the documented first-class setter on the InputField. Ladder from
      // appImManager.chat; property reads only; silent miss.
      var g = wkGlobals();
      var seeds = [];
      try {
        if (g.im && g.im.chat) {
          seeds.push(g.im.chat.input, g.im.chat.appInputPanel, g.im.chat.inputPanel, g.im.chat.richMessageInput);
        }
      } catch (e) {}
      for (var i = 0; i < seeds.length; i++) {
        var seed = seeds[i];
        if (!seed || typeof seed !== 'object') continue;
        var probe = [seed];
        var subs = ['inputField', 'richMessageInput', 'input', 'editor'];
        for (var k = 0; k < subs.length; k++) {
          try { if (seed[subs[k]] && typeof seed[subs[k]] === 'object') probe.push(seed[subs[k]]); } catch (eS) {}
        }
        for (var p = 0; p < probe.length; p++) {
          try { if (probe[p] && typeof probe[p].setValueSilently === 'function') return probe[p]; } catch (eF) {}
          try { if (probe[p] && probe[p].inputField && typeof probe[p].inputField.setValueSilently === 'function') return probe[p].inputField; } catch (eI) {}
        }
      }
      return null;
    }
    async function wkSetComposerText(api, text) {
      // documented setter, then the EXACT-match verify law against the DOM
      try { api.setValueSilently(text); }
      catch (eS1) {
        try { api.setValueSilently(text, []); } catch (eS2) { return false; }
      }
      var want = normWs(text);
      return !!(await pollUntil(Date.now() + 700, function () {
        var box = getComposer();
        return (box && composerText(box) === want) ? true : null;
      }, 80));
    }

    // ============================ strict open-chat DOM reader (tier 1) ============================
    // T1 2.2, verified on tweb master 2026-11-22 (bubbles.ts): every
    // message bubble is .bubble[data-mid][data-peer-id][data-timestamp],
    // .is-out marks outgoing, .time carries the rendered clock; date
    // separators are .is-date and sponsored bubbles .is-sponsored (their
    // own queries skip both -- so do we). Serves ONLY the chat the engine
    // opened (setInnerPeer / row-click win) and WAITS OUT the async
    // history render before concluding empty: the no-wait race is what
    // emptied every read while the pane was still loading.
    function bubbleKindOf(b, cls) {
      try {
        if (/(^|\s)service(\s|$)/.test(cls) || b.querySelector('.service-msg')) return 'system';
        if (b.querySelector('.document-container, .media-sticker-wrapper, .media-gif-wrapper, .audio, .media-round, img.photo, video, .link-container')) return 'media-placeholder';
      } catch (e) {}
      return 'text';
    }
    function bubbleTextOf(b) {
      // prefer the dedicated text element; else the bubble's own text with
      // the clock, reply-quote and media chrome stripped (clone, never the
      // live node)
      try {
        for (var i = 0; i < BUBBLE_TEXT_CHAIN.length; i++) {
          var tEl = b.querySelector(BUBBLE_TEXT_CHAIN[i]);
          if (tEl) {
            var t = normWs(tEl.innerText != null ? tEl.innerText : tEl.textContent);
            if (t) return t;
          }
        }
      } catch (eC) {}
      try {
        var clone = b.cloneNode(true);
        var strip = clone.querySelectorAll('.time, [class*="time"], .reply, .replies-element, .document-container, .media-sticker-wrapper, .media-gif-wrapper, .audio, .media-round, svg');
        for (var s = 0; s < strip.length; s++) {
          try { if (strip[s].parentNode) strip[s].parentNode.removeChild(strip[s]); } catch (eR) {}
        }
        return normWs(clone.textContent);
      } catch (eT) { return ''; }
    }
    function readOpenBubbles(pid) {
      // pure read of the rendered bubble window (visible + scrolled):
      // Web K virtualizes, so what exists in the DOM IS the readable slice
      var out = [];
      try {
        var scope = chainFirst(MSG_SCROLLER_CHAIN);
        if (!scope) return out;
        var bubbles = qsa('.bubble[data-mid]:not(.is-date):not(.is-sponsored)', scope);
        for (var i = 0; i < bubbles.length && i < MSG_CAP * 2; i++) {
          try {
            var b = bubbles[i];
            var mid = String(b.getAttribute('data-mid') || '');
            if (!mid) continue;
            var ts = 0;
            try { ts = parseInt(b.getAttribute('data-timestamp'), 10) || 0; } catch (eT) {} // seconds epoch
            var cls = ' ' + String(b.className || '') + ' ';
            var fromMe = /(^|\s)is-out(\s|$)/.test(cls);
            var bPid = '';
            try { bPid = String(b.getAttribute('data-peer-id') || ''); } catch (eG) {}
            var kind = bubbleKindOf(b, cls);
            var row = { id: mid, fromMe: fromMe, text: bubbleTextOf(b), ts: ts, kind: kind, pid: bPid };
            if (kind === 'media-placeholder') row.mId = mid; // mId for getMedia
            out.push(row);
          } catch (eB) {}
        }
        // peer gate that can never empty an honest read: pids exist AND at
        // least one matches (raw, or numerically in tweb's internal space)
        // -> keep exactly those; total id-space drift -> the gate drops
        // itself rather than lie
        if (pid && out.length) {
          var wantN = wkPeerNum(pid);
          var pidRows = 0;
          var matchRows = 0;
          var q;
          for (q = 0; q < out.length; q++) {
            if (out[q].pid) {
              pidRows++;
              if (out[q].pid === pid || (isFinite(wantN) && wkPeerNum(out[q].pid) === wantN)) matchRows++;
            }
          }
          if (pidRows && matchRows) {
            var kept = [];
            for (var k = 0; k < out.length; k++) {
              if (!out[k].pid || out[k].pid === pid || (isFinite(wantN) && wkPeerNum(out[k].pid) === wantN)) kept.push(out[k]);
            }
            out = kept;
          }
        }
      } catch (eS) {}
      return out;
    }
    async function domOpenChatMessages(pid, lim) {
      // tier 1: ONLY the chat the engine opened, and only while the pane
      // is live; waits out the async history render, then maps ascending
      if (!lastOpenedChatId) return [];
      if (!openEvidence()) return [];
      var deadline = Date.now() + MSG_RENDER_WAIT_MS;
      var rows = readOpenBubbles(pid);
      while (!rows.length && Date.now() < deadline) {
        await sleep(120);
        rows = readOpenBubbles(pid);
      }
      if (!rows.length) return [];
      rows.sort(function (a, b) { return a.ts - b.ts; });
      if (lim && rows.length > lim) rows = rows.slice(rows.length - lim);
      return rows;
    }
    function openBubblesForRead() {
      // growth probes + delivery ack: strict reader first, legacy fuzzy
      // reader as the fallback rung (same counts either way)
      try {
        var rows = readOpenBubbles('');
        if (rows.length) return rows;
      } catch (eS) {}
      try { return domBubbles(); } catch (eD) { return []; }
    }

    // ============================ open-state belief ============================
    // lastOpenedChatId: the chatId of the most recent openChat that returned
    // ok:true during this injection's lifetime. The engine view is
    // permanently covered (no human clicks it), so our own opens are the
    // only actors; a page reload wipes the scope and the belief with it.
    var lastOpenedChatId = '';

    // ============================ composer / send button ============================
    var COMPOSER_TIER = 0;
    function getComposer() {
      COMPOSER_TIER = 0;
      for (var i = 0; i < COMPOSER_CHAIN.length; i++) {
        try {
          var el = D.querySelector(COMPOSER_CHAIN[i]);
          if (el && laidOut(el)) { COMPOSER_TIER = i + 1; return el; }
        } catch (e) {}
      }
      return null;
    }
    function composerLive() {
      try { return !!getComposer(); } catch (e) { return false; }
    }
    function composerText(box) {
      try { return normWs(box.innerText != null ? box.innerText : box.textContent); }
      catch (e) { return ''; }
    }
    function chatPanelLive() {
      try {
        if (qsa('.bubbles, .bubbles-inner').length) return true;
        var c = chainFirst(MSG_SCROLLER_CHAIN);
        return !!(c && (c.children && c.children.length));
      } catch (e) { return false; }
    }
    function openEvidence() {
      return composerLive() && chatPanelLive();
    }

    var BTN_TIER = 0;
    function findTextSendButton() {
      BTN_TIER = 0;
      for (var i = 0; i < SEND_BTN_CHAIN.length; i++) {
        try {
          var list = qsa(SEND_BTN_CHAIN[i]);
          for (var j = 0; j < list.length; j++) {
            var b = list[j];
            // NEVER the voice-note button: skip record/mic/voice families
            try {
              var cls = String(b.className || '') + ' ' + String(b.getAttribute('aria-label') || '');
              if (VOICE_RE.test(cls)) continue;
              var svg = b.querySelector('svg');
              if (svg && VOICE_RE.test(String(svg.className && svg.className.baseVal || svg.className || ''))) continue;
            } catch (eV) {}
            try {
              if (b.disabled) continue;
              if (b.getAttribute('aria-hidden') === 'true') continue;
              if (b.getAttribute('aria-disabled') === 'true') continue;
              if (!laidOut(b)) continue;
            } catch (eG) { continue; }
            BTN_TIER = i + 1;
            return b;
          }
        } catch (eS) {}
      }
      return null;
    }

    // ============================ insert / clear (legacy synthetic, verified) ============================
    var INSERT_FALLBACK = false;
    function selectAllIn(box) {
      try {
        var sel = W.getSelection();
        if (!sel || typeof sel.removeAllRanges !== 'function') return false;
        var range = D.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      } catch (e) { return false; }
    }
    function insertViaSelection(box, text) {
      INSERT_FALLBACK = false;
      try {
        box.focus();
      } catch (eF) {}
      if (!selectAllIn(box)) return false;
      var ok = false;
      try { ok = D.execCommand('insertText', false, text); } catch (eE) { ok = false; }
      if (ok && composerText(box) === normWs(text)) return true;
      // fallback: input event dispatch (weak, but some builds read it)
      INSERT_FALLBACK = true;
      try {
        var ev = new W.InputEvent('input', { bubbles: true, cancelable: false, data: text, inputType: 'insertText' });
        box.dispatchEvent(ev);
      } catch (eD) {}
      return composerText(box) === normWs(text);
    }
    function clearViaSelection(box) {
      try {
        box.focus();
      } catch (eF) {}
      if (!selectAllIn(box)) return false;
      var ok = false;
      try { ok = D.execCommand('insertText', false, ''); } catch (eE) { ok = false; }
      if (ok && !composerText(box)) return true;
      try {
        var ev = new W.InputEvent('input', { bubbles: true, cancelable: false, data: '', inputType: 'deleteContentBackward' });
        box.dispatchEvent(ev);
      } catch (eD) {}
      return !composerText(box);
    }

    // ============================ impl: ready / health ============================
    async function readyImpl() {
      var idbOk = false;
      try { idbOk = await probeIdb(false); } catch (eI) { idbOk = false; }
      if (idbOk) return true;
      // IDB silent (not logged in yet, or an unclassified schema): the DOM
      // tier can still serve listChats honestly
      return domChatListLive();
    }

    // ============================ impl: listChats ============================
    async function listChatsImpl() {
      try {
        var idbOk = await probeIdb(false);
        var out = [];
        var seen = {};
        // tier 0 (T1 4): an in-memory dialogs cache on the window managers,
        // if Web K exposes one in the tab; silent miss expected and fine
        try {
          var wkRecs = wkDialogRecords();
          for (var w = 0; w < wkRecs.length; w++) pushDialog(out, seen, wkRecs[w], {}, {});
        } catch (eW) {}
        if (out.length) tail('list: wk tier 0 rows ' + out.length);
        if (idbOk && IDB.dialogs) {
          // NAME JOIN (the E1 fix): dialog records reference user/chat ids
          // and the names live in the users/chats stores keyed by '' + id
          // (T1 3.1). The old join sampled the first 500 records of each
          // store -- on a 13k-dialog account almost every id was outside
          // the sample and every title came back empty. Now: read the
          // dialogs FIRST, then resolve names by TARGETED single-key gets
          // for exactly the ids the roster needs (wide value-scan maps
          // stay as the fallback for stores with odd key formats).
          // F1: read dialogs WITH their store keys via the capped cursor walk.
          // getAll dropped the key -- and the key IS the canonical '' + peerId,
          // the join's ground truth when a record's own peer fields are absent.
          // getAll is also one all-or-nothing deserialize of a 13k-record
          // store under a 2 s timeout; a cursor streams and resolves whatever
          // it collected when the budget ends.
          var recs = [];
          await idbWalk(IDB.dialogs, DIALOG_SCAN_CAP, function (val, key) {
            try {
              if (Array.isArray(val)) {
                for (var a = 0; a < val.length; a++) recs.push({ rec: val[a], key: key });
              } else recs.push({ rec: val, key: key });
            } catch (eD2) {}
          }, IDB_TX_MS * 4);
          var usersById = {};
          var chatsById = {};
          if (IDB.users) {
            var us = await idbGetAll(IDB.users, NAME_SAMPLE_CAP);
            for (var i = 0; i < us.length; i++) {
              try {
                var u = us[i];
                if (u && typeof u.id !== 'undefined') {
                  var un = userName(u);
                  if (un) usersById[String(u.id)] = un;
                }
              } catch (eU) {}
            }
          }
          if (IDB.chats) {
            var cs = await idbGetAll(IDB.chats, NAME_SAMPLE_CAP);
            for (var c = 0; c < cs.length; c++) {
              try {
                var ch = cs[c];
                if (ch && typeof ch.id !== 'undefined' && typeof ch.title === 'string') {
                  chatsById[String(ch.id)] = normWs(ch.title);
                }
              } catch (eC) {}
            }
          }
          // the ids the roster will actually need
          var needUser = {};
          var needChat = {};
          for (var p0 = 0; p0 < recs.length; p0++) {
            var rid = dialogId(recs[p0].rec) || keyToChatId(recs[p0].key);
            if (!rid) continue;
            var mc = rid.match(/^-100(\d+)$/) || rid.match(/^-(\d+)$/);
            if (mc) {
              needChat[String(parseInt(mc[1], 10))] = true; // kills -100 markers / padding
              needChat[digitsOnly(rid)] = true;
            } else {
              needUser[digitsOnly(rid)] = true;
            }
          }
          // targeted gets: '' + id keys (T1 3.1), BATCHED -- one readonly
          // transaction per 60-key chunk (was one transaction per key:
          // hundreds of serialized round-trips per roster pass). The
          // record-id sanity check is digits-tolerant, so marker/padding
          // drift between our chatId space and the store key can never
          // mislabel: digits-only equality still pins the record.
          var gets = 0;
          var nameKeyOf = function (k) { return NAME_KEY_MODE === 'num' ? Number(k) : k; };
          var tryGet = async function (store, map, keys, isUser) {
            for (var c = 0; c < keys.length && gets < NAME_GET_CAP; c += 60) {
              var take = Math.min(60, keys.length - c, NAME_GET_CAP - gets);
              if (take <= 0) break;
              var chunk = keys.slice(c, c + take).map(nameKeyOf);
              gets += take;
              var vals = await idbGetMany(store, chunk);
              for (var v = 0; v < vals.length; v++) {
                try {
                  var k2 = keys[c + v];
                  var val = vals[v];
                  if (!k2 || !val || map[k2]) continue;
                  var idOk = (typeof val.id === 'undefined') || (digitsOnly(String(val.id)) === digitsOnly(k2));
                  if (!idOk) continue; // a foreign record under this key: skip, never mislabel
                  if (isUser) {
                    var nm2 = userName(val);
                    if (nm2) map[k2] = nm2;
                  } else if (typeof val.title === 'string' && normWs(val.title)) {
                    map[k2] = normWs(val.title);
                  }
                } catch (eV2) {}
              }
            }
          };
          if (IDB.users) await tryGet(IDB.users, usersById, Object.keys(needUser), true);
          if (IDB.chats) await tryGet(IDB.chats, chatsById, Object.keys(needChat), false);
          // F1 key-format drift guard (failure mode a): if the bare-digit
          // pass total-missed on a real sample, this build's name-store keys
          // are not '' + id strings -- probe the number-keyed form once; if
          // numbers hit, latch the mode for this page session and redo the
          // join in that space. The latch makes the retry exactly once.
          if (NAME_KEY_MODE !== 'num' && IDB.users) {
            var needTried = Object.keys(needUser).length + Object.keys(needChat).length;
            var gotNames = 0;
            for (var gk in usersById) gotNames++;
            for (var gk2 in chatsById) gotNames++;
            if (needTried >= 20 && !gotNames) {
              var driftKeys = Object.keys(needUser).slice(0, 10).map(function (x) { return Number(x); });
              if (driftKeys.length >= 3) {
                var driftVals = await idbGetMany(IDB.users, driftKeys);
                var numHit = 0;
                for (var dv = 0; dv < driftVals.length; dv++) {
                  if (driftVals[dv] && driftVals[dv]._ === 'user') numHit++;
                }
                if (numHit >= 3) {
                  NAME_KEY_MODE = 'num';
                  tail('list: name keys num-mode');
                  return await listChatsImpl();
                }
              }
            }
          }
          for (var d3 = 0; d3 < recs.length; d3++) {
            pushDialog(out, seen, recs[d3].rec, usersById, chatsById, keyToChatId(recs[d3].key));
          }
          out.sort(function (x, y) { return y.t - x.t; });
          if (out.length > ROSTER_CAP) out.length = ROSTER_CAP;
        }
        // DOM tier: BACKFILLS titles the IDB join missed (the rendered
        // .dialog-title .user-title IS the real name), floors unread, and
        // adds rows the IDB tier never had. pid match first (through
        // wkPeerNum: the attribute carries tweb-internal ids, ours are
        // marked), title match second -- never a duplicate row.
        try {
          var rows = domChatRows();
          var byId = {};
          var byNum = {};
          var byTitle = {};
          for (var o = 0; o < out.length; o++) {
            if (out[o].chatId) {
              byId[out[o].chatId] = out[o];
              var on = wkPeerNum(out[o].chatId);
              if (isFinite(on)) byNum[on] = out[o];
            }
            if (out[o].title) byTitle[out[o].title.toLowerCase()] = out[o];
          }
          for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var hit = null;
            if (row.pid) {
              var rowPidN = wkPeerNum(row.pid);
              hit = byId[row.pid] || (isFinite(rowPidN) ? byNum[rowPidN] : null) || null;
            }
            if (!hit) hit = byTitle[row.title.toLowerCase()] || null;
            if (hit) {
              if (!hit.title && row.title) hit.title = row.title; // the REAL name, rendered
              if (row.unread > hit.unread) hit.unread = row.unread;
            } else {
              var seenKey2 = row.pid || row.title.toLowerCase();
              if (!seen[seenKey2]) {
                seen[seenKey2] = true;
                out.push({ chatId: row.pid, title: row.title, unread: row.unread, t: 0, archived: false });
              }
            }
          }
          out.sort(function (x2, y2) { return y2.t - x2.t; }); // t=0 rows sink; stable enough
          if (out.length > ROSTER_CAP) out.length = ROSTER_CAP;
        } catch (eDom) {}
        if (out.length) tail('list: rows ' + out.length + ' tier ' + (idbOk ? 1 : 2));
        return out;
      } catch (eL) {
        noteError('listChats', eL);
        return [];
      }
    }
    function pushDialog(out, seen, rec, usersById, chatsById, keyId) {
      try {
        if (!looksLikeDialog(rec)) return;
        // F1: the store key ('' + peerId) is the id fallback -- a persisted
        // record that predates tweb's dialog.peerId assignment still joins
        var id = dialogId(rec) || (typeof keyId === 'string' ? keyId : '');
        if (!id) return;
        if (seen[id]) return;
        seen[id] = true;
        var title = '';
        var digits = digitsOnly(id);
        // join: user dialogs by user id; group/channel dialogs by chat id.
        // parseInt normalization kills -100 markers and zero padding so
        // the marked, internal (-abs, no marker) and raw forms all hit
        // the same map
        var m = id.match(/^-100(\d+)$/) || id.match(/^-(\d+)$/);
        if (m) {
          title = chatsById[m[1]] || chatsById[String(parseInt(m[1], 10))] || chatsById[digits] || '';
        } else if (digits && usersById[digits]) {
          title = usersById[digits];
        }
        if (!title && typeof rec.title === 'string') title = normWs(rec.title);
        var unread = 0;
        try {
          if (typeof rec.unread_count === 'number' && rec.unread_count > 0) unread = rec.unread_count;
          else if (rec.pFlags && rec.pFlags.unread) unread = 1;
        } catch (eU) {}
        var archived = false;
        try {
          if (rec.pFlags && rec.pFlags.archived) archived = true;
          else if (rec.folder_id === 1) archived = true; // the Archive folder
        } catch (eA) {}
        // F1: MTProto dialogs carry no date; tweb's persisted record embeds
        // topMessage (assigned in the same save pass that writes the store,
        // dialogsStorage.ts), so its date seconds is the real recency signal
        var tmDate = 0;
        try { if (rec.topMessage && typeof rec.topMessage.date === 'number') tmDate = rec.topMessage.date; } catch (eTm) {}
        var t = firstNum(rec.date, rec.top_date, tmDate, rec.t);
        out.push({ chatId: id, title: title, unread: unread, t: t, archived: archived });
      } catch (eP) {}
    }

    // ============================ impl: getContact ============================
    async function getContactImpl(chatId) {
      var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
      if (!id) return null;
      try {
        var idbOk = await probeIdb(false);
        if (idbOk) {
          if (IDB.users) {
            // targeted single-key get first ('' + id keys, T1 3.1): the
            // old sample scan missed any user outside the first 500 rows
            var dg0 = digitsOnly(id);
            var ug = null;
            try { ug = await idbGetKey(IDB.users, dg0); } catch (eG0) { ug = null; }
            if (ug && looksLikeUser(ug) && digitsOnly(String(ug.id)) === dg0) {
              var nm0 = userName(ug);
              var ph0 = '';
              if (typeof ug.phone === 'string' && ug.phone) ph0 = '+' + digitsOnly(ug.phone);
              if (nm0 || ph0) return { name: nm0 || ph0, phone: ph0 || null };
            }
            var us = await idbGetAll(IDB.users, ROSTER_CAP);
            for (var i = 0; i < us.length; i++) {
              var u = us[i];
              if (!u || typeof u.id === 'undefined') continue;
              if (String(u.id) === id || digitsOnly(u.id) === digitsOnly(id)) {
                var nm = userName(u);
                var ph = '';
                if (typeof u.phone === 'string' && u.phone) ph = '+' + digitsOnly(u.phone);
                if (nm || ph) return { name: nm || ph, phone: ph || null };
              }
            }
          }
          if (IDB.chats) {
            var cs = await idbGetAll(IDB.chats, ROSTER_CAP);
            for (var c = 0; c < cs.length; c++) {
              var ch = cs[c];
              if (!ch || typeof ch.id === 'undefined') continue;
              if (keyMatchesChat(String(ch.id), id) && typeof ch.title === 'string') {
                return { name: normWs(ch.title), phone: null }; // groups/channels carry no phone
              }
            }
          }
        }
        return null;
      } catch (eG) {
        noteError('getContact', eG);
        return null;
      }
    }

    // ============================ impl: getMessages ============================
    var MSGCACHE = {};
    function cacheKey(id, lim) { return id + '#' + lim; }
    async function idbReadMessages(id, lim) {
      // two store shapes tolerated: (a) flat message records with a peer
      // field, (b) keyed-by-chat entries holding arrays
      var rows = [];
      for (var s = 0; s < IDB.msgs.length; s++) {
        var store = IDB.msgs[s];
        var matched = 0;
        await idbWalk(store, MSG_SCAN_CAP, function (val, key) {
          try {
            if (!val || typeof val !== 'object') return true;
            var peer = msgPeerId(val);
            var hit = false;
            if (peer) hit = (peer === id) || keyMatchesChat(peer, id);
            if (!hit && key !== undefined) hit = !peer && keyMatchesChat(String(key), id);
            if (!hit) return true;
            if (looksLikeMessage(val)) { rows.push(val); matched++; }
            if (matched >= lim * 3) return false; // enough raw; sliced after sort
          } catch (eV) {}
          return true;
        }, IDB_TX_MS * 2);
        if (rows.length) break; // first message store that yields wins
      }
      var mapped = [];
      for (var i = 0; i < rows.length; i++) {
        try { if (rows[i]) mapped.push(mapMsg(rows[i], i)); } catch (eM) {}
      }
      return mapped;
    }
    function domBubbles(onlyPeer) {
      var out = [];
      try {
        var scope = chainFirst(MSG_SCROLLER_CHAIN);
        if (!scope) return out;
        // T1 2.2: .bubble with data-mid / data-peer-id / data-timestamp is
        // the Web K contract; the fuzzy chains stay as fallback rungs only
        var bubbles = qsa('.bubble[data-mid]', scope);
        if (!bubbles.length) bubbles = qsa(BUBBLE_CHAIN[0], scope);
        if (!bubbles.length) bubbles = qsa('[class*="bubble"]', scope);
        var now = Date.now() / 1000;
        for (var i = 0; i < bubbles.length && i < MSG_CAP * 2; i++) {
          try {
            var b = bubbles[i];
            var bPid = '';
            try { bPid = String(b.getAttribute('data-peer-id') || ''); } catch (eG) {}
            var cls = ' ' + String(b.className || '') + ' ';
            var system = /(^|\s)(service|is-system)(\s|$)/.test(cls) || !!b.querySelector('.service-msg');
            var fromMe = /(^|\s)(is-out|out)(\s|$)/.test(cls);
            var mid = '';
            try { mid = String(b.getAttribute('data-mid') || ''); } catch (eM) {}
            var ts = 0;
            try { ts = parseInt(b.getAttribute('data-timestamp'), 10) || 0; } catch (eT) {} // T1 2.2: seconds epoch
            if (!ts) {
              var tEl = chainFirst(BUBBLE_TIME_CHAIN, b);
              if (tEl) {
                var mm = collapsed(tEl).match(/(\d{1,2}):(\d{2})/);
                if (mm) {
                  var d = new Date();
                  d.setHours(parseInt(mm[1], 10), parseInt(mm[2], 10), 0, 0);
                  var epoch = Math.floor(d.getTime() / 1000);
                  if (epoch > now + 60) epoch -= 86400; // crossed midnight: honest same-day reconstruction
                  ts = epoch;
                }
              }
            }
            var text = '';
            var textEl = chainFirst(BUBBLE_TEXT_CHAIN, b);
            if (textEl) text = normWs(textEl.innerText != null ? textEl.innerText : textEl.textContent);
            var kind = 'text';
            if (system) kind = 'system';
            else if (b.querySelector('img, video, audio, [class*="sticker"], [class*="photo"], [class*="media"]')) kind = 'media-placeholder';
            var row = { id: mid || ('dom_' + i), fromMe: fromMe, text: text, ts: ts, kind: kind, pid: bPid };
            if (kind === 'media-placeholder') row.mId = row.id;
            out.push(row);
          } catch (eB) {}
        }
        if (onlyPeer) {
          // peer gate that can never empty an honest read: if the bubbles
          // carry pids and some match, keep exactly those; if none match
          // (id-space drift), the gate drops itself rather than lie
          var pidRows = 0, matchRows = 0;
          for (var q2 = 0; q2 < out.length; q2++) {
            if (out[q2].pid) { pidRows++; if (out[q2].pid === onlyPeer) matchRows++; }
          }
          if (matchRows > 0) {
            var kept = [];
            for (var q3 = 0; q3 < out.length; q3++) {
              if (!out[q3].pid || out[q3].pid === onlyPeer) kept.push(out[q3]);
            }
            out = kept;
          }
        }
      } catch (eS) {}
      return out;
    }
    async function getMessagesImpl(chatId, limit) {
      var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
      if (!id) return [];
      var lim = 50;
      try {
        var n = parseInt(limit, 10);
        if (isFinite(n) && n > 0) lim = Math.min(MSG_CAP, Math.floor(n));
      } catch (eN) {}
      var ck = cacheKey(id, lim);
      try {
        var c = MSGCACHE[ck];
        if (c && (Date.now() - c.at) < MSG_CACHE_MS) return c.rows.slice();
      } catch (eC) {}
      var tier = 0;
      var mapped = [];
      // tier 0 (T1 3.2/5 + tweb master): message bodies live in the worker
      // memory cache, not in IDB; the window-manager route reads them for
      // ANY chat, no open needed, no UI change (options-object getHistory
      // + per-mid getMessageByPeer, numeric internal peerId)
      try {
        var wkRows = await wkReadHistory(wkPid(id), lim);
        if (wkRows.length) { mapped = wkRows; tier = 0; }
      } catch (eW) { mapped = []; }
      // tier 1: the strict open-chat DOM reader (T1 2.2 bubble contract).
      // Web K loads history ASYNC after the open, so this tier WAITS OUT
      // the render instead of racing it -- the race is what emptied every
      // read while the pane was still loading
      if (!mapped.length && id === lastOpenedChatId) {
        try {
          var domRows1 = await domOpenChatMessages(wkPid(id), lim);
          if (domRows1.length) {
            mapped = domRows1;
            tier = 1;
            noteDomCount(id, domRows1.length); // baseline for hasNewMessages
          }
        } catch (eD1) { mapped = []; }
      }
      // tier 2: the IDB message stores (structurally empty on Web K
      // master: the messages store has no writer; kept for other builds)
      if (!mapped.length) try {
        var idbOk = await probeIdb(false);
        if (idbOk && IDB.msgs.length) {
          mapped = await idbReadMessages(id, lim);
          if (mapped.length) tier = 2;
        }
      } catch (eI) { mapped = []; }
      // tier 3: the legacy fuzzy DOM reader (same open-chat gate as before)
      if (!mapped.length) {
        if (id === lastOpenedChatId || !id) {
          try {
            var rows = domBubbles();
            if (rows.length) {
              mapped = rows;
              tier = 3;
              noteDomCount(id, rows.length);
            }
          } catch (eD) {}
        }
      }
      if (!mapped.length) return [];
      mapped.sort(function (a, b) { return a.ts - b.ts; }); // ascending: newest last
      if (mapped.length > lim) mapped = mapped.slice(mapped.length - lim);
      noteMsgCount(id, mapped.length);
      try {
        var keys = Object.keys(MSGCACHE);
        if (keys.length > 60) delete MSGCACHE[keys[0]];
        MSGCACHE[ck] = { at: Date.now(), rows: mapped.slice() };
      } catch (eK) {}
      tail('msgs: tier ' + tier + ' rows ' + mapped.length);
      return mapped;
    }

    // ============================ engine-sync bookkeeping ============================
    // two per-chat baselines (numbers only, privacy law): MSGCOUNT = the
    // last count getMessages SERVED; DOMCOUNT = the last DOM bubble count
    // seen for the open chat. hasNewMessages compares like against like:
    // the open chat against DOMCOUNT (the DOM tier grows the moment a
    // message renders), other chats against the dialog's own unread flags.
    // Never cross-tier (an IDB 50-row read vs a 12-bubble render would lie
    // in both directions).
    var MSGCOUNT = {};
    var DOMCOUNT = {};
    var NEWMSG_BK = {};
    function noteMsgCount(id, n) {
      try {
        if (typeof n !== 'number') return;
        var keys = Object.keys(MSGCOUNT);
        if (keys.length >= 400) delete MSGCOUNT[keys[0]];
        MSGCOUNT[id] = n;
      } catch (e) {}
    }
    function noteDomCount(id, n) {
      try {
        if (typeof n !== 'number' || n <= 0) return;
        DOMCOUNT[id] = n;
      } catch (e) {}
    }
    async function hasNewMessagesImpl(chatId) {
      var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
      if (!id) return false;
      try {
        if (id === lastOpenedChatId) {
          var fresh = openBubblesForRead().length; // cheap: the open chat renders live
          var prevDom = DOMCOUNT[id] || 0;
          noteDomCount(id, fresh); // every look refreshes the baseline
          if (prevDom && fresh > prevDom) return true;
          return false;
        }
        var bk = NEWMSG_BK[id];
        if (bk && (Date.now() - bk) < MSG_WARM_RETRY_MS) return false;
        NEWMSG_BK[id] = Date.now();
        var idbOk = await probeIdb(false);
        if (idbOk && IDB.dialogs) {
          var dialogs = await idbGetAll(IDB.dialogs, ROSTER_CAP * 2);
          for (var i = 0; i < dialogs.length; i++) {
            var rec = dialogs[i];
            if (rec && dialogId(rec) === id) {
              try {
                if (typeof rec.unread_count === 'number' && rec.unread_count > 0) return true;
                if (rec.pFlags && rec.pFlags.unread) return true;
              } catch (eU) {}
              return false;
            }
          }
        }
        return false;
      } catch (eH) { return false; }
    }

    // ============================ impl: openChat ============================
    async function titleForChat(id) {
      // strict: the roster row whose chatId EQUALS the request. Never a
      // positional fallback (a wrong title would click the WRONG chat row).
      // Callers that already know the title pass it (chatRowCoords).
      try {
        var chats = await listChatsImpl();
        for (var i = 0; i < chats.length; i++) {
          if (chats[i].chatId === id && chats[i].title) return chats[i].title;
        }
      } catch (eT) {}
      return '';
    }
    function domRowByTitle(title) {
      var want = normWs(title).toLowerCase();
      if (!want) return null;
      var rows = domChatRows();
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].title.toLowerCase() === want) return rows[i];
      }
      return null;
    }
    async function openChatImpl(chatId) {
      tailReset();
      tail('open: begin');
      var deadline = Date.now() + OPEN_TIMEOUT;
      try {
        var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
        if (!id) { tail('open: bad id'); return { ok: false, error: 'bad id' }; }
        // fast path: our own last successful open, proven live
        if (id === lastOpenedChatId) {
          var live = await pollUntil(Date.now() + FAST_LIVENESS_MS, openEvidence, 100);
          if (live) { tail('open: fast-path'); return { ok: true, error: null }; }
          tail('open: fast-path stale');
        }
        // tier 0 (T1 4): the e2e-documented open. appImManager.setInnerPeer
        // with the canonical peerId (the same string as data-peer-id on rows
        // and the dialogs store keys, T1 2.1/3.1)
        var g0 = wkGlobals();
        if (g0.im && typeof g0.im.setInnerPeer === 'function') {
          var pid0 = wkPid(id);
          var pidN0 = wkPeerNum(id);
          // setInnerPeer takes the tweb-internal peerId NUMBER (users
          // positive, groups AND channels -abs(id), no -100 marker); the
          // numeric form goes first, the marked string rung stays as
          // tolerance (tweb's getPeerId accepts numeric strings)
          if (isFinite(pidN0)) {
            try { g0.im.setInnerPeer({ peerId: pidN0 }); } catch (eN) {}
            var wkOpenN = await pollUntil(Math.min(deadline, Date.now() + MODULE_PHASE_MS), openEvidence, 70);
            if (wkOpenN) {
              lastOpenedChatId = id;
              tail('open: setInnerPeer win');
              return { ok: true, error: null };
            }
            tail('open: setInnerPeer numeric miss');
          }
          if (pid0) {
            try { g0.im.setInnerPeer({ peerId: pid0 }); } catch (eS) {}
            var wkOpen = await pollUntil(Math.min(deadline, Date.now() + MODULE_PHASE_MS), openEvidence, 70);
            if (wkOpen) {
              lastOpenedChatId = id;
              tail('open: setInnerPeer win');
              return { ok: true, error: null };
            }
            tail('open: setInnerPeer miss');
          }
        }

        // module tier (opportunistic, bounded): manager openChat-ish callables
        var modOk = false;
        try { modOk = await probeRuntime(false); } catch (eP) { modOk = false; }
        if (modOk && RUNTIME.openFns.length) {
          var modDeadline = Math.min(deadline, Date.now() + MODULE_PHASE_MS);
          var calls = 0;
          for (var f = 0; f < RUNTIME.openFns.length && calls < MOD_TIER_CALLS; f++) {
            var cand = RUNTIME.openFns[f];
            var argShapes = [Number(id), id, { chatId: id }, { peerId: id }, { id: id }];
            for (var s = 0; s < argShapes.length && calls < MOD_TIER_CALLS; s++) {
              if (Date.now() >= modDeadline) break;
              calls++;
              try { cand.obj[cand.fn](argShapes[s]); } catch (eC) { continue; }
              var v = await pollUntil(Math.min(modDeadline, Date.now() + 350), openEvidence, 70);
              if (v) {
                lastOpenedChatId = id;
                tail('open: module tier win');
                return { ok: true, error: null };
              }
            }
          }
          tail('open: module tier miss');
        }
        // DOM tier: roster title, then row click (blind, covered-page law)
        var title = await titleForChat(id);
        var norm = normWs(title).toLowerCase();
        var domDeadline = Math.min(deadline, Date.now() + DOM_ROUTE_MS);
        var clicked = null;
        var row = null;
        row = domRowByPid(wkPid(id)); // T1 2.1: exact id match beats titles
        if (!row && norm) row = domRowByTitle(title);
        if (row) {
          try { row.el.click(); } catch (eK) {}
          clicked = await pollUntil(Math.min(domDeadline, Date.now() + OPEN_VERIFY_MS), openEvidence, VERIFY_STEP_MS);
          if (!clicked) {
            tail('open: retry click');
            var row2 = domRowByTitle(title);
            if (row2) {
              try { row2.el.click(); } catch (eK2) {}
              clicked = await pollUntil(Math.min(domDeadline, Date.now() + OPEN_VERIFY_MS), openEvidence, VERIFY_STEP_MS);
            }
          }
        } else {
          tail('open: row not in view');
        }
        if (clicked) {
          lastOpenedChatId = id;
          tail('open: row tier win');
          return { ok: true, error: null };
        }
        tail('open: fail');
        return { ok: false, error: 'chat not openable (row not found)' };
      } catch (eO) {
        noteError('openChat', eO);
        tail('open: exception');
        return { ok: false, error: 'open failed' };
      }
    }

    // ============================ impl: send (guarded legacy attempt) ============================
    async function clickRegistered(text) {
      var deadline = Date.now() + CLICK_REGISTRATION_MS;
      var want = normWs(text);
      while (true) {
        var box = getComposer();
        if (!box) return true; // nothing retryable; the ack poll decides truth
        if (composerText(box) !== want) return true; // the draft provably left the box
        if (Date.now() >= deadline) return false;
        await sleep(CLICK_REG_STEP_MS);
      }
    }
    async function deliveryAck(text, startedAt) {
      // first positive signal inside the cap: (a) a fresh fromMe bubble with
      // the exact text in the open chat, (b) a fromMe record with the exact
      // text in the IDB message store, (c) the same via the worker history
      // (T1 3.2: Web K IDB holds no message bodies). Counts only in the tail.
      var want = normWs(text);
      var deadline = Date.now() + ACK_TIMEOUT;
      var wkAckTried = false;
      while (Date.now() < deadline) {
        await sleep(ACK_STEP_MS);
        try {
          var bubbles = openBubblesForRead();
          for (var i = bubbles.length - 1; i >= 0 && i > bubbles.length - 12; i--) {
            if (bubbles[i].fromMe && bubbles[i].kind !== 'system' && normWs(bubbles[i].text) === want) return 'dom';
          }
        } catch (eD) {}
        if (!wkAckTried && lastOpenedChatId) {
          // one bounded worker-history probe only (T1: bodies are in worker
          // memory), never per poll step
          wkAckTried = true;
          try {
            var wkAckRows = await wkReadHistory(wkPid(lastOpenedChatId), 30);
            for (var w = wkAckRows.length - 1; w >= 0; w--) {
              if (wkAckRows[w].fromMe && normWs(wkAckRows[w].text) === want) return 'wk';
            }
          } catch (eW) {}
        }
        try {
          var idbOk = await probeIdb(false);
          if (idbOk && IDB.msgs.length && lastOpenedChatId) {
            var found = false;
            await idbWalk(IDB.msgs[0], 800, function (val) {
              try {
                if (!val || typeof val !== 'object') return true;
                if (isMsgOut(val) && typeof val.message === 'string' && normWs(val.message) === want) {
                  var peer = msgPeerId(val);
                  if (peer === lastOpenedChatId || keyMatchesChat(peer, lastOpenedChatId)) { found = true; return false; }
                }
              } catch (eV) {}
              return true;
            }, IDB_TX_MS * 2);
            if (found) return 'idb';
          }
        } catch (eI) {}
      }
      return '';
    }
    async function sendImpl(text) {
      tailReset();
      tail('send: begin');
      try {
        if (typeof text !== 'string' || !normWs(text)) {
          tail('send: empty text');
          return { ok: false, error: 'empty text' };
        }
        var box = getComposer();
        if (!box) {
          var live = await pollUntil(Date.now() + 1200, composerLive, 150);
          if (!live) {
            tail('send: no chat open');
            return { ok: false, error: 'no chat open' };
          }
          box = getComposer();
          if (!box) {
            tail('send: composer miss');
            return { ok: false, error: 'composer not found' };
          }
        } else {
          tail('send fast-path');
        }
        // NORMATIVE ROUTE NOTE: production sends go through the spine's
        // real-input sequence at composerCoords()/sendButtonCoords(). This
        // legacy synthetic attempt keeps the API contract and fails CLOSED:
        // the button is never clicked unless the exact text provably sits
        // in the composer.
        // T1 6: the Web K composer is Tiptap 3.31.3 and setValueSilently is
        // its documented first-class setter, so the setter runs FIRST; the
        // selection/execCommand ladder below stays as the generic fallback.
        var apiSet = false;
        try {
          var wkApi = wkComposerApi();
          if (wkApi) {
            apiSet = await wkSetComposerText(wkApi, text);
            if (apiSet) tail('send: insert via tiptap setter');
          }
        } catch (eW) { apiSet = false; }
        if (!apiSet) {
        if (!insertViaSelection(box, text)) {
          tail('send: insert failed');
          return { ok: false, error: 'insert failed' };
        }
        tail(INSERT_FALLBACK ? 'send: insert via fallback events' : 'send: insert via selection');
        if (composerText(box) !== normWs(text)) {
          // one fresh-node retry (the composer node can be re-rendered)
          tail('send: verify mismatch once, retried');
          box = getComposer();
          if (!box) {
            tail('send: composer replaced');
            return { ok: false, error: 'composer replaced' };
          }
          if (!insertViaSelection(box, text) || composerText(box) !== normWs(text)) {
            tail('send: text verify failed');
            return { ok: false, error: 'insert verify failed' };
          }
          tail('send: text verify ok after retry');
        } else {
          tail('send: text verify ok');
        }
        }
        var btn = await pollTries(findTextSendButton, BUTTON_TRIES, BUTTON_STEP_MS);
        if (!btn) {
          tail('send: send button miss');
          return { ok: false, error: 'send button not found' };
        }
        tail('send: button tier ' + BTN_TIER + ' hit');
        try { btn.click(); } catch (eC) {
          tail('send: click 1 failed');
          return { ok: false, error: 'click failed' };
        }
        tail('send: click 1 sent');
        var registered = await clickRegistered(text);
        if (!registered) {
          // the draft provably never left the box: ONE fresh-button retry
          tail('send: click 1 did not register');
          var btn2 = await pollTries(findTextSendButton, BUTTON_TRIES, BUTTON_STEP_MS);
          if (!btn2) {
            tail('send: send button miss on retry');
            return { ok: false, error: 'send click did not register' };
          }
          try { btn2.click(); } catch (eC2) {
            tail('send: click 2 failed');
            return { ok: false, error: 'send click did not register' };
          }
          tail('send: click 2 sent');
          if (!(await clickRegistered(text))) {
            tail('send: click 2 did not register');
            return { ok: false, error: 'send click did not register' };
          }
          tail('send: click 2 registered');
        } else {
          tail('send: click 1 registered');
        }
        var ack = await deliveryAck(text, Date.now());
        if (!ack) {
          tail('send: ack miss');
          return { ok: false, error: 'delivery not confirmed' };
        }
        tail('send: ack hit (' + ack + ')');
        return { ok: true, error: null };
      } catch (eS) {
        noteError('send', eS);
        tail('send: exception');
        return { ok: false, error: 'send failed' };
      }
    }

    // ============================ impl: real-input coordinates ============================
    // The spine's NORMATIVE send route: openChat, then real-click
    // composerCoords, real keystrokes (sendInputEvent per char), then
    // sendButtonCoords real-click. Coordinates are css-px centers, identical
    // convention to the WhatsApp engine's searchTargetCoords family.
    async function composerCoordsImpl() {
      try {
        var box = getComposer();
        if (!box) return { ok: false, error: 'composer not found' };
        var c = centerOf(box);
        if (!c) return { ok: false, error: 'composer not found' };
        return { ok: true, x: c.x, y: c.y, w: c.w, h: c.h };
      } catch (eC) {
        noteError('composerCoords', eC);
        return { ok: false, error: 'composer not found' };
      }
    }
    async function sendButtonCoordsImpl() {
      try {
        var btn = await pollTries(findTextSendButton, 6, 100);
        if (!btn) return { ok: false, error: 'send button not found' };
        var c = centerOf(btn);
        if (!c) return { ok: false, error: 'send button not ready' };
        return { ok: true, x: c.x, y: c.y };
      } catch (eB) {
        noteError('sendButtonCoords', eB);
        return { ok: false, error: 'send button not found' };
      }
    }
    async function chatRowCoordsImpl(chatId, title) {
      try {
        var ttl = normWs(title);
        if (!ttl) ttl = await titleForChat(String(chatId == null ? '' : chatId));
        var row = ttl ? domRowByTitle(ttl) : null;
        if (!row) return { ok: false, error: 'row not in view' };
        var c = centerOf(row.el);
        if (!c) return { ok: false, error: 'row not in view' };
        return { ok: true, x: c.x, y: c.y };
      } catch (eR) {
        noteError('chatRowCoords', eR);
        return { ok: false, error: 'row not in view' };
      }
    }
    async function searchBoxCoordsImpl() {
      try {
        var el = chainFirst(SEARCH_CHAIN);
        if (!el || !laidOut(el)) return { ok: false, error: 'search box not found' };
        var c = centerOf(el);
        if (!c) return { ok: false, error: 'search box not found' };
        return { ok: true, x: c.x, y: c.y };
      } catch (eS) {
        noteError('searchBoxCoords', eS);
        return { ok: false, error: 'search box not found' };
      }
    }

    // ============================ impl: insertDraft ============================
    async function insertDraftImpl(text) {
      tailReset();
      var t = (typeof text === 'string') ? text : '';
      var box = getComposer();
      if (!box) {
        tail('draft: no composer');
        return { ok: false, verified: false, cleared: false };
      }
      if (!normWs(t)) {
        var cOnly = clearViaSelection(box);
        if (!cOnly) {
          var cb = getComposer();
          if (cb) cOnly = clearViaSelection(cb);
        }
        tail(cOnly ? 'draft: clear ok' : 'draft: clear fail');
        return { ok: cOnly, verified: false, cleared: cOnly };
      }
      var okIns = false;
      // T1 6: the documented Tiptap setter first, selection ladder fallback
      try {
        var wkApi2 = wkComposerApi();
        if (wkApi2) okIns = await wkSetComposerText(wkApi2, t);
      } catch (eW) { okIns = false; }
      if (!okIns) { try { okIns = insertViaSelection(box, t); } catch (eI) { okIns = false; } }
      var verified = okIns && composerText(getComposer() || box) === normWs(t); // EXACT match law
      tail(verified ? 'draft: insert ok' : 'draft: insert fail');
      // IMMEDIATE clear: a probe draft never lingers in a real chat
      var cleared = false;
      try {
        var wkApi3 = wkComposerApi();
        if (wkApi3) {
          try { wkApi3.setValueSilently(''); } catch (eS3) {}
          cleared = !!(await pollUntil(Date.now() + 400, function () {
            var cb3 = getComposer();
            return (cb3 && !composerText(cb3)) ? true : null;
          }, 80));
        }
      } catch (eW3) { cleared = false; }
      if (!cleared) cleared = clearViaSelection(box);
      if (!cleared) {
        var cb2 = getComposer();
        if (cb2) cleared = clearViaSelection(cb2);
      }
      tail(cleared ? 'draft: clear ok' : 'draft: clear fail');
      return { ok: !!(verified && cleared), verified: verified, cleared: cleared };
    }

    // ============================ impl: history (endless-scroll law) ============================
    // Same contract as the WhatsApp J1 pair: paged walk, full ascending
    // read, NEVER sends. Tiers: (1) module managers (getHistory-ish, any
    // chat), (2) DOM scroll-up pagination (the open chat only: scrollTop
    // steps up, settle window counts bubble growth). hasMoreHistory is the
    // cheap one-page growth probe.
    var HISTBK = {};
    function msgScroller() {
      for (var i = 0; i < MSG_SCROLLER_CHAIN.length; i++) {
        try {
          var el = D.querySelector(MSG_SCROLLER_CHAIN[i]);
          if (el && (el.scrollHeight > 0)) return el;
        } catch (e) {}
      }
      return null;
    }
    async function getMessagesHistoryImpl(chatId, pages) {
      tailReset();
      tail('history: begin');
      try {
        var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
        if (!id) return { ok: false, error: 'bad id', messages: [], grewBy: 0, hasMore: false, pagesRun: 0 };
        var pg = 5;
        try {
          var pn = parseInt(pages, 10);
          if (isFinite(pn) && pn > 0) pg = Math.min(HIST_PAGE_MAX, Math.floor(pn));
        } catch (eP) {}
        var deadline = Date.now() + HIST_TOTAL_MS;
        var grewBy = 0;
        var ran = 0;
        var lastGrew = false;
        var domUsable = (id === lastOpenedChatId);
        // module tier: getHistory-ish callables for ANY chat
        var modOk = false;
        try { modOk = await probeRuntime(false); } catch (ePr) { modOk = false; }
        if (modOk && RUNTIME.histFns.length) {
          var calls = 0;
          for (var f = 0; f < RUNTIME.histFns.length && calls < 4; f++) {
            var cand = RUNTIME.histFns[f];
            var shapes = [Number(id), id, { chatId: id }, { peerId: id }];
            for (var s = 0; s < shapes.length && calls < 4; s++) {
              calls++;
              try { cand.obj[cand.fn](shapes[s]); } catch (eC) { continue; }
              tail('history: module page ' + calls);
            }
          }
          await sleep(HIST_SETTLE_MS); // let the manager fill the store
        }
        // DOM scroll tier (open chat only)
        if (domUsable) {
          var sc = msgScroller();
          if (sc) {
            var prev = openBubblesForRead().length;
            var flat = 0;
            for (var page = 1; page <= pg; page++) {
              if (Date.now() >= deadline) break;
              ran = page;
              try {
                var top = Math.max(0, sc.scrollTop - Math.max(240, sc.clientHeight * 2));
                sc.scrollTop = top; // programmatic scroll is not input; works blind
                if (sc.scrollTop <= 0 && page === 1) sc.scrollTop = 0;
              } catch (eS) { break; }
              var grewTo = await pollUntil(
                Math.min(deadline, Date.now() + HIST_SETTLE_MS),
                function () {
                  var n = openBubblesForRead().length;
                  return n > prev ? n : null;
                },
                HIST_STEP_MS
              );
              var now = grewTo || openBubblesForRead().length;
              var delta = now - prev;
              prev = now;
              grewBy += delta > 0 ? delta : 0;
              lastGrew = delta > 0;
              tail('history: page ' + page + ' (+' + (delta > 0 ? delta : 0) + ')');
              if (delta <= 0) {
                flat++;
                if (flat >= 2) break; // two flat pages = exhausted (J1 law)
              } else {
                flat = 0;
              }
            }
          }
        }
        // full ascending read through the normal tiers (cache bypassed)
        try { delete MSGCACHE[cacheKey(id, MSG_CAP)]; } catch (eD) {}
        var messages = await getMessagesImpl(id, MSG_CAP);
        // honesty gate: no page ran, nothing grew, nothing readable = the
        // chat is not open and no module tier filled the store; say so
        // instead of an ok:true empty success
        if (ran === 0 && grewBy === 0 && !messages.length) {
          tail('history: chat not open');
          return { ok: false, error: 'chat not open', messages: [], grewBy: 0, hasMore: false, pagesRun: 0 };
        }
        var hasMore = lastGrew;
        tail('history: done rows ' + messages.length);
        return { ok: true, messages: messages, grewBy: grewBy, hasMore: hasMore, pagesRun: ran };
      } catch (eH) {
        noteError('getMessagesHistory', eH);
        tail('history: exception');
        return { ok: false, error: 'history failed', messages: [], grewBy: 0, hasMore: false, pagesRun: 0 };
      }
    }
    async function hasMoreHistoryImpl(chatId) {
      try {
        var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
        if (!id) return false;
        if (id !== lastOpenedChatId) return false; // DOM probe is open-chat only
        var bk = HISTBK[id];
        if (bk && (Date.now() - bk) < MSG_WARM_RETRY_MS) return false;
        var sc = msgScroller();
        if (!sc) return false;
        var prev = openBubblesForRead().length;
        try { sc.scrollTop = Math.max(0, sc.scrollTop - Math.max(240, sc.clientHeight * 2)); } catch (eS) { return false; }
        var grewTo = await pollUntil(Date.now() + HIST_SETTLE_MS, function () {
          var n = openBubblesForRead().length;
          return n > prev ? n : null;
        }, HIST_STEP_MS);
        var grew = !!(grewTo || openBubblesForRead().length > prev);
        if (!grew) HISTBK[id] = Date.now();
        return grew;
      } catch (eM) { return false; }
    }

    // ============================ impl: media ============================
    async function blobToDataUrl(blob, kindGuess) {
      return new W.Promise(function (resolve) {
        var done = false;
        var fin = function (v) { if (!done) { done = true; resolve(v); } };
        try {
          var fr = new W.FileReader();
          var timer = W.setTimeout(function () { fin(null); }, MEDIA_BLOB_MS);
          fr.onload = function () {
            try { W.clearTimeout(timer); } catch (eT) {}
            var url = String(fr.result || '');
            if (!url || url.length > MEDIA_CAP) { fin(null); return; }
            var mime = '';
            try { mime = String((blob && blob.type) || ''); } catch (eM) { mime = ''; }
            var kind = kindGuess || (mime.indexOf('video') !== -1 ? 'video' : mime.indexOf('audio') !== -1 ? 'audio' : 'image');
            fin({ ok: true, kind: kind, data: url, mime: mime });
          };
          fr.onerror = function () { fin(null); };
          fr.readAsDataURL(blob);
        } catch (eF) { fin(null); }
      });
    }
    async function fetchUrlCapped(url, kindGuess) {
      return new W.Promise(function (resolve) {
        var done = false;
        var fin = function (v) { if (!done) { done = true; resolve(v); } };
        try {
          W.fetch(url, { credentials: 'include' }).then(function (res) {
            if (!res || !res.ok) { fin(null); return; }
            return res.blob().then(function (blob) {
              if (!blob || blob.size > MEDIA_CAP * 2) { fin(null); return; }
              blobToDataUrl(blob, kindGuess).then(fin).then(null, function () { fin(null); });
            }).then(null, function () { fin(null); });
          }).then(null, function () { fin(null); });
          W.setTimeout(function () { fin(null); }, MEDIA_FETCH_MS);
        } catch (eF) { fin(null); }
      });
    }
    async function getMediaImpl(chatId, msgId) {
      try {
        var id = (typeof chatId === 'string') ? chatId : String(chatId == null ? '' : chatId);
        var mid = (typeof msgId === 'string') ? msgId : String(msgId == null ? '' : msgId);
        if (!id || !mid) return { ok: false, error: 'media unavailable' };
        // DOM tier: dom_N ids map to the Nth media element of the open chat
        if (mid.indexOf('dom_') === 0 && id === lastOpenedChatId) {
          var scope = chainFirst(MSG_SCROLLER_CHAIN);
          if (scope) {
            var idx = parseInt(mid.slice(4), 10);
            var els = qsa('img, video, audio', scope).filter(function (el) {
              try { return laidOut(el) && el.src; } catch (eL) { return false; }
            });
            var el2 = els && els.length ? els[Math.min(idx, els.length - 1)] : null;
            if (el2 && el2.src) {
              var guess = (el2.tagName === 'VIDEO') ? 'video' : (el2.tagName === 'AUDIO') ? 'audio' : 'image';
              var got = await fetchUrlCapped(el2.src, guess);
              if (got) return got;
            }
          }
        }
        // IDB tier: the message record's own url-ish fields
        var idbOk = await probeIdb(false);
        if (idbOk && IDB.msgs.length) {
          var target = null;
          await idbWalk(IDB.msgs[0], 1500, function (val) {
            try {
              if (!val || typeof val !== 'object') return true;
              if (String(val.id != null ? val.id : '') !== mid) return true;
              var peer = msgPeerId(val);
              if (peer === id || keyMatchesChat(peer, id)) { target = val; return false; }
            } catch (eV) {}
            return true;
          }, IDB_TX_MS * 2);
          if (target) {
            var fields = ['url', 'src', 'file_url', 'blob_url', 'path'];
            for (var f = 0; f < fields.length; f++) {
              var v = target[fields[f]];
              if (typeof v === 'string' && v.length > 4 && (/^(https?:|blob:|data:)/i.test(v))) {
                var got2 = await fetchUrlCapped(v, null);
                if (got2) return got2;
              }
              try {
                if (v && typeof v === 'object' && typeof v.url === 'string' && v.url.length > 4) {
                  var got3 = await fetchUrlCapped(v.url, null);
                  if (got3) return got3;
                }
              } catch (eO) {}
            }
          }
        }
        return { ok: false, error: 'media unavailable' };
      } catch (eG) {
        noteError('getMedia', eG);
        return { ok: false, error: 'media unavailable' };
      }
    }

    // ============================ impl: avatars ============================
    // E2: scoped + tiered, same laws as the WhatsApp engine. Research
    // (T-TELEGRAM-WEB.md L55): the Web K avatar lives under .dialog-avatar
    // (dialogElement.ts L324) - an img for photo peers, a painted canvas for
    // monogram peers; Web A may paint a background-image div. Telegram also
    // renders emoji in titles/previews AS img.emoji, so the img tier rejects
    // emoji-class imgs. MIME LAW everywhere: only a data:image/ dataURL under
    // 60 KB is a face; anything else answers null (initials-only peers return
    // no face BY DESIGN - the rail's initials are the fallback). Tier counts:
    // tail + debugAvatarTiers, numbers only.
    var AVATAR_TIERS = { rows: 0, img: 0, canvas: 0, bg: 0, miss: 0 };
    function avatarSrcOkTg(raw) {
      if (!raw) return false;
      var s = String(raw);
      if (s.charAt(0) === '#') return false; // placeholder src: never fetch
      return s.indexOf('blob:') === 0 || s.indexOf('data:image/') === 0 ||
             s.indexOf('https:') === 0 || s.indexOf('http:') === 0;
    }
    function imgEmojiishTg(el) {
      try {
        var c = ' ' + String(el.className || '').replace(/\s+/g, ' ') + ' ';
        return c.indexOf(' emoji ') !== -1 || c.indexOf(' sticker ') !== -1;
      } catch (e) { return true; }
    }
    function avatarFromUrlTg(u) {
      return W.fetch(u).then(function (res) { return res ? res.blob() : null; }).then(function (blob) {
        if (!blob || String(blob.type || '').indexOf('image/') !== 0) return null; // MIME law
        return new W.Promise(function (resolve) {
          var fr = new W.FileReader();
          fr.onload = function () {
            var s = String(fr.result || '');
            resolve(s.indexOf('data:image/') === 0 && s.length < 60000 ? s : null);
          };
          fr.onerror = function () { resolve(null); };
          fr.readAsDataURL(blob);
        });
      }).then(null, function () { return null; });
    }
    function avatarFromImgElTg(img) {
      return new W.Promise(function (resolve) {
        try {
          var raw = '';
          try { raw = img.getAttribute('src') || ''; } catch (eA) { raw = ''; }
          if (raw.indexOf('data:image/') === 0) { resolve(raw.length < 60000 ? raw : null); return; }
          if (!avatarSrcOkTg(raw) || imgEmojiishTg(img)) { resolve(null); return; }
          var abs = '';
          try { abs = img.src || ''; } catch (eS) { abs = ''; }
          if (!abs || abs.indexOf('data:') === 0) { resolve(null); return; }
          avatarFromUrlTg(abs).then(resolve);
        } catch (eE) { resolve(null); }
      });
    }
    function avatarCanvasTg(scope) {
      try {
        var cvs = qsa('canvas', scope);
        for (var i = 0; i < cvs.length; i++) {
          var cv = cvs[i];
          var w = 0;
          try { w = cv.width || 0; } catch (eW) { w = 0; }
          if (w < 16 || w > 512) continue;
          var s = cv.toDataURL('image/png'); // tainted canvas throws -> caught
          if (s && s.indexOf('data:image/') === 0 && s.length < 60000) return s;
        }
      } catch (eC) {}
      return null;
    }
    function avatarBgUrlTg(scope) {
      // Returns a raw URL string (data: or fetchable) or '' - conversion is
      // the caller's job so there is exactly one MIME-law path.
      try {
        var els = qsa('*', scope);
        for (var i = 0; i < els.length && i < 24; i++) {
          var el = els[i];
          var v = '';
          try { v = (el.style && el.style.backgroundImage) || ''; } catch (eI) { v = ''; }
          if (!v || v === 'none') {
            try { v = (W.getComputedStyle(el, null) || {}).backgroundImage || ''; } catch (eC) { v = ''; }
          }
          if (!v || v === 'none' || v.indexOf('url(') === -1) continue;
          var m = /url\((['"]?)([^'")]+)\1\)/.exec(v);
          if (!m) continue;
          if (m[2].indexOf('data:image/') === 0 && m[2].length < 60000) return m[2];
          if (avatarSrcOkTg(m[2])) return m[2];
        }
      } catch (eB) {}
      return '';
    }
    function getAvatarsImpl(limit) {
      var cap = Math.max(1, Math.min(AVATAR_CAP, parseInt(limit, 10) || 60));
      return new W.Promise(function (resolve) {
        try {
          var rows = domChatRows().slice(0, cap);
          AVATAR_TIERS = { rows: 0, img: 0, canvas: 0, bg: 0, miss: 0 };
          var out = [];
          var tasks = [];
          rows.forEach(function (row) {
            try {
              if (!row.title || !row.el) return;
              AVATAR_TIERS.rows++;
              // F1: .dialog-avatar is the master contract (dialogElement.ts
              // L324); .chat-avatar / .avatar rungs cover drift so the img/
              // canvas/bg ladder always has the tightest scope that exists
              var scope = row.el.querySelector('.dialog-avatar') ||
                          row.el.querySelector('.chat-avatar') ||
                          row.el.querySelector('.avatar') ||
                          row.el.querySelector('[class*="avatar"]') || row.el;
              var imgs = qsa('img', scope);
              var img = null;
              for (var q = 0; q < imgs.length; q++) {
                try {
                  var r0 = imgs[q].getAttribute('src') || '';
                  if (avatarSrcOkTg(r0) && !imgEmojiishTg(imgs[q])) { img = imgs[q]; break; }
                } catch (eQ) {}
              }
              tasks.push((img ? avatarFromImgElTg(img) : W.Promise.resolve(null)).then(function (a) {
                if (a) { AVATAR_TIERS.img++; out.push({ title: row.title, avatar: a }); return; }
                var cv = avatarCanvasTg(scope);
                if (cv) { AVATAR_TIERS.canvas++; out.push({ title: row.title, avatar: cv }); return; }
                var bg = avatarBgUrlTg(scope);
                if (!bg) { AVATAR_TIERS.miss++; return; } // initials-only peer: by design
                var p = bg.indexOf('data:image/') === 0 ? W.Promise.resolve(bg) : avatarFromUrlTg(bg);
                return p.then(function (a2) {
                  if (a2) { AVATAR_TIERS.bg++; out.push({ title: row.title, avatar: a2 }); }
                  else AVATAR_TIERS.miss++;
                });
              }).then(null, function () { AVATAR_TIERS.miss++; }));
            } catch (eR) {}
          });
          W.Promise.all(tasks).then(function () {
            tail('avatars rows=' + AVATAR_TIERS.rows + ' img=' + AVATAR_TIERS.img + ' canvas=' + AVATAR_TIERS.canvas +
                 ' bg=' + AVATAR_TIERS.bg + ' miss=' + AVATAR_TIERS.miss);
            resolve(out);
          }).then(null, function () { resolve([]); });
        } catch (eA) { resolve([]); }
      });
    }

    // ============================ impl: typing ============================
    // Row titles whose chat list row currently shows Telegram's own typing
    // state. Locale-safe first (class tokens), EN text labels best-effort.
    // Titles only; one pass, no polling; cached TYPING_CACHE_MS.
    var TYPING = { at: 0, val: [] };
    async function typingImpl() {
      try {
        if ((Date.now() - TYPING.at) < TYPING_CACHE_MS) return TYPING.val.slice();
        var out = [];
        var seen = {};
        var rows = domChatRows().slice(0, TYPING_ROW_CAP);
        for (var i = 0; i < rows.length; i++) {
          try {
            var row = rows[i];
            var trip = false;
            var tEl = row.el.querySelector('.peer-typing-container, [class*="typing"]'); // T1 7: exact Web K marker first
            if (tEl) trip = true;
            if (!trip) {
              var sub = chainFirst(ROW_SUB_CHAIN, row.el);
              if (sub && TYPING_TEXT_RE.test(normWs(sub.textContent))) trip = true;
            }
            if (!trip) {
              var al = row.el.getAttribute('aria-label') || '';
              if (TYPING_TEXT_RE.test(normWs(al))) trip = true;
            }
            if (trip) {
              var k = row.title.toLowerCase();
              if (!seen[k]) { seen[k] = true; out.push(row.title); }
            }
          } catch (eR) {}
        }
        // open chat (T1 7): the topbar subtitle line carries typing state;
        // reached through the appImManager reference, title joined by our
        // own open belief. State read in one pass, no subscription.
        try {
          var gT = wkGlobals();
          if (gT.im && gT.im.chat && lastOpenedChatId) {
            var tb = null;
            try { tb = gT.im.chat.topbar && gT.im.chat.topbar.subtitle; } catch (eTb) { tb = null; }
            if (tb) {
              var tripOpen = false;
              try { if (tb.querySelector && tb.querySelector('.peer-typing-container, [class*="typing"]')) tripOpen = true; } catch (eQ) {}
              if (!tripOpen) { try { if (TYPING_TEXT_RE.test(normWs(tb.textContent))) tripOpen = true; } catch (eTx) {} }
              if (tripOpen) {
                var openTitle = await titleForChat(lastOpenedChatId);
                if (openTitle) {
                  var ok2 = openTitle.toLowerCase();
                  if (!seen[ok2]) { seen[ok2] = true; out.push(openTitle); }
                }
              }
            }
          }
        } catch (eO) {}
        TYPING.at = Date.now();
        TYPING.val = out;
        return out.slice();
      } catch (eT) { return []; }
    }

    // ============================ impl: __probeTelegram (diagnostics) ============================
    // One bounded pass that settles WHY a tier fails before anyone
    // guesses: which window globals exist, which manager paths resolve,
    // whether getHistory is callable, which arg shape it accepts and what
    // shape it answers with, plus DOM/id-format/IDB structure facts.
    // PRIVACY LAW: booleans, counts, key NAMES and type tags only -- no
    // titles, no message text, no raw peer ids (id FORMATS only: sign +
    // digit-length + marker prefix, never the number).
    function idFormOf(v) {
      try {
        var s = String(v == null ? '' : v);
        if (!s) return 'empty';
        var neg = s.charAt(0) === '-';
        var dg = s.replace(/\D/g, '');
        return (neg ? 'neg' : 'pos') + ':' + (dg.length >= 10 ? 'long' : dg.length >= 4 ? 'mid' : 'short') + (dg.indexOf('100') === 0 ? ':m100' : '');
      } catch (e) { return '?'; }
    }
    function typeTagOf(v) {
      try {
        if (v === null || v === undefined) return 'none';
        if (Array.isArray(v)) return 'array(' + v.length + ')';
        if (v instanceof W.Map) return 'map(' + v.size + ')';
        if (v instanceof W.Set) return 'set(' + v.size + ')';
        if (typeof v === 'string') return 'string';
        if (typeof v === 'number' || typeof v === 'boolean') return typeof v;
        if (typeof v.then === 'function') return 'promise';
        return 'object';
      } catch (e) { return '?'; }
    }
    async function probeTelegramImpl() {
      var deadline = Date.now() + PROBE_TOTAL_MS;
      var out = {
        wkLive: wkLive(),
        hasImManager: false,
        hasDialogsManager: false,
        hasRootScope: false,
        hasApiManagerProxy: false,
        hasMsgsManager: false,
        managerPathsTried: [],      // [{path, found, hasGetHistory}] -- fixed path names only
        getHistoryArgsShape: [],    // [{shape, threw, resolved, resultType, historyLen, messagesType}]
        sampleResultKeys: [],       // 'key:type' tags of the first resolving result
        extra: {}
      };
      try {
        var g = wkGlobals();
        out.hasImManager = !!g.im;
        out.hasDialogsManager = !!g.dialogsMgr;
        out.hasRootScope = !!g.root;
        out.hasApiManagerProxy = !!g.api;
        var paths = [
          ['rootScope.managers.appMessagesManager', function () { return g.root && g.root.managers && g.root.managers.appMessagesManager; }],
          ['rootScope.managers.all.appMessagesManager', function () { return g.root && g.root.managers && g.root.managers.all && g.root.managers.all.appMessagesManager; }],
          ['rootScope.appMessagesManager', function () { return g.root && g.root.appMessagesManager; }],
          ['apiManagerProxy.appMessagesManager', function () { return g.api && g.api.appMessagesManager; }],
          ['apiManagerProxy.managers.appMessagesManager', function () { return g.api && g.api.managers && g.api.managers.appMessagesManager; }],
          ['window.appMessagesManager', function () { return W.appMessagesManager; }]
        ];
        var mgr = null;
        var mgrPath = '';
        for (var p = 0; p < paths.length; p++) {
          var v = null;
          try { v = paths[p][1](); } catch (eP) { v = null; }
          var has = !!(v && typeof v === 'object');
          var hasGh = false;
          try { hasGh = has && typeof v.getHistory === 'function'; } catch (eG) { hasGh = false; }
          out.managerPathsTried.push({ path: paths[p][0], found: has, hasGetHistory: hasGh });
          if (hasGh && !mgr) { mgr = v; mgrPath = paths[p][0]; }
        }
        out.hasMsgsManager = !!mgr;
        // live getHistory probe: ONLY against the chat the engine opened
        // (openChat first, then probe -- no other peer is ever touched)
        if (mgr && lastOpenedChatId) {
          var pidS = wkPid(lastOpenedChatId);
          var pidN = wkPeerNum(lastOpenedChatId);
          var shapes = [
            { tag: 'object{peerId:number,limit}', v: { peerId: pidN, limit: 20 } },
            { tag: 'object{peerId:string,limit}', v: { peerId: String(pidN), limit: 20 } },
            { tag: 'number', v: pidN },
            { tag: 'string-marked', v: pidS }
          ];
          var pr = null;
          for (var s = 0; s < shapes.length && Date.now() < deadline; s++) {
            var rec = { shape: shapes[s].tag, threw: false, resolved: false, resultType: 'none', historyLen: -1, messagesType: 'none' };
            try {
              pr = mgr.getHistory(shapes[s].v);
              if (pr && typeof pr.then === 'function') pr = await raceDeadline(pr, Math.min(deadline, Date.now() + 1500));
              if (pr != null) rec.resolved = true;
              rec.resultType = typeTagOf(pr);
              if (pr && typeof pr === 'object') {
                if (Array.isArray(pr.history)) rec.historyLen = pr.history.length;
                rec.messagesType = typeTagOf(pr.messages);
              }
            } catch (eC) { rec.threw = true; }
            out.getHistoryArgsShape.push(rec);
            if (rec.resolved && (rec.historyLen > 0 || rec.messagesType.indexOf('array') === 0 || rec.messagesType.indexOf('map') === 0)) {
              try {
                var keys = Object.keys(pr || {});
                for (var kk = 0; kk < keys.length && out.sampleResultKeys.length < 12; kk++) {
                  out.sampleResultKeys.push(keys[kk] + ':' + typeTagOf(pr[keys[kk]]));
                }
              } catch (eK) {}
              break;
            }
          }
        }
        // DOM + id-format + IDB structure facts
        try {
          var rowEl = D.querySelector('.chatlist-chat[data-peer-id]');
          var bubEl = D.querySelector('.bubble[data-mid]');
          out.extra.rowPidForm = rowEl ? idFormOf(rowEl.getAttribute('data-peer-id')) : 'none';
          out.extra.bubblePidForm = bubEl ? idFormOf(bubEl.getAttribute('data-peer-id')) : 'none';
          out.extra.openChatPidForm = lastOpenedChatId ? idFormOf(wkPid(lastOpenedChatId)) : 'none';
          out.extra.bubblesWithMid = qsa('.bubble[data-mid]').length;
          out.extra.scroller = chainFirst(MSG_SCROLLER_CHAIN) ? true : false;
        } catch (eD) {}
        try {
          out.extra.idb = { ok: IDB.ok === true, classified: !!IDB.dialogs, dialogs: !!IDB.dialogs, users: !!IDB.users, chats: !!IDB.chats, msgsStores: IDB.msgs.length };
        } catch (eI) {}
        out.extra.managerUsed = mgrPath;
      } catch (eW) { out.extra.probeError = 'step'; }
      return out;
    }

    // ============================ export ============================
    function guard(step, fallback, fn) {
      return function () {
        var args = arguments;
        try {
          return W.Promise.resolve()
            .then(function () { return fn.apply(null, args); })
            .then(null, function (err) { noteError(step, err); return fallback; });
        } catch (e) {
          noteError(step, e);
          return W.Promise.resolve(fallback);
        }
      };
    }

    W.__wabEng = {
      ready: guard('ready', false, readyImpl),
      listChats: guard('listChats', [], listChatsImpl),
      getContact: guard('getContact', null, getContactImpl),
      getMessages: guard('getMessages', [], getMessagesImpl),
      openChat: guard('openChat', { ok: false, error: 'open failed' }, openChatImpl),
      send: guard('send', { ok: false, error: 'send failed' }, sendImpl),
      getAvatars: guard('getAvatars', [], getAvatarsImpl),
      debugAvatarTiers: function () { try { return AVATAR_TIERS; } catch (eD) { return {}; } },
      getTyping: guard('getTyping', [], typingImpl),
      getMedia: guard('getMedia', { ok: false, error: 'media unavailable' }, getMediaImpl),
      hasNewMessages: guard('hasNewMessages', false, hasNewMessagesImpl),
      getMessagesHistory: guard('getMessagesHistory', { ok: false, messages: [], grewBy: 0, hasMore: false, pagesRun: 0 }, getMessagesHistoryImpl),
      hasMoreHistory: guard('hasMoreHistory', false, hasMoreHistoryImpl),
      insertDraft: guard('insertDraft', { ok: false, verified: false, cleared: false }, insertDraftImpl),
      // Telegram real-input additions (the spine drives sendInputEvent at
      // these css-px centers; same convention as the WA engine's coord family)
      composerCoords: guard('composerCoords', { ok: false, error: 'composer not found' }, composerCoordsImpl),
      sendButtonCoords: guard('sendButtonCoords', { ok: false, error: 'send button not found' }, sendButtonCoordsImpl),
      chatRowCoords: guard('chatRowCoords', { ok: false, error: 'row not in view' }, chatRowCoordsImpl),
      searchBoxCoords: guard('searchBoxCoords', { ok: false, error: 'search box not found' }, searchBoxCoordsImpl),
      __probeTelegram: guard('__probeTelegram', null, probeTelegramImpl),
      debugTail: function () {
        try { return TAIL.slice(); } catch (eD) { return []; }
      },
      health: function () {
        return W.Promise.resolve({
          idb: HEALTH.idb === true,
          modules: wkLive() || HEALTH.modules === true,
          lastError: HEALTH.lastError || null
        });
      }
    };
  } catch (eBoot) {
    // never throw out of the injection; the spine sees a missing __wabEng
    // and health via the next injection attempt after reload
  }
})();
