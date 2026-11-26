// Chat Bridge Ã¢â‚¬â€ session manager. One isolated partition per partner account,
// official web.whatsapp.com (or the local mock in --mock mode) in a BrowserView.
// Privacy blindfold is injected from inject/privacy-inject.js on every load.
const { session, BrowserView, WebContentsView, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PRIVACY_SRC = fs.readFileSync(path.join(__dirname, 'inject', 'privacy-inject.js'), 'utf8');
const SCRAPER_SRC = fs.readFileSync(path.join(__dirname, 'inject', 'context-scraper.js'), 'utf8');
const DECLUTTER_SRC = fs.readFileSync(path.join(__dirname, 'inject', 'declutter-inject.js'), 'utf8');
// A2's open-chat automation lands as a file; guarded read so the spine boots before it exists.
const OPENCHAT_PATH = path.join(__dirname, 'inject', 'open-chat-inject.js');
const OPENCHAT_SRC = fs.existsSync(OPENCHAT_PATH) ? fs.readFileSync(OPENCHAT_PATH, 'utf8') : '';
// v3 engine bridge (builder D); guarded the same way.
const ENGINE_PATH = path.join(__dirname, 'engine', 'engine-inject.js');
const ENGINE_SRC = fs.existsSync(ENGINE_PATH) ? fs.readFileSync(ENGINE_PATH, 'utf8') : '';
// v14 T3: the Telegram adapter (builder T2); guarded the same way, so the
// spine boots before that file exists and Telegram accounts answer
// 'engine bridge not installed yet' instead of dying.
const TG_ENGINE_PATH = path.join(__dirname, 'engine', 'telegram-inject.js');
const TG_ENGINE_SRC = fs.existsSync(TG_ENGINE_PATH) ? fs.readFileSync(TG_ENGINE_PATH, 'utf8') : '';
// v3 mock fixtures
const FIXTURES_PATH = path.join(__dirname, '..', '..', 'tools', 'fixtures.json');
let FIXTURES = null;
function loadFixtures() {
  if (FIXTURES) return FIXTURES;
  try { FIXTURES = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')); } catch (e) { FIXTURES = { people: [], messages: {} }; }
  return FIXTURES;
}

const { normalizeTitle, titlesMatch } = require('../shared/normalize');

// Hardening fix 1 (research C): the UA must match the real Chromium engine version,
// not a hardcoded stale one. A 26-version contradiction between UA and client hints
// is a detection signal (Cloudflare Turnstile challenges this shape).
const CHROME_VER = (process.versions && process.versions.chrome ? process.versions.chrome.split('.')[0] : '130');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + CHROME_VER + '.0.0.0 Safari/537.36';

const WA_URL = 'https://web.whatsapp.com';
const TG_URL = 'https://webk.telegram.org';   // v14 T1 research: pin Web K (the bare root randomly picks K or A per load)
const MOCK_URL = 'file://' + path.join(__dirname, '..', '..', 'tools', 'mock-wa.html').replace(/\\/g, '/');

let flags = { mock: false };
const sessions = new Map();   // accountId -> { view, qrWindow, status, missCount, lastUnread, bound }
let shellWin = null;
let uiView = null;            // v3: the operator's UI view, always on top
let layoutMode = 'single';
let attached = new Map();     // slot -> accountId
const engineInShell = new Set();   // accountIds whose engine views sit under the UI

// v2 Conversation Mode: pane state + prefs
let activePane = 0;
const paneState = new Map();  // slot -> { accountId, title }

function setFlags(f) { flags = Object.assign(flags, f); }
function setShellWindow(win) { shellWin = win; }
function setUiView(v) { uiView = v; }

// The operator-facing webContents: the UI view's, never the window's own blank.
function uiWC(win) {
  const target = win || shellWin;
  try {
    if (target && target.uiView && !target.isDestroyed()) return target.uiView.webContents;
    if (uiView) return uiView.webContents;
  } catch (e) { /* mid-teardown */ }
  return null;
}

// v13 M1: full-hop liveness. During teardown rec.view.webContents itself
// can be undefined before the rec leaves the map; spine-side guards go
// through here so no isDestroyed call ever reads undefined.
function wcAlive(rec) {
  return !!(rec && rec.view && rec.view.webContents && !rec.view.webContents.isDestroyed());
}

// v14 T3: platform-aware URL. Mock mode serves the same mock page to both
// platforms (every eng* path bypasses the engine in mock, so the smoke
// never depends on the page DOM matching either platform).
function accountUrl(account) {
  if (flags.mock) return MOCK_URL;
  return (account && account.platform === 'telegram') ? TG_URL : WA_URL;
}

// v14 T3: ids carry their platform. No argument = the old WhatsApp shape,
// so every existing caller (main.js smoke mk, anything older) is unchanged.
function makeId(platform) {
  const pre = platform === 'telegram' ? 'tg_' : 'wa_';
  return pre + Math.random().toString(16).slice(2, 10);
}

// v14 T3 partition law: 'persist:wa-<tail>' / 'persist:tg-<tail>'. A STORED
// partition always wins, so every existing WhatsApp account keeps its data
// home byte-identical; only accounts born after this patch get the new
// names. (Every account on disk today carries a partition written at add
// time, so the fallback is birth-naming, not migration.)
function partitionFor(account) {
  if (account && account.partition) return account.partition;
  const tail = String((account && account.id) || '').replace(/^(wa|tg)_/, '');
  return ((account && account.platform === 'telegram') ? 'persist:tg-' : 'persist:wa-') + tail;
}

// ---------- view creation ----------

function createSession(account, qrWindow) {
  const partition = partitionFor(account);   // v14 T3: stored partition (existing accounts) or platform-routed new one
  const sess = session.fromPartition(partition);
  sess.setUserAgent(UA);
  // Privacy law: no OS notifications from the WhatsApp page, no capture, no geolocation.
  // The desk shows its own toasts (generic for restricted chats).
  sess.setPermissionRequestHandler((wc, permission, callback) => {
    callback(false);
  });

  const view = new WebContentsView({
    webPreferences: {
      session: sess,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,   // engines must never sleep (research law: set at birth)
      devTools: true   // the operator owns this machine; dev tools are the honest escape hatch
    }
  });
  view.setBackgroundColor('#12140b');

  const rec = { view, qrWindow: qrWindow || null, status: 'linking', missCount: 0, lastUnread: null, bound: false };
  sessions.set(account.id, rec);

    // v12.8 RULING (the send-failure case, closed): engine rooms get NATURAL WhatsApp.
  // The v2 crop/declutter CSS hid the chat list INSIDE the engines, zero-sizing the
  // rows and the search box, killing every DOM open route (search text erased,
  // clicks on invisible elements never activating). Engines are invisible anyway;
  // their WhatsApp must stay fully rendered and input-ready. Only the privacy
  // blindfold (allow/deny at the data layer) and the engine bridge inject.
  const inject = () => { injectPrivacy(account.id); injectEngine(account.id); };
  view.webContents.on('dom-ready', inject);
  view.webContents.on('did-navigate', inject);
  view.webContents.on('did-navigate-in-page', inject);

  // Links open in the real browser, never inside the desk.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url.startsWith('http') && !flags.mock) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Clicking straight into a WhatsApp view activates its pane: the renderer
  // cannot see that click (views swallow input), so the spine reports it.
  view.webContents.on('did-focus', () => {
    for (const [s, id] of attached) {
      if (id === account.id) {
        if (activePane !== s) setActivePane(s);
        else pushPaneState(s);
        return;
      }
    }
  });

  // Right-click bridge to the AI panel. Menu aims at the click point:
  // view coords + the view's offset inside its window.
  view.webContents.on('context-menu', (e, params) => {
    const hasSel = !!(params.selectionText && params.selectionText.trim());
    const menu = Menu.buildFromTemplate([
      { label: 'Ask AI about this chat', click: () => openAIPanel(account.id, null) },
      ...(hasSel
        ? [{ label: 'Ask AI about the selected text', click: () => openAIPanel(account.id, 'lookup') }]
        : [])
    ]);
    const target = (shellWin && !shellWin.isDestroyed()) ? shellWin : view.webContents.getOwnerWindow();
    if (!target) return;
    try {
      const b = view.getBounds();
      menu.popup({ window: target, x: b.x + params.x, y: b.y + params.y });
    } catch (err) {
      menu.popup({ window: target });
    }
  });

  view.webContents.loadURL(accountUrl(account)).catch(err => {
    console.error('[sessions] load failed for', account.name, err.message);
  });
  return rec;
}

function injectPrivacy(accountId) {
  const rec = sessions.get(accountId);
  if (!rec || rec.view.webContents.isDestroyed()) return;
  const cfg = store.getPrivacy(accountId);
  const src = `window.__WAB_PRIVACY__ = ${JSON.stringify(cfg)};\n${PRIVACY_SRC}`;
  rec.view.webContents.executeJavaScript(src, false).catch(() => { /* mid-navigation: retry fires on next dom-ready */ });
}

// Declutter is global (not per-account): strip WhatsApp's own chrome so the
// desk shows chats only. Idempotent in-page.
function injectDeclutter() {
  for (const [accountId, rec] of sessions) {
    if (!rec.view || rec.view.webContents.isDestroyed()) continue;
    rec.view.webContents.executeJavaScript(DECLUTTER_SRC, false).catch(() => { /* mid-navigation */ });
  }
}

// v2 law: the desk NEVER shows WhatsApp's own list/nav. Thread-crop applies on
// every page load when the pref is on (default), not only after opening a person.
function injectCrop(accountId) {
  const rec = sessions.get(accountId);
  if (!rec || rec.view.webContents.isDestroyed()) return;
  if (!store.getPrefs().threadCrop) return;
  rec.view.webContents.executeJavaScript(
    `(function(){try{if(window.__wabSetDeclutter){window.__wabSetDeclutter(true);}if(window.__wabSetThreadCrop){window.__wabSetThreadCrop(true);}}catch(e){}return true;})()`, false
  ).catch(() => { /* mid-navigation */ });
}

// v3: install the engine bridge (idempotent in-page) on every load.
// v14 T3: the bridge FILE is platform-routed; both adapters expose the
// same window.__wabEng surface, so every caller below stays agnostic.
function engineSrcFor(accountId) {
  const acc = store.getAccount(accountId);
  return (acc && acc.platform === 'telegram') ? TG_ENGINE_SRC : ENGINE_SRC;
}

function injectEngine(accountId) {
  const rec = sessions.get(accountId);
  if (!rec || rec.view.webContents.isDestroyed()) return;
  const src = engineSrcFor(accountId);
  if (!src) return;
  rec.view.webContents.executeJavaScript(src, false).catch(() => { /* mid-navigation */ });
}

// D1: reload an engine page and make sure the engine bridge comes back.
// dom-ready/did-navigate re-inject (createSession listeners) and engCall
// self-heals a missing bridge, but a missed event on a freshly reloaded
// page must not strand a live WhatsApp with no __wabEng, so three bounded
// post-reload checks (2.5 s / 6 s / 12 s, past WhatsApp's slow loads)
// install the bridge only when the page reports it missing. The engine's
// own __wabEngInstalled guard makes any redundant inject a no-op. Pure
// insertion insurance; this never sends anything.
function reloadEnginePage(accountId, reason) {
  const rec = sessions.get(accountId);
  if (!wcAlive(rec)) return;
  try { rec.view.webContents.reload(); } catch (eR) { return; }
  debugEvent('engine-error', accountId, reason);
  [2500, 6000, 12000].forEach(ms => {
    setTimeout(() => {
      try {
        const r = sessions.get(accountId);
        if (!wcAlive(r)) return;
        r.view.webContents.executeJavaScript(
          `(function(){try{return !window.__wabEng;}catch(e){return true;}})()`, false)
          .then(missing => { if (missing) injectEngine(accountId); })
          .catch(() => { /* mid-navigation */ });
      } catch (eS) { /* view died under the timer */ }
    }, ms);
  });
}

// v3: call an engine method. Returns the method's resolved value, or {ok:false,error}.
async function engCall(accountId, callSrc) {
  const rec = sessions.get(accountId);
  if (!wcAlive(rec)) return { ok: false, error: 'that account has no live engine' };   // v13 M1: full-hop guard
  const src = engineSrcFor(accountId);   // v14 T3: platform-routed bridge
  if (!src) return { ok: false, error: 'engine bridge not installed yet' };
  try {
    const installed = await rec.view.webContents.executeJavaScript(
      `(function(){try{return !!window.__wabEng;}catch(e){return false;}})()`, false);
    if (!installed) await rec.view.webContents.executeJavaScript(src, false);
    return await rec.view.webContents.executeJavaScript(callSrc, false);
  } catch (e) {
    return { ok: false, error: 'engine call failed: ' + String(e && e.message || e) };
  }
}

// v3 blindfold, enforced on the DATA before anything renders or sends.
function chatAllowed(accountId, title) {
  const cfg = store.getPrivacy(accountId);
  const t = String(title || '');
  if (cfg.mode === 'allow' && !cfg.allow.some(a => titlesMatch(a, t))) return false;
  if (cfg.mode === 'deny' && cfg.deny.some(a => titlesMatch(a, t))) return false;
  return true;
}

// Blindfold door for the per-chat engine calls (send + read). engPeople
// filters a LIST it already holds titles for; engSend and engMessages name
// the target by chat id, so the title comes from the engine's own roster
// first (authoritative: a caller-supplied name must never walk an allowed
// title into a restricted chat), with the caller's title as fallback when
// the roster misses. Fail-closed in allow mode: a title that cannot be
// resolved matches no allow entry, so the door refuses it.
async function chatRestricted(accountId, chatId, title) {
  const cfg = store.getPrivacy(accountId);
  if (cfg.mode !== 'allow' && cfg.mode !== 'deny') return false;   // no blindfold active: skip the roster read
  let t = await resolveChatTitle(accountId, chatId);   // ONE bounded roster read; compare-only, never logged
  if (!t) t = String(title == null ? '' : title);
  return !chatAllowed(accountId, t);
}

// v3 avatars: pulled from each engine's rendered chat list, cached on disk.
// v12.1: people serve INSTANTLY from whatever cache exists (age only gates the
// background re-pull); faces refresh in the background and push an update event.
function avatarCachePath(accountId) {
  return path.join(require('electron').app.getPath('userData'), 'avatars-' + accountId + '.json');
}
function loadAvatarCache(accountId) {
  try {
    const raw = JSON.parse(fs.readFileSync(avatarCachePath(accountId), 'utf8'));
    if (raw && raw.avatars) return { avatars: raw.avatars, savedAt: raw.savedAt || 0 };
  } catch (e) { /* none yet */ }
  return null;
}
function saveAvatarCache(accountId, avatars) {
  try {
    fs.writeFileSync(avatarCachePath(accountId), JSON.stringify({ savedAt: Date.now(), avatars }), 'utf8');
  } catch (e) { /* disk full etc: faces are a nicety */ }
}
// E2: avatar pull throttle state (accountId -> last EMPTY pull ms). A broken
// harvest must not re-fire 80 page fetches on every people poll; a good pull
// clears the marker and the 24 h cache age becomes the only re-pull gate.
const AVATAR_PULL_AT = new Map();
const AVATAR_PULL_RETRY_MS = 10 * 60 * 1000;
function refreshAvatars(accountId) {
  engCall(accountId, `(function(){try{return window.__wabEng.getAvatars(80);}catch(e){return [];}})()`)
    .then(avRes => {
      if (!Array.isArray(avRes)) return;
      const fresh = {};
      for (const a of avRes) {
        const url = String((a && a.avatar) || '');
        // MIME law at the chokepoint: only real faces enter the cache, so the
        // renderer can never swap initials for a broken image ("faces vanish")
        if (url.indexOf('data:image/') === 0 && url.length < 60000) {
          fresh[String(a.title || '').trim()] = url;
        }
      }
      const nFresh = Object.keys(fresh).length;
      if (!nFresh) {
        AVATAR_PULL_AT.set(accountId, Date.now());
        debugEvent('engine-error', accountId, 'avatar pull empty');  // no longer silent
        return;
      }
      AVATAR_PULL_AT.delete(accountId);
      const old = loadAvatarCache(accountId);
      const prev = old ? (old.avatars || {}) : {};
      const merged = Object.assign({}, prev, fresh);   // merge: a partial pull never drops good faces
      let changed = !old;
      if (!changed) for (const k of Object.keys(fresh)) { if (prev[k] !== fresh[k]) { changed = true; break; } }
      saveAvatarCache(accountId, merged);
      debugEvent('people-refresh', accountId, 'avatar pull ok (' + nFresh + ' faces)');  // count fixed
      if (changed && pushHandler) pushHandler('eng:people-updated', { accountId });
    })
    .catch(() => { debugEvent('engine-error', accountId, 'avatar pull failed'); });
}

// E2: title-keyed face lookup with the D2 title law baked in. Engines key
// faces by the DOM row title (2026 WhatsApp = aria-label cut at the first
// comma); engPeople walks IDB/model titles. Exact hit first, then
// normalizeTitle equality, then the shared titlesMatch law (prefix >= 5
// chars either way, digits >= 6) so a "Name" DOM cut still finds the
// "Name Surname" cache key. A miss is null - initials, never a guess.
function avatarFor(avatars, title) {
  const t = String(title || '').trim();
  if (!t || !avatars) return null;
  const hit = avatars[t];
  if (typeof hit === 'string') return hit;
  const nt = normalizeTitle(t);
  let fuzzy = '';
  for (const k of Object.keys(avatars)) {
    if (nt && normalizeTitle(k) === nt) return avatars[k];
    if (!fuzzy && titlesMatch(t, k)) fuzzy = avatars[k];
  }
  return fuzzy || null;
}

// v3 data spine: people (engine or fixtures), blindfolded.
async function engPeople() {
  if (flags.mock) {
    const fx = loadFixtures();
    return (fx.people || []).map(p => Object.assign({}, p, {
      accountId: p.accountId || 'fix_a', accountName: p.accountName || 'Fixture A', accountColor: p.accountColor || '#426CA8',
      platform: p.platform || 'whatsapp'   // v14 T3: renderer badges by platform; fixtures may override
    }));
  }
  const out = [];
  for (const [accountId, rec] of sessions) {
    if (!rec.view || rec.view.webContents.isDestroyed() || rec.status !== 'linked') continue;
    const acc = store.getAccount(accountId);
    if (!acc) continue;
    const res = await engCall(accountId, `(function(){try{return window.__wabEng.listChats();}catch(e){return [];}})()`);
    const chats = Array.isArray(res) ? res : [];

    // Faces: serve the cache instantly (any age); re-pull in the background only
    // when stale or missing, then push an update so the rail never blanks out.
    // E2: an EMPTY pull throttles itself (10 min) so a broken harvest cannot
    // re-fire 80 page fetches on every people poll; a good pull clears it.
    const cache = loadAvatarCache(accountId);
    const avatars = cache ? cache.avatars : {};
    const avatarStale = !cache || Date.now() - cache.savedAt > 24 * 3600 * 1000;
    const avatarThrottled = Date.now() - (AVATAR_PULL_AT.get(accountId) || 0) < AVATAR_PULL_RETRY_MS;
    if (avatarStale && !avatarThrottled) {
      refreshAvatars(accountId);   // fire and forget; pushes eng:people-updated
    }

    for (const c of chats) {
      if (!chatAllowed(accountId, c.title)) continue;   // blindfold: data-deep
      const t = String(c.title || '').trim();
      out.push({
        chatId: c.chatId, title: c.title, unread: c.unread || 0, t: c.t || 0,
        accountId, accountName: acc.name, accountColor: acc.color,
        platform: acc.platform || 'whatsapp',   // v14 T3: from the account record, never from the DOM
        avatar: avatarFor(avatars, t)
      });
    }
  }
  return out;
}

async function engMessages(accountId, chatId, limit) {
  const cap = Math.min(200, Math.max(10, parseInt(limit, 10) || 50));
  if (flags.mock) {
    const fx = loadFixtures();
    return (fx.messages && fx.messages[chatId]) || [];
  }
  // Blindfold door: the same law that filters the people list gates the read.
  // A restricted chat answers an explicit failure object, never an empty
  // array (an empty array would render as a normal quiet chat and hide the
  // refusal, which breaks the fail loud law).
  if (await chatRestricted(accountId, chatId, '')) {
    return { ok: false, error: 'blindfold: this chat is restricted by the account owner' };
  }
  const res = await engCall(accountId,
    `(function(){try{return window.__wabEng.getMessages(${JSON.stringify(String(chatId))}, ${cap});}catch(e){return {ok:false,error:'engine read failed'};}})()`);
  // Z2 seam cut: a failed read must reach the renderer as a failure object,
  // never as a fake empty array (which rendered as "No messages yet").
  return Array.isArray(res) ? res : (res || { ok: false, error: 'engine read returned nothing' });
}

// v13 J1 spine wrappers: endless history. The renderer scrolls up, the engine
// pages older messages out of WhatsApp's own archive via repeated warm loads.
async function engHistory(accountId, chatId, pages) {
  const cap = Math.min(20, Math.max(1, parseInt(pages, 10) || 2));
  if (flags.mock) {
    const fx = loadFixtures();
    const msgs = (fx.messages && fx.messages[chatId]) || [];
    return { ok: true, messages: msgs, grewBy: 0, hasMore: false };
  }
  const res = await engCall(accountId,
    `(function(){try{return window.__wabEng.getMessagesHistory(${JSON.stringify(String(chatId))}, ${cap});}catch(e){return {ok:false,error:'history read failed'};}})()`);
  return res || { ok: false, error: 'history returned nothing' };
}

async function engHasMoreHistory(accountId, chatId) {
  if (flags.mock) return { ok: true, hasMore: false };
  const res = await engCall(accountId,
    `(function(){try{return window.__wabEng.hasMoreHistory(${JSON.stringify(String(chatId))});}catch(e){return {ok:false};}})()`);
  return res || { ok: false, hasMore: false };
}

// v12.8 THE REAL-OPEN ROUTE (the send-failure case, closed): drive the engine's
// own WhatsApp with genuine OS input â€” real clicks at true row coordinates. The
// trial proved: synthetic typing never executes WhatsApp's search; module open
// routes are absent in this build; a REAL click opens the chat every time.
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

function rowQuerySrc(chatId, title) {
  // v13 K1: TITLE-first row matching. Live truth (2026-11-21 selftests):
  // rendered rows carry no data-id on the elements this query walks, so the
  // digit law matched nothing while the same rows were provably clickable
  // at their coordinates. Ladder: (1) title-exact, (2) title law
  // (normalize-equal, startsWith >= 5 chars, >= 6 equal digits: the spine's
  // titlesMatch, inlined below as the third member of the shared/normalize.js
  // KEEP-IN-SYNC family after privacy-inject.js and context-scraper.js),
  // (3) digits from ANY of data-id / id / aria-label (untitled lid chats;
  // >= 6 digits, the digit bridge law; equal digit runs, the run inside the
  // attribute's digits, or the literal run in the raw value; values with an
  // underscore are message-shaped and never match). Same row selectors the trial proved
  // clickable; same center math; the row must now also intersect the
  // viewport (visible-row law). The title is compare-only and never
  // returned or logged beyond its match tier token (privacy law).
  return `(function(){
    var want = String(${JSON.stringify(String(chatId))});
    var wantTitle = String(${JSON.stringify(String(title || ''))});
    var digits = function (s) { return String(s || '').replace(/\\D/g, ''); };
    var wd = digits(want);
    var norm = function (s) {
      try {
        var t = String(s || '').normalize('NFD')
          .replace(/[\\u0300-\\u036f]/g, '')
          .replace(/[\\u200b\\u200d\\ufe0e\\ufe0f]/g, '')
          .toLowerCase()
          .replace(/\\s+/g, ' ');
        t = t.replace(/\\p{Extended_Pictographic}/gu, '');
        t = t.replace(/[\\p{P}\\p{S}\\p{M}\\p{C}]/gu, '');
        return t.replace(/\\s+/g, ' ').trim();
      } catch (e) { try { return String(s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); } catch (e2) { return ''; } }
    };
    var sameTitle = function (a, b) {
      var na = norm(a), nb = norm(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      if (na.length >= 5 && nb.indexOf(na) === 0) return true;
      if (nb.length >= 5 && na.indexOf(nb) === 0) return true;
      var da = digits(a), db = digits(b);
      if (da.length >= 6 && db.length >= 6 && da === db) return true;
      return false;
    };
    // D2: structure-free title tiers. Live 2026 rows carry no testid, no
    // span[title], no span[dir="auto"] (firstTitleLen 0 across 36 rendered
    // rows), so the old ladder always returned '' and the title tiers
    // never matched. New order: legacy attr spans first (mock + older
    // builds), then dir spans, then the row's aria-label ("Name, preview,
    // time" - cut at the first comma), then innerText lines (first line
    // that survives validation, trailing timestamp stripped). Compare-only
    // (privacy law): never returned to the spine, never logged.
    var cand = function (t) {
      t = String(t || '').replace(/\\s+/g, ' ').trim();
      if (!t || t.length < 2) return '';
      if (/^\\d{1,2}:\\d{2}(\\s?[ap]\\.?m\\.?)?$/i.test(t)) return '';
      if (/^\\d{1,2}\\/\\d{1,2}(\\/\\d{2,4})?$/i.test(t) || /^yesterday$|^today$/i.test(t)) return '';
      if (/^\\d+$/.test(t)) return '';
      try { if (!t.replace(/[\\p{Extended_Pictographic}]/gu, '').replace(/[\\s\\u200b\\u200d\\ufe0e\\ufe0f]/g, '')) return ''; } catch (eE) {}
      return t;
    };
    var rowTitle = function (r) {
      var q = null;
      try { q = r.querySelector('[data-testid="cell-frame-title"] span[title]'); } catch (e0) {}
      if (q) { var v0 = cand(q.getAttribute('title')); if (v0) return v0; }
      try { q = r.querySelector('span[title]'); } catch (e1) {}
      if (q) { var v2 = cand(q.getAttribute('title')); if (v2) return v2; }
      var spans = [];
      try { spans = r.querySelectorAll('span[dir="auto"], div[dir="auto"]'); } catch (e3) {}
      for (var k = 0; k < spans.length; k++) {
        var tx = cand(spans[k] ? spans[k].textContent : '');
        if (tx) return tx;
      }
      var ar = '';
      try { ar = (r.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(); } catch (eA) {}
      if (ar) {
        var cut = ar.indexOf(', ') !== -1 ? ar.slice(0, ar.indexOf(', ')) : ar;
        cut = cut.replace(/^chat with\\s+/i, '');
        var vc = cand(cut) || cand(ar);
        if (vc) return vc;
      }
      var lines = [];
      try { lines = String(r.innerText || '').split(/\\n+/); } catch (eL) {}
      for (var li = 0; li < lines.length; li++) {
        var lt = cand(lines[li].replace(/\\s+\\d{1,2}:\\d{2}(\\s?[ap]\\.?m\\.?)?$/i, ''));
        if (lt) return lt;
      }
      return '';
    };
    var center = function (r) {
      var b = r.getBoundingClientRect();
      var vh = window.innerHeight || 9999;
      var vw = window.innerWidth || 9999;
      if (b.width > 2 && b.height > 2 && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw) {
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 30)) };
      }
      return null;
    };
    var rows = document.querySelectorAll('[data-testid="cell-frame-container"], #pane-side [role="row"]');
    var i, r, c;
    if (wantTitle) {
      var nt = norm(wantTitle);
      for (i = 0; i < rows.length; i++) {   // tier 1: normalize-exact title
        r = rows[i];
        var rt = rowTitle(r);
        if (!rt || !nt) continue;
        if (norm(rt) !== nt) continue;
        c = center(r);
        if (c) { c.by = 'title'; return c; }
      }
      for (i = 0; i < rows.length; i++) {   // tier 2: full title law
        r = rows[i];
        var rt2 = rowTitle(r);
        if (!rt2) continue;
        if (!sameTitle(rt2, wantTitle)) continue;
        c = center(r);
        if (c) { c.by = 'title'; return c; }
      }
    }
    if (wd && wd.length >= 6) {
      for (i = 0; i < rows.length; i++) {   // tier 3: digits from any id-ish attribute
        r = rows[i];
        var attrs = ['data-id', 'id', 'aria-label'];
        var hitAttr = false;
        for (var j = 0; j < attrs.length; j++) {
          var av = '';
          try { av = r.getAttribute(attrs[j]) || ''; } catch (eA) {}
          if (!av || av.indexOf('_') !== -1) continue;   // message-shaped ids never match
          var ad = digits(av);
          if (ad === wd || ad.indexOf(wd) !== -1 || av.indexOf(wd) !== -1) { hitAttr = true; break; }
        }
        if (!hitAttr) continue;
        c = center(r);
        if (c) { c.by = 'digits'; return c; }
      }
    }
    return null;
  })()`;
}

const VERIFY_OPEN_SRC = `(function(){
  try { return { composer: document.querySelectorAll('footer div[contenteditable="true"]').length }; }
  catch (e) { return { composer: 0 }; }
})()`;

// v13 K1: spine-side roster lookup that feeds the title tier. The roster is
// the same people data engPeople serves (engine listChats); ONE bounded read
// per open, only when the caller passed no title, so every route (preopen,
// send, selftest) title-matches on day one without waiting on cross-file
// seams. The title is compare-only and never reaches any debug string.
async function resolveChatTitle(accountId, chatId) {
  try {
    const res = await engCall(accountId, `(function(){try{return window.__wabEng.listChats();}catch(e){return [];}})()`);
    const chats = Array.isArray(res) ? res : [];
    const want = String(chatId || '');
    for (const c of chats) {
      if (c && c.chatId === want && c.title) return String(c.title);
    }
  } catch (eR) { /* roster miss: the digit tier still runs */ }
  return '';
}

// v13 D7: the REAL-TYPING search open (H4's engine coordinates + real input).
// For chats whose rows are unreachable by list scrolling: real-click the search
// box, type with real keystrokes, poll the result row, real-click it. Never sends.
let searchOpenFlight = new Set();
async function engRealSearchOpen(accountId, chatId, title) {
  if (searchOpenFlight.has(accountId)) return { ok: false, error: 'search open already in flight' };
  searchOpenFlight.add(accountId);
  const release = () => searchOpenFlight.delete(accountId);
  try {
    const rec = sessions.get(accountId);
    if (!rec || rec.view.webContents.isDestroyed()) return { ok: false, error: 'no live engine' };
    const wc = rec.view.webContents;
    const call = async (src) => { try { return await wc.executeJavaScript(src, false); } catch (e) { return null; } };

    // Free win: the target row may already be on screen.
    let row = await call(`(function(){try{return window.__wabEng.searchResultCoords(${JSON.stringify(String(chatId))}, ${JSON.stringify(String(title || ''))});}catch(e){return null;}})()`);

    if (!row) {
      // Query ladder (v13 K1): phone digits when >= 6 (the digit bridge law);
      // else the title's first word when >= 5 chars (the startsWith law,
      // lowercased, capped at 12 chars so typing stays quick); else whatever
      // digits exist. The engine's searchResultCoords title tier matches the
      // result row once the word is typed.
      const digits = String(chatId).replace(/\D/g, '');
      const ttl = String(title || '').trim();
      const firstWord = ttl ? ttl.split(/\s+/)[0].toLowerCase().slice(0, 12) : '';
      let query = '';
      if (digits.length >= 6) query = digits;
      else if (firstWord.length >= 5) query = firstWord;
      else if (digits) query = digits;
      if (!query) { release(); return { ok: false, error: 'no searchable text for this chat' }; }
      const box = await call(`(function(){try{return window.__wabEng.searchTargetCoords(${JSON.stringify(query)});}catch(e){return null;}})()`);
      if (!box || !box.boxX) { release(); return { ok: false, error: 'search box not reachable' }; }
      try { wc.focus(); } catch (eF) {}
      // Real-click the box, clear it, type the query as real keystrokes.
      await wc.sendInputEvent({ type: 'mouseMove', x: box.boxX, y: box.boxY });
      await sleepMs(120 + Math.floor(Math.random() * 100));
      await wc.sendInputEvent({ type: 'mouseDown', x: box.boxX, y: box.boxY, button: 'left', clickCount: 1 });
      await wc.sendInputEvent({ type: 'mouseUp', x: box.boxX, y: box.boxY, button: 'left', clickCount: 1 });
      await sleepMs(250 + Math.floor(Math.random() * 180));
      for (let esc = 0; esc < 2; esc++) {
        await wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        await wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await sleepMs(80);
      }
      for (const ch of query) {
        await wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
        await wc.sendInputEvent({ type: 'char', keyCode: ch });
        await wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
        await sleepMs(40);
      }
      // Poll for the result row (id digits first, title tier for id-less rows).
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        await sleepMs(250 + Math.floor(Math.random() * 180));
        row = await call(`(function(){try{return window.__wabEng.searchResultCoords(${JSON.stringify(String(chatId))}, ${JSON.stringify(String(title || ''))});}catch(e){return null;}})()`);
        if (row) break;
      }
    }

    let ok = false;
    if (row && row.x) {
      try { wc.focus(); } catch (eF2) {}
      await wc.sendInputEvent({ type: 'mouseMove', x: row.x, y: row.y });
      await sleepMs(120 + Math.floor(Math.random() * 100));
      await wc.sendInputEvent({ type: 'mouseDown', x: row.x, y: row.y, button: 'left', clickCount: 1 });
      await wc.sendInputEvent({ type: 'mouseUp', x: row.x, y: row.y, button: 'left', clickCount: 1 });
      await sleepMs(1200);
      const v = await call(VERIFY_OPEN_SRC);
      ok = !!(v && v.composer > 0);
      if (!ok) {
        // The trial law: second click lands.
        await wc.sendInputEvent({ type: 'mouseMove', x: row.x, y: row.y });
        await sleepMs(200);
        await wc.sendInputEvent({ type: 'mouseDown', x: row.x, y: row.y, button: 'left', clickCount: 1 });
        await wc.sendInputEvent({ type: 'mouseUp', x: row.x, y: row.y, button: 'left', clickCount: 1 });
        await sleepMs(1200);
        const v2 = await call(VERIFY_OPEN_SRC);
        ok = !!(v2 && v2.composer > 0);
      }
    }

    if (!ok) {
      // Evidence snapshot (v13 K1): what the overlay actually held when the
      // poll never found the target row. Overlay bool, row count, first row
      // title LENGTH only. Never a name (privacy law).
      try {
        const snap = await call(`(function(){
          // D2: probe with the SAME ladder rowQuerySrc uses; report the
          // winning tier token + length only (privacy law: never a name).
          var cand = function (t) {
            t = String(t || '').replace(/\\s+/g, ' ').trim();
            if (!t || t.length < 2) return '';
            if (/^\\d{1,2}:\\d{2}(\\s?[ap]\\.?m\\.?)?$/i.test(t)) return '';
            if (/^\\d{1,2}\\/\\d{1,2}(\\/\\d{2,4})?$/i.test(t) || /^yesterday$|^today$/i.test(t)) return '';
            if (/^\\d+$/.test(t)) return '';
            try { if (!t.replace(/[\\p{Extended_Pictographic}]/gu, '').replace(/[\\s\\u200b\\u200d\\ufe0e\\ufe0f]/g, '')) return ''; } catch (eE) {}
            return t;
          };
          var probe = function (r) {
            var q = null;
            try { q = r.querySelector('span[title]'); } catch (e1) {}
            if (q) { var v = cand(q.getAttribute('title')); if (v) return { len: v.length, tier: 'attr' }; }
            var sp = [];
            try { sp = r.querySelectorAll('span[dir="auto"], div[dir="auto"]'); } catch (e2) {}
            for (var k = 0; k < sp.length; k++) {
              var tx = cand(sp[k] ? sp[k].textContent : '');
              if (tx) return { len: tx.length, tier: 'span' };
            }
            var ar = '';
            try { ar = (r.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(); } catch (e3) {}
            if (ar) {
              var cut = ar.indexOf(', ') !== -1 ? ar.slice(0, ar.indexOf(', ')) : ar;
              cut = cut.replace(/^chat with\\s+/i, '');
              var vc = cand(cut) || cand(ar);
              if (vc) return { len: vc.length, tier: 'aria' };
            }
            var lines = [];
            try { lines = String(r.innerText || '').split(/\\n+/); } catch (e4) {}
            for (var li = 0; li < lines.length; li++) {
              var lt = cand(lines[li].replace(/\\s+\\d{1,2}:\\d{2}(\\s?[ap]\\.?m\\.?)?$/i, ''));
              if (lt) return { len: lt.length, tier: 'line' };
            }
            return null;
          };
          var ov = document.querySelector('[data-testid="overlay"]');
          var scope = ov || document.querySelector('#pane-side') || document;
          var rows = scope.querySelectorAll('[data-testid="cell-frame-container"], [role="row"]');
          var p = rows[0] ? probe(rows[0]) : null;
          var hooks = 0;
          try { hooks = rows[0] ? rows[0].querySelectorAll('span[title], span[dir="auto"], div[dir="auto"], [data-testid="cell-frame-title"]').length : 0; } catch (e5) {}
          return {
            overlay: !!ov,
            rowCount: rows.length,
            firstTitleLen: p ? p.len : 0,
            firstTitleTier: p ? p.tier : '',
            hookEls: hooks
          };
        })()`);
        debugEvent('open-step', accountId, 'search miss snapshot: ' + JSON.stringify(snap));
      } catch (eS) { /* snapshot is diagnostic only */ }
    }
    // Always restore the engine's curtain state and clear the search.
    await call(`(function(){try{return window.__wabEng.searchDone();}catch(e){return null;}})()`);
    try { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); } catch (eEsc1) { /* void */ }
    try { wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); } catch (eEsc2) { /* void */ }
    debugEvent('open-step', accountId, ok ? 'real-search open win' : 'real-search open failed');
    return ok ? { ok: true } : { ok: false, error: 'search route could not open this chat' };
  } catch (e) {
    return { ok: false, error: 'search open error: ' + String(e && e.message || e) };
  } finally {
    release();   // bulletproof: the flight lock frees on every path
  }
}

