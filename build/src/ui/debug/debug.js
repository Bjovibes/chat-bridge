/* Chat Bridge debug.js, stage S1 (v12). Mirrors build\src\ui\debug\debug.js.
   Classic script, no modules, file:// safe. The always-on Debug panel for the
   Settings slide-over. Exposes window.WABDebug = { init, open, close }.
   Spine reads: wab.debug.dump() (seed, array or { events: [...] }),
   wab.debug.onEvent(cb) (live, event { t, kind, accountId, text }),
   wab.eng.health() -> { accountId: { idb, modules, lastError } }.
   Every guard fails soft: an old preload or a missing fragment never throws.
   Event text carries step names and counts only; this panel adds nothing. */

(function () {
  'use strict';

  /* ---------- constants + state ---------- */

  var MAX_ROWS = 100;
  var HEALTH_TICK_MS = 10000;

  // Chip classes per kind. Green stays reserved for reply/live signals.
  var KIND_CLASS = {
    'engine-health': '',
    'send-step': '',
    'open-step': '',
    'people-refresh': '',
    'pane-reply': 'is-reply',
    'engine-error': 'is-error'
  };

  var state = {
    inited: false,
    open: false,
    events: [],      // newest first, capped at MAX_ROWS
    feedError: '',
    health: null,    // accountId -> { idb, modules, lastError }, null until read
    healthError: '',
    healthTimer: null,
    dumpSeq: 0,
    unsubEvent: null,
    settingsObserver: null
  };

  var el = {
    root: null, enginesList: null, refreshBtn: null,
    feed: null, feedEmpty: null, feedCount: null, peopleAge: null
  };

  /* ---------- utils ---------- */

  function $(id) { return document.getElementById(id); }

  function wabOk() { return typeof window.wab === 'object' && window.wab !== null; }
  function dumpOk() {
    return wabOk() && window.wab.debug && typeof window.wab.debug.dump === 'function';
  }
  function eventsOk() {
    return wabOk() && window.wab.debug && typeof window.wab.debug.onEvent === 'function';
  }
  function healthOk() {
    return wabOk() && window.wab.eng && typeof window.wab.eng.health === 'function';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clockTime(t) {
    var d = new Date(Number(t) || 0);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // wa_ab12cd34 -> ab12cd34. Unknown shapes clip to 8 chars.
  function shortId(accountId) {
    var s = String(accountId || '');
    if (s.indexOf('wa_') === 0) s = s.slice(3);
    s = s.slice(0, 8);
    return s || 'unknown';
  }

  function cleanEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      t: Number(raw.t) || 0,
      kind: String(raw.kind || 'unknown').slice(0, 40),
      accountId: String(raw.accountId || '').slice(0, 40),
      text: String(raw.text || '').slice(0, 200)
    };
  }

  // The live spine returns the ring array; older drafts returned { events: [...] }.
  // Accept both so the panel never depends on which shape ships.
  function normalizeDump(res) {
    var list = null;
    if (Array.isArray(res)) list = res;
    else if (res && Array.isArray(res.events)) list = res.events;
    if (!list) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var ev = cleanEvent(list[i]);
      if (ev) out.push(ev);
    }
    return out;
  }

  function ageText(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
  }

  function errText(err, fallback) {
    var msg = err && (err.message || err.error);
    return (typeof msg === 'string' && msg) ? msg : (fallback || 'Something went wrong');
  }

  /* ---------- engines block ---------- */

  function badge(name, ok) {
    var b = document.createElement('span');
    b.className = 'wab-debug-badge ' + (ok ? 'is-ok' : 'is-bad');
    b.textContent = name;
    return b;
  }

  function noteRow(text, isError) {
    var n = document.createElement('div');
    n.className = 'wab-debug-note' + (isError ? ' is-error' : '');
    n.textContent = text;
    return n;
  }

  function engineRow(accountId, h) {
    var row = document.createElement('div');
    row.className = 'wab-debug-eng';

    var top = document.createElement('div');
    top.className = 'wab-debug-eng-top';
    var idSpan = document.createElement('span');
    idSpan.className = 'wab-debug-eng-id';
    idSpan.textContent = shortId(accountId);
    idSpan.title = accountId;
    top.appendChild(idSpan);
    top.appendChild(badge('idb', !!(h && h.idb)));
    top.appendChild(badge('modules', !!(h && h.modules)));
    row.appendChild(top);

    var err = (h && h.lastError) ? String(h.lastError).slice(0, 160) : '';
    if (err) {
      var errDiv = document.createElement('div');
      errDiv.className = 'wab-debug-eng-err';
      errDiv.textContent = err;
      row.appendChild(errDiv);
    }
    return row;
  }

  function renderEngines() {
    if (!el.enginesList) return;
    el.enginesList.textContent = '';
    if (state.healthError) {
      el.enginesList.appendChild(noteRow(state.healthError, true));
      return;
    }
    if (!state.health) {
      el.enginesList.appendChild(noteRow('Reading engine health.', false));
      return;
    }
    var ids = Object.keys(state.health);
    ids.sort();
    if (!ids.length) {
      el.enginesList.appendChild(noteRow('No engine sessions yet.', false));
      return;
    }
    for (var i = 0; i < ids.length; i++) {
      el.enginesList.appendChild(engineRow(ids[i], state.health[ids[i]]));
    }
  }

  function refreshHealth() {
    if (!healthOk()) {
      state.healthError = 'Engine health is not available in this build.';
      renderEngines();
      return;
    }
    window.wab.eng.health().then(function (res) {
      state.health = (res && typeof res === 'object') ? res : {};
      state.healthError = '';
      if (state.open) renderEngines();
    }, function (err) {
      state.healthError = errText(err, 'Could not read engine health');
      if (state.open) renderEngines();
    });
  }

  /* ---------- event feed ---------- */

  function feedRow(ev) {
    var r = document.createElement('div');
    r.className = 'wab-debug-row';

    var time = document.createElement('span');
    time.className = 'wab-debug-time';
    time.textContent = clockTime(ev.t);
    r.appendChild(time);

    var kc = KIND_CLASS[ev.kind];
    var chip = document.createElement('span');
    chip.className = 'wab-debug-chip' + (kc ? ' ' + kc : '');
    chip.textContent = ev.kind;
    r.appendChild(chip);

    var text = document.createElement('span');
    text.className = 'wab-debug-text';
    text.textContent = ev.text;
    text.title = ev.text;
    r.appendChild(text);

    if (ev.accountId) {
      var acc = document.createElement('span');
      acc.className = 'wab-debug-acc';
      acc.textContent = shortId(ev.accountId);
      acc.title = ev.accountId;
      r.appendChild(acc);
    }
    return r;
  }

  function clearFeedRows() {
    if (!el.feed) return;
    var rows = el.feed.querySelectorAll('.wab-debug-row');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].parentNode) rows[i].parentNode.removeChild(rows[i]);
    }
  }

  function trimFeed() {
    if (!el.feed) return;
    var rows = el.feed.querySelectorAll('.wab-debug-row');
    while (rows.length > MAX_ROWS) {
      var last = rows[rows.length - 1];
      if (!last || !last.parentNode) break;
      last.parentNode.removeChild(last);
      rows = el.feed.querySelectorAll('.wab-debug-row');
    }
  }

  // Newest first: a fresh row goes above the current first row.
  function insertTop(row) {
    if (!el.feed) return;
    var first = el.feed.querySelector('.wab-debug-row');
    if (first) { el.feed.insertBefore(row, first); return; }
    if (el.feedEmpty && el.feedEmpty.parentNode === el.feed) { el.feed.insertBefore(row, el.feedEmpty); return; }
    el.feed.appendChild(row);
  }

  function updateFeedEmpty() {
    if (!el.feedEmpty) return;
    if (state.feedError) {
      el.feedEmpty.textContent = state.feedError;
      el.feedEmpty.classList.add('is-error');
      el.feedEmpty.hidden = false;
      return;
    }
    el.feedEmpty.classList.remove('is-error');
    el.feedEmpty.textContent = 'No events yet.';
    el.feedEmpty.hidden = el.feed.querySelectorAll('.wab-debug-row').length > 0;
  }

  function updateCount() {
    if (!el.feedCount) return;
    var n = el.feed ? el.feed.querySelectorAll('.wab-debug-row').length : 0;
    el.feedCount.textContent = n > 0 ? n + ' events' : '';
  }

  function renderPeopleAge() {
    if (!el.peopleAge) return;
    var found = null;
    for (var i = 0; i < state.events.length; i++) {
      if (state.events[i].kind === 'people-refresh') { found = state.events[i]; break; }
    }
    if (!found || !found.t) { el.peopleAge.hidden = true; return; }
    el.peopleAge.hidden = false;
    el.peopleAge.textContent = 'People list refreshed ' + ageText(Date.now() - found.t);
  }

  function renderFeed() {
    if (!el.feed) return;
    clearFeedRows();
    for (var i = 0; i < state.events.length; i++) {
      el.feed.appendChild(feedRow(state.events[i]));
    }
    if (el.feedEmpty && el.feedEmpty.parentNode === el.feed) el.feed.appendChild(el.feedEmpty);
    trimFeed();
    updateCount();
    renderPeopleAge();
    updateFeedEmpty();
    el.feed.scrollTop = 0; // newest first: the top is always the live edge
  }

  function prependRow(ev) {
    if (!el.feed) return;
    insertTop(feedRow(ev));
    trimFeed();
    state.feedError = '';
    updateCount();
    renderPeopleAge();
    updateFeedEmpty();
    el.feed.scrollTop = 0;
  }

  function seedFeed() {
    if (!dumpOk()) {
      state.feedError = 'The debug history is not available in this build.';
      if (state.open) { clearFeedRows(); updateFeedEmpty(); }
      return;
    }
    var seq = ++state.dumpSeq;
    window.wab.debug.dump().then(function (res) {
      if (seq !== state.dumpSeq) return;
      var list = normalizeDump(res).slice(-MAX_ROWS);
      list.reverse(); // the ring is oldest first; the feed is newest first
      state.events = list;
      state.feedError = '';
      if (state.open) renderFeed();
    }, function (err) {
      if (seq !== state.dumpSeq) return;
      state.events = [];
      state.feedError = errText(err, 'Could not load the debug feed');
      if (state.open) renderFeed();
    });
  }

  function onDebugEvent(raw) {
    var ev = cleanEvent(raw);
    if (!ev) return;
    state.events.unshift(ev);
    if (state.events.length > MAX_ROWS) state.events.length = MAX_ROWS;
    if (state.open) prependRow(ev);
  }

  /* ---------- open / close / timers ---------- */

  function stopHealthTimer() {
    if (state.healthTimer !== null) {
      window.clearInterval(state.healthTimer);
      state.healthTimer = null;
    }
  }

  function startHealthTimer() {
    stopHealthTimer();
    state.healthTimer = window.setInterval(function () {
      if (!state.open || document.hidden) return;
      refreshHealth();
      renderPeopleAge(); // the age line keeps aging between events
    }, HEALTH_TICK_MS);
  }

  function openPanel() {
    if (!state.inited) initInternal();
    if (!el.root) return;
    state.open = true;
    el.root.hidden = false;
    renderEngines();
    refreshHealth();
    seedFeed();
    startHealthTimer();
  }

  function closePanel() {
    state.open = false;
    stopHealthTimer();
    if (el.root) el.root.hidden = true;
  }

  /* ---------- init ---------- */

  function initInternal() {
    if (state.inited) return;
    el.root = $('debug-panel-root');
    if (!el.root) return; // fragment not pasted yet; a later init() can still run
    state.inited = true;

    el.enginesList = $('wab-debug-engines-list');
    el.refreshBtn = $('wab-debug-refresh');
    el.feed = $('wab-debug-feed');
    el.feedEmpty = $('wab-debug-feed-empty');
    el.feedCount = $('wab-debug-feed-count');
    el.peopleAge = $('wab-debug-people-age');

    if (el.refreshBtn) {
      el.refreshBtn.addEventListener('click', function () {
        refreshHealth();
        seedFeed();
      });
    }

    // Live wire: keep collecting even while closed so nothing is missed.
    if (eventsOk()) {
      try {
        var unsub = window.wab.debug.onEvent(function (ev) { onDebugEvent(ev); });
        if (typeof unsub === 'function') state.unsubEvent = unsub;
      } catch (e) { /* old preload: dump-only mode */ }
    }

    // Ride along with the Settings slide-over when it exists: the panel opens
    // and closes with it, so init() alone is enough. Manual open()/close()
    // keep working for any other placement.
    var settingsEl = $('settings');
    if (settingsEl && typeof MutationObserver === 'function') {
      try {
        state.settingsObserver = new MutationObserver(function () {
          if (settingsEl.hidden) closePanel();
          else openPanel();
        });
        state.settingsObserver.observe(settingsEl, { attributes: true, attributeFilter: ['hidden'] });
        if (!settingsEl.hidden) openPanel();
      } catch (e) { /* manual control still works */ }
    }
  }

  /* ---------- public surface ---------- */

  window.WABDebug = {
    init: function () {
      try { initInternal(); } catch (e) { /* degrade quietly */ }
    },
    open: function () {
      try { openPanel(); } catch (e) { /* degrade quietly */ }
    },
    close: function () {
      try { closePanel(); } catch (e) { /* degrade quietly */ }
    }
  };

  /* Auto-boot like the other UI modules; WABDebug.init() stays a safe no-op
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
