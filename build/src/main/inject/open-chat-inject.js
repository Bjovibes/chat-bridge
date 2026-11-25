// open-chat-inject.js - Chat Bridge conversation opener (v2 Conversation Mode).
// NOT a CommonJS module. Main reads this file as TEXT and runs it via
// webContents.executeJavaScript (installer pattern like the other injects).
// Defines in the page world: window.__wabOpenChat(title), called by the
// integrator as __wabOpenChat(JSON.stringify(title)) inside an executed
// string, so the page receives the title TEXT (a JSON-quoted payload is also
// accepted and unwrapped). Returns a
// Promise that ALWAYS resolves {ok:true} or {ok:false, error:'...'}; it never
// rejects, and it always lowers the declutter curtain again on the way out.
// Flow: lift curtain -> find WhatsApp's search box -> clear it -> type the
// title -> click the first matching result row -> confirm the conversation
// header -> restore the curtain -> resolve.
// NEVER locates or presses any send button. Opening a chat is all this does.
// All waiting is setTimeout-chain polling (never busy loops). Worst case stays
// under 9 seconds, then it fails loud naming the step that failed.
(function () {
  'use strict';
  try {
    if (typeof window === 'undefined' || !window.document) return;
    var W = window;
    var D = window.document;
    if (W.__wabOpenChatInstalled) return; // double-injection guard
    W.__wabOpenChatInstalled = true;

    // budgets in ms: 0.5 + 4 + 4 (plus poll slack) keeps worst case < 9 s
    var STEP_MS = 150;
    var BOX_TIMEOUT = 500;
    var RESULTS_TIMEOUT = 4000;
    var HEADER_TIMEOUT = 4000;
    var CLICK_GRACE = 1200; // after row.click(), grace before the synthetic mouse fallback

    // ---- title normalization (KEEP IN SYNC with privacy-inject.js and src/shared/normalize.js) ----
    // Same logic as privacy-inject.js: lowercase, strip emoji/diacritics/
    // punctuation, collapse whitespace; digit-run comparison for phone titles.
    var EMOJI_RE = (function () {
      try { return new RegExp('[\\p{Extended_Pictographic}]', 'gu'); }
      catch (e) { return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu; }
    })();
    var STRIP_RE = (function () {
      try { return new RegExp('[\\p{P}\\p{S}\\p{M}\\p{C}]', 'gu'); }
      catch (e) { return /[!-/:-@[-`{-~ -¿ -⁯⸀-⹿︀-️‍]/gu; }
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
    function collapsed(el) {
      try { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
      catch (e) { return ''; }
    }
    function firstText(sel) {
      var el = qsa(sel)[0];
      if (!el) return '';
      return collapsed(el);
    }

    // ---- declutter curtain. The setter lives in declutter-inject.js; the
    // root class is the mechanism, so toggle it directly too (old injections
    // may predate the setter) ----
    function setDeclutter(on) {
      try { if (typeof W.__wabSetDeclutter === 'function') W.__wabSetDeclutter(on); } catch (eS) {}
      try {
        if (on) D.documentElement.classList.add('wab-declutter');
        else D.documentElement.classList.remove('wab-declutter');
      } catch (eC) {}
    }

    // ---- thread crop curtain, same pattern: the search box lives inside #side,
    // which the crop hides entirely, so the search needs BOTH curtains up ----
    function setThreadCrop(on) {
      try { if (typeof W.__wabSetThreadCrop === 'function') W.__wabSetThreadCrop(on); } catch (eS) {}
      try {
        if (on) D.documentElement.classList.add('wab-threadcrop');
        else D.documentElement.classList.remove('wab-threadcrop');
      } catch (eC) {}
    }

    // ---- step 2: the search box, contract fallback chain, first hook first.
    // 2026 reality (census): the box lives in [data-testid="chat-list-search-container"],
    // not in a #side > header. Title-based selector from the research file as backup. ----
    var BOX_CHAIN = [
      '[data-testid="chat-list-search-container"] div[contenteditable="true"]',
      '[data-testid="chat-list-search-container"] input[type="text"]',
      'div[title="Search input textbox"]',
      '#side header div[data-tab="3"]',
      '#side header div[contenteditable="true"]',
      '#side div[contenteditable="true"]',
      '#side header input[type="text"]'
    ];
    function findSearchBox() {
      for (var i = 0; i < BOX_CHAIN.length; i++) {
        var el = qsa(BOX_CHAIN[i])[0];
        if (el) return el;
      }
      return null;
    }

    // ---- step 3: clear the box, then type. Returns true when the box carries
    // the title ----
    function typeIntoBox(box, title) {
      var isInput = false;
      try { isInput = (box.tagName || '').toLowerCase() === 'input'; } catch (eT) { isInput = false; }
      if (isInput) {
        // plain text input (last-resort selector): set value, notify the page
        try {
          box.value = title;
          box.dispatchEvent(new W.Event('input', { bubbles: true }));
        } catch (eV) {}
        try { return String(box.value) === title; } catch (eR) { return false; }
      }
      try { box.focus(); } catch (eF) {}
      // select existing content via getSelection + Range, then delete it
      try {
        var sel = W.getSelection();
        var range = D.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (eSel) {}
      var deleted = false;
      try { deleted = D.execCommand('delete'); } catch (eD) { deleted = false; }
      if (!deleted && collapsed(box)) { try { box.textContent = ''; } catch (eX) {} }
      try { box.focus(); } catch (eF2) {}
      var inserted = false;
      try { inserted = !!D.execCommand('insertText', false, title); } catch (eI) { inserted = false; }
      var probe = title.replace(/\s+/g, ' ').trim().slice(0, 24);
      if (probe && collapsed(box).indexOf(probe) !== -1) return true;
      // execCommand failed or the box stayed empty: synthetic input with the
      // text in data (React-driven search boxes listen for this)
      try {
        box.dispatchEvent(new W.InputEvent('input', { inputType: 'insertText', data: title, bubbles: true }));
      } catch (eE) {}
      return !!probe && collapsed(box).indexOf(probe) !== -1;
    }

    // ---- step 4: result rows. Overlay first (real WhatsApp), .matched-name
    // ancestors next, then generic overlay rows, then the chat list itself
    // (WhatsApp filters the list live while typing; the mock does the same) ----
    var TIME_ONLY_RE = /^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i;
    function visible(el) {
      try {
        if (el.getClientRects && el.getClientRects().length) return true;
        var st = W.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      } catch (e) { return true; }
    }
    function pushUnique(list, el) { if (el && list.indexOf(el) === -1) list.push(el); }
    function clickableAncestor(el) {
      var p = el;
      for (var i = 0; i < 8 && p && p !== D.body; i++) {
        try { p = p.parentElement; } catch (e) { return null; }
        if (!p || p === D.body) return null;
        var role = '';
        try { role = p.getAttribute('role') || ''; } catch (eR) {}
        if (role === 'button' || role === 'row' || role === 'listitem' ||
            role === 'option' || role === 'gridcell' || role === 'link') return p;
      }
      return null;
    }
    var LIST_CHAIN = [
      '#pane-side [role="row"]',
      'div[role="listbox"] [role="row"]',
      'div[role="listbox"] [role="listitem"]',
      '[aria-label*="chat list" i] [role="row"]',
      '[data-testid="chat-list"] [role="row"]'
    ];
    function findResultRows() {
      var out = [], i, j, rows;
      // 1. WhatsApp's search results overlay
      rows = qsa('[data-testid="overlay"] [role="button"]');
      for (i = 0; i < rows.length; i++) pushUnique(out, rows[i]);
      if (out.length) return out;
      // 2. rows known by their highlighted .matched-name spans
      var names = qsa('.matched-name');
      for (i = 0; i < names.length; i++) pushUnique(out, clickableAncestor(names[i]));
      if (out.length) return out;
      // 3. any overlay/panel that appeared, holding title-like spans
      var overlays = qsa('[data-testid="overlay"]');
      for (i = 0; i < overlays.length; i++) {
        rows = qsa('[role="button"], [role="listitem"], [role="row"]', overlays[i]);
        for (j = 0; j < rows.length; j++) pushUnique(out, rows[j]);
        if (!rows.length) {
          var kids = qsa('span[dir="auto"], div[dir="auto"]', overlays[i]);
          for (j = 0; j < kids.length; j++) {
            pushUnique(out, clickableAncestor(kids[j]) || kids[j].parentElement);
          }
        }
      }
      if (out.length) return out;
      // 4. the live-filtered chat list: visible rows only
      for (i = 0; i < LIST_CHAIN.length; i++) {
        rows = qsa(LIST_CHAIN[i]).filter(visible);
        if (rows.length) return rows;
      }
      return [];
    }
    function spansText(row, sel) {
      var spans = qsa(sel, row), firstTxt = '';
      for (var i = 0; i < spans.length; i++) {
        var t = collapsed(spans[i]);
        if (!t) continue;
        if (!firstTxt) firstTxt = t;
        if (!TIME_ONLY_RE.test(t)) return t; // skip bare clock stamps
      }
      return firstTxt;
    }
    function resultRowTitle(row) {
      if (!row) return '';
      try {
        var t = spansText(row, 'span[dir="auto"]');
        if (t) return t;
        t = spansText(row, 'div[dir="auto"]');
        if (t) return t;
        var al = row.getAttribute && (row.getAttribute('aria-label') || row.getAttribute('title'));
        if (al && al.replace(/\s+/g, ' ').trim()) return al.replace(/\s+/g, ' ').trim();
        var m = qsa('.matched-name', row), acc = '';
        for (var i = 0; i < m.length; i++) acc += ' ' + (m[i].innerText || m[i].textContent || '');
        acc = acc.replace(/\s+/g, ' ').trim();
        if (acc) return acc;
        return collapsed(row).slice(0, 200);
      } catch (e) { return ''; }
    }
    function syntheticClick(el) {
      var types = ['mousedown', 'mouseup', 'click'];
      for (var i = 0; i < types.length; i++) {
        try {
          el.dispatchEvent(new W.MouseEvent(types[i], { bubbles: true, cancelable: true, view: W, button: 0 }));
        } catch (e) {}
      }
    }

    // ---- step 6: conversation header (KEEP IN SYNC with context-scraper.js contactName) ----
    function headerTitle() {
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
          var x = collapsed(s);
          if (x.length > n) { best = x; n = x.length; }
        });
        if (best) return best;
      } catch (e) {}
      return '';
    }

    // ---- poll helper: setTimeout chain, first check immediate, never a busy
    // loop. Resolves the first truthy fn() value, or null at timeout ----
    function poll(fn, timeoutMs) {
      return new W.Promise(function (resolve) {
        var started = Date.now();
        var tick = function () {
          var v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) { resolve(v); return; }
          if (Date.now() - started >= timeoutMs) { resolve(null); return; }
          W.setTimeout(tick, STEP_MS);
        };
        tick();
      });
    }

    // ---- the flow. Async but NEVER rejects: every path resolves {ok:...} ----
    async function run(title) {
      var liftedDeclutter = false;
      var liftedCrop = false;
      try {
        // step 1: lift BOTH curtains so the search box reappears. Remember what
        // each curtain was, restore exactly that (the desk may run uncropped).
        try { liftedDeclutter = D.documentElement.classList.contains('wab-declutter'); } catch (eP1) { liftedDeclutter = false; }
        try { liftedCrop = D.documentElement.classList.contains('wab-threadcrop'); } catch (eP2) { liftedCrop = false; }
        setDeclutter(false);
        setThreadCrop(false);

        // step 2: find the search box
        var box = await poll(findSearchBox, BOX_TIMEOUT);
        if (!box) return { ok: false, error: 'search box not found' };

        // step 3: clear it and type the title
        if (!typeIntoBox(box, title)) {
          return { ok: false, error: 'search box would not accept text' };
        }

        // step 4: wait for a result row whose normalized title matches
        var row = await poll(function () {
          var rows = findResultRows();
          for (var i = 0; i < rows.length; i++) {
            if (titlesMatch(resultRowTitle(rows[i]), title)) return rows[i];
          }
          return null;
        }, RESULTS_TIMEOUT);
        if (!row) return { ok: false, error: 'search did not find ' + title };

        // step 5: click it; if the click does not register, send the mouse trio
        var clickedAt = Date.now();
        var synthSent = false;
        try { row.click(); } catch (eC) { syntheticClick(row); synthSent = true; }

        // step 6: confirm the chat actually opened. Version-agnostic law:
        // an open chat = the intro/welcome panel is GONE (or a real conversation
        // container exists). Header text is only a bonus signal, never the gate.
        var confirmed = await poll(function () {
          if (!synthSent && Date.now() - clickedAt >= CLICK_GRACE) {
            synthSent = true;
            syntheticClick(row);
          }
          try {
            if (D.querySelector('[data-testid="intro-panel"]')) return false;  // still nothing open
            if (D.querySelector('footer div[contenteditable="true"]') ||
                D.querySelector('[data-testid="conversation-panel-messages"]') ||
                D.querySelector('[data-testid^="conv-msg-"]')) return true;
          } catch (eQ) {}
          return titlesMatch(headerTitle(), title);   // legacy layouts
        }, HEADER_TIMEOUT);
        if (!confirmed) return { ok: false, error: 'chat did not open (intro panel never left)' };

        return { ok: true };
      } catch (e) {
        return { ok: false, error: 'open chat failed: ' + String((e && e.message) || e) };
      } finally {
        // step 7: curtains back to their prior states, always, even on failure
        try { setDeclutter(liftedDeclutter); } catch (eF1) {}
        try { setThreadCrop(liftedCrop); } catch (eF2) {}
      }
    }

    W.__wabOpenChat = function (titleJson) {
      var title = null;
      if (typeof titleJson === 'string') {
        title = titleJson;
        // the integrator embeds JSON.stringify(title) in the call, so the page
        // receives the decoded title; a JSON-quoted payload parses to the same
        // thing, and bare title text simply fails the parse and stays as-is
        try {
          var parsed = JSON.parse(titleJson);
          if (typeof parsed === 'string') title = parsed;
        } catch (eP) { /* bare title text: keep as-is */ }
      }
      if (typeof title !== 'string' || !title.replace(/\s+/g, '')) {
        return W.Promise.resolve({ ok: false, error: 'title payload was not a chat title' });
      }
      try {
        return run(title); // a promise that always resolves, never rejects
      } catch (eOuter) {
        return W.Promise.resolve({ ok: false, error: 'open chat failed before it started' });
      }
    };
  } catch (eBoot) {}
})();