async function engRealOpen(accountId, chatId, title) {
  const rec = sessions.get(accountId);
  if (!rec || rec.view.webContents.isDestroyed()) return { ok: false, error: 'no live engine' };
  const wc = rec.view.webContents;
  // v13 K1: the row match is TITLE-first (live rows carry no data-id on the
  // elements the query walks). Callers that know the title pass it; when none
  // came, ONE bounded roster read fills it. Resolved ONCE per open, before
  // the attempts, never inside the retry loop.
  let ttl = String(title == null ? '' : title);
  if (!ttl) {
    ttl = await resolveChatTitle(accountId, chatId);
    if (ttl) debugEvent('open-step', accountId, 'row title resolved from roster');
  }
  const attempt = async () => {
    let coords = null;
    try { coords = await wc.executeJavaScript(rowQuerySrc(chatId, ttl), false); } catch (eQ) { coords = null; }
    if (!coords) {
      // Row not in view. Hunt BOTH directions: first back to the TOP (newest chats
      // live above the viewport after deep scrolls), then downward, page by page.
      for (let page = 0; page < 4; page++) {
        try { await wc.sendInputEvent({ type: 'mouseWheel', x: 200, y: 400, deltaY: -900, deltaMode: 0 }); } catch (eW1) { break; }
        await sleepMs(250 + Math.floor(Math.random() * 180));
        try { coords = await wc.executeJavaScript(rowQuerySrc(chatId, ttl), false); } catch (eQ1) { coords = null; }
        if (coords) break;
      }
      if (!coords) {
        for (let page = 0; page < 4; page++) {
          try { await wc.sendInputEvent({ type: 'mouseWheel', x: 200, y: 400, deltaY: 900, deltaMode: 0 }); } catch (eW2) { break; }
          await sleepMs(250 + Math.floor(Math.random() * 180));
          try { coords = await wc.executeJavaScript(rowQuerySrc(chatId, ttl), false); } catch (eQ2) { coords = null; }
          if (coords) break;
        }
      }
    }
    if (!coords) {
      // Evidence snapshot: what does the engine actually see right now?
      try {
        const snap = await wc.executeJavaScript(`(function(){
          // D2: same probe ladder as the search-miss snapshot; lengths,
          // tier tokens and element counts only (privacy law).
          var cand = function (t) {
            t = String(t || '').replace(/\\s+/g, ' ').trim();
            if (!t || t.length < 2) return '';
            if (/^\\d{1,2}:\\d{2}(\\s?[ap]\\.?m\\.?)?$/i.test(t)) return '';
            if (/^\\d{1,2}\\/\\d{1,2}(\\/\\d{2,4})?$/i.test(t) || /^yesterday$|^today$/i.test(t)) return '';
            if (/^\\d+$/.test(t)) return '';
            try { if (!t.replace(/[\\p{Extended_Pictographic}]/gu, '').replace(/[\\s\\u200b\\u200d\\ufe0e\\ufe0f]/g, '')) return ''; } catch (eE) {}
            return t;
          };
          var probe = function (r) {
            var sp = [];
            try { sp = r.querySelectorAll('span[dir="auto"], div[dir="auto"]'); } catch (e2) {}
            for (var k = 0; k < sp.length; k++) {
              var tx = cand(sp[k] ? sp[k].textContent : '');
              if (tx) return { len: tx.length, tier: 'span' };
            }
            var ar = '';
            try { ar = (r.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(); } catch (e3) {}
            if (ar) {
              var cut = ar.indexOf(', ') !== -1 ? ar.slice(0, ar.indexOf(', ')) : ar;
              cut = cut.replace(/^chat with\\s+/i, '');
              var vc = cand(cut) || cand(ar);
              if (vc) return { len: vc.length, tier: 'aria' };
            }
            var lines = [];
            try { lines = String(r.innerText || '').split(/\\n+/); } catch (e4) {}
            for (var li = 0; li < lines.length; li++) {
              var lt = cand(lines[li].replace(/\\s+\\d{1,2}:\\d{2}(\\s?[ap]\\.?m\\.?)?$/i, ''));
              if (lt) return { len: lt.length, tier: 'line' };
            }
            return null;
          };
          var list = document.querySelector('#pane-side, [data-testid="drawer-left"]');
          var lb = list ? list.getBoundingClientRect() : null;
          var rows = document.querySelectorAll('[data-testid="cell-frame-container"], #pane-side [role="row"]');
          var p = rows[0] ? probe(rows[0]) : null;
          return {
            listRect: lb ? [Math.round(lb.left), Math.round(lb.top), Math.round(lb.width), Math.round(lb.height)] : null,
            rowCount: rows.length,
            firstRowRect: (function(){var r=rows[0];if(!r)return null;var b=r.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)];})(),
            firstTitleLen: p ? p.len : 0,
            firstTitleTier: p ? p.tier : '',
            hookEls: (function(){var r=rows[0];if(!r)return 0;try{return r.querySelectorAll('span[title], span[dir="auto"], div[dir="auto"], [data-testid="cell-frame-title"]').length;}catch(eH){return 0;}})(),
            at200x400: (function(){var e=document.elementFromPoint(200,400);return e?{tag:e.tagName,cls:String(e.className||'').slice(0,40),testid:e.getAttribute('data-testid')||null}:null;})()
          };
        })()`, false);
        debugEvent('open-step', accountId, 'row miss snapshot: ' + JSON.stringify(snap));
      } catch (eS) { /* snapshot is diagnostic only */ }
      return { ok: false, error: 'chat row not reachable in the list' };
    }
    try { wc.focus(); } catch (eF) {}
    try {
      await wc.sendInputEvent({ type: 'mouseMove', x: coords.x, y: coords.y });
      await sleepMs(280 + Math.floor(Math.random() * 200));
      await wc.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
      await wc.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    } catch (eC) { return { ok: false, error: 'real click dispatch failed' }; }
    await sleepMs(1200);
    try {
      const v = await wc.executeJavaScript(VERIFY_OPEN_SRC, false);
      if (v && v.composer > 0) return { ok: true, by: coords.by || 'row' };
    } catch (eV) { /* verify below */ }
    try {
      const hit = await wc.executeJavaScript(`(function(){var e=document.elementFromPoint(${coords.x},${coords.y});return e?{tag:e.tagName,cls:String(e.className||'').slice(0,50),testid:e.getAttribute('data-testid')||null,dataId:(e.closest('[data-id]')||null)?'row':'no-row'}:null;})()`, false);
      debugEvent('open-step', accountId, 'click refused snapshot: ' + JSON.stringify(hit));
    } catch (eS2) { /* diagnostic only */ }
    return { ok: false, error: 'click not registered' };
  };
  // The trial's truth: the first real click warms focus, the second lands. Retry once.
  let r = await attempt();
  if (!r.ok) r = await attempt();
  if (!r.ok && r.error === 'chat row not reachable in the list') {
    // D7: rows beyond the scroll get the real-typing search route.
    r = await engRealSearchOpen(accountId, chatId, ttl);
  }
  debugEvent('open-step', accountId, r.ok ? 'real-click open win (row by ' + String(r.by || 'search') + ')' : 'real-click open failed: ' + r.error);
  // V13 H2 spine invariant: engSend skips the reopen when its preOpened map
  // matches, so the map must ALWAYS name the chat the engine actually sits
  // on. Every successful real-open stamps the belief (callers that stamp it
  // again are harmless); a failed open leaves it untouched. Without this,
  // any direct engRealOpen caller (the selftest) could leave the map stale
  // and a later send would fire into the wrong open chat.
  if (r && r.ok) preOpened.set(accountId, chatId);
  return r;
}

