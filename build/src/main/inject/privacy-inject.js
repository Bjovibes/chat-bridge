// privacy-inject.js - Chat Bridge privacy blindfold.
// NOT a CommonJS module. Main reads this file as TEXT and passes the whole
// string to webContents.executeJavaScript, AFTER setting:
//   window.__WAB_PRIVACY__ = <PrivacyConfig JSON>
// Re-running the string re-applies the live config cleanly via __wabApplyPrivacy.
// Defines in the page world: __wabGetUnread, __wabListChats, __wabApplyPrivacy.
// Everything is guarded: a missed selector is a silent no-op, never a throw.
(function () {
  'use strict';
  try {
    if (typeof window === 'undefined' || !window.document) return;
    var W = window;
    var D = window.document;

    // ---- title normalization (KEEP IN SYNC with src/shared/normalize.js) ----
    var EMOJI_RE = (function () {
      try { return new RegExp('[\\p{Extended_Pictographic}]', 'gu'); }
      catch (e) { return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu; }
    })();
    var STRIP_RE = (function () {
      try { return new RegExp('[\\p{P}\\p{S}\\p{M}\\p{C}]', 'gu'); }
      catch (e) { return /[ -⁯⸀-⹿︀-️‍]/gu; }
    })();
    var DIGITS_RE = (function () {
      try { return new RegExp('[\\p{Nd}]+', 'gu'); }
      catch (e) { return /[0-9]+/g; }
    })();
    function normalizeTitle(str) {
      if (typeof str !== 'string') return '';
      var t = str.normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[‍︎️]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ');
      t = t.replace(EMOJI_RE, '').replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
      return t;
    }
    function digitsOnly(str) {
      if (typeof str !== 'string') return '';
      var m = str.match(DIGITS_RE);
      return m ? m.join('') : '';
    }
    function titlesMatch(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      var na = normalizeTitle(a);
      var nb = normalizeTitle(b);
      if (na === nb) return true;
      if (!na || !nb) return false;
      if (na.length >= 5 && nb.indexOf(na) === 0) return true;
      if (nb.length >= 5 && na.indexOf(nb) === 0) return true;
      var da = digitsOnly(a);
      var db = digitsOnly(b);
      if (da.length >= 6 && db.length >= 6 && da === db) return true;
      return false;
    }
    // ---- end KEEP IN SYNC block ----

    function qsa(sel, root) {
      try { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }
      catch (e) { return []; }
    }
    function firstText(sel) {
      var el = qsa(sel)[0];
      if (!el) return '';
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function cfg() {
      var c = null;
      try { c = W.__WAB_PRIVACY__; } catch (e) { c = null; }
      return (c && typeof c === 'object') ? c : null;
    }
    function isRestricted(title, c) {
      try {
        if (!c || c.mode === 'all' || !title) return false;
        var list, i;
        if (c.mode === 'allow') {
          list = Array.isArray(c.allow) ? c.allow : [];
          for (i = 0; i < list.length; i++) { if (titlesMatch(String(list[i]), title)) return false; }
          return true; // not in the allow list
        }
        if (c.mode === 'deny') {
          list = Array.isArray(c.deny) ? c.deny : [];
          for (i = 0; i < list.length; i++) { if (titlesMatch(String(list[i]), title)) return true; }
        }
      } catch (e) {}
      return false;
    }

    // ---- DOM discovery, always with fallback chains ----
    var TIME_ONLY_RE = /^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i;

    function rowTitle(row) {
      if (!row) return '';
      try {
        var spans = qsa('span[dir="auto"]', row);
        var firstTxt = '';
        for (var i = 0; i < spans.length; i++) {
          var t = (spans[i].innerText || spans[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          if (!firstTxt) firstTxt = t;
          if (!TIME_ONLY_RE.test(t)) return t; // first span that is not a bare clock
        }
        if (firstTxt) return firstTxt;
        var al = row.getAttribute && (row.getAttribute('aria-label') || row.getAttribute('title'));
        if (al) return al.trim();
      } catch (e) {}
      return '';
    }

    function findListScope() {
      var el = D.getElementById('pane-side');
      if (el) return el;
      el = qsa('[data-testid="chatlist"]')[0] || qsa('[data-testid="chatlist-container"]')[0];
      if (el) return el;
      el = qsa('[data-testid="chat-list"]')[0];
      if (el) return el;
      el = qsa('[aria-label*="chat list" i]')[0];
      if (el) return el;
      // structural: the tall scrollable column hugging the left edge
      var best = null, bestScore = 0;
      qsa('div').forEach(function (d) {
        try {
          var st = W.getComputedStyle(d);
          if (st.overflowY !== 'auto' && st.overflowY !== 'scroll') return;
          var r = d.getBoundingClientRect();
          if (r.width < 160 || r.height < 240) return;
          if (r.left > W.innerWidth * 0.55) return;
          if (r.height > bestScore) { best = d; bestScore = r.height; }
        } catch (e) {}
      });
      return best;
    }

    function findChatRows() {
      var rows, i;
      // 2026 testids first (research 2026-11-21), legacy + mock shapes after.
      var chain = [
        '[data-testid="cell-frame-container"]',
        '#pane-side div[role="row"]',
        '#pane-side [data-testid="chat-list"] > div',
        '#pane-side [aria-label*="chat list" i] [role="listitem"]',
        '#pane-side ._8XnVH',
        'div[role="listbox"] [role="row"]',
        'div[role="listbox"] [role="listitem"]',
        'div[role="grid"] div[role="gridcell"]',
        '[aria-label*="chat list" i] [role="listitem"]',
        '[data-testid="chat-list"] > div'
      ];
      for (i = 0; i < chain.length; i++) {
        rows = qsa(chain[i]);
        if (rows.length) return rows;
      }
      var scope = findListScope();
      if (!scope) return [];
      rows = qsa('[role="row"], [role="listitem"]', scope);
      if (rows.length) return rows;
      // structural: repeated same-class children inside the tall column
      var groups = {};
      qsa('div', scope).forEach(function (d) {
        var k = (typeof d.className === 'string') ? d.className : '';
        if (!k || !d.parentNode) return;
        if (!groups[k]) groups[k] = [];
        if (groups[k].length < 300) groups[k].push(d);
      });
      var bestRows = [];
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        if (g.length < 3) return;
        var withTitle = 0;
        g.forEach(function (d) { if (rowTitle(d)) withTitle++; });
        if (withTitle >= Math.max(3, Math.floor(g.length / 2)) && g.length > bestRows.length) bestRows = g;
      });
      return bestRows;
    }

    function rowUnread(row) {
      try {
        var marked = qsa('[aria-label*="unread" i]', row);
        for (var i = 0; i < marked.length; i++) {
          var m = (marked[i].getAttribute('aria-label') || '').match(/\d+/);
          if (m) return parseInt(m[0], 10);
          var t = (marked[i].innerText || '').match(/\d+/);
          if (t) return parseInt(t[0], 10);
        }
        // heuristic: a small pure-digit span (badges are digits, times have colons)
        var spans = qsa('span', row);
        for (var j = 0; j < spans.length; j++) {
          var txt = (spans[j].innerText || '').trim();
          if (/^\d{1,3}$/.test(txt)) return parseInt(txt, 10);
        }
      } catch (e) {}
      return 0;
    }

    function openChatTitle() {
      var t = firstText('header [data-testid="conversation-info-header"]');
      if (t) return t;
      t = firstText('header .copyable-text');
      if (t) return t;
      t = firstText('div[data-tab="6"]');
      if (t) return t;
      t = firstText('header span[dir="auto"]');
      if (t) return t;
      try {
        var best = '', n = 0;
        qsa('header span').forEach(function (s) {
          var x = (s.innerText || s.textContent || '').replace(/\s+/g, ' ').trim();
          if (x.length > n) { best = x; n = x.length; }
        });
        if (best) return best;
      } catch (e) {}
      return '';
    }

    function findCompose() {
      var el = qsa('footer div[contenteditable="true"]')[0];
      if (el) return el;
      el = qsa('div[contenteditable="true"][data-tab="10"]')[0];
      if (el) return el;
      var foot = qsa('footer [contenteditable="true"]');
      if (foot.length) return foot[0];
      var all = qsa('div[contenteditable="true"]');
      return all.length ? all[all.length - 1] : null;
    }

    function findConversationPane() {
      var el = D.getElementById('main');
      if (el) return el;
      el = qsa('[data-testid="conversation-panel"]')[0];
      if (el) return el;
      var foot = findCompose();
      if (foot) {
        var p = foot.parentElement;
        while (p && p !== D.body) {
          if (p.clientWidth >= 300 && p.clientHeight >= 300) return p;
          p = p.parentElement;
        }
      }
      return null;
    }

    // ---- in-page toast ----
    var toastTimer = null;
    function toast(msg) {
      try {
        var el = D.getElementById('wab-toast');
        if (!el) {
          el = D.createElement('div');
          el.id = 'wab-toast';
          el.style.cssText = 'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);' +
            'background:#111b21;color:#fff;padding:10px 16px;border-radius:8px;' +
            'font:14px -apple-system,"Segoe UI",sans-serif;z-index:2147483647;' +
            'box-shadow:0 4px 12px rgba(0,0,0,0.4);opacity:0;transition:opacity 0.15s;' +
            'pointer-events:none;max-width:80vw;';
          (D.body || D.documentElement).appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        if (toastTimer) { try { W.clearTimeout(toastTimer); } catch (e1) {} }
        toastTimer = W.setTimeout(function () {
          try { el.style.opacity = '0'; } catch (e2) {}
        }, 2200);
      } catch (e) {}
    }

    // ---- conversation pane blind ----
    function applyPaneBlind(on) {
      try {
        var ov = D.getElementById('wab-pane-blind');
        if (!on) {
          if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
          return;
        }
        if (ov) return; // already applied
        var pane = findConversationPane();
        if (!pane) return;
        var st = W.getComputedStyle(pane);
        if (st.position === 'static') pane.style.position = 'relative';
        ov = D.createElement('div');
        ov.id = 'wab-pane-blind';
        ov.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;z-index:99998;' +
          'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
          'background:rgba(17,27,33,0.35);pointer-events:none;';
        pane.appendChild(ov);
      } catch (e) {}
    }

    // ---- the blindfold pass (idempotent: re-check, never accumulate) ----
    var paneBlurred = false;
    function doPass() {
      try {
        var c = cfg();
        var rows = findChatRows();
        var i, row, title;
        for (i = 0; i < rows.length; i++) {
          row = rows[i];
          title = rowTitle(row);
          try { row.setAttribute('data-wab', '1'); } catch (e0) {}
          var restricted = isRestricted(title, c);
          var hide = (c && c.mode === 'allow' && restricted);
          var blur = (c && c.mode === 'deny' && restricted);
          if (hide) {
            row.style.display = 'none';
            try { row.setAttribute('data-wab-hidden', '1'); } catch (e1) {}
          } else if (row.getAttribute('data-wab-hidden')) {
            row.style.display = '';
            try { row.removeAttribute('data-wab-hidden'); } catch (e2) {}
          }
          if (blur) {
            row.style.filter = 'blur(9px)';
            row.style.pointerEvents = 'none';
            try { row.setAttribute('data-wab-blurred', '1'); } catch (e3) {}
          } else if (row.getAttribute('data-wab-blurred')) {
            row.style.filter = '';
            row.style.pointerEvents = '';
            try { row.removeAttribute('data-wab-blurred'); } catch (e4) {}
          }
        }
        var openRestricted = false;
        if (c && c.mode !== 'all') {
          var ht = openChatTitle();
          if (ht && isRestricted(ht, c)) openRestricted = true;
        }
        applyPaneBlind(openRestricted);
        if (openRestricted && !paneBlurred) toast('Restricted by account owner');
        paneBlurred = openRestricted;
      } catch (e) {}
    }

    // ---- click and key guard (capture phase) ----
    var GUARD_SEL = '[role="row"], [role="listitem"], [role="option"], [role="gridcell"], [role="button"], [data-testid="chat-list"] > div';
    function blockedTarget(node) {
      try {
        var c = cfg();
        if (!c || c.mode === 'all') return false;
        var el = (node && node.closest) ? node.closest(GUARD_SEL) : null;
        if (!el) return false;
        var t = rowTitle(el);
        if (!t) return false;
        return isRestricted(t, c);
      } catch (e) { return false; }
    }
    function armGuards() {
      try {
        D.addEventListener('click', function (ev) {
          if (blockedTarget(ev.target)) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            toast('Restricted by account owner');
          }
        }, true);
        D.addEventListener('keydown', function (ev) {
          try {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            if (blockedTarget(ev.target)) {
              ev.preventDefault();
              ev.stopPropagation();
              toast('Restricted by account owner');
            }
          } catch (e) {}
        }, true);
      } catch (e) {}
    }

    // ---- observers ----
    var passTimer = null;
    function schedulePass() {
      try {
        if (passTimer) { try { W.clearTimeout(passTimer); } catch (e0) {} }
        passTimer = W.setTimeout(function () { passTimer = null; doPass(); }, 200);
      } catch (e) { doPass(); }
    }
    function watch() {
      try {
        if (!D.body) { D.addEventListener('DOMContentLoaded', watch); return; }
        var mo = new MutationObserver(schedulePass);
        mo.observe(D.body, { childList: true, subtree: true });
        var list = findListScope();
        if (list && list !== D.body) { try { mo.observe(list, { childList: true, subtree: true }); } catch (e1) {} }
        var pane = findConversationPane();
        if (pane && pane !== D.body) { try { mo.observe(pane, { childList: true, subtree: true }); } catch (e2) {} }
        W.addEventListener('hashchange', doPass);
      } catch (e) {}
    }

    // ---- public page-world API ----
    W.__wabGetUnread = function () {
      var out = { allowed: 0, restricted: 0 };
      try {
        var c = cfg();
        var rows = findChatRows();
        for (var i = 0; i < rows.length; i++) {
          var n = rowUnread(rows[i]);
          if (!n) continue;
          if (isRestricted(rowTitle(rows[i]), c)) out.restricted += n;
          else out.allowed += n;
        }
      } catch (e) {}
      return out; // counts only, titles never leave the page here
    };
    W.__wabListChats = function () {
      var out = [];
      try {
        var rows = findChatRows();
        for (var i = 0; i < rows.length; i++) {
          var title = rowTitle(rows[i]);
          if (!title) continue;
          out.push({ title: title, unread: rowUnread(rows[i]) });
        }
      } catch (e) {}
      return out;
    };

    // double-injection guard + clean re-apply of a freshly set __WAB_PRIVACY__
    if (typeof W.__wabApplyPrivacy === 'function') {
      try { W.__wabApplyPrivacy(); } catch (eR) {}
      return;
    }
    W.__wabApplyPrivacy = doPass;

    armGuards();
    watch();
    doPass();
  } catch (eOuter) {}
})();
