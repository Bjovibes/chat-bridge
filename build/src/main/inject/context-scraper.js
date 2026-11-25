// context-scraper.js - Chat Bridge AI context reader + draft inserter.
// NOT a CommonJS module. Main reads this file as TEXT and passes the whole
// string to webContents.executeJavaScript on demand.
// Defines in the page world: __wabScrapeChat, __wabInsertText.
// This script NEVER locates, references, or presses any send button.
(function () {
  'use strict';
  try {
    if (typeof window === 'undefined' || !window.document) return;
    var W = window;
    var D = window.document;
    if (W.__WAB_SCRAPER_READY__) return; // double-injection guard
    W.__WAB_SCRAPER_READY__ = true;

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

    var ERR_READ = 'could not read this chat (WhatsApp UI changed?)';

    function qsa(sel, root) {
      try { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }
      catch (e) { return []; }
    }
    function firstText(sel) {
      var el = qsa(sel)[0];
      if (!el) return '';
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function contactName() {
      // 2026 testid first (Oct 2026 source), then the still-alive generic ones.
      var t = firstText('#main header [data-testid="conversation-info-header-chat-title"]');
      if (t) return t;
      t = firstText('header [data-testid="conversation-info-header-chat-title"]');
      if (t) return t;
      t = firstText('header [data-testid="conversation-info-header"]');
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

    // refuse to read a chat the privacy config restricts (defense in depth)
    function isRestrictedNow() {
      try {
        var c = W.__WAB_PRIVACY__;
        if (!c || typeof c !== 'object' || c.mode === 'all') return false;
        var name = contactName();
        if (!name) return false;
        var list, i;
        if (c.mode === 'allow') {
          list = Array.isArray(c.allow) ? c.allow : [];
          for (i = 0; i < list.length; i++) { if (titlesMatch(String(list[i]), name)) return false; }
          return true;
        }
        if (c.mode === 'deny') {
          list = Array.isArray(c.deny) ? c.deny : [];
          for (i = 0; i < list.length; i++) { if (titlesMatch(String(list[i]), name)) return true; }
        }
      } catch (e) {}
      return false;
    }

    // ---- message discovery, always with fallbacks ----
    function structuralMessageEls() {
      var pane = findConversationPane();
      if (!pane) return [];
      var groups = {};
      qsa('div', pane).forEach(function (d) {
        var k = (typeof d.className === 'string') ? d.className : '';
        if (!k) return;
        if (!groups[k]) groups[k] = [];
        if (groups[k].length < 400) groups[k].push(d);
      });
      var best = [];
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        if (g.length < 3) return;
        var withText = 0;
        g.forEach(function (d) { if ((d.innerText || '').trim()) withText++; });
        if (withText >= Math.floor(g.length * 0.6) && g.length > best.length) best = g;
      });
      return best;
    }

    function findMessageEls() {
      // 2026 DOM first (message-in/out classes were removed in 2026:
      // notes\WAWEB-DOM-RESEARCH-2026-11-21.md), legacy shapes kept for the
      // mock and older builds, structural fallback last.
      var chain = [
        '[data-testid^="conv-msg-"]',
        'div[data-testid="msg-container"]',
        '[data-tab="8"] .message-in, [data-tab="8"] .message-out',
        '.message-in, .message-out',
        '._ao3e'
      ];
      var els = [];
      for (var i = 0; i < chain.length; i++) {
        els = qsa(chain[i]);
        if (els.length) break;
      }
      if (!els.length) els = structuralMessageEls();
      if (!els.length) return [];
      // drop nested duplicates: keep the outermost element of any ancestor chain
      return els.filter(function (el) {
        var p = el.parentElement;
        while (p) {
          if (els.indexOf(p) !== -1) return false;
          p = p.parentElement;
        }
        return true;
      });
    }

    function fromMe(el) {
      try {
        // 2026: the data-id attribute is the DOM-to-model bridge; outgoing ids
        // carry a true_ prefix, incoming false_ (heuristic, high confidence).
        var host = el;
        var hop = 0;
        while (host && hop < 4) {
          var did = host.getAttribute && host.getAttribute('data-id');
          if (did) {
            if (/^true_/i.test(did)) return true;
            if (/^false_/i.test(did)) return false;
            break;
          }
          host = host.parentElement; hop++;
        }
        var cl = el.classList;
        if (cl && cl.contains('message-out')) return true;
        if (cl && cl.contains('message-in')) return false;
        var arrow = el.getAttribute('data-incoming-arrows');
        if (arrow === 'true' || arrow === '1') return false;
        if (arrow === 'false' || arrow === '0') return true;
        var inner = qsa('[data-incoming-arrows]', el)[0];
        if (inner) {
          var v = inner.getAttribute('data-incoming-arrows');
          if (v === 'true' || v === '1') return false;
          if (v === 'false' || v === '0') return true;
        }
        if (qsa('[data-icon="msg-dblcheck"], [data-icon="msg-check"], [data-icon="msg-dblcheck-ack"]', el).length) return true;
        // last resort: outgoing bubbles sit right of the pane midline
        var box = el.getBoundingClientRect();
        var pane = findConversationPane();
        if (pane) {
          var pr = pane.getBoundingClientRect();
          if (pr.width) return (box.left - pr.left) > pr.width / 2;
        }
      } catch (e) {}
      return false;
    }

    var CLOCK_RE = /(\d{1,2}:\d{2})(\s?[ap]\.?m\.?)?/i;
    function bubbleTs(el) {
      try {
        var pre = el.getAttribute && el.getAttribute('data-pre-plain-text');
        if (pre) {
          var m0 = pre.match(CLOCK_RE);
          if (m0) return m0[1];
        }
        var spans = qsa('span', el);
        for (var i = spans.length - 1; i >= 0; i--) {
          var al = spans[i].getAttribute('aria-label') || '';
          if (al) { var m1 = al.match(CLOCK_RE); if (m1) return m1[1]; }
          var tt = spans[i].getAttribute('title') || '';
          if (tt) { var m2 = tt.match(CLOCK_RE); if (m2) return m2[1]; }
        }
        var own = el.getAttribute && el.getAttribute('aria-label');
        if (own) { var m3 = own.match(CLOCK_RE); if (m3) return m3[1]; }
      } catch (e) {}
      return null;
    }

    var MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
    var NOISE_RE = new RegExp(
      '^(today|yesterday|now|[0-9]{1,2}:[0-9]{2}|[0-9]{1,2}/[0-9]{1,2}/[0-9]{2,4}|' +
      '[0-9]{1,2} (?:' + MONTHS + ') [0-9]{4}|' +
      'monday|tuesday|wednesday|thursday|friday|saturday|sunday)$', 'i'
    );
    function isNoise(text) {
      if (!text) return true;
      var x = text.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!x) return true;
      if (NOISE_RE.test(x)) return true;
      if (/^messages?( and calls)?( are)? end-to-end encrypted/.test(x)) return true;
      if (/^unread message/.test(x)) return true;
      return false;
    }
    function stripTrailingClock(text) {
      return text.replace(/\s*\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?\s*$/i, '').replace(/\s+/g, ' ').trim();
    }

    // ---- public page-world API ----
    W.__wabScrapeChat = function () {
      try {
        if (isRestrictedNow()) {
          return { ok: false, error: 'this chat is restricted by the account owner' };
        }
        var name = contactName();
        var els = findMessageEls();
        if (!els.length && !name) return { ok: false, error: ERR_READ };
        var msgs = [];
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          var raw = (el.innerText || el.textContent || '');
          var text = stripTrailingClock(raw.replace(/\s+/g, ' ').trim());
          if (isNoise(text)) continue;
          msgs.push({ fromMe: fromMe(el), text: text, ts: bubbleTs(el) });
        }
        if (!msgs.length) return { ok: false, error: ERR_READ };
        return { ok: true, contactName: name, messages: msgs.slice(-40) }; // oldest first
      } catch (e) {
        return { ok: false, error: ERR_READ };
      }
    };

    W.__wabInsertText = function (text) {
      try {
        if (typeof text !== 'string' || !text.trim()) {
          return { ok: false, error: 'nothing to insert' };
        }
        var compose = findCompose();
        if (!compose) return { ok: false, error: 'could not find the message box' };
        try { compose.focus(); } catch (eF) {}

        var done = false;
        try { done = !!D.execCommand('insertText', false, text); } catch (eE) { done = false; }

        var probe = text.replace(/\s+/g, ' ').trim().slice(0, 24);
        var current = (compose.innerText || '').replace(/\s+/g, ' ');
        if (!done || !probe || current.indexOf(probe) === -1) {
          // fallback: synthetic paste carrying the plain text, then input events
          try {
            var dt = new DataTransfer();
            dt.setData('text/plain', text);
            compose.dispatchEvent(new ClipboardEvent('paste', {
              bubbles: true, cancelable: true, clipboardData: dt
            }));
          } catch (eP) {}
          try {
            compose.dispatchEvent(new InputEvent('beforeinput', {
              inputType: 'insertText', data: text, bubbles: true, cancelable: true
            }));
          } catch (eB) {}
          try {
            compose.dispatchEvent(new InputEvent('input', {
              inputType: 'insertText', data: text, bubbles: true
            }));
          } catch (eI) {}
        }

        var after = (compose.innerText || '').replace(/\s+/g, ' ');
        if (probe && after.indexOf(probe) !== -1) return { ok: true };
        return { ok: false, error: 'could not insert into the message box' };
      } catch (eOuter) {
        return { ok: false, error: 'could not insert into the message box' };
      }
    };
  } catch (eBoot) {}
})();