// v12.4 speed law: the engine pre-opens a conversation when it is VIEWED, so by
// the time the operator presses Send the engine is already sitting on the chat.
const preOpened = new Map();   // accountId -> chatId (spine's belief; engine verifies)
function engPreOpen(accountId, chatId, title) {
  if (flags.mock) return Promise.resolve({ ok: true, echo: true });
  if (preOpened.get(accountId) === chatId) {
    return Promise.resolve({ ok: true, preopened: true });
  }
  debugEvent('open-step', accountId, 'pre-opening chat on view');
  // v14 T3: Telegram opens through the adapter (T2 owns that DOM). The
  // real-input ladder below is WhatsApp selectors by design and must
  // never run against a Telegram page.
  const accP = store.getAccount(accountId);
  if (accP && accP.platform === 'telegram') {
    return engCall(accountId,
      `(function(){try{return window.__wabEng.openChat(${JSON.stringify(String(chatId))});}catch(e){return {ok:false,error:'open failed'};}})()`)
      .then(r => {
        if (r && r.ok) preOpened.set(accountId, chatId);
        debugEvent('open-step', accountId, (r && r.ok) ? 'pre-open ok' : 'pre-open failed: ' + ((r && r.error) || 'no result'));
        return r;
      });
  }
  // PRIMARY: the real-click route (proven live). Module routes stay as a fast-path attempt.
  return engRealOpen(accountId, chatId, title).then(r => {
    if (!r.ok) {
      // Fallback: the engine's internal ladder (module routes), then accept whichever worked.
      return engCall(accountId, `(function(){try{return window.__wabEng.openChat(${JSON.stringify(String(chatId))});}catch(e){return {ok:false,error:'open failed'};}})()`)
        .then(r2 => {
          const best = (r2 && r2.ok) ? r2 : r;
          if (best.ok) preOpened.set(accountId, chatId);
          debugEvent('open-step', accountId, best.ok ? 'pre-open ok' : 'pre-open failed: ' + (best.error || 'no result'));
          return best;
        });
    }
    preOpened.set(accountId, chatId);
    return r;
  });
}

