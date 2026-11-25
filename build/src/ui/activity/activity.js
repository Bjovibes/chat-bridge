/* Chat Bridge activity.js, stage G1 (v12.7). Mirrors build\src\ui\activity\activity.js.
   Classic script, no modules, file:// safe. The Activity section for the
   Settings slide-over: the operator's own outgoing send stats. Exposes
   window.WABActivity = { init, open, close }.
   Spine reads: wab.stats.sent() -> { total, today, week, byAccount: {name: n},
   byChatTop: [{chat, n}], last } (metadata only), and wab.accounts.list() ->
   [{ id, name, color }] for the bar colors (account colors are data, chosen by
   the owner per account). Loads on settings open and re-reads every 30s while
   visible; no manual refresh button, same cadence idea as the debug panel.
   Every guard fails soft: an old preload or a missing fragment never throws. */

(function () {
  'use strict';

  /* ---------- constants + state ---------- */

  var TICK_MS = 30000;
  var MAX_CHAT_ROWS = 8;
  var MIN_BAR_PCT = 2; // a count of 1 still shows a sliver

  // Same palette shell.js falls back to when an account has no color yet.
  var FALLBACK_COLORS = ['#426CA8', '#2F855A', '#B7791F', '#C05621', '#9B2C2C', '#6B46C1', '#2C7A7B', '#4A5568'];

  var state = {
    inited: false,
    open: false,
    stats: null,      // normalized sent stats, null until first read
    statsError: '',
    colors: {},       // account name -> color
    loadSeq: 0,
    tickTimer: null,
    settingsObserver: null
  };

  var el = {
    root: null, note: null, statsRow: null,
    today: null, week: null, total: null, last: null,
    empty: null, accountsBlock: null, accounts: null,
    chatsBlock: null, chats: null
  };

  /* ---------- utils ---------- */

  function $(id) { return document.getElementById(id); }

  function wabOk() { return typeof window.wab === 'object' && window.wab !== null; }
  function statsOk() {
    return wabOk() && window.wab.stats && typeof window.wab.stats.sent === 'function';
  }
  function accountsOk() {
    return wabOk() && window.wab.accounts && typeof window.wab.accounts.list === 'function';
  }

  function errText(err, fallback) {
    var msg = err && (err.message || err.error);
    return (typeof msg === 'string' && msg) ? msg : (fallback || 'Something went wrong');
  }

  function fmtNum(n) {
    var v = Math.max(0, Math.floor(Number(n) || 0));
    return v >= 1000 ? v.toLocaleString('en-US') : String(v);
  }

  // "x min ago" for the Last send tile; days past that, still honest.
  function ageText(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  /* ---------- normalize the spine shapes ---------- */

  function normByAccount(byAccount) {
    var out = [];
    if (byAccount && typeof byAccount === 'object') {
      for (var key in byAccount) {
        if (!Object.prototype.hasOwnProperty.call(byAccount, key)) continue;
        var n = Math.max(0, Math.floor(Number(byAccount[key]) || 0));
        if (n <= 0) continue;
        out.push({ name: String(key || '').trim() || 'Unknown account', n: n });
      }
    }
    out.sort(function (a, b) { return b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return out;
  }

  // Chat keys are "account name · chat title" (the spine joins them with ' · ').
  // Split for coloring; the row shows the title, the full key rides in title=.
  function normChats(byChatTop) {
    var out = [];
    if (Array.isArray(byChatTop)) {
      for (var i = 0; i < byChatTop.length; i++) {
        var row = byChatTop[i];
        if (!row || typeof row !== 'object') continue;
        var n = Math.max(0, Math.floor(Number(row.n) || 0));
        if (n <= 0) continue;
        var full = String(row.chat || '').trim();
        if (!full) continue;
        var cut = full.indexOf(' · ');
        var account = cut > 0 ? full.slice(0, cut) : '';
        var title = cut > 0 ? full.slice(cut + 3) : full;
        out.push({ full: full, account: account, title: title || full, n: n });
      }
    }
    out.sort(function (a, b) { return b.n - a.n; });
    return out.slice(0, MAX_CHAT_ROWS);
  }

  function cleanStats(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    return {
      total: Math.max(0, Math.floor(Number(s.total) || 0)),
      today: Math.max(0, Math.floor(Number(s.today) || 0)),
      week: Math.max(0, Math.floor(Number(s.week) || 0)),
      byAccount: normByAccount(s.byAccount),
      byChat: normChats(s.byChatTop),
      last: Number(s.last) || 0
    };
  }

  /* ---------- colors (data, not decoration) ---------- */

  function resolveColors(accounts) {
    var map = {};
    if (Array.isArray(accounts)) {
      for (var i = 0; i < accounts.length; i++) {
        var a = accounts[i];
        if (!a) continue;
        var name = String(a.name || '').trim();
        if (!name) continue;
        map[name] = String(a.color || '').trim() || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
      }
    }
    return map;
  }

  // Deterministic fallback so a bar keeps its color between renders even when
  // the account is gone from the list (old log entries keep their counts).
  function colorFor(name) {
    if (name && state.colors[name]) return state.colors[name];
    var h = 0;
    var s = String(name || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  }

  /* ---------- render ---------- */

  function barRow(label, title, count, max, color) {
    var row = document.createElement('div');
    row.className = 'wab-activity-bar';

    var top = document.createElement('div');
    top.className = 'wab-activity-bar-top';
    var name = document.createElement('span');
    name.className = 'wab-activity-bar-name';
    name.textContent = label;
    name.title = title || label;
    top.appendChild(name);
    var n = document.createElement('span');
    n.className = 'wab-activity-bar-count';
    n.textContent = fmtNum(count);
    top.appendChild(n);
    row.appendChild(top);

    var pct = max > 0 ? Math.round((count / max) * 100) : 0;
    if (pct < MIN_BAR_PCT) pct = MIN_BAR_PCT;
    if (pct > 100) pct = 100;

    var track = document.createElement('div');
    track.className = 'wab-activity-track';
    var fill = document.createElement('div');
    fill.className = 'wab-activity-fill';
    fill.style.width = pct + '%';
    fill.style.background = color;
    track.appendChild(fill);
    row.appendChild(track);
    return row;
  }

  function renderBars(host, rows, useChatColor) {
    host.textContent = '';
    var max = 0;
    for (var i = 0; i < rows.length; i++) if (rows[i].n > max) max = rows[i].n;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var color = colorFor(useChatColor ? r.account : r.name);
      host.appendChild(barRow(r.title || r.name, r.full || r.name, r.n, max, color));
    }
  }

  function renderAll() {
    if (!el.root) return;
    var mode = 'loading'; // loading | error | empty | data
    if (state.statsError) mode = 'error';
    else if (state.stats) mode = state.stats.total > 0 ? 'data' : 'empty';

    if (mode === 'loading' || mode === 'error') {
      el.note.classList.toggle('is-error', mode === 'error');
      el.note.textContent = mode === 'error' ? state.statsError : 'Reading activity.';
      el.note.hidden = false;
    } else {
      el.note.hidden = true;
    }

    var showData = mode === 'data';
    el.statsRow.hidden = !showData;
    el.accountsBlock.hidden = !showData;
    el.chatsBlock.hidden = !showData;
    el.empty.hidden = mode !== 'empty';
    if (!showData) return;

    el.today.textContent = fmtNum(state.stats.today);
    el.week.textContent = fmtNum(state.stats.week);
    el.total.textContent = fmtNum(state.stats.total);
    el.last.textContent = state.stats.last
      ? ageText(Date.now() - state.stats.last)
      : 'Never';

    renderBars(el.accounts, state.stats.byAccount, false);
    renderBars(el.chats, state.stats.byChat, true);
  }

  /* ---------- data ---------- */

  function refresh() {
    if (!statsOk()) {
      state.stats = null;
      state.statsError = 'The activity stats are not available in this build.';
      if (state.open) renderAll();
      return;
    }
    var seq = ++state.loadSeq;
    // Colors first (cheap), then the stats; a stale answer never renders.
    var accountsReady = accountsOk()
      ? window.wab.accounts.list().then(null, function () { return null; })
      : Promise.resolve(null);
    accountsReady.then(function (accounts) {
      if (seq !== state.loadSeq) return null;
      state.colors = resolveColors(accounts);
      return window.wab.stats.sent();
    }).then(function (res) {
      if (seq !== state.loadSeq) return;
      state.stats = cleanStats(res);
      state.statsError = '';
      if (state.open) renderAll();
    }, function (err) {
      if (seq !== state.loadSeq) return;
      state.stats = null;
      state.statsError = errText(err, 'Could not load the activity stats');
      if (state.open) renderAll();
    });
  }

  /* ---------- open / close / timers ---------- */

  function stopTick() {
    if (state.tickTimer !== null) {
      window.clearInterval(state.tickTimer);
      state.tickTimer = null;
    }
  }

  function startTick() {
    stopTick();
    state.tickTimer = window.setInterval(function () {
      if (!state.open || document.hidden) return;
      refresh(); // also re-ages the "last send" tile
    }, TICK_MS);
  }

  function openPanel() {
    if (!state.inited) initInternal();
    if (!el.root) return;
    state.open = true;
    el.root.hidden = false;
    renderAll();
    refresh();
    startTick();
  }

  function closePanel() {
    state.open = false;
    stopTick();
    if (el.root) el.root.hidden = true;
  }

  /* ---------- init ---------- */

  function initInternal() {
    if (state.inited) return;
    el.root = $('activity-panel-root');
    if (!el.root) return; // fragment not pasted yet; a later init() can still run
    state.inited = true;

    el.note = $('wab-activity-note');
    el.statsRow = $('wab-activity-stats');
    el.today = $('wab-activity-today');
    el.week = $('wab-activity-week');
    el.total = $('wab-activity-total');
    el.last = $('wab-activity-last');
    el.empty = $('wab-activity-empty');
    el.accountsBlock = $('wab-activity-accounts-block');
    el.accounts = $('wab-activity-accounts');
    el.chatsBlock = $('wab-activity-chats-block');
    el.chats = $('wab-activity-chats');

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

  window.WABActivity = {
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

  /* Auto-boot like the other UI modules; WABActivity.init() stays a safe no-op
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
