/* Chat Bridge people.js, builder B2, evolved V12.6 Z3 (tagging-rail).
   Classic script, no modules, file:// safe.
   Exposes window.WABPeople = { init, refresh, openInActivePane, openPalette,
   closePalette, setActivePane, refreshPanes, setFolded }. Everything guarded: old
   preload, missing WABSlots, pane states before chips exist. Never throws, never
   alerts.

   V12 S3 additions (docs\PR-V12.md #6 #7 #8 #9):
   - Photo-only avatars: the row avatar carries the wabr-avatar marker class so
     render.js never prepends a second initials circle; initials only when the
     person has no photo.
   - Open-person blink is pure CSS at 1.2s (people.css); no JS timers here.
   - Account-color left glow on every row; a debug pane-reply event brightens
     all rows of that account for 2s via a body-level class toggle.
   - Rail fold: body.wab-rail-folded collapses the rail to a 64px avatar column;
     remembered through pane prefs slot -1 with a localStorage fallback.

   V12.1 T2 additions (owner live feedback, 2026-11-21):
   - Mixed accounts: every render path orders ALL people by t descending
     (last contact) across accounts; account color strips distinguish.
     Covers the rail list, the palette recent list and the /sender receiver
     pool (sortPeople is the single ordering law).
   - Refresh never blanks: the loading note only appears before the first
     successful load; a refresh (button, push, poll) keeps the current rows
     and swaps them the moment fresh data lands.
   - Keep-last-photo guard: avatars are cached by accountId+title; if fresh
     data lacks the avatar field, the previous photo survives (the spine
     serves cached avatars synchronously, this is the second line of
     defense).
   - Open-person highlight and blink survive every re-render (re-derived
     from pane state after each render).

   V12.5 Y3 additions (owner live feedback, 2026-11-21):
   - Typing dots: wab.eng.onTyping pushes {accountId, titles} (full state per
     account); state.typing holds accountId+normalized title keys, rows derive
     their is-typing class from it after every render, so the signal survives
     refreshes. Dots sit in the slot just before the unread badge (dots then
     badge when both show). A 10s TTL sweeps marks whose stop push was lost.
   - Progress line: render.js (Y2) dispatches window CustomEvent
     'wab:progress' {slot, kind, on}; the slot maps to its person via
     state.paneStates and the row shows a 2px shimmer line under the name
     while any kind is on. Kinds are tracked per slot so a load and a send
     never clear each other; a pane person change drops its stale kinds.
   - Folded rail: dots hidden, a pulsing account-color ring plays around the
     avatar instead (people.css); the progress line hides when folded.

   V12.6 Z3 additions (owner live feedback, 2026-11-21):
   - Command bar fixed end to end. Root cause of the dead flow: cmdComplete
     and the Enter path checked __cmdAccount on the DATA in
     state.paletteResults, but that marker only ever lived on the DOM row
     elements, so Tab after "/bj" completed nothing at all, and render.js's
     capture-phase Enter listener on #search-palette then hijacked the key
     and tried to OPEN THE ACCOUNT NAME as a chat. Fix: a document-level
     capture layer now owns Tab, Enter and row clicks for command queries
     (document capture fires before render.js's palette capture, so the
     whole interception chain is bypassed for command queries and left
     untouched for plain searches), the sender token completes from the DOM
     row marker, and the receiver opens through the live open path:
     WABRender.openConversation, the same targetOpenSlot routing
     openFromPalRow ends in (the ACTIVE screen in single and tabs, the
     ACTIVE slot in splits and grids), with the legacy chats.open call as
     the fallback for hosts running this fragment without render.js.
   - cmdParse rewritten around the first @ token: the sender run and the
     receiver run each keep their spaces, so account names and titles like
     "Marc Deckers" no longer collapse to their last word, and all matching
     runs through norm() like the rest of the rail.
   - The palette input is cleared on every open, so stale text from a
     previous palette session can never leak into a new query.
   - Open-to-top: people open in ANY pane or screen pin to the top of every
     people surface (rail, palette recent, receiver pool, search results) in
     pane-slot order, above the t-descending recency sort; closing the pane
     or screen releases them back into the normal order. Source of truth:
     the panes:onState pushes already stored in state.paneStates (fed by
     render.js's spine reporting since X2, so they describe reality). Open
     people keep their typing dots, glow, blink and unread badges as-is:
     the pin changes ORDER only. */