// v13.2 REAL-TYPING SEND (the drill's verdict: 2026 WhatsApp's composer rejects
// synthetic inserts exactly like its search box â€” all six failures died at
// 'text verify failed'). Real click on the composer, real keystrokes for every
// character, read-back verify, real click on the send button, ack = the box
// empties + the message count grows. The operator's click is still the only
// thing that triggers any of this.
const COMPOSER_COORDS_SRC = `(function(){
  var q = function (s) { try { return document.querySelectorAll(s); } catch (e) { return []; } };
  var list = q('footer div[contenteditable="true"]');
  if (!list.length) list = q('div[contenteditable="true"][data-tab]');
  for (var i = 0; i < list.length; i++) {
    var b = list[i].getBoundingClientRect();
    if (b.width > 40 && b.height > 16) {
      return { x: Math.round(b.left + Math.min(40, b.width / 2)), y: Math.round(b.top + b.height / 2) };
    }
  }
  return null;
})()`;

const COMPOSER_TEXT_SRC = `(function(){
  var q = function (s) { try { return document.querySelectorAll(s); } catch (e) { return []; } };
  var list = q('footer div[contenteditable="true"]');
  if (!list.length) list = q('div[contenteditable="true"][data-tab]');
  for (var i = 0; i < list.length; i++) {
    var b = list[i].getBoundingClientRect();
    if (b.width > 40 && b.height > 16) return (list[i].textContent || '').replace(/\\u00a0/g, ' ').trim();
  }
  return null;
})()`;

const SEND_BTN_COORDS_SRC = `(function(){
  var footer = document.querySelector('footer');
  if (!footer) return null;
  var btn = footer.querySelector('button[aria-label="Send"], [role="button"][aria-label="Send"]');
  if (!btn) {
    var titles = footer.querySelectorAll('title');
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent || '').trim() === 'wds-ic-send-filled') {
        btn = titles[i].closest('button, [role="button"]'); break;
      }
    }
  }
  if (!btn) return null;
  var b = btn.getBoundingClientRect();
  if (b.width < 4) return null;
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`;

async function engRealTypeSend(accountId, text) {
  const rec = sessions.get(accountId);
  if (!rec || rec.view.webContents.isDestroyed()) return { ok: false, error: 'no live engine' };
  const wc = rec.view.webContents;
  const call = async (src) => { try { return await wc.executeJavaScript(src, false); } catch (e) { return null; } };
  const realClick = async (x, y) => {
    try { wc.focus(); } catch (eF) {}
    await wc.sendInputEvent({ type: 'mouseMove', x, y });
    await sleepMs(120);
    await wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleepMs(200);
  };

  // 1. Composer present + coords.
  let box = await call(COMPOSER_COORDS_SRC);
  if (!box) return { ok: false, error: 'composer not present (chat not open?)' };

  // 2. Real-click it, select-all + delete to clear.
  await realClick(box.x, box.y);
  try {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['ctrl'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['ctrl'] });
  } catch (eA) { /* empty box anyway */ }
  await sleepMs(120);
  try {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
  } catch (eD) { /* fine */ }
  await sleepMs(120 + Math.floor(Math.random() * 100));

  // 3. THE CLIPBOARD PASTE: per-char keyDown/char/keyUp is unreliable (the
  // drill proved it: 6/6 failed at "text verify failed"). A real Ctrl+V paste
  // is ONE atomic keyboard event the browser processes natively — the same
  // paste the operator would do by hand. Fast, atomic, reliable.
  const { clipboard } = require('electron');
  clipboard.writeText(String(text));
  await sleepMs(80);
  try {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: ['ctrl'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: ['ctrl'] });
  } catch (eV) { /* paste attempt */ }
  await sleepMs(400);

  // 4. Verify by reading the box back (reads are safe; writes were the ghost).
  const typed = await call(COMPOSER_TEXT_SRC);
  const want = String(text).replace(/Â /g, ' ').trim();
  if (typed === null || typed !== want) {
    debugEvent('send-step', accountId, 'real-typing verify mismatch (got len ' + (typed === null ? -1 : typed.length) + ', want ' + want.length + ')');
    return { ok: false, error: 'real-typing verify failed' };
  }
  debugEvent('send-step', accountId, 'real-typing insert verified');

  // 5. Real-click the send button.
  const btn = await call(SEND_BTN_COORDS_SRC);
  if (!btn) return { ok: false, error: 'send button not found' };
  await realClick(btn.x, btn.y);

  // 6. Ack: the composer empties (WhatsApp clears on send).
  for (let i = 0; i < 8; i++) {
    await sleepMs(400);
    const now = await call(COMPOSER_TEXT_SRC);
    if (now === '') {
      debugEvent('send-step', accountId, 'real-typing send confirmed (box cleared)');
      return { ok: true };
    }
  }
  debugEvent('send-step', accountId, 'real-typing ack miss (box did not clear)');
  return { ok: false, error: 'send click did not register (text still in composer)' };
}