(function () {
  'use strict';

  /* ---------- state ---------- */

  var state = {
    inited: false,
    people: [],            // cached listPeople rows, sorted t desc across accounts
    peopleLoaded: false,
    peopleError: false,
    loadingPeople: false,
    lastPeopleKey: '',
    accounts: [],          // linked sender accounts (command bar /sender phase)
    paneStates: {},        // slot -> {accountId, accountName, accountColor, title, open}
    activeSlot: 0,
    openSig: '',           // Z3: signature of the open-person set (pin change gate)
    openMark: 0,           // timestamp of the last successful chats.open
    openMarkAccount: null, // account it opened (active-pane attribution heuristic)
    paletteOpen: false,
    paletteResults: [],    // rows currently rendered in the palette
    paletteCursor: -1,
    searchSeq: 0,
    replyTimer: null,      // body.wabp-reply-glow clear timer (2s window)
    replyStyleEl: null,    // <style> holding the current reply-glow account rule
    avatarCache: {},       // accountId + '\u0000' + title -> last seen photo url
    avatarCacheOrder: [],  // insertion order, for the size cap
    typing: new Set(),     // keys accountId + '\u0000' + norm(title) now typing
    typingUntil: {},       // same key -> expiry ms (TTL sweep)
    typingTimer: null,     // sweep interval, runs only while the set is non-empty
    progressKinds: {},     // slot -> Set of kinds currently on ('wab:progress')
    lockedAccounts: [],    // consent-first: accounts stored as allow-mode with an empty allow list
    lockProbeSeq: 0        // guards the async lock probe against stale landings
  };

  var AVATAR_CACHE_MAX = 400;
  var TYPING_TTL = 10000; // ms a typing mark survives without a refresh push

  var el = {
    root: null, rail: null, filter: null, list: null, searchBtn: null,
    palette: null, paletteInput: null, paletteResults: null, paletteClose: null,
    chips: null, foldBtn: null
  };

  /* ---------- small utils ---------- */

  function $(id) { return document.getElementById(id); }

  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    try {
      // NFD then drop combining marks (U+0300..U+036F) by char code,
      // so the source stays plain ASCII.
      s = s.normalize('NFD');
      var stripped = '';
      for (var ci = 0; ci < s.length; ci++) {
        var cc = s.charCodeAt(ci);
        if (cc < 0x300 || cc > 0x36f) stripped += s.charAt(ci);
      }
      s = stripped;
    } catch (e) { /* old engine: skip diacritic folding */ }
    return s.replace(/\s+/g, ' ').trim();
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      if (t !== null) window.clearTimeout(t);
      var args = arguments;
      t = window.setTimeout(function () {
        t = null;
        try { fn.apply(null, args); } catch (e) { /* never throw from a timer */ }
      }, ms);
    };
  }

  function errText(err, fallback) {
    var msg = err && (err.message || err.error);
    return (typeof msg === 'string' && msg) ? msg : (fallback || 'Something went wrong');
  }

  // Shell toast is not a global; bridge through an event the integrator can wire.
  function toastRaw(text) {
    try {
      window.dispatchEvent(new CustomEvent('wab:toast-raw', { detail: { text: String(text) } }));
    } catch (e) { /* degrade silently */ }
  }

  // Runs a wab call, catches rejection, toasts, resolves null on failure.
  function wrap(fn, fallback) {
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        return r.then(null, function (err) {
          toastRaw(errText(err, fallback));
          return null;
        });
      }
      return Promise.resolve(r);
    } catch (e) {
      toastRaw(errText(e, fallback));
      return Promise.resolve(null);
    }
  }

  function wabOk() {
    return typeof window.wab === 'object' && window.wab !== null;
  }

  function chatsOk() {
    return wabOk() && window.wab.chats &&
      typeof window.wab.chats.listPeople === 'function' &&
      typeof window.wab.chats.searchAll === 'function' &&
      typeof window.wab.chats.open === 'function';
  }

  function paneApiOk() {
    return wabOk() && window.wab.app && typeof window.wab.app.setActivePane === 'function';
  }

  // Same key shape as the avatar cache and the typing set:
  // accountId + '\u0000' + norm(title).
  function personKey(accountId, title) {
    return String(accountId || '') + '\u0000' + norm(title);
  }

  /* ---------- V12.1 T2 + V12.6 Z3: the single ordering law ----------
     Every people surface orders through sortPeople: people currently open
     in a pane or screen FIRST (pane-slot order, so the block stays stable
     while open), then everyone else by t descending across ALL accounts,
     title as the tie-break so rows never shuffle between renders when
     timestamps are equal. Returns a new array, never mutates the input. */

  function personT(p) {
    if (!p) return 0;
    if (typeof p.t === 'number') return p.t;
    var n = parseInt(p.t, 10);
    return isNaN(n) ? 0 : n;
  }

  // Z3: open people straight from the pane-state pushes, slot ascending,
  // deduped by accountId+norm(title). The spine is truth-fed by render.js
  // (reportSpine), so these pushes describe what is really on the desk.
  function openPaneEntries() {
    var slots = [];
    for (var k in state.paneStates) {
      if (!Object.prototype.hasOwnProperty.call(state.paneStates, k)) continue;
      var st = state.paneStates[k];
      if (!st || !st.open || !st.accountId || !st.title) continue;
      var s = parseInt(k, 10);
      if (!isNaN(s)) slots.push(s);
    }
    slots.sort(function (a, b) { return a - b; });
    var seen = {};
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      var st2 = state.paneStates[slots[i]];
      var key = personKey(st2.accountId, st2.title);
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ slot: slots[i], key: key });
    }
    return out;
  }

  function openRankMap() {
    var entries = openPaneEntries();
    var rank = {};
    for (var i = 0; i < entries.length; i++) rank[entries[i].key] = i;
    return rank;
  }

  // Signature of the open set; onPaneState re-renders the rail only when
  // this changes, so isActive-only pushes never thrash the list.
  function openSetSig() {
    var entries = openPaneEntries();
    var parts = [];
    for (var i = 0; i < entries.length; i++) {
      parts.push(entries[i].slot + ':' + entries[i].key);
    }
    return parts.join('|');
  }

  function sortPeople(list) {
    var rank = openRankMap();
    var arr = Array.isArray(list) ? list.slice() : [];
    arr.sort(function (a, b) {
      var ra = rank[personKey(a && a.accountId, a && a.title)];
      var rb = rank[personKey(b && b.accountId, b && b.title)];
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;   // only b is open: b pins first
        if (rb === undefined) return -1;  // only a is open: a pins first
        if (ra !== rb) return ra - rb;    // both open: pane-slot order
      }
      var d = personT(b) - personT(a);
      if (d !== 0) return d;
      var ta = norm(a && a.title);
      var tb = norm(b && b.title);
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });
    return arr;
  }

  function recentPeople(n) {
    return sortPeople(state.people).slice(0, n || 12);
  }

  /* ---------- V12.1 T2: avatar keep-last-photo cache ----------
     Keyed by accountId + title. Fresh photos refresh the cache first, then
     rows whose avatar field is absent-in-flight borrow the last known photo,
     so a refresh can never blank a face back to initials. */

  function avatarKey(p) {
    return String((p && p.accountId) || '') + '\u0000' + String((p && p.title) || '');
  }

  function cacheAvatar(p) {
    if (!p || !p.avatar) return;
    var k = avatarKey(p);
    if (!Object.prototype.hasOwnProperty.call(state.avatarCache, k)) {
      state.avatarCacheOrder.push(k);
    }
    state.avatarCache[k] = String(p.avatar);
    while (state.avatarCacheOrder.length > AVATAR_CACHE_MAX) {
      var drop = state.avatarCacheOrder.shift();
      delete state.avatarCache[drop];
    }
  }

  function cachedAvatar(p) {
    if (!p) return '';
    var v = state.avatarCache[avatarKey(p)];
    return typeof v === 'string' ? v : '';
  }

  // Pass 1 stores every fresh photo, pass 2 backfills rows that arrived
  // without one. Mutates the incoming rows in place so every render path
  // (rail, palette recent, search) sees the same hydrated objects.
  function hydratePeople(list) {
    if (!Array.isArray(list)) return list;
    var i, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p && p.avatar) cacheAvatar(p);
    }
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p && !p.avatar) {
        var kept = cachedAvatar(p);
        if (kept) {
          try { p.avatar = kept; } catch (eM) { /* frozen row object: skip */ }
        }
      }
    }
    return list;
  }

  /* ---------- avatars (PR #8: photo only, initials only as fallback) ---------- */

  // The wabr-avatar class is a marker: render.js upgrades only rows that lack
  // one, so carrying it keeps our photo/initials avatar single. Initials are
  // written only in the no-photo branch; a photo never wears a ring.
  function buildAvatar(p) {
    var av = document.createElement('span');
    av.className = 'people-avatar wabr-avatar';
    if (p && p.avatar) {
      av.classList.add('has-img');
      try { av.style.backgroundImage = 'url("' + p.avatar + '")'; } catch (e) { /* keep fallback */ }
    } else {
      var t = String((p && p.title) || '').trim();
      var parts = t.split(/\s+/);
      av.textContent = t ? (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase() : '';
      var ring = (p && p.accountColor) || 'rgba(255,255,255,0.42)';
      try { av.style.setProperty('--wabr-ring', ring); } catch (eR) { /* cosmetic */ }
      try { av.style.borderColor = ring; } catch (eB) { /* cosmetic */ }
    }
    return av;
  }

  // V14 T5: platform of a person row. The T3 spine stamps every engPeople
  // row with platform; older spines and the mock fixtures carry no field,
  // and absent means WhatsApp (the smoke law).
  function platformOf(v) {
    return v === 'telegram' ? 'telegram' : 'whatsapp';
  }

  // V14 T5: the 4px platform dot (people.css) that rides after the
  // avatar, before the name: green WhatsApp, blue Telegram.
  function platformDot(p) {
    var d = document.createElement('span');
    d.className = 'wabp-plat-dot' + (platformOf(p && p.platform) === 'telegram' ? ' is-telegram' : '');
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  /* ---------- V14 U3: click-a-logo-to-connect (rail platform cards) ----------
     U2 renders user-grouped platform cards in the rail's sender section.
     This stage owns the click: an UNCONNECTED card opens the shell's
     add-account modal pre-filled for that user+platform, through the
     wab:add-account window event (the T5 seam; shell.js owns the modal, the
     event is the hand-off, never a direct DOM grab into shell internals).
     DOM contract with U2, read via closest() so nesting is free:
     - the group:  an element carrying data-user-id (and data-user-name)
     - the button: button[data-platform="whatsapp|telegram"], unconnected
                   = also carries class is-unconnected */

  var U3_PLAT = {
    whatsapp: { suffix: 'WA', color: '#426CA8', label: 'WhatsApp' },
    telegram: { suffix: 'TG', color: '#229ED9', label: 'Telegram' }
  };

  // Latest linked accounts (state.accounts refreshes on every people load
  // and on accounts pushes). Legacy accounts without userId never match.
  function accountExistsFor(userId, platform) {
    if (!userId) return false;
    for (var i = 0; i < state.accounts.length; i++) {
      var a = state.accounts[i];
      if (a && String(a.userId || '') === String(userId) &&
          ((a.platform || 'whatsapp') === platform)) return true;
    }
    return false;
  }

  function u3Toast(text) {
    try { window.dispatchEvent(new CustomEvent('wab:toast-raw', { detail: { text: text } })); } catch (eT) { /* degrade quietly */ }
  }

  function onPlatCardClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var btn = t.closest('button[data-platform]');
    if (!btn || !btn.classList.contains('is-unconnected')) return;
    var group = btn.closest('[data-user-id]');
    if (!group) return;
    var platform = platformOf(btn.getAttribute('data-platform'));
    var userId = group.getAttribute('data-user-id') || '';
    var userName = (group.getAttribute('data-user-name') || '').trim();
    // Duplicate guard: U2 should never render these unconnected anyway.
    if (userId && accountExistsFor(userId, platform)) {
      u3Toast((platform === 'telegram' ? 'Telegram' : 'WhatsApp') +
        ' is already connected for ' + (userName || 'this user'));
      return;
    }
    connectPlatform(platform, userId, userName);
  }

  // Also public (WABPeople.connectPlatform) so U2 cards or fragments can call
  // the flow directly. Returns true when a listener claimed the event.
  function connectPlatform(platform, userId, userName) {
    var meta = U3_PLAT[platformOf(platform)] || U3_PLAT.whatsapp;
    if (userId && accountExistsFor(userId, platformOf(platform))) return false;
    var detail = {
      platform: platformOf(platform),
      userId: userId || '',
      name: userName ? userName + ' ' + meta.suffix : meta.label,
      color: meta.color,
      handled: false
    };
    try {
      window.dispatchEvent(new CustomEvent('wab:add-account', { detail: detail }));
    } catch (eD) { return false; }
    return !!detail.handled;   // false on fragment hosts without the shell
  }

  /* ---------- reply glow (PR #6: account color, brighter on reply) ---------- */

  // Escapes an account id for use inside an attribute selector string.
  function selEscape(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\a ');
  }

  function ensureReplyStyle() {
    if (state.replyStyleEl && document.head && document.head.contains(state.replyStyleEl)) {
      return state.replyStyleEl;
    }
    try {
      var st = document.createElement('style');
      st.id = 'wabp-reply-glow-style';
      document.head.appendChild(st);
      state.replyStyleEl = st;
      return st;
    } catch (e) {
      return null;
    }
  }

  // Body-level class toggle: while body carries wabp-reply-glow, every rail row
  // of the replying account glows at 0.6 for 2s (rows match via data-account,
  // so the glow survives rail re-renders). Person-level matching can come later.
  function onReplyGlow(accountId) {
    if (!accountId || !document.body) return;
    var st = ensureReplyStyle();
    if (st) {
      st.textContent =
        'body.wabp-reply-glow .people-row[data-account="' + selEscape(accountId) + '"]{' +
        '--wabp-glow-a:0.6;}' +
        'body.wabp-reply-glow .people-row[data-account="' + selEscape(accountId) + '"]::before{' +
        'box-shadow:0 0 12px 1px var(--wabp-acct, rgba(255,255,255,0.42));}';
    }
    document.body.classList.add('wabp-reply-glow');
    if (state.replyTimer !== null) window.clearTimeout(state.replyTimer);
    state.replyTimer = window.setTimeout(function () {
      state.replyTimer = null;
      try { document.body.classList.remove('wabp-reply-glow'); } catch (e) { /* fine */ }
    }, 2000);
  }

  /* ---------- rail fold (PR #9: 64px avatar column, remembered) ---------- */

  var FOLD_KEY = 'wab-rail-folded';

  function bodyFolded() {
    return !!(document.body && document.body.classList.contains('wab-rail-folded'));
  }

  function readFoldLocal() {
    try { return window.localStorage.getItem(FOLD_KEY) === '1'; } catch (e) { return false; }
  }

  // Persists both ways: pane prefs slot -1 is the rail's slot, but the store
  // currently keeps only zoom and minimized, so localStorage carries the flag
  // until the spine widens the whitelist. Both stay in sync on every toggle.
  function persistFold(on) {
    try { window.localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    try {
      if (wabOk() && window.wab.app && typeof window.wab.app.setPanePrefs === 'function') {
        window.wab.app.setPanePrefs(-1, { folded: !!on }).catch(function () { /* prefs optional */ });
      }
    } catch (e) { /* old preload */ }
  }

  function applyFold(on, persist) {
    try {
      document.body.classList.toggle('wab-rail-folded', !!on);
    } catch (e) { /* no body yet */ }
    if (el.foldBtn) {
      el.foldBtn.classList.toggle('is-folded', !!on);
      el.foldBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
      el.foldBtn.title = on ? 'Unfold the rail' : 'Fold the rail (avatars only)';
      el.foldBtn.setAttribute('aria-label', on ? 'Unfold the rail' : 'Fold the rail');
    }
    if (persist !== false) persistFold(!!on);
    // Pane chips and slot rects settle after the 200ms width transition.
    window.setTimeout(function () { refreshPanes(); }, 240);
  }

  function loadFold() {
    try {
      if (wabOk() && window.wab.app && typeof window.wab.app.getPanePrefs === 'function') {
        window.wab.app.getPanePrefs().then(function (prefs) {
          var p = prefs && prefs['-1'];
          if (p && typeof p.folded === 'boolean') applyFold(p.folded, false);
          else applyFold(readFoldLocal(), false);
        }).catch(function () { applyFold(readFoldLocal(), false); });
        return;
      }
    } catch (e) { /* fall through to localStorage */ }
    applyFold(readFoldLocal(), false);
  }

  function wireFold() {
    if (el.foldBtn) return;
    var btn = $('rail-fold-btn');
    if (!btn) return;
    el.foldBtn = btn;
    btn.addEventListener('click', function () {
      applyFold(!bodyFolded(), true);
    });
  }

  /* ---------- rail mount ---------- */

  // The integrator places an empty <div id="people-rail"></div> inside the shell
  // rail. If one exists outside this fragment, move our block into it; the host
  // gives up its id so our block stays the single #people-rail afterwards.
  function mountRail() {
    var root = el.root;
    if (!root) return;
    var block = root.querySelector('#people-rail');
    if (!block) return;
    el.rail = block;

    var host = null;
    try {
      var cands = document.querySelectorAll('#people-rail');
      for (var i = 0; i < cands.length; i++) {
        if (cands[i] !== block && !root.contains(cands[i])) { host = cands[i]; break; }
      }
    } catch (e) { host = null; }

    if (host) {
      try {
        while (host.firstChild) host.removeChild(host.firstChild);
        host.classList.add('people-rail-host');
        host.appendChild(block);
        host.removeAttribute('id');
      } catch (e) { /* move failed: block renders in place at the fragment root */ }
    }
  }

  /* ---------- people list ---------- */

  // V12.1 T2: always resolves a Promise (the refresh button chains .then on
  // the result, and a swallowed busy-return used to throw on undefined).
  // The loading note shows only before the FIRST successful load; afterwards
  // refreshes keep the current rows on screen until fresh data lands.
  function loadPeople(opts) {
    var showLoading = !(opts && opts.silent);
    if (state.loadingPeople) return Promise.resolve(false);
    if (!chatsOk()) {
      renderNote(el.list, 'People needs the latest app version', 'Update Chat Bridge to see people here.');
      return Promise.resolve(false);
    }
    state.loadingPeople = true;
    if (showLoading && !state.peopleLoaded) renderNote(el.list, 'Loading people', '');

    return wrap(function () { return window.wab.chats.listPeople(); }, 'Could not load the people list')
      .then(function (res) {
        state.loadingPeople = false;
        if (res === null) { // wrap already toasted
          state.peopleError = true;
          if (state.peopleLoaded) {
            applyPersonHighlight(); // keep the stale rows; a toast already said why
          } else {
            renderPeopleList();
          }
          if (state.paletteOpen && !paletteQuery()) {
            if (state.peopleLoaded) renderPaletteRecent();
            else renderPalNote('Could not load people', 'Try again in a moment.');
          }
          return false;
        }
        if (!Array.isArray(res)) res = [];
        hydratePeople(res);              // keep-last-photo guard, before any render
        state.people = sortPeople(res);  // open people pinned, then t desc across accounts
        state.peopleLoaded = true;
        state.peopleError = false;
        // v14.6: people load success is a first-run guide refresh event; the
        // renderer's own list is the freshest personVisible there is.
        try {
          if (window.WABOnboarding) window.WABOnboarding.notePeople(state.people.length > 0);
        } catch (eWob) { /* the guide must never break the people load */ }
        onPeopleData();
        applyPersonHighlight();          // open-person state survives the re-render
        if (state.paletteOpen && !paletteQuery()) renderPaletteRecent();
        loadLockInfo();                  // consent-first: lock cards follow the fresh rows
        return true;
      });
  }

  function onPeopleData() {
    var key = '';
    try { key = JSON.stringify(state.people); } catch (e) { key = String(state.people.length); }
    if (key !== state.lastPeopleKey) {
      state.lastPeopleKey = key;
      renderPeopleList();
    } else {
      applyPersonHighlight();
    }
  }

  function peopleFilterNorm() {
    return el.filter ? norm(el.filter.value) : '';
  }

  // Rail list note: loading, empty, error, no filter match.
  function renderNote(container, main, sub) {
    if (!container) return;
    container.textContent = '';
    var note = document.createElement('div');
    note.className = 'people-note';
    var m = document.createElement('span');
    m.className = 'people-note-main';
    m.textContent = main || '';
    note.appendChild(m);
    if (sub) {
      var s = document.createElement('span');
      s.className = 'people-note-sub';
      s.textContent = sub || '';
      note.appendChild(s);
    }
    container.appendChild(note);
  }

  /* ---------- consent-first lock cards ---------- */

  // Fail-loud law: a locked account must never look like a broken or silent
  // empty list. The card reuses the people-note pattern (same classes, same
  // CSS) so it reads as a first-class rail state, not an error.
  function lockedCard(acc) {
    var note = document.createElement('div');
    note.className = 'people-note';
    var m = document.createElement('span');
    m.className = 'people-note-main';
    m.textContent = 'No contacts shared yet';
    note.appendChild(m);
    var s = document.createElement('span');
    s.className = 'people-note-sub';
    s.textContent = (acc && acc.name ? acc.name + ': ' : '') +
      'This account is locked until its owner picks contacts. Send them the consent invite (Settings, Privacy, Consent portal).';
    note.appendChild(s);
    return note;
  }

  // A locked account counts as locked ONLY while it also shows no people
  // rows: the moment the owner picks contacts, rows appear and the card
  // drops out on the next refresh.
  function visibleLockedAccounts() {
    var out = [];
    for (var i = 0; i < state.lockedAccounts.length; i++) {
      var acc = state.lockedAccounts[i];
      var hasPeople = false;
      for (var j = 0; j < state.people.length; j++) {
        if (state.people[j] && state.people[j].accountId === acc.id) { hasPeople = true; break; }
      }
      if (!hasPeople) out.push(acc);
    }
    return out;
  }

  // Pulls the account list plus each account's privacy config and keeps
  // state.lockedAccounts fresh. Runs after every successful people load and
  // on accounts:list-changed, so a portal pick clears the card on the next
  // poll without a restart.
  function loadLockInfo() {
    if (!wabOk() || !window.wab.accounts || typeof window.wab.accounts.list !== 'function') return;
    if (!window.wab.privacy || typeof window.wab.privacy.get !== 'function') return;
    var seq = ++state.lockProbeSeq;
    wrap(function () { return window.wab.accounts.list(); }, 'Could not read the account list')
      .then(function (list) {
        if (seq !== state.lockProbeSeq || !Array.isArray(list)) return;
        state.accounts = list;
        var checks = list.map(function (acc) {
          return wrap(function () { return window.wab.privacy.get(acc.id); }, 'Could not read privacy settings')
            .then(function (cfg) {
              return (cfg && cfg.mode === 'allow' && Array.isArray(cfg.allow) && cfg.allow.length === 0)
                ? acc : null;
            });
        });
        Promise.all(checks).then(function (res) {
          if (seq !== state.lockProbeSeq) return;
          var locked = [];
          for (var i = 0; i < res.length; i++) if (res[i]) locked.push(res[i]);
          state.lockedAccounts = locked;
          renderPeopleList();
        });
      });
  }

  // v14.6: account list changes also refresh the first-run guide's steps.
  function refreshGuide() {
    try {
      if (window.WABOnboarding) window.WABOnboarding.refresh();
    } catch (eWob) { /* the guide never breaks a push */ }
  }

  function renderPeopleList() {
    if (!el.list) return;
    // v14.6, the shell's rename law: never rebuild while the guide's name
    // input holds focus; the next event re-renders once the field commits.
    if (document.activeElement && document.activeElement.classList &&
        document.activeElement.classList.contains('wob-input')) return;
    el.list.textContent = '';

    if (!chatsOk()) {
      renderNote(el.list, 'People needs the latest app version', 'Update Chat Bridge to see people here.');
      return;
    }
    if (!state.peopleLoaded) {
      renderNote(el.list, state.peopleError ? 'Could not load people' : 'Loading people',
        state.peopleError ? 'Try again in a moment.' : '');
      return;
    }
    if (state.people.length === 0) {
      // v14.6: while the first-run guide is live it owns the empty desk,
      // ABOVE the locked-account cards so both explain themselves together.
      var guide = null;
      try {
        if (window.WABOnboarding && typeof window.WABOnboarding.card === 'function') {
          guide = window.WABOnboarding.card();
        }
      } catch (eG) { guide = null; }
      if (guide) el.list.appendChild(guide);
      var lockedEmpty = visibleLockedAccounts();
      if (lockedEmpty.length) {
        // Locked accounts explain themselves instead of a bare empty list.
        lockedEmpty.forEach(function (acc) { el.list.appendChild(lockedCard(acc)); });
      } else if (!guide) {
        renderNote(el.list, 'No people yet', 'Linked accounts with visible chats appear here.');
      }
      return;
    }

    var q = peopleFilterNorm();
    var shown = sortPeople(state.people); // open first, then t desc across accounts
    if (q) {
      shown = shown.filter(function (p) {
        return norm(p && p.title).indexOf(q) !== -1;
      });
    }
    if (shown.length === 0) {
      renderNote(el.list, 'No one matches that filter', '');
      return;
    }

    shown.forEach(function (p) {
      el.list.appendChild(buildPersonRow(p));
    });
    if (!q) {
      // Locked accounts sit after the rows so mixed desks stay honest too.
      var lockedExtra = visibleLockedAccounts();
      lockedExtra.forEach(function (acc) { el.list.appendChild(lockedCard(acc)); });
    }
    applyPersonHighlight();
    applyRailSignals(); // Y3: typing dots + progress line survive the re-render
  }

  function buildPersonRow(p) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'people-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset.account = String(p && p.accountId || '');
    row.dataset.title = String(p && p.title || '');
    if (p && p.chatId) row.dataset.chatId = String(p.chatId);
    row.dataset.platform = platformOf(p && p.platform); // V14 T5: render.js opens read this

    // Account color feeds the left-edge glow and the open-person blink halo.
    try { row.style.setProperty('--wabp-acct', (p && p.accountColor) || 'rgba(255,255,255,0.42)'); } catch (eV) { /* cosmetic */ }

    row.appendChild(buildAvatar(p));
    row.appendChild(platformDot(p)); // V14 T5: platform dot between face and name

    var name = document.createElement('span');
    name.className = 'people-name';
    name.textContent = (p && p.title) || 'Unknown';
    row.appendChild(name);

    // Y3: typing dots own the slot just before the unread badge. The span is
    // always in the DOM (display none until the row carries is-typing), so
    // applyTyping only toggles a class, never rebuilds the row.
    var typing = document.createElement('span');
    typing.className = 'people-typing';
    typing.setAttribute('aria-hidden', 'true');
    for (var di = 0; di < 3; di++) {
      typing.appendChild(document.createElement('i'));
    }
    row.appendChild(typing);

    var u = parseInt(p && p.unread, 10) || 0;
    if (u > 0) {
      var badge = document.createElement('span');
      badge.className = 'people-unread';
      badge.textContent = String(u);
      row.appendChild(badge);
    }

    // Y3: 2px progress line under the name while a pane is loading or sending
    // in this conversation. Always in the DOM, shown via is-progress.
    var prog = document.createElement('span');
    prog.className = 'people-progress';
    prog.setAttribute('aria-hidden', 'true');
    row.appendChild(prog);

    row.title = ((p && p.title) || '') + ((p && p.accountName) ? ' · ' + p.accountName : '');
    row.addEventListener('click', function () { openFromCmd(p); });
    return row;
  }

  // Re-derives the open-person class from pane state after every render, so
  // the highlight plus blink survive refreshes, pushes and filter re-renders.
  function applyPersonHighlight() {
    if (!el.list) return;
    var st = state.paneStates[state.activeSlot];
    var wantAccount = (st && st.open && st.accountId) || null;
    var wantTitle = (st && st.open && st.title) || null;

    var rows = el.list.querySelectorAll('.people-row');
    Array.prototype.forEach.call(rows, function (row) {
      var hit = !!(wantAccount && wantTitle &&
        row.dataset.account === String(wantAccount) &&
        norm(row.dataset.title) === norm(wantTitle));
      row.classList.toggle('is-open-person', hit);
      row.setAttribute('aria-selected', hit ? 'true' : 'false');
    });
  }

  /* ---------- V12.5 Y3: typing dots + progress line (rail signals) ----------
     Both signals are DATA first, paint second: state.typing and
     state.progressKinds survive every re-render, and rows derive their
     is-typing / is-progress classes from that data after each render. */

  // wab.eng.onTyping push: {accountId, titles}. Contract: titles is the FULL
  // current typing set for that account, so each push drops that account's
  // stale marks and re-adds the live ones. A TTL sweeps anything whose stop
  // push was lost; the sweep interval runs only while marks exist.
  function onTypingPush(payload) {
    try {
      if (!payload || !payload.accountId) return;
      var account = String(payload.accountId);
      var prefix = account + '\u0000';
      var titles = payload.titles;
      if (titles == null) titles = [];
      if (!Array.isArray(titles)) titles = [titles];

      var keep = [];
      for (var i = 0; i < titles.length; i++) {
        var t = norm(titles[i]);
        if (t) keep.push(t);
      }

      var now = Date.now();
      var changed = false;
      state.typing.forEach(function (key) {
        if (key.indexOf(prefix) === 0 && keep.indexOf(key.slice(prefix.length)) === -1) {
          state.typing.delete(key);
          delete state.typingUntil[key];
          changed = true;
        }
      });
      for (var j = 0; j < keep.length; j++) {
        var k = prefix + keep[j];
        if (!state.typing.has(k)) changed = true;
        state.typing.add(k);
        state.typingUntil[k] = now + TYPING_TTL;
      }
      if (changed) applyRailSignals();
      ensureTypingSweep();
    } catch (e) { /* never throw from a push */ }
  }

  function sweepTyping() {
    var now = Date.now();
    var expired = false;
    state.typing.forEach(function (key) {
      var until = state.typingUntil[key];
      if (!until || until < now) {
        state.typing.delete(key);
        delete state.typingUntil[key];
        expired = true;
      }
    });
    if (state.typing.size === 0 && state.typingTimer !== null) {
      window.clearInterval(state.typingTimer);
      state.typingTimer = null;
    }
    if (expired) applyRailSignals();
  }

  function ensureTypingSweep() {
    if (state.typingTimer === null && state.typing.size > 0) {
      state.typingTimer = window.setInterval(function () {
        try { sweepTyping(); } catch (e) { /* never throw from a timer */ }
      }, 3000);
    }
  }

  // render.js (Y2) dispatches window CustomEvent 'wab:progress'
  // {slot, kind, on}. Kinds stack per slot (a load and a send can overlap);
  // the line shows while any kind is on.
  function onProgressEvent(ev) {
    try {
      var d = ev && ev.detail;
      if (!d || d.slot === undefined || d.slot === null) return;
      var slot = parseInt(d.slot, 10);
      if (isNaN(slot)) return;
      var kind = String(d.kind || 'any');
      if (d.on) {
        var kinds = state.progressKinds[slot];
        if (!kinds) {
          kinds = new Set();
          state.progressKinds[slot] = kinds;
        }
        kinds.add(kind);
      } else {
        var cur = state.progressKinds[slot];
        if (cur) {
          cur.delete(kind);
          if (cur.size === 0) delete state.progressKinds[slot];
        }
      }
      applyRailSignals();
    } catch (e) { /* never throw from an event */ }
  }

  // Slot -> person keys that currently carry a progress line.
  function progressKeys() {
    var keys = [];
    var slots = Object.keys(state.progressKinds);
    for (var i = 0; i < slots.length; i++) {
      var st = state.paneStates[slots[i]];
      if (st && st.open && st.accountId && st.title) {
        keys.push(personKey(st.accountId, st.title));
      }
    }
    return keys;
  }

  function applyTyping() {
    if (!el.list) return;
    var rows = el.list.querySelectorAll('.people-row');
    Array.prototype.forEach.call(rows, function (row) {
      row.classList.toggle('is-typing',
        state.typing.has(personKey(row.dataset.account, row.dataset.title)));
    });
  }

  function applyProgress() {
    if (!el.list) return;
    var keys = progressKeys();
    var rows = el.list.querySelectorAll('.people-row');
    Array.prototype.forEach.call(rows, function (row) {
      var key = personKey(row.dataset.account, row.dataset.title);
      var on = false;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === key) { on = true; break; }
      }
      row.classList.toggle('is-progress', on);
    });
  }

  // One repaint pass for both signals; called after every list render and on
  // every typing or progress push.
  function applyRailSignals() {
    applyTyping();
    applyProgress();
  }

  /* ---------- opening a person ---------- */

  // Z3: every rail, palette and command-bar open routes through here. The
  // LIVE path is render.js: WABRender.openConversation targets the ACTIVE
  // screen in single and tabs (its record owns the one visible rect) and
  // the ACTIVE slot in splits and grids, reports the person to the spine
  // (X2's reportSpine feeds the panes:onState pushes this file trusts) and
  // fires the pre-open speed path. The legacy chats.open call stays as the
  // fallback for hosts running this fragment without render.js; the spine's
  // activePane follows render.js's active slot, so that path lands in the
  // active pane too.
  function openFromCmd(p) {
    if (p && p.chatId && window.WABRender &&
        typeof window.WABRender.openConversation === 'function') {
      window.WABRender.openConversation(p);
      return;
    }
    openPerson(p);
  }

  function openPerson(p) {
    if (!p || !p.accountId || !p.title) return;
    if (!chatsOk()) {
      toastRaw('People needs the latest app version');
      return;
    }
    wrap(function () { return window.wab.chats.open(p.accountId, p.title); }, 'Could not open that chat')
      .then(function (res) {
        if (res === null) return; // wrap toasted the failure
        if (res && res.ok === false) {
          toastRaw(res.error || 'Could not open that chat');
          return;
        }
        // Pane state push arrives separately; this is the safety net.
        state.openMark = Date.now();
        state.openMarkAccount = p.accountId;
        refreshPanes();
      });
  }

  /* ---------- pane state and reply-as chips ---------- */

  function onPaneState(p) {
    if (!p) return;
    var slot = parseInt(p.slot, 10);
    if (isNaN(slot)) return;
    var prev = state.paneStates[slot];
    state.paneStates[slot] = {
      accountId: p.accountId || null,
      accountName: p.accountName || '',
      accountColor: p.accountColor || '',
      title: p.title || '',
      open: p.open !== false
    };
    // Y3: the pane moved to a different person; in-flight progress kinds
    // belonged to the old thread, drop them so the line never jumps people.
    if (state.progressKinds[slot] && prev && prev.open &&
        (String(prev.accountId) !== String(p.accountId) ||
         norm(prev.title) !== norm(p.title || ''))) {
      delete state.progressKinds[slot];
    }
    // chats.open attaches to the ACTIVE pane: the first push for that account
    // right after an open tells us which slot is active.
    if (state.openMark && state.openMarkAccount &&
        Date.now() - state.openMark < 5000 &&
        p.accountId === state.openMarkAccount) {
      state.activeSlot = slot;
      state.openMark = 0;
    }
    // Z3: the open-to-top pin follows the open set. Re-render only when the
    // set changed, so isActive-only pushes never thrash the rail; the
    // highlight and signals are re-derived either way.
    var sig = openSetSig();
    if (sig !== state.openSig) {
      state.openSig = sig;
      renderPeopleList();
    } else {
      applyPersonHighlight();
      applyRailSignals(); // progress lines remap to the new pane person
    }
    refreshPanes();
  }

  function safeRects() {
    try {
      if (window.WABSlots && typeof window.WABSlots.getRects === 'function') {
        var r = window.WABSlots.getRects();
        if (Array.isArray(r)) return r;
      }
    } catch (e) { /* no slots yet */ }
    return [];
  }

  function ensureChips() {
    if (el.chips || !document.body) return;
    el.chips = $('wab-pane-chips');
    if (!el.chips) {
      el.chips = document.createElement('div');
      el.chips.id = 'wab-pane-chips';
      document.body.appendChild(el.chips);
    }
  }

  function buildChip(rect) {
    var slot = parseInt(rect.slot, 10);
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pane-chip';
    chip.style.left = (rect.x + 8) + 'px';
    chip.style.top = (rect.y + 8) + 'px';
    if (rect.w > 16) chip.style.maxWidth = (rect.w - 16) + 'px';

    var st = state.paneStates[slot];
    var hasPerson = !!(st && st.open && st.title);

    if (hasPerson) {
      var dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = st.accountColor || 'var(--wabp-dot-fallback)';
      chip.appendChild(dot);

      var title = document.createElement('span');
      title.className = 'chip-title';
      title.textContent = st.title;
      chip.appendChild(title);

      var acct = document.createElement('span');
      acct.className = 'chip-acct';
      acct.textContent = st.accountName || '';
      chip.appendChild(acct);

      chip.title = st.title + ' · ' + (st.accountName || '');
      chip.setAttribute('aria-label', 'Pane ' + (slot + 1) + ': ' + st.title +
        (st.accountName ? ', account ' + st.accountName : ''));
    } else {
      chip.classList.add('is-empty');
      var empty = document.createElement('span');
      empty.className = 'chip-empty';
      empty.textContent = 'Empty pane';
      chip.appendChild(empty);
      chip.title = 'Empty pane';
      chip.setAttribute('aria-label', 'Pane ' + (slot + 1) + ': empty');
    }

    if (slot === state.activeSlot) chip.classList.add('is-active');
    chip.addEventListener('click', function () { setActivePane(slot); });
    return chip;
  }

  function refreshPanes() {
    if (!el.chips) return;
    var rects = safeRects();
    el.chips.textContent = '';
    for (var i = 0; i < rects.length; i++) {
      if (!rects[i] || rects[i].slot === undefined) continue;
      el.chips.appendChild(buildChip(rects[i]));
    }
  }

  function setActivePane(slot) {
    slot = parseInt(slot, 10);
    if (isNaN(slot)) return;
    state.activeSlot = slot;
    refreshPanes();
    applyPersonHighlight();
    if (paneApiOk()) {
      wrap(function () { return window.wab.app.setActivePane(slot); }, 'Could not switch the active pane');
    }
  }

  function cyclePane(dir) {
    var rects = safeRects().slice().sort(function (a, b) { return (a.x || 0) - (b.x || 0); });
    if (rects.length === 0) return;
    // Single screen with several sender accounts: arrows swipe the screens.
    if (rects.length === 1 && window.WABShell && typeof window.WABShell.cycleSingleAccount === 'function') {
      window.WABShell.cycleSingleAccount(dir);
      return;
    }
    var idx = -1;
    for (var i = 0; i < rects.length; i++) {
      if (parseInt(rects[i].slot, 10) === state.activeSlot) { idx = i; break; }
    }
    if (idx === -1) idx = 0;
    var next = rects[(idx + dir + rects.length) % rects.length];
    setActivePane(parseInt(next.slot, 10));
  }

  /* ---------- palette ---------- */

  function paletteQuery() {
    return el.paletteInput ? (el.paletteInput.value || '').trim() : '';
  }

  /* ---------- command bar: /sender @receiver (owner spec, 2026-11-21) ----------
     "/bj" + Tab completes the sender account, "@bo" lists Boris/Boardy ordered
     by last contact (open chats pinned first since Z3), Tab completes, Enter
     opens that thread from that account in the ACTIVE pane or screen.

     Z3 law: for command queries, THIS file owns Tab, Enter and result-row
     clicks through document-level capture listeners. Document capture fires
     before render.js's capture listeners on #search-palette and
     #palette-results, so its interception chain (openFromPalRow, which reads
     the row's account NAME and would try to open the sender account itself
     as a chat) is fully bypassed for command queries and untouched for plain
     searches. */

  function isCmdQuery() {
    var q = paletteQuery();
    return q.charAt(0) === '/' || q.charAt(0) === '@' || /(^|\s)@/.test(q);
  }

  function stripSenderMark(s) {
    s = String(s || '');
    return s.charAt(0) === '/' ? s.slice(1) : s;
  }

  // Exact name first, then the first account whose name starts with the
  // token. norm() both sides, so "/bj" hits "the owner" and diacritics fold.
  function findAccount(tok) {
    var t = norm(tok);
    if (!t) return null;
    var accts = state.accounts || [];
    var prefix = null;
    for (var i = 0; i < accts.length; i++) {
      var nm = norm(accts[i] && accts[i].name);
      if (!nm) continue;
      if (nm === t) return accts[i];
      if (!prefix && nm.indexOf(t) === 0) prefix = accts[i];
    }
    return prefix;
  }

  // Split around the FIRST @ token: everything before it is the sender run
  // (leading '/' optional, spaces kept so account names like "BJ Marketing"
  // stay in one piece), everything from it on is the receiver title (spaces
  // kept so "Marc Deckers" never collapses to "Deckers"). Without an @, the
  // first token is the sender and any further tokens are the receiver being
  // typed bare ("/bj mar"). The old token loop overwrote a multi-word
  // receiver with its last word; this parser cannot.
  function cmdParse() {
    var q = paletteQuery();
    var tokens = q.split(/\s+/).filter(Boolean);
    var out = { senderTok: '', receiverTok: '', sender: null, phase: 'sender' };

    var at = -1;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].charAt(0) === '@') { at = i; break; }
    }

    if (at !== -1) {
      out.senderTok = stripSenderMark(tokens.slice(0, at).join(' '));
      out.receiverTok = tokens.slice(at).join(' ').replace(/^@/, '');
      out.phase = 'receiver';
    } else if (tokens.length) {
      out.senderTok = stripSenderMark(tokens[0]);
      if (tokens.length > 1) {
        out.receiverTok = tokens.slice(1).join(' ');
        out.phase = 'receiver';
      }
    }
    out.sender = findAccount(out.senderTok);
    return out;
  }

  // The .pal-row elements currently rendered, in cursor order.
  function cmdRows() {
    if (!el.paletteResults) return [];
    return Array.prototype.slice.call(el.paletteResults.querySelectorAll('.pal-row'), 0);
  }

  // Sender completion reads the marker off the DOM ROW (cmdBuildAccountRow
  // sets row.__cmdAccount). The V12.5 code checked state.paletteResults
  // objects for that marker, which only ever lived on the rows, so Tab
  // completed nothing: that was the tagging root cause.
  function pickSenderFromRow(row) {
    var acc = row && row.__cmdAccount;
    if (!acc || !el.paletteInput) return false;
    el.paletteInput.value = '/' + (acc.name || '') + ' @';
    cmdRender();
    return true;
  }

  function cmdComplete() {
    var p = cmdParse();
    if (p.phase === 'sender') {
      var row = cmdRows()[state.paletteCursor];
      if (row) pickSenderFromRow(row);
      return;
    }
    var cur = state.paletteResults[state.paletteCursor];
    var title = (cur && cur.title) || '';
    if (!title || !el.paletteInput) return;
    el.paletteInput.value = (p.sender ? '/' + p.sender.name + ' ' : '') + '@' + title + ' ';
    cmdRender();
  }

  // Enter in a command query: sender phase completes the token (same as
  // Tab), receiver phase opens the selected thread through the live path.
  function cmdEnter() {
    var p = cmdParse();
    if (p.phase === 'sender') {
      var row = cmdRows()[state.paletteCursor];
      if (row) pickSenderFromRow(row);
      return;
    }
    var cur = state.paletteResults[state.paletteCursor];
    if (!cur || !cur.title) return;
    closePalette();
    openFromCmd(cur);
  }

  // Document capture: fires before render.js's #search-palette capture for
  // every key aimed at the palette input. Only Tab and Enter in a command
  // query are taken; everything else passes through untouched.
  function onDocKeyDownCapture(ev) {
    try {
      if (!state.paletteOpen || !el.paletteInput) return;
      if (document.activeElement !== el.paletteInput) return;
      if (!isCmdQuery()) return;
      var key = ev.key || '';
      if (key === 'Tab') {
        ev.preventDefault();
        ev.stopPropagation();
        cmdComplete();
      } else if (key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        cmdEnter();
      }
    } catch (e) { /* never throw out of a handler */ }
  }

  // Document capture: row clicks in a command query never reach render.js's
  // #palette-results capture (which would openFromPalRow the account row as
  // if it were a person). Sender rows pick the sender; receiver rows open
  // the exact person object the row was built from.
  function onDocClickCapture(ev) {
    try {
      if (!state.paletteOpen || !isCmdQuery()) return;
      if (!el.paletteResults || !el.paletteInput) return;
      if (!el.paletteResults.contains(ev.target)) return;
      var row = ev.target && ev.target.closest ? ev.target.closest('.pal-row') : null;
      if (!row) return;
      if (row.__cmdAccount) {
        ev.preventDefault();
        ev.stopPropagation();
        if (pickSenderFromRow(row)) {
          try { el.paletteInput.focus(); } catch (eF) { /* fine */ }
        }
        return;
      }
      if (row.__wabPerson) {
        ev.preventDefault();
        ev.stopPropagation();
        closePalette();
        openFromCmd(row.__wabPerson);
      }
    } catch (e) { /* never throw out of a handler */ }
  }

  function cmdBuildAccountRow(acc, index) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'pal-row';
    row.setAttribute('role', 'option');
    row.__cmdAccount = acc; // DOM-row marker: cmdComplete and the click layer read it
    // wabr-avatar on the dot: render.js decorates only rows without one, and
    // sender accounts carry no photos, so the dot stays a dot.
    var dot = document.createElement('span');
    dot.className = 'pal-dot wabr-avatar';
    dot.style.background = acc.color || '#426CA8';
    row.appendChild(dot);
    var name = document.createElement('span');
    name.className = 'pal-name';
    name.textContent = acc.name || 'Account';
    row.appendChild(name);
    var tag = document.createElement('span');
    tag.className = 'pal-account';
    tag.textContent = 'sender';
    row.appendChild(tag);
    row.addEventListener('mouseenter', function () { state.paletteCursor = index; paintCursor(); });
    row.addEventListener('click', function () {
      // Z3: usually stopped at the document-capture layer before it gets
      // here; kept so the row still works when that layer is unwired.
      pickSenderFromRow(row);
      try { el.paletteInput.focus(); } catch (e) { /* fine */ }
    });
    return row;
  }

  function cmdRender() {
    if (!state.paletteOpen) return;
    var p = cmdParse();
    if (p.phase === 'sender') {
      var st = norm(p.senderTok);
      var accts = (state.accounts || []).filter(function (a) {
        return !st || norm(a && a.name).indexOf(st) === 0;
      });
      state.paletteResults = accts.slice(0, 12);
      state.paletteCursor = state.paletteResults.length ? 0 : -1;
      el.paletteResults.textContent = '';
      var hint = document.createElement('div');
      hint.className = 'people-note';
      var hm = document.createElement('span');
      hm.className = 'people-note-main';
      hm.textContent = 'Pick the sender';
      var hs = document.createElement('span');
      hs.className = 'people-note-sub';
      hs.textContent = 'Tab or Enter completes, then type @ for the receiver';
      hint.appendChild(hm); hint.appendChild(hs);
      el.paletteResults.appendChild(hint);
      state.paletteResults.forEach(function (acc, i) {
        el.paletteResults.appendChild(cmdBuildAccountRow(acc, i));
      });
      if (!state.paletteResults.length) {
        renderPalNote('No sender matches', 'Linked accounts only.');
      }
      paintCursor();
      return;
    }
    // Receiver phase: people narrowed to the chosen sender, open chats
    // pinned first, then last contact (the single ordering law).
    var rt = norm(p.receiverTok);
    var pool = (state.people || []).filter(function (person) {
      if (p.sender && person.accountId &&
          String(person.accountId) !== String(p.sender.id)) return false;
      if (!rt) return true;
      return norm(person && person.title).indexOf(rt) !== -1;
    });
    pool = sortPeople(pool);
    var rows = pool.slice(0, 12);
    state.paletteResults = rows;
    state.paletteCursor = rows.length ? 0 : -1;
    el.paletteResults.textContent = '';
    var rhint = document.createElement('div');
    rhint.className = 'people-note';
    var rm = document.createElement('span');
    rm.className = 'people-note-main';
    rm.textContent = p.sender ? ('From ' + p.sender.name) : 'All accounts';
    var rs = document.createElement('span');
    rs.className = 'people-note-sub';
    rs.textContent = 'Open chats first, then newest contact. Tab completes, Enter opens.';
    rhint.appendChild(rm); rhint.appendChild(rs);
    el.paletteResults.appendChild(rhint);
    rows.forEach(function (person, i) {
      el.paletteResults.appendChild(buildPalRow(person, i));
    });
    if (!rows.length) renderPalNote('No receiver matches', 'Type more of the name.');
    paintCursor();
  }

  function openPalette() {
    if (!el.palette) return;
    state.paletteOpen = true;
    state.searchSeq++;
    state.paletteCursor = -1;
    el.palette.hidden = false;
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(true); } catch (e) { /* optional */ }
    if (el.paletteInput) {
      // Z3: every palette session starts clean. The old select-only dance
      // kept stale text from a previous session, and when the selection
      // was lost the first keystroke APPENDED to it ("/marc" turning into
      // "marc/"), so the command bar never engaged on reopen.
      el.paletteInput.value = '';
      try { el.paletteInput.select(); } catch (e) { /* fine */ }
      window.setTimeout(function () {
        try { el.paletteInput.focus(); } catch (e2) { /* fine */ }
      }, 0);
    }
    // Command bar needs the linked accounts for the /sender phase.
    try {
      if (window.wab && window.wab.accounts && typeof window.wab.accounts.list === 'function') {
        window.wab.accounts.list().then(function (list) {
          if (Array.isArray(list)) {
            state.accounts = list;
            if (state.paletteOpen && isCmdQuery()) cmdRender();
          }
        }).catch(function () { /* degrade to people-only */ });
      }
    } catch (eAcc) { /* degrade quietly */ }
    renderPaletteRecent();
  }

  function closePalette() {
    state.paletteOpen = false;
    state.searchSeq++;
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(false); } catch (e) { /* optional */ }
    if (el.palette) el.palette.hidden = true;
    if (el.paletteInput) {
      // Z3: drop the query with the session, so no path can reopen the
      // palette onto a stale command.
      el.paletteInput.value = '';
      try { el.paletteInput.blur(); } catch (e) { /* fine */ }
    }
  }

  function renderPalNote(main, sub) {
    if (!el.paletteResults) return;
    state.paletteResults = [];
    state.paletteCursor = -1;
    el.paletteResults.textContent = '';
    var note = document.createElement('div');
    note.className = 'people-note';
    var m = document.createElement('span');
    m.className = 'people-note-main';
    m.textContent = main || '';
    note.appendChild(m);
    if (sub) {
      var s = document.createElement('span');
      s.className = 'people-note-sub';
      s.textContent = sub || '';
      note.appendChild(s);
    }
    el.paletteResults.appendChild(note);
  }

  function renderPaletteRecent() {
    if (!chatsOk()) {
      renderPalNote('Search needs the latest app version', '');
      return;
    }
    if (!state.peopleLoaded) {
      renderPalNote('Loading people', '');
      loadPeople({ silent: true });
      return;
    }
    if (state.people.length === 0) {
      renderPalNote('No people yet', 'Link an account to start.');
      return;
    }
    renderPaletteResults(recentPeople(12)); // open pinned, then t desc across accounts
  }

  function runPaletteSearch() {
    if (!state.paletteOpen) return;
    var q = paletteQuery();
    var seq = ++state.searchSeq;
    if (!q) { renderPaletteRecent(); return; }
    if (!chatsOk()) {
      renderPalNote('Search needs the latest app version', '');
      return;
    }
    renderPalNote('Searching', '');
    wrap(function () { return window.wab.chats.searchAll(q); }, 'Search failed')
      .then(function (res) {
        if (!state.paletteOpen || seq !== state.searchSeq) return;
        if (res === null) {
          renderPalNote('Search failed', 'Try again in a moment.');
          return;
        }
        if (!Array.isArray(res)) res = [];
        if (res.length === 0) {
          renderPalNote('Nothing found', 'No person matches that search.');
          return;
        }
        hydratePeople(res); // search rows borrow cached photos too
        renderPaletteResults(sortPeople(res));
      });
  }

  function buildPalRow(p, index) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'pal-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('data-account', String(p && p.accountId || ''));
    row.setAttribute('data-title', String(p && p.title || ''));
    if (p && p.chatId) row.setAttribute('data-chat-id', String(p.chatId));
    row.setAttribute('data-platform', platformOf(p && p.platform)); // V14 T5
    row.__wabPerson = p; // Z3: the click layer opens the exact object, not a re-read of the DOM

    // Photo when the person has one, initials only as the fallback (PR #8).
    row.appendChild(buildAvatar(p));
    row.appendChild(platformDot(p)); // V14 T5: same dot as the rail

    var name = document.createElement('span');
    name.className = 'pal-name';
    name.textContent = (p && p.title) || 'Unknown';
    row.appendChild(name);

    if (p && p.accountName) {
      var acct = document.createElement('span');
      acct.className = 'pal-account';
      acct.textContent = p.accountName;
      row.appendChild(acct);
    }

    var u = parseInt(p && p.unread, 10) || 0;
    if (u > 0) {
      var badge = document.createElement('span');
      badge.className = 'pal-unread';
      badge.textContent = String(u);
      row.appendChild(badge);
    }

    row.title = ((p && p.title) || '') + ((p && p.accountName) ? ' · ' + p.accountName : '');
    row.addEventListener('mouseenter', function () {
      state.paletteCursor = index;
      paintCursor();
    });
    row.addEventListener('click', function () {
      // Z3: command queries are stopped at the document-capture layer, which
      // opens the exact person; this listener serves plain searches, where
      // render.js's capture layer usually wins and re-reads the row anyway.
      openFromCmd(p);
      closePalette();
    });
    return row;
  }

  function renderPaletteResults(list) {
    if (!el.paletteResults) return;
    state.paletteResults = list;
    state.paletteCursor = list.length ? 0 : -1;
    el.paletteResults.textContent = '';
    list.forEach(function (p, i) {
      el.paletteResults.appendChild(buildPalRow(p, i));
    });
    paintCursor();
  }

  function paintCursor() {
    if (!el.paletteResults) return;
    var rows = el.paletteResults.querySelectorAll('.pal-row');
    Array.prototype.forEach.call(rows, function (row, i) {
      var on = i === state.paletteCursor;
      row.classList.toggle('cursor', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var cur = rows[state.paletteCursor];
    if (cur && typeof cur.scrollIntoView === 'function') {
      try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) { /* fine */ }
    }
  }

  function moveCursor(dir) {
    var len = state.paletteResults.length;
    if (len === 0) return;
    var next = state.paletteCursor + dir;
    if (next < 0) next = len - 1;
    if (next >= len) next = 0;
    state.paletteCursor = next;
    paintCursor();
  }

  /* ---------- wiring ---------- */

  var searchDebounced = debounce(runPaletteSearch, 200);
  var peopleRefreshDebounced = debounce(function () { loadPeople({ silent: true }); }, 1000);

  function wire() {
    if (el.filter) {
      el.filter.addEventListener('input', function () { renderPeopleList(); });
    }
    if (el.searchBtn) {
      el.searchBtn.addEventListener('click', function () { openPalette(); });
    }
    if (el.paletteClose) {
      el.paletteClose.addEventListener('click', function () { closePalette(); });
    }
    if (el.palette) {
      el.palette.addEventListener('click', function (ev) {
        if (ev.target === el.palette) closePalette();
      });
    }
    if (el.paletteInput) {
      el.paletteInput.addEventListener('input', function () {
        if (isCmdQuery()) cmdRender();
        else searchDebounced();
      });
      el.paletteInput.addEventListener('keydown', function (ev) {
        // Z3: Tab and Enter in a command query are owned by the
        // document-capture handler (it fires first and stops the event);
        // this listener serves arrows, Escape and plain-search Enter.
        var key = ev.key || '';
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          ev.preventDefault();
          ev.stopPropagation();
          moveCursor(key === 'ArrowDown' ? 1 : -1);
        } else if (key === 'Enter') {
          if (isCmdQuery()) return; // document-capture layer handled it
          ev.preventDefault();
          ev.stopPropagation();
          var p = state.paletteResults[state.paletteCursor];
          if (p) {
            openFromCmd(p);
            closePalette();
          }
        } else if (key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closePalette();
        }
      });
    }

    // Z3: the command-bar layer. Document capture beats render.js's
    // #search-palette and #palette-results capture listeners on the way
    // down, so Tab, Enter and row clicks in a command query are ours.
    document.addEventListener('keydown', onDocKeyDownCapture, true);
    document.addEventListener('click', onDocClickCapture, true);

    window.addEventListener('keydown', function (ev) {
      try {
        var key = ev.key || '';
        var lower = key.toLowerCase();
        if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && lower === 'k') {
          ev.preventDefault();
          if (state.paletteOpen) closePalette();
          else openPalette();
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
          ev.preventDefault();
          cyclePane(key === 'ArrowRight' ? 1 : -1);
          return;
        }
        if (key === 'Escape' && state.paletteOpen &&
            document.activeElement !== el.paletteInput) {
          ev.preventDefault();
          closePalette();
        }
      } catch (e) { /* never throw out of a handler */ }
    });

    // Y3: pane progress mirror. render.js (Y2) dispatches 'wab:progress'
    // {slot, kind, on}; before that merge lands this simply never fires.
    window.addEventListener('wab:progress', function (ev) { onProgressEvent(ev); });

    // v14.6: the first-run guide re-renders the rail when its step states move.
    window.addEventListener('wab:onboarding-updated', function () { renderPeopleList(); });

    // V14 U3: rail platform-card clicks, delegated at document level (U2 owns
    // the card DOM in the rail's sender section, outside this fragment's root,
    // and re-renders it freely; delegation survives every re-render).
    document.addEventListener('click', onPlatCardClick);

    window.addEventListener('resize', function () { refreshPanes(); });
    window.addEventListener('load', function () { refreshPanes(); });
  }

  function subscribePushes() {
    if (!wabOk()) return;
    try {
      if (window.wab.app && typeof window.wab.app.onUnread === 'function') {
        window.wab.app.onUnread(function () { peopleRefreshDebounced(); });
      }
    } catch (e) { /* degrade quietly */ }
    // Spine seam (v12.1): background avatar pulls push eng:people-updated; swap
    // rows in place so faces arrive without a full refresh.
    try {
      if (window.wab.eng && typeof window.wab.eng.onPeopleUpdated === 'function') {
        window.wab.eng.onPeopleUpdated(function () { peopleRefreshDebounced(); });
      }
    } catch (ePu) { /* degrade quietly */ }
    // Spine seam (v12.5 Y1): typing pushes carry the full per-account typing
    // set. Guarded: before the spine merge this simply never fires.
    try {
      if (window.wab.eng && typeof window.wab.eng.onTyping === 'function') {
        window.wab.eng.onTyping(function (payload) { onTypingPush(payload); });
      }
    } catch (eTy) { /* degrade quietly */ }
    try {
      if (window.wab.accounts && typeof window.wab.accounts.onStatus === 'function') {
        window.wab.accounts.onStatus(function () { peopleRefreshDebounced(); });
      }
    } catch (e) { /* degrade quietly */ }
    try {
      if (window.wab.accounts && typeof window.wab.accounts.onListChanged === 'function') {
        window.wab.accounts.onListChanged(function () { peopleRefreshDebounced(); loadLockInfo(); refreshGuide(); });
      }
    } catch (e) { /* degrade quietly */ }
    try {
      if (window.wab.app && typeof window.wab.app.onPaneState === 'function') {
        window.wab.app.onPaneState(function (p) { onPaneState(p); });
      }
    } catch (e) { /* degrade quietly */ }
    try {
      if (window.WABSlots && typeof window.WABSlots.onLayoutChange === 'function') {
        window.WABSlots.onLayoutChange(function () { refreshPanes(); });
      }
    } catch (e) { /* degrade quietly */ }
    // Reply glow: the spine pushes debug events; pane-reply carries accountId.
    // Guarded: before the spine merge this simply never fires.
    try {
      if (window.wab.debug && typeof window.wab.debug.onEvent === 'function') {
        window.wab.debug.onEvent(function (ev) {
          try {
            if (ev && ev.kind === 'pane-reply' && ev.accountId) onReplyGlow(ev.accountId);
          } catch (e) { /* never throw from a push */ }
        });
      }
    } catch (e) { /* degrade quietly */ }
  }

  /* ---------- init ---------- */

  function initInternal() {
    if (state.inited) return;
    wireFold();             // rail fold chrome is host-level, not fragment-level
    el.root = $('wab-people-root');
    if (!el.root) return; // fragment not pasted yet; a later init() can still run
    state.inited = true;
    loadFold();             // after wireFold so the button reflects the state

    try { el.root.removeAttribute('hidden'); } catch (e) { /* fine */ }

    mountRail();
    el.filter = $('people-filter');
    el.list = $('people-list');
    el.searchBtn = $('people-search-btn');
    el.refreshBtn = $('people-refresh-btn');
    if (el.refreshBtn) {
      el.refreshBtn.addEventListener('click', function () {
        try { el.refreshBtn.classList.add('spin'); } catch (eS) { /* fine */ }
        loadPeople({ silent: false }).then(function () {
          try { el.refreshBtn.classList.remove('spin'); } catch (eR) { /* fine */ }
        }, function () {
          try { el.refreshBtn.classList.remove('spin'); } catch (eR2) { /* fine */ }
        });
        try { window.dispatchEvent(new CustomEvent('wab:people-refresh')); } catch (eD) { /* renderer listens if present */ }
      });
    }
    el.palette = $('search-palette');
    el.paletteInput = $('palette-input');
    el.paletteResults = $('palette-results');
    el.paletteClose = $('palette-close');

    ensureChips();
    wire();
    subscribePushes();

    renderPeopleList(); // loading state
    loadPeople();
    refreshPanes();

    // Auto-refresh: silent poll while the window is visible (hard refresh stays for a forced pull).
    state.autoTimer = window.setInterval(function () {
      if (document.hidden) return;
      loadPeople({ silent: true });
    }, 20000);

    // Command bar (/sender @receiver) needs the accounts ready before the first '/'.
    try {
      if (window.wab && window.wab.accounts && typeof window.wab.accounts.list === 'function') {
        window.wab.accounts.list().then(function (list) {
          if (Array.isArray(list)) state.accounts = list;
        }).catch(function () { /* degrade to lazy load on palette open */ });
      }
    } catch (eAcc) { /* degrade quietly */ }
  }

  /* ---------- public surface ---------- */

  window.WABPeople = {
    init: function () {
      try { initInternal(); } catch (e) { /* degrade quietly */ }
    },
    refresh: function () {
      try { loadPeople(); } catch (e) { /* degrade quietly */ }
    },
    openInActivePane: function (person) {
      try { openFromCmd(person); } catch (e) { /* degrade quietly */ }
    },
    openPalette: function () {
      try { openPalette(); } catch (e) { /* degrade quietly */ }
    },
    closePalette: function () {
      try { closePalette(); } catch (e) { /* degrade quietly */ }
    },
    setActivePane: function (slot) {
      try { setActivePane(slot); } catch (e) { /* degrade quietly */ }
    },
    refreshPanes: function () {
      try { ensureChips(); refreshPanes(); } catch (e) { /* degrade quietly */ }
    },
    connectPlatform: function (platform, userId, userName) {
      try { return connectPlatform(platform, userId, userName); } catch (e) { return false; }
    },
    setFolded: function (on) {
      try { applyFold(!!on, true); } catch (e) { /* degrade quietly */ }
    }
  };

  /* Auto-boot like the other UI modules; WABPeople.init() stays a safe no-op
     afterwards (and before the fragment exists). */
  function boot() {
    try { initInternal(); } catch (e) { /* degrade quietly */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