// v3 send: his click only. The engine is pre-opened; open here only as fallback.
async function engSend(accountId, chatId, text, title) {
  const clean = String(text == null ? '' : text);
  if (!clean.trim()) return { ok: false, error: 'nothing to send' };
  if (flags.mock) {
    debugEvent('send-step', accountId, 'fixture echo send');
    await new Promise(r => setTimeout(r, 800));
    return { ok: true, echo: true };
  }
  // Blindfold door: cannot send into a chat the blindfold hides. ENFORCED,
  // not just claimed: the same chatAllowed law that filters the people list
  // runs here first, on the roster's own title for this chat id, so a
  // restricted chat is refused before any open, typing, clipboard write,
  // engine call or ledger row can happen.
  const acc = store.getAccount(accountId);
  if (!acc) return { ok: false, error: 'unknown account' };
  if (await chatRestricted(accountId, chatId, title)) {
    debugEvent('send-step', accountId, 'send refused by the blindfold (restricted chat)');
    return { ok: false, error: 'blindfold: this chat is restricted by the account owner' };
  }
  if (preOpened.get(accountId) !== chatId) {
    debugEvent('send-step', accountId, 'engine not on this chat, opening');
    // v14 T3: Telegram opens through the adapter (the WA real-input
    // selectors would stare at a Telegram page); WhatsApp keeps the
    // proven ladder. acc is already resolved above in this function.
    let opened = (acc.platform === 'telegram')
      ? await engCall(accountId,
          `(function(){try{return window.__wabEng.openChat(${JSON.stringify(String(chatId))});}catch(e){return {ok:false,error:'open failed'};}})()`)
      : await engRealOpen(accountId, chatId, title);
    if (!opened || !opened.ok) {
      opened = await engCall(accountId,
        `(function(){try{return window.__wabEng.openChat(${JSON.stringify(String(chatId))});}catch(e){return {ok:false,error:'open failed'};}})()`);
    }
    if (!opened || !opened.ok) {
      debugEvent('send-step', accountId, 'open failed: ' + ((opened && opened.error) || 'no result'));
      return { ok: false, error: (opened && opened.error) || 'could not open that chat in the engine' };
    }
    preOpened.set(accountId, chatId);
  }
  debugEvent('send-step', accountId, 'chat open, sending');
  // PRIMARY: real-typing send (the drill proved synthetic inserts die). The
  // engine-internal send() stays as fallback for builds that accept it.
  // v14 T3: Telegram sends through the adapter's own send (T2 owns that
  // DOM); the composer/send-button scans in engRealTypeSend are WhatsApp
  // layout only (footer, wds-ic-send-filled).
  let sent = (acc.platform === 'telegram')
    ? await engCall(accountId,
        `(function(){try{return window.__wabEng.send(${JSON.stringify(clean)});}catch(e){return {ok:false,error:'send failed'};}})()`)
    : await engRealTypeSend(accountId, clean);
  if (!sent || !sent.ok) {
    debugEvent('send-step', accountId, 'real-typing path failed, trying engine-internal fallback');
    sent = await engCall(accountId,
      `(function(){try{return window.__wabEng.send(${JSON.stringify(clean)});}catch(e){return {ok:false,error:'send failed'};}})()`);
  }
  const okSend = sent && sent.ok === true;
  debugEvent('send-step', accountId, okSend ? 'send confirmed' : 'send failed: ' + ((sent && sent.error) || 'no result'));
  // The operator's own activity record: metadata only, his sends are his ledger.
  try {
    store.logSend({ accountId, accountName: acc ? acc.name : '', chatId, title: String(title || ''), ok: okSend });
  } catch (eLog) { /* stats are a nicety */ }
  if (!okSend) {
    // Autopsy on the tin: the engine's last steps ride along in the error so the
    // operator sees exactly which door refused, without opening any panel.
    try {
      const tail = await engCall(accountId, `(function(){try{return window.__wabEng.debugTail?window.__wabEng.debugTail():[];}catch(e){return [];}})()`);
      if (Array.isArray(tail) && tail.length) {
        const last = tail.slice(-3).join(' | ');
        return Object.assign({}, sent, { error: ((sent && sent.error) || 'send failed') + '. Last steps: ' + String(last).slice(0, 180) });
      }
    } catch (eT) { /* tail is a nicety */ }
  }
  return sent && typeof sent.ok === 'boolean' ? sent : { ok: false, error: 'engine send returned nothing' };
}

async function engHealth() {
  const out = {};
  for (const [accountId] of sessions) {
    const res = await engCall(accountId, `(function(){try{return window.__wabEng.health();}catch(e){return {idb:false,modules:false,lastError:'no engine'};}})()`);
    out[accountId] = res || { idb: false, modules: false, lastError: 'no result' };
  }
  return out;
}

// ---------- V13 H2: spine-owned timer registry ----------
// Every interval this module creates is registered here so --selftest (and
// any future leak hunt) can report how many timers the spine owns (docket
// D9/D12). Nothing else changes: same callbacks, same periods. Nothing
// clears these today, so the created count IS the live count; a future clear
// path must splice its entry out.
const spineTimers = [];
function trackInterval(label, fn, ms) {
  // v13 M1: a tracked interval's async body must never reject unhandled -
  // a poll tick landing mid-teardown (view closing under it) used to
  // surface as an unhandled rejection and could take the smoke gate down.
  const wrapped = () => {
    try { Promise.resolve(fn()).catch(() => { /* mid-teardown tick; next tick retries */ }); }
    catch (eS) { /* sync throw: same law, never kill the spine */ }
  };
  const id = setInterval(wrapped, ms);
  spineTimers.push({ label: String(label), ms: ms, at: Date.now() });
  return id;
}
function timerReport() {
  return spineTimers.map(t => ({ label: t.label, ms: t.ms, ageS: Math.round((Date.now() - t.at) / 1000) }));
}

// ---------- status + unread polling ----------

const PROBE_SRC = `(function(){try{return {title:document.title||'', hasList:!!(document.querySelector('#pane-side')||document.querySelector('[data-testid="chat-list"]')||document.querySelector('[role="listbox"]'))};}catch(e){return {title:'',hasList:false};}})()`;
// v14 T3: WhatsApp's DOM probe must never judge a Telegram page (#pane-side
// is WhatsApp layout; it would read linking forever). Telegram's linked
// signal is the ADAPTER contract instead: listChats answers a real array
// only on a logged-in page. Works for sync and async listChats;
// executeJavaScript awaits the returned promise either way.
const TG_PROBE_SRC = `(function(){try{var p=(window.__wabEng&&window.__wabEng.listChats)?window.__wabEng.listChats():[];return Promise.resolve(p).then(function(c){return {title:document.title||'',hasList:Array.isArray(c)&&c.length>0};});}catch(e){return {title:'',hasList:false};}})()`;

function startPolling(push) {
  trackInterval('poll', async () => {
    for (const [accountId, rec] of sessions) {
      if (!wcAlive(rec)) continue;   // v13 M1: full-hop guard
      try {
        const probe = await rec.view.webContents.executeJavaScript(
          (store.getAccount(accountId) || {}).platform === 'telegram' ? TG_PROBE_SRC : PROBE_SRC, false);
        // status machine: linking -> linked on first chat list; linked -> logged-out after 3 misses
        if (probe && probe.hasList) {
          rec.missCount = 0;
          if (rec.status !== 'linked') {
            rec.status = 'linked';
            const acc = store.getAccount(accountId);
            if (acc && acc.status !== 'linked') {
              store.upsertAccount(Object.assign({}, acc, { status: 'linked' }));
            }
            // Detach the view from the QR window BEFORE closing it: closing a
            // window destroys its BrowserViews, and this view IS the live session.
            if (rec.qrWindow && !rec.qrWindow.isDestroyed()) {
              try { rec.qrWindow.contentView.removeChildView(rec.view); } catch (e) { /* already gone */ }
              rec.qrWindow.close();
              rec.qrWindow = null;
            }
            attachToFreeSlot(accountId);
            push('app:onToast', { kind: 'info', text: (acc ? acc.name : 'Account') + ' linked, opening chats' });
            push('accounts:onStatus', { accountId, status: 'linked' });
            push('accounts:list-changed', {});
            relayout();
          }
        } else {
          if (rec.status === 'linked') {
            rec.missCount += 1;
            if (rec.missCount >= 3) {
              rec.status = 'logged-out';
              const acc = store.getAccount(accountId);
              if (acc) store.upsertAccount(Object.assign({}, acc, { status: 'logged-out' }));
              push('accounts:onStatus', { accountId, status: 'logged-out' });
              push('accounts:list-changed', {});
            }
          }
        }

        // unread counts (allowed + restricted; restricted is never named anywhere)
        const unread = await rec.view.webContents.executeJavaScript(
          `(function(){try{return window.__wabGetUnread?window.__wabGetUnread():{allowed:0,restricted:0};}catch(e){return {allowed:0,restricted:0};}})()`, false);
        if (unread) {
          const prev = rec.lastUnread || { allowed: 0, restricted: 0 };
          if (unread.allowed > prev.allowed) {
            const acc = store.getAccount(accountId);
            push('app:onToast', { kind: 'allowed', text: 'New message on ' + (acc ? acc.name : 'an account') });
          }
          if (unread.restricted > prev.restricted) {
            push('app:onToast', { kind: 'restricted', text: 'New message in a restricted chat' });
          }
          rec.lastUnread = unread;
          push('app:onUnread', { accountId, allowed: unread.allowed || 0, restricted: unread.restricted || 0 });
        }
      } catch (e) { /* view mid-navigation; next tick retries */ }
    }
  }, 2500);
}

// ---------- layout / slots ----------

let pushHandler = null;
function setPushHandler(fn) { pushHandler = fn; }

// v12.5 typing poller: every 2s per linked engine, pushes the set of titles
// whose chats show a typing indicator. Titles only (they are already public
// in the people list); no message text ever.
let typingPollTimer = null;
function startTypingPoll() {
  if (typingPollTimer) return;
  typingPollTimer = trackInterval('typing-poll', async () => {
    if (flags.mock || !pushHandler) return;
    for (const [accountId, rec] of sessions) {
      if (!wcAlive(rec) || rec.status !== 'linked') continue;   // v13 M1: full-hop guard
      try {
        const res = await rec.view.webContents.executeJavaScript(
          `(function(){try{return window.__wabEng&&window.__wabEng.getTyping?window.__wabEng.getTyping():[];}catch(e){return [];}})()`, false);
        if (Array.isArray(res)) pushHandler('eng:on-typing', { accountId, titles: res.slice(0, 20) });
      } catch (e) { /* mid-navigation */ }
    }
  }, 2000);
}

// v13.2 THE WATCHDOG (the owner's law: constant monitoring while the app is open,
// with a self-healing loop). Every 15s it reads the ring + engine states and
// heals what it safely can: dead engines reloaded from their persisted
// partitions, stale open-beliefs cleared after send failures, one guarded
// retry per failure class. It NEVER sends anything. All actions hit the ring.
let watchdogTimer = null;
const wdogLastAction = new Map();   // key -> ts (cooldowns)
const wdogModsFail = new Map();     // D1: accountId -> consecutive health ticks with modules:false
function wdogCool(key, ms) {
  const last = wdogLastAction.get(key) || 0;
  if (Date.now() - last < ms) return false;
  wdogLastAction.set(key, Date.now());
  return true;
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = trackInterval('watchdog', async () => {
    try {
      // 1. DEAD ENGINE HEAL: store says linked but session missing / not linked
      //    (the selftest caught engines flipping to linking mid-run).
      for (const acc of store.listAccounts()) {
        const key = 'reload:' + acc.id;
        const rec = sessions.get(acc.id);
        const dead = !wcAlive(rec) ||   // v13 M1: full-hop guard
          (rec.status !== 'linked' && acc.status === 'linked' && Date.now() - new Date(acc.createdAt || 0).getTime() > 60000);
        if (!dead) continue;
        if (!wdogCool(key, 5 * 60 * 1000)) continue;
        debugEvent('engine-error', acc.id, 'watchdog: engine down, recreating from saved session');
        try {
          removeSession(acc.id);
          const restored = Object.assign({}, acc, { status: 'linking' });
          createSession(restored, null);
          attachToSlot(acc.id, 0);
          relayout();
        } catch (eR) {
          debugEvent('engine-error', acc.id, 'watchdog: recreate failed');
        }
      }

      // 2. STALE BELIEF HEAL: a send failed at the open stage in the last 90s
      //    -> clear that account's pre-open belief so the next attempt opens fresh.
      const recent = debugDump().filter(e => Date.now() - e.t < 90000 && e.kind === 'send-step');
      for (const e of recent) {
        if (!/open failed|could not open/.test(e.text || '')) continue;
        const key = 'belief:' + e.accountId;
        if (!wdogCool(key, 60000)) continue;
        if (preOpened.has(e.accountId)) {
          preOpened.delete(e.accountId);
          debugEvent('send-step', e.accountId, 'watchdog: cleared stale open belief');
        }
      }

      // 3. HEALTH PROBE HEAL: linked engines get health read EVERY tick
      //    now (one cheap cached call; the old wdogCool on the check
      //    itself starved it to once per 5 min). idb:false still reloads
      //    at most once per 5 min (own key, unchanged max rate). D1 NEW:
      //    modules:false on TWO consecutive ticks -> full page reload
      //    with a 3 min per-account cooldown. A dead module runtime never
      //    heals itself: the bundle never came up after a reload (loading
      //    or error shell) while IndexedDB still opens, so idb stays true
      //    and the old probe never acted. WhatsApp's own reload usually
      //    restores the runtime; reloadEnginePage re-insures the bridge.
      for (const [accountId, rec] of sessions) {
        if (rec.status !== 'linked' || !wcAlive(rec)) {   // v13 M1: full-hop guard
          wdogModsFail.set(accountId, 0);
          continue;
        }
        let h = null;
        try {
          h = await rec.view.webContents.executeJavaScript(
            `(function(){try{return window.__wabEng?window.__wabEng.health():null;}catch(e){return null;}})()`, false);
        } catch (eH) { /* engine busy; next tick */ }
        if (h && h.idb === false) {
          if (wdogCool('health:' + accountId, 5 * 60 * 1000)) {
            reloadEnginePage(accountId, 'watchdog: idb down, reloading engine page');
          }
          continue;
        }
        // D1 modules heal: 2 consecutive dead-module ticks at 15 s = dead
        // for ~30 s, past any slow bundle load; any healthy read resets
        // the count; reload gated by a 3 min per-account cooldown.
        if (h && h.modules === false) {
          const fails = (wdogModsFail.get(accountId) || 0) + 1;
          wdogModsFail.set(accountId, fails);
          if (fails >= 2 && wdogCool('health-mods:' + accountId, 3 * 60 * 1000)) {
            debugEvent('engine-error', accountId, 'watchdog: module runtime down x' + fails + ', reloading engine page');
            reloadEnginePage(accountId, 'watchdog: module runtime down, reloading engine page');
          }
        } else if (h) {
          wdogModsFail.set(accountId, 0);
        }
      }

      // 4. FLOOD GUARD: if remediations exceed 6 in 5 minutes, stand down 5 min.
      const acts = Array.from(wdogLastAction.values()).filter(t => Date.now() - t < 5 * 60 * 1000);
      if (acts.length > 6) {
        if (wdogCool('standdown', 5 * 60 * 1000)) {
          debugEvent('engine-error', '', 'watchdog: flood guard, standing down 5 minutes');
        }
      }
    } catch (eW) { /* the watchdog must never crash the spine */ }
  }, 15000);
}

// v12 spine debug contract (conventions #7): ring buffer of step events.
// Step names and counts ONLY. Never contact names, never message text.
const debugRing = [];
function debugEvent(kind, accountId, text) {
  try {
    debugRing.push({ t: Date.now(), kind: String(kind), accountId: String(accountId || ''), text: String(text || '').slice(0, 160) });
    if (debugRing.length > 300) debugRing.shift();
    if (pushHandler) pushHandler('debug:on-event', debugRing[debugRing.length - 1]);
  } catch (e) { /* debug must never break the spine */ }
}
function debugDump() { return debugRing.slice(-300); }

function setLayout(mode) {
  layoutMode = mode;
  // Push to the shell: it applies the layout through its own setter (slot flags,
  // tabstrip, active states) with no push back, so no loop.
  if (pushHandler) pushHandler('app:layout', mode);
  relayout();
}

// ---------- v2 Conversation Mode ----------

function setActivePane(slot) {
  activePane = typeof slot === 'number' ? slot : 0;
  pushAllPaneStates();   // re-push with fresh isActive flags for every pane
}

// v3: the renderer owns what a pane SHOWS; the spine owns the RECORD of it.
function setPanePerson(slot, accountId, chatId, title) {
  if (accountId && chatId) paneState.set(slot, { accountId, chatId, title: String(title || '') });
  else paneState.delete(slot);
  pushPaneState(slot);
}

function pushPaneState(slot) {
  if (!pushHandler) return;
  const st = paneState.get(slot) || null;
  let payload = { slot, open: false, isActive: slot === activePane };
  if (st) {
    const acc = store.getAccount(st.accountId);
    payload = {
      slot,
      open: true,
      isActive: slot === activePane,
      accountId: st.accountId,
      accountName: acc ? acc.name : '',
      accountColor: acc ? acc.color : '#426CA8',
      platform: acc ? (acc.platform || 'whatsapp') : 'whatsapp',   // v14 T3: pane headers badge by platform
      title: st.title
    };
  }
  pushHandler('panes:onState', payload);
}

function pushAllPaneStates() {
  for (const slot of attached.keys()) pushPaneState(slot);
  pushPaneState(activePane);
}

// Open a chat by title inside an account's WhatsApp, put that account's view in
// the active pane, crop to thread, focus the compose box. Two clicks to typing.
async function openChat(accountId, title) {
  const rec = sessions.get(accountId);
  if (!rec || rec.view.webContents.isDestroyed()) return { ok: false, error: 'that account has no live session' };
  if (!OPENCHAT_SRC) return { ok: false, error: 'chat opener not installed yet (v2 inject missing)' };
  try {
    await rec.view.webContents.executeJavaScript(OPENCHAT_SRC, false);   // idempotent installer
    const res = await rec.view.webContents.executeJavaScript(
      `window.__wabOpenChat(${JSON.stringify(String(title))})`, false);
    if (!res || !res.ok) {
      return { ok: false, error: (res && res.error) || 'could not open that chat' };
    }
  } catch (e) {
    return { ok: false, error: 'chat opener failed: ' + String(e && e.message || e) };
  }

  attachToSlot(accountId, activePane);
  paneState.set(activePane, { accountId, title: String(title) });
  pushPaneState(activePane);

  // Crop to the thread (prefs) and put the cursor where the work happens.
  try {
    if (store.getPrefs().threadCrop) {
      await rec.view.webContents.executeJavaScript(
        `(function(){try{if(window.__wabSetThreadCrop){window.__wabSetThreadCrop(true);}}catch(e){}return true;})()`, false);
    }
    await rec.view.webContents.executeJavaScript(
      `(function(){try{var f=document.querySelector('footer div[contenteditable=\\"true\\"]')||document.querySelector('div[contenteditable=\\"true\\"]');if(f){f.focus();return true;}return false;}catch(e){return false;}})()`, false);
    rec.view.webContents.focus();
  } catch (e) { /* non-fatal: the chat is open, focus is a nicety */ }
  relayout();
  return { ok: true };
}

// People: privacy-filtered merge of every linked account's chat list.
// The blindfold applies HERE, in the spine, before anything reaches the renderer.
async function collectPeople() {
  const people = [];
  for (const [accountId, rec] of sessions) {
    if (!rec.view || rec.view.webContents.isDestroyed() || rec.status !== 'linked') continue;
    let chats = [];
    try {
      chats = await rec.view.webContents.executeJavaScript(
        `(function(){try{return window.__wabListChats?window.__wabListChats():[];}catch(e){return [];}})()`, false) || [];
    } catch (e) { continue; }
    const acc = store.getAccount(accountId);
    if (!acc) continue;
    const cfg = store.getPrivacy(accountId);
    for (const chat of chats) {
      const t = String(chat.title || '').trim();
      if (!t) continue;
      if (cfg.mode === 'allow' && !cfg.allow.some(a => titlesMatch(a, t))) continue;
      if (cfg.mode === 'deny' && cfg.deny.some(a => titlesMatch(a, t))) continue;
      people.push({
        title: t,
        unread: chat.unread || 0,
        accountId,
        accountName: acc.name,
        accountColor: acc.color,
        platform: acc.platform || 'whatsapp'   // v14 T3: palette/search rows badge by platform too
      });
    }
  }
  return people;
}

function attachToSlot(accountId, slot) {
  for (const [s, id] of attached) if (id === accountId) attached.delete(s);
  if (typeof slot === 'number') attached.set(slot, accountId);
  relayout();
}

// Grok happy path law: the moment an account links, it is ON the desk.
// First free visible slot, else slot 0. No hunting for cards after a scan.
function attachToFreeSlot(accountId) {
  const vis = visibleSlots();
  let free = -1;
  for (const s of vis) { if (!attached.has(s)) { free = s; break; } }
  if (free === -1) free = (vis[0] !== undefined) ? vis[0] : 0;
  attachToSlot(accountId, free);
}

function detach(accountId) {
  // Pane bookkeeping only in v3: an engine may keep running under the UI even
  // when no pane shows it. Removing the engine entirely is removeSession's job.
  for (const [s, id] of attached) if (id === accountId) attached.delete(s);
}

function visibleSlots() {
  switch (layoutMode) {
    case 'split2': return [0, 1];
    case 'split3': return [0, 1, 2];
    case 'grid4': return [0, 1, 2, 3];
    case 'grid5': return [0, 1, 2, 3, 4];
    case 'grid6': return [0, 1, 2, 3, 4, 5];
    default: return [0]; // single + tabs
  }
}

const shownViews = new Set();   // accountIds whose engine views sit under the UI (kept for capture guards)
let overlayOpen = false;        // retired in the view-tree topology: the UI is ALWAYS on top

function setOverlayVisible(on) {
  overlayOpen = !!on;   // no-op for engines now; kept so older UI code keeps working
  relayout();
}

// v3 topology: linked engines live UNDER the UI view at full window size (covered,
// alive, unthrottled Ã¢â‚¬â€ the researched-correct home). The UI is re-added on top so
// it always stays visible above every engine.
function fitEngines(w, h) {
  if (!shellWin || shellWin.isDestroyed() || !uiView) return;
  const cv = shellWin.contentView;
  for (const [accountId, rec] of sessions) {
    if (!wcAlive(rec)) continue;   // v13 M1: full-hop guard
    if (rec.status === 'linking') continue;         // lives in the QR window during linking
    if (!engineInShell.has(accountId)) {
      try { cv.addChildView(rec.view); engineInShell.add(accountId); shownViews.add(accountId); } catch (e) { /* closing */ }
    }
    try { rec.view.setBounds({ x: 0, y: 0, width: Math.max(1, w), height: Math.max(1, h) }); } catch (e) { /* ok */ }
    // Engines are invisible; the old desktop-illusion zoom is obsolete. A stale
    // partition zoom (0.67 from v2) breaks real-input coordinate math: normalize to 1.
    try { const z = rec.view.webContents.getZoomFactor(); if (Math.abs(z - 1) > 0.01) rec.view.webContents.setZoomFactor(1); } catch (eZ) { /* nicety */ }
  }
  try { cv.addChildView(uiView); } catch (e) { /* re-add brings the UI back on top */ }
}

async function relayout() {
  if (!shellWin || shellWin.isDestroyed()) return;
  try {
    const [w, h] = shellWin.getContentSize();
    fitEngines(w, h);
    // Retired engines (removed accounts) come out of the tree.
    for (const id of Array.from(engineInShell)) {
      const rec = sessions.get(id);
      if (!wcAlive(rec)) {   // v13 M1: full-hop guard
        engineInShell.delete(id);
        shownViews.delete(id);
        continue;
      }
      if (rec.status === 'linking') {
        try { shellWin.contentView.removeChildView(rec.view); } catch (e) { /* ok */ }
        engineInShell.delete(id);
        shownViews.delete(id);
      }
    }
  } catch (e) { /* window closing */ }
}

// Continuous repositioning: the shell reports slot rects, we follow (resize, layout switches, tab picks).
function startRelayoutLoop() {
  trackInterval('relayout', relayout, 700);
}

function openAIPanel(accountId, command) {
  if (!shellWin || shellWin.isDestroyed()) return;
  shellWin.focus();
  const arg = command ? { accountId, command } : { accountId };
  uiWC(shellWin).executeJavaScript(
    `(function(){try{if(window.WABAiPanel){window.WABAiPanel.open(${JSON.stringify(arg)});return true;}return false;}catch(e){return false;}})()`, false)
    .catch(() => {});
  // Context line: which chat and which account the sidekick is working on.
  const acc = store.getAccount(accountId);
  runInPage(accountId, `(function(){try{return window.__wabScrapeChat?window.__wabScrapeChat():null;}catch(e){return null;}})()`)
    .then(scrape => {
      if (scrape && scrape.ok && shellWin && !shellWin.isDestroyed()) {
        uiWC(shellWin).executeJavaScript(
          `(function(){try{if(window.WABAiPanel){window.WABAiPanel.setContext(${JSON.stringify({
            accountId, chatName: scrape.contactName || 'this chat', accountName: acc ? acc.name : ''
          })});}}catch(e){}})()`, false).catch(() => {});
      }
    })
    .catch(() => {});
}

// ---------- lifecycle ----------

function removeSession(accountId) {
  const rec = sessions.get(accountId);
  if (!rec) return;
  detach(accountId);
  if (rec.qrWindow && !rec.qrWindow.isDestroyed()) rec.qrWindow.close();
  if (shellWin && !shellWin.isDestroyed() && engineInShell.has(accountId)) {
    try { shellWin.contentView.removeChildView(rec.view); } catch (e) { /* already gone */ }
    engineInShell.delete(accountId);
    shownViews.delete(accountId);
  }
  if (wcAlive(rec)) {   // v13 M1: full-hop guard
    try { rec.view.webContents.close(); } catch (e) { /* ok */ }
  }
  sessions.delete(accountId);
}

function getSession(accountId) { return sessions.get(accountId) || null; }

function allSessions() { return sessions; }

// Run a page-side helper from inject/context-scraper.js inside a session's page.
async function runInPage(accountId, exprFactory) {
  const rec = sessions.get(accountId);
  if (!wcAlive(rec)) return { ok: false, error: 'that account has no live session' };   // v13 M1: full-hop guard
  try {
    return await rec.view.webContents.executeJavaScript(
      `(function(){try{${SCRAPER_SRC}\nreturn (${exprFactory})();}catch(e){return {ok:false,error:'page bridge failed: '+String(e && e.message || e)};}})()`, false);
  } catch (e) {
    return { ok: false, error: 'page bridge failed: ' + String(e && e.message || e) };
  }
}

function isShown(accountId) { return shownViews.has(accountId); }

// v12.7: snapshot of pane truths for the sidekick's live context.
function paneStateInfo() {
  const out = [];
  for (const [slot, st] of paneState) {
    const acc = store.getAccount(st.accountId);
    out.push({ slot, accountId: st.accountId, chatId: st.chatId, title: st.title, accountName: acc ? acc.name : '' });
  }
  return out;
}

module.exports = {
  makeId, createSession, removeSession, getSession, allSessions,
  setFlags, setShellWindow, setUiView, setPushHandler, startPolling, startRelayoutLoop,
  setLayout, attachToSlot, detach, relayout, fitEngines, setOverlayVisible, isShown,
  injectPrivacy, runInPage, openAIPanel, accountUrl, partitionFor,
  setActivePane, setPanePerson, openChat, collectPeople, pushAllPaneStates,
  engPeople, engMessages, engSend, engHealth, engPreOpen, engRealOpen, engCall, startTypingPoll, timerReport,
  engHistory, engHasMoreHistory, startWatchdog,
  uiWC, debugEvent, debugDump, paneStateInfo
};
