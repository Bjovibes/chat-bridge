/* Chat Bridge render.js, builder E (v3 engine rooms). Classic script, file:// safe.
   Owns the conversation experience: one .rpane per visible slot inside
   #slot-area, bubbles, per pane zoom / maximize / minimize, message polling
   via wab.eng. Exposes exactly window.WABRender per docs/CONTRACT.md.
   Everything guarded: never throws, never alerts.

   V12 S4 evolution (owner spec 2026-11-21):
   - Pane header face: the person's photo ONLY when a photo exists; the
     initials ring is the fallback, never shown beside a photo.
   - Account-color edge glow on every non-empty pane (dim), flaring bright
     when a NEW incoming reply lands in that pane. The flare also fires
     window event 'wab:pane-reply' {slot, accountId} for other modules.
   - Background panes poll too (slower than the active pane) so replies in
     any pane of a grid4/grid6 desk flash where they arrive.
   - grid4 / grid6: pane sync already follows WABSlots.getRects, so six
     slots just work; any pane holds any (account, chat) pair.

   V12.1 T3 evolution (the owner ruling 2026-11-21):
   - ONE compose bar. Panes carry no compose footer in the DOM at all: the
     hovering central bar owns every send. Message beds keep a bottom
     inset so bubbles never slide under it.
   - The central bar is the visible ROUTER: an account-color strip on its
     left edge, a subtle 300ms pulse whenever the routed pane changes, and
     an identity chip that focuses the routed pane when clicked.

   V12.2 U1 evolution (owner spec 2026-11-21):
   - VIRTUAL SCREENS in single and tabs mode: one pool of up to 6 pane
     records, one per screen. The single visible rect mounts whichever
     screen is active (state.screenIdx). Opening a conversation from the
     rail, the palette or the command bar targets the ACTIVE screen only,
     so every person keeps its own screen. Switching screens mounts that
     screen's pane with person, cached messages (re-polled on mount), scroll
     position (scrollTop saved on unmount), zoom, minimized flag and compose
     draft all intact.
   - Every pane header carries a small X at its top-left, before the face:
     one click closes that conversation view through the existing
     clearPerson path. No confirmation needed; the conversation itself
     stays on WhatsApp. In single mode closing the mounted screen
     auto-mounts the next non-empty screen or shows the empty state.
   - Grid and split modes keep the direct slot-to-pane mapping. The screen
     pool and the grid slots are the same 6 records, so layout switches
     never drop a conversation.

   V12.3 W1 evolution (the owner ruling 2026-11-21):
   - The bottom switcher is dead in every mode (shell.js removes its DOM).
     The ONLY switcher UI is a row of just dots pinned to the top center of
     the pane area, visible in single and tabs: one dot per screen, 8px,
     hollow when the screen is empty, filled with the screen conversation's
     account color when occupied, the active screen slightly larger and
     ringed. Clicking a dot still switches; swipe is the primary gesture.
   - Switching feels like OS desktop switching: a two-finger horizontal
     trackpad swipe over the pane area flips screens. Swipe math: wheel
     deltaX dominance |dX| > |dY| * 1.5 with 40px accumulated, one flip per
     350ms debounce, gesture accumulator resets 150ms after the last wheel
     event (momentum close). preventDefault fires ONLY on the event that
     flips a screen, so vertical message scrolling and Ctrl+wheel zoom are
     never trapped. Natural direction: fingers left = next screen, fingers
     right = previous, wrapping like the cycle keys.
   - Replies on UNMOUNTED screens: a light 5s poll watches every hidden
     occupied screen; a fresh incoming id blinks its top dot in the account
     color (steady 1.2s CSS loop) and pushes the same spine debug event
     ('pane-reply', accountId only, no names). Mounting that screen stops
     the blink and the existing pane flare plays.
   - The hovering central bar is back at its fixed bottom position in every
     mode: the body.wab-screens lift class is gone because the bottom
     divider it dodged no longer exists.

   V12.5 Y2 evolution (owner spec 2026-11-21):
   - A PROGRESSION RAIL under every pane header: a 2px line pinned between
     the header and the message bed, full pane width, below the screen-dots
     row. Loading a conversation (messages fetch, open resolve, engine
     pre-open) runs an indeterminate shimmer in the account color; sending
     pulses a left-anchored bar; success plays a 300ms bright sweep then
     hides; a failed load or send holds a steady dim red until the next
     action. All visuals are CSS animation; this file only swaps classes
     and counts in-flight ops per pane.
   - The desk can listen: every transition dispatches window event
     'wab:progress' {slot, kind:'load'|'send', on:boolean}, and while any
     pane holds an op the body carries the class 'wab-busy'.
   - Typing dots: the spine push eng:on-typing (subscribed via
     wab.eng.onTyping, guarded) lists the titles currently typing per
     account; when it lists the MOUNTED pane's person, three account-color
     dots bounce next to the person name (WhatsApp style) and the
     account-name text steps aside until the push stops listing them.
     Unmounted screens ignore the push: their screen dot already blinks.
   - Opening or mounting a conversation now fires wab.eng.preopen for it
     (the v12.4 speed law: the engine sits on the chat before Send), and
     that flight is part of the load shimmer.

   V12.4 X2 evolution (the owner live complaints, 2026-11-21), rebased on Y2:
   - SWIPE PERSISTENCE FIX. Root cause: the swipe itself never dropped a
     person. Every screen switch reports app:setActivePane, and the spine
     answered pushAllPaneStates with panes:onState {open:false} for every
     pane in its own never-informed paneState map, because this module never
     called app:setPanePerson when it opened a conversation. onPaneState
     honored those pushes and clearPerson wiped the conversation off the
     screen the owner had just left; swiping back mounted an empty screen. Fix
     in two layers: (1) the renderer is the truth, every person change is
     reported to the spine (reportSpine -> app:setPanePerson), so its pushes
     describe reality; (2) onPaneState never clears a person the spine was
     not told about (pane.spineSig guard), so a stale bookkeeping push can
     never destroy state again. Invariant: opening a conversation replaces
     ONLY the person of the screen that is CURRENTLY MOUNTED AND ACTIVE;
     swipes and spine pushes never mutate person data, only which record is
     mounted. The preopen speed path stays exactly as Y2 wired it
     (firePreopen at open and mount).
   - CENTRAL BAR CENTERING. The bar centers over the CONVERSATION AREA
     (#render-root, inset 0 of #slot-area, right of the rail), not the raw
     window: viewport left:50% sat it too far right whenever the rail was
     open. Measured rects on every sync (resize, layout switch, rail fold,
     maximize) cover every rail width (240 unfolded, 64 folded, 56
     maximized, narrow-window media query) with no --rail-w guessing.

   V12.6 Z2 evolution (integrator live probe 2026-11-21), rebased on X2+Y2:
   - THE READ FLOW, MADE HONEST END TO END. Live probe truth: the engine
     answers eng:messages with real messages, yet the owner saw no full loading
     state and no messages. The renderer was the drop, in four places.
     (1) CHATID RESOLUTION: the rail feeds from chats.listPeople (v2
     scraper titles, NO chatId field); resolveForOpen could only find a
     chatId through an EXACT normalized-title match against the eng.people
     cache. Engine titles come from the IDB name join and can drift from
     the DOM titles (or be empty), so a click on a perfectly real person
     dead-ended. cacheLookup now runs a second tier: same account, loose
     title match (prefix either direction at 5+, digit-run equality at 6+),
     the same law the spine's titlesMatch uses. openFromSpecLive also
     forces ONE fresh eng.people pull on a miss (the boot race: first click
     against a not-yet-hydrated roster), and its Retry now retries the
     RESOLVE (pane.pendingSpec) instead of dropping to the empty picker.
   - (2) LOADING VISIBILITY LAW: is-empty now means "picker state" ONLY
     (syncEmptyClass: no person AND st === 'empty'), so a loading or error
     pane always carries its glass surface, its rail and its skeleton; the
     old code painted resolve-loadings and errors on a transparent,
     rail-less is-empty pane, which is exactly "I don't see the loading
     state fully". The rail lights from the FIRST line of every
     user-initiated request (open resolve, preopen, fetch) and ends with
     it; background polls stay silent, as before.
   - (3) SILENT DROPS NAMED LOUDLY: a tracked load with no chatId, a
     rejected invoke (null) and a non-array result all set the error state
     with Retry now (the spine coerces a failed engine read to [], so a
     tracked load that returns ZERO messages shows "No messages came back
     for this chat yet." WITH a Retry button instead of a bare success
     note). openConversationIn's silent false return (no visible rect this
     frame) now resyncs, retries once, and toasts if still nothing.
   - (4) RENDER SELF-CHECK: after a tracked load succeeds with count > 0,
     if the pane still shows zero bubbles in the DOM 500ms later it sets
     the error state "Messages were fetched but not rendered." That names
     the render-bug class if it ever recurs, instead of an empty pane.
   - READ-STEP DEBUG EVENTS: user-initiated reads push spine debug events
     ('open-step' / 'engine-error', counts only) at every stage: resolve,
     read sent, read ok (n), read empty, read failed. The Debug panel can
     now answer "did the renderer even ask" the next time this recurs.
   - MOUNT SHIMMER FIX: setActiveSlot no longer fires its eager untracked
     fetch for a pane that is not mounted yet; on a screen switch that
     early fetch held pane.fetching and the mount's tracked fetch returned
     at the fetching guard, so mounting a screen showed no rail. The mount
     path owns the shimmer again.
   - Send refresh now reloads the SENDING pane's slot, not the active one
     (switching screens mid-send reloaded a stranger).

   V12.7 F2 evolution (the owner ask 2026-11-21): MEDIA AND LINKS INLINE, scoped
   to message rendering only (appendGroup / renderMessages / bubble
   construction); bar, pane-layout and screen code untouched.
   - Text bubbles linkify: every http(s) URL becomes an anchor that opens
     through window.open(url, '_blank'), which the engine-side window-open
     handler routes to the system browser. Hover underlines in the account
     color, long URLs break. A message whose whole content is one URL also
     gets a compact link chip under the bubble (domain + truncated path).
   - 'media-placeholder' bubbles render a 4/3 glass frame (max 260px wide)
     that fetches its bytes through wab.eng.media(accountId, chatId, mId)
     ONCE, when it scrolls into view (shared IntersectionObserver, one
     in-flight guard per msgId, module-level LRU cache of 60 data URLs that
     survives every re-render and person change). Image -> img (contain,
     click opens the lightbox: click-away and Esc close); video/gif
     (mime video/*) -> muted autoplay looping playsinline video; sticker ->
     bare img max 180px with no bubble chrome; audio -> a quiet "Voice note
     (plays on the phone)" chip. A failed fetch paints "Media unavailable on
     the desk" with a small retry arrow (refetch only on that click, never a
     retry storm). Data URLs only, never remote URLs, and no media byte
     ever reaches a debug event, a toast or a log. */

/* V12.7 E1 evolution (owner spec 2026-11-21): EMOJI IN THE CENTRAL BAR.
   - A smiley button between the identity chip and the textarea (inline SVG,
     hairline glass circle like the pane controls) toggles a picker panel
     anchored above the bar: 8 text-label category tabs (Smileys, Gestures,
     Hearts, People, Objects, Food, Travel, Symbols), a Recent row first
     (last 16 used, localStorage 'wab-emoji-recent', guarded; the pane-prefs
     whitelist is fixed so recents never touch setPanePrefs), a curated
     inline set of ~250 emojis, max-height 240px, scrolling grid.
   - Colon autocomplete: typing ':' + 2 or more word characters inside the
     bar textarea opens a caret-anchored popover (max 6 matches against
     shortname + aliases, so :+1: finds thumbsup). Arrows pick, Tab or plain
     Enter inserts the emoji and removes the :query, Esc closes. Enter
     WITHOUT an active suggestion still sends; Shift+Enter still newlines.
   - Both paths insert at the caret (selectionStart aware) without sending
     and without losing focus; emojis are message CONTENT and the chrome
     stays emoji free. The send path is untouched: text with emojis passes
     through dispatchCentral -> wab.eng.send exactly as before. GIFs ride
     WhatsApp's own flow later (out of scope).
   - All E1 state lives in the local `em` record; the shared state object
     only gains state.gemoji. Additive surface only, for W2 reconciliation. */

(function () {
  'use strict';

  /* ---------- constants ---------- */

  var ZOOM_MIN = 0.8;
  var ZOOM_MAX = 2.4;
  var ZOOM_STEP = 0.1;
  var BASE_FONT = 15;          // px at zoom 1; every size inside a pane is em
  var MSG_LIMIT = 50;
  var POLL_MSGS_MS = 2000;     // active pane messages
  var POLL_BG_MS = 4000;       // background pane messages (reply flash needs these)
  var POLL_SCREEN_MS = 5000;   // unmounted virtual screens (dot blink needs these)
  var POLL_PEOPLE_MS = 3000;   // people cache + rail
  var NEAR_BOTTOM_PX = 90;
  var HIST_TOP_PX = 60;        // V13 J2: scrollTop under this = ask for older pages
  var HIST_PAGES = 2;          // V13 J2: pages per scroll-up fetch (phone law)
  var FLASH_MS = 1700;         // class outlives the 1.6s animation on purpose
  var SEEN_CAP = 800;          // per-pane known message ids before compaction
  var SCREENS = 6;             // virtual screens in single and tabs mode
  var SWIPE_MIN_PX = 40;       // accumulated horizontal distance before a flip
  var SWIPE_DOMINANCE = 1.5;   // |dX| must beat |dY| by this factor
  var SWIPE_DEBOUNCE_MS = 350; // at most one flip per this window
  var SWIPE_MOMENTUM_MS = 150; // accumulator resets this long after the last wheel
  var SELFCHECK_MS = 500;      // V12.6 Z2: fetched-vs-rendered verify delay
  var MEDIA_CACHE_MAX = 60;    // V12.7 F2: cached media data URLs (LRU, module-level)
  var MEDIA_PRELOAD = '140px'; // V12.7 F2: fetch media slightly before fully visible

  var ICONS = {
    close: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8"/></svg>',
    zout: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 7h9"/></svg>',
    zin: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M7 2.5v9M2.5 7h9"/></svg>',
    min: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 11.5h9"/></svg>',
    max: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5V2.5H5M9 2.5h2.5V5M11.5 9v2.5H9M5 11.5H2.5V9"/></svg>',
    restoreMax: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.5V5H2.5M11.5 5H9V2.5M9 11.5V9h2.5M2.5 9H5v2.5"/></svg>',
    restoreMin: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 9.5l4-4 4 4"/></svg>',
    media: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l4.8-4.8 3.4 3.4 2.6-2.6 4.2 4.2"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.2h-4.2"/></svg>',
    linkExt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v4.5A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-11A1.5 1.5 0 0 1 6.5 6H11"/></svg>'
  };

  /* ---------- state ---------- */

  var state = {
    inited: false,
    root: null,
    panes: {},            // pane record id -> pane record; records survive unmount
    activeSlot: 0,        // active pane RECORD id (in single/tabs: the mounted screen)
    screenIdx: 0,         // single/tabs: which virtual screen owns the visible rect
    screensSig: null,     // occupancy signature; gates wab:screens-changed dispatches
    maxSlot: null,
    people: [],           // wab.eng.people cache
    peopleFails: 0,
    deadRefreshes: 0,     // capped WABPeople.refresh() attempts on a dead rail
    selfWrite: false,     // my own DOM writes skip the mutation observer once
    syncRaf: null,
    zoomTimers: {},       // slot -> persist debounce
    pollsOn: false,
    dotsEl: null,         // V12.3 W1: the top dot row (the only switcher UI)
    swipe: { accX: 0, accY: 0, firedAt: 0, timer: null }, // V12.3 W1 swipe detector
    lastLayout: null,   // V12.7 W2: layout at the last sync; a flip re-deals panes
    slotMap: null,      // V12.7 W2: visible rect slot -> mounted record id (null = identity)
    barSettleTimer: null, // V12.4 X2: delayed bar recenter after a body class flip
    gbarSlot: null,     // V13 D1: record id the bar last routed to (draft save target)
    drafts: null        // V13 D1: 'wab-drafts' cache (key -> text), loaded once
  };

  /* ---------- small utils ---------- */

  function $(id) { return document.getElementById(id); }

  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    try {
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

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Shell toast bridge (the integrator wires this event into the toast stack).
  function toastRaw(text) {
    try {
      window.dispatchEvent(new CustomEvent('wab:toast-raw', { detail: { text: String(text) } }));
    } catch (e) { /* degrade silently */ }
  }

  // Runs a call, catches rejection, resolves null on failure. Quiet by design:
  // failures surface in the pane (error state or inline compose error).
  function callQuiet(fn) {
    try {
      var r = fn();
      if (r && typeof r.then === 'function') {
        return r.then(null, function () { return null; });
      }
      return Promise.resolve(r);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function wabOk() { return typeof window.wab === 'object' && window.wab !== null; }

  function engOk() {
    return wabOk() && window.wab.eng &&
      typeof window.wab.eng.people === 'function' &&
      typeof window.wab.eng.messages === 'function' &&
      typeof window.wab.eng.send === 'function';
  }

  function prefsOk() {
    return wabOk() && window.wab.app &&
      typeof window.wab.app.setPanePrefs === 'function';
  }

  // Consent-first pane law: an account whose owner has not picked contacts
  // yet (mode 'allow' with an empty allow list) is LOCKED. A pane aimed at
  // it shows the explicit locked message, never a generic error or a blank.
  // Degrades to false (not locked) when the privacy API is missing: the
  // data-layer blindfold stays the real boundary either way.
  function accountLocked(acctId) {
    if (!acctId) return Promise.resolve(false);
    if (!wabOk() || !window.wab.privacy || typeof window.wab.privacy.get !== 'function') {
      return Promise.resolve(false);
    }
    return callQuiet(function () { return window.wab.privacy.get(acctId); })
      .then(function (cfg) {
        return !!(cfg && cfg.mode === 'allow' && Array.isArray(cfg.allow) && cfg.allow.length === 0);
      });
  }

  function lockedMessage() {
    return 'This account is locked until its owner picks contacts. Send them the consent invite (Settings, Privacy, Consent portal).';
  }

  // V12.6 Z2: push a spine debug event (conventions #7: fixed step names and
  // counts ONLY, never contact names, never message text). Used by the read
  // flow so the Debug panel can answer "did the renderer even ask" live.
  function debugStep(kind, accountId, text) {
    try {
      if (wabOk() && window.wab.debug && typeof window.wab.debug.push === 'function') {
        callQuiet(function () {
          return window.wab.debug.push(kind, accountId || '', String(text || ''));
        });
      }
    } catch (e) { /* debug is a nicety, never a gate */ }
  }

  // Wraps a DOM write so my own mutation observer ignores it once.
  function withSelfWrite(fn) {
    state.selfWrite = true;
    try { fn(); } catch (e) { /* never throw out of here */ }
    Promise.resolve().then(function () { state.selfWrite = false; });
  }

  /* ---------- color + text helpers ---------- */

  // Any account color into a low-alpha surface tint for outgoing bubbles.
  function acctSoft(color) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!m) return 'rgba(255,255,255,0.10)';
    var hex = m[1];
    if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    var r = parseInt(hex.slice(0, 2), 16);
    var g = parseInt(hex.slice(2, 4), 16);
    var b = parseInt(hex.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',0.20)';
  }

  // Account color into an "r,g,b" triplet so the CSS edge glow can pick its
  // own alphas: rgba(var(--wabr-glow-rgb), 0.25) dim, 0.9 on the reply flare.
  // Non-hex colors (rare) fall back to white; the glow stays neutral, never wrong.
  function acctRGBTriplet(color) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!m) return '255,255,255';
    var hex = m[1];
    if (hex.length === 3) hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    return parseInt(hex.slice(0, 2), 16) + ',' + parseInt(hex.slice(2, 4), 16) + ',' + parseInt(hex.slice(4, 6), 16);
  }

  function isLetterOrDigit(c) {
    if (c >= 'a' && c <= 'z') return true;
    if (c >= 'A' && c <= 'Z') return true;
    if (c >= '0' && c <= '9') return true;
    var cc = c.charCodeAt(0);
    return (cc >= 0x00c0 && cc <= 0x024f) || (cc >= 0x0400 && cc <= 0x04ff);
  }

  function fmtTime(ts) {
    var t = Number(ts);
    if (!isFinite(t) || t <= 0) return '';
    if (t < 1e12) t = t * 1000; // engine may hand back seconds
    var d = new Date(t);
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- people cache lookups ---------- */

  // V12.6 Z2: the digit run of a title, for the loose-match tier below.
  function digitsOf(s) {
    var m = String(s == null ? '' : s).match(/[0-9]+/g);
    return m ? m.join('') : '';
  }

  // V12.6 Z2: loose title equality, the spine's titlesMatch law ported to the
  // renderer: normalized equality, prefix either direction at 5+ chars, or
  // digit-run equality at 6+ digits. Bridges the v2 DOM-scraper titles the
  // rail carries and the engine's IDB name-join titles the cache carries.
  function looseTitleMatch(a, b) {
    var na = norm(a);
    var nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length >= 5 && nb.indexOf(na) === 0) return true;
    if (nb.length >= 5 && na.indexOf(nb) === 0) return true;
    var da = digitsOf(a);
    var db = digitsOf(b);
    if (da.length >= 6 && db.length >= 6 && da === db) return true;
    return false;
  }

  function cacheLookup(accountId, title, accountName) {
    var nt = norm(title);
    if (!nt) return null;
    var nameHit = null;
    var titleHit = null;
    var looseHit = null;
    for (var i = 0; i < state.people.length; i++) {
      var p = state.people[i];
      if (!p || norm(p.title) !== nt) continue;
      if (accountId && p.accountId === accountId) return p;
      if (!titleHit) titleHit = p;
      if (accountName && p.accountName === accountName && !nameHit) nameHit = p;
    }
    if (nameHit || titleHit) return nameHit || titleHit;
    // V12.6 Z2 tier 2: same account (or account name), drifted title. The
    // rail's v2 title and the engine's IDB title describe the same human
    // when one is a prefix of the other or their digit runs agree.
    for (var j = 0; j < state.people.length; j++) {
      var q = state.people[j];
      if (!q || !q.title) continue;
      var sameAcct = accountId ? q.accountId === accountId
        : (accountName ? q.accountName === accountName : false);
      if (!sameAcct) continue;
      if (looseTitleMatch(q.title, title)) return q;
      if (!looseHit) looseHit = q; // paranoia: never reached, kept simple
    }
    return looseHit;
  }

  // Fills in chatId / accountName / accountColor from the eng cache.
  function resolveForOpen(spec) {
    spec = spec || {};
    var hit = cacheLookup(spec.accountId, spec.title, spec.accountName);
    return {
      accountId: spec.accountId || (hit && hit.accountId) || null,
      chatId: spec.chatId || (hit && hit.chatId) || null,
      title: spec.title || (hit && hit.title) || 'Unknown',
      accountName: spec.accountName || (hit && hit.accountName) || '',
      accountColor: spec.accountColor || (hit && hit.accountColor) || '',
      avatar: spec.avatar || (hit && hit.avatar) || null,
      // V14 T5: platform from the open spec (rail rows carry data-platform)
      // or the roster hit; absent (mock fixtures, older spine) = whatsapp.
      platform: platformOf(spec.platform || (hit && hit.platform) || null)
    };
  }

  /* ---------- root mount + slot rects ---------- */

  function mountRoot() {
    var root = $('render-root');
    if (!root) return false;
    state.root = root;
    var area = $('slot-area');
    if (area && root.parentNode !== area) {
      try { area.appendChild(root); } catch (e) { /* keep it where it is */ }
    }
    try { root.removeAttribute('hidden'); } catch (e) { /* fine */ }
    return true;
  }

  function measureSlots() {
    var rects = [];
    try {
      var nodes = document.querySelectorAll('.slot');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (node.hidden || node.getClientRects().length === 0) continue;
        var r = node.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        rects.push({
          slot: parseInt(node.getAttribute('data-slot'), 10),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height)
        });
      }
    } catch (e) { /* no slots measurable */ }
    return rects;
  }

  function getRects() {
    try {
      if (window.WABSlots && typeof window.WABSlots.getRects === 'function') {
        var r = window.WABSlots.getRects();
        if (Object.prototype.toString.call(r) === '[object Array]') return r;
      }
    } catch (e) { /* fall through to measuring */ }
    return measureSlots();
  }

  /* ---------- V12.2 U1: virtual screens ---------- */

  // The shell writes data-layout on body. Single and tabs are the layouts
  // where ONE rect serves many conversations: there the rect mounts the
  // active virtual screen's pane instead of a same-numbered pane.
  function currentLayout() {
    try { return document.body.getAttribute('data-layout') || 'single'; } catch (e) { return 'single'; }
  }

  function isScreenLayout() {
    var l = currentLayout();
    return l === 'single' || l === 'tabs';
  }

  // Which pane record a visible rect mounts. Screen layouts route rect 0 to
  // the active screen; every other layout maps slots straight to panes.
  function paneIdForRect(rectSlot) {
    if (isScreenLayout() && rectSlot === 0) return state.screenIdx;
    var mapped = state.slotMap ? state.slotMap[rectSlot] : null; // V12.7 W2: the deal
    return (mapped == null || isNaN(mapped)) ? rectSlot : mapped;
  }

  // Occupancy for auto-advance and the dots: a screen counts as occupied
  // when it holds a conversation, an account home, or full WhatsApp.
  function screenOccupied(pane) {
    return !!(pane && (pane.person || pane.home || pane.full));
  }

  // The account color a screen's dot should fill with: the conversation's
  // account color, or the account's own color for home / full-WhatsApp
  // screens. Null means the screen reads as empty (hollow dot).
  function screenDotColor(pane) {
    if (!pane) return null;
    if (pane.person && pane.person.accountColor) return pane.person.accountColor;
    if (pane.home) {
      var acc = accountByIdLocal(pane.home);
      if (acc && acc.color) return acc.color;
    }
    if (pane.full && pane.fullAcc) {
      var acc2 = accountByIdLocal(pane.fullAcc);
      if (acc2 && acc2.color) return acc2.color;
    }
    return null;
  }

  function screenInfoData() {
    var busy = [];
    var colors = [];
    var hasNew = [];
    for (var i = 0; i < SCREENS; i++) {
      var p = state.panes[i];
      busy.push(screenOccupied(p));
      colors.push(screenDotColor(p));
      hasNew.push(!!(p && p.hasNew));
    }
    return { active: state.screenIdx, busy: busy, colors: colors, hasNew: hasNew, screens: isScreenLayout() };
  }

  // Tells the shell (and any future consumer) that screen state moved.
  // Signature-gated: routine syncs that change nothing dispatch nothing.
  function notifyScreensChanged() {
    var info = screenInfoData();
    var sig = (info.screens ? '1' : '0') + '|' + info.active + '|' +
      info.busy.join('') + '|' + info.colors.join(',') + '|' + info.hasNew.join('');
    if (sig === state.screensSig) return;
    state.screensSig = sig;
    renderScreenDots(); // the dots are ours; repaint them with the new state
    try {
      window.dispatchEvent(new CustomEvent('wab:screens-changed', { detail: info }));
    } catch (e) { /* shell listens if present */ }
  }

  // Switch the active virtual screen (single and tabs only). The outgoing
  // screen keeps its scroll and compose draft; the incoming screen mounts
  // into the visible rect with everything it had. Swipe, dot clicks,
  // Ctrl+1..6 and the arrow cycle all land here.
  function switchScreen(idx) {
    idx = parseInt(idx, 10);
    if (isNaN(idx)) return false;
    idx = clamp(idx, 0, SCREENS - 1);
    if (!isScreenLayout()) return false;
    if (idx === state.screenIdx) {
      notifyScreensChanged();
      return true;
    }
    var out = state.panes[state.screenIdx];
    if (out) {
      savePaneScroll(out);
      if (out.person && state.gta) {
        out.draft = state.gta.value || '';
        persistPaneDraft(out); // V13 D1: screen switches file the draft too
      }
    }
    state.screenIdx = idx;
    if (state.activeSlot !== idx) setActiveSlot(idx, {}); // bar, rail, polls follow
    syncPanes(); // unmounts the outgoing screen, mounts the incoming one
    var inc = state.panes[idx];
    if (state.gta) {
      if (inc && inc.person) state.gta.value = inc.draft || '';
      else state.gta.value = '';
    }
    notifyScreensChanged();
    return true;
  }

  // After a close on the mounted screen: hop to the next occupied screen
  // (wrapping), or stay put and let the empty state show.
  function advanceScreenAfterClose(fromIdx) {
    for (var step = 1; step < SCREENS; step++) {
      var idx = (fromIdx + step) % SCREENS;
      if (idx === fromIdx) break;
      if (screenOccupied(state.panes[idx])) {
        switchScreen(idx);
        return;
      }
    }
  }

  /* ---------- V12.3 W1: top dots (the only switcher UI) ---------- */

  // One row of just dots, pinned to the TOP CENTER of the pane area, inside
  // the pane rect's top (never the toolbar). Single and tabs only; split and
  // grid modes show nothing. Clicking a dot switches; the two-finger swipe
  // is the primary gesture. No labels, no arrows, just a soft glass pill.
  function buildScreenDots() {
    if (state.dotsEl || !state.root) return;
    var row = h('div', 'rsdots');
    row.setAttribute('role', 'tablist');
    row.setAttribute('aria-label', 'Screens');
    row.hidden = true;
    row.addEventListener('click', function (ev) {
      var d = ev.target && ev.target.closest ? ev.target.closest('.rsdot') : null;
      if (!d) return;
      var idx = parseInt(d.getAttribute('data-screen'), 10);
      if (!isNaN(idx)) switchScreen(idx);
    });
    state.root.appendChild(row);
    state.dotsEl = row;
  }

  // Repaints and repositions the dot row from live screen state. Runs on
  // every screens-changed signature move and every pane sync (layout and
  // resize moves the rect the pill rides).
  function renderScreenDots() {
    var row = state.dotsEl;
    if (!row || !state.root) return;
    var rect = null;
    if (isScreenLayout()) {
      var rects = getRects();
      for (var r = 0; r < rects.length; r++) {
        if (parseInt(rects[r].slot, 10) === 0) { rect = rects[r]; break; }
      }
    }
    if (!rect) { row.hidden = true; return; } // split / grid: zero switcher UI
    row.hidden = false;
    var rootR = state.root.getBoundingClientRect();
    row.style.left = (rect.x - Math.round(rootR.left) + Math.round(rect.w / 2)) + 'px';
    row.style.top = (rect.y - Math.round(rootR.top) + 10) + 'px'; // inside the pane top
    row.textContent = '';
    for (var i = 0; i < SCREENS; i++) {
      var pane = state.panes[i];
      var busy = screenOccupied(pane);
      var color = busy ? (screenDotColor(pane) || 'rgba(255, 255, 255, 0.88)') : '';
      var on = (i === state.screenIdx);
      var hasNew = !!(pane && pane.hasNew);
      var d = document.createElement('button');
      d.type = 'button';
      d.className = 'rsdot' + (busy ? ' busy' : '') + (on ? ' on' : '') + (hasNew ? ' has-new' : '');
      d.setAttribute('data-screen', String(i));
      d.setAttribute('role', 'tab');
      d.setAttribute('aria-selected', on ? 'true' : 'false');
      d.setAttribute('aria-label', 'Screen ' + (i + 1) +
        (busy ? '' : ', empty') + (hasNew ? ', new replies' : ''));
      d.title = 'Screen ' + (i + 1);
      if (busy && color) {
        d.style.setProperty('--rsd-color', color);
        d.style.setProperty('--rsd-rgb', acctRGBTriplet(color));
      }
      row.appendChild(d);
    }
  }

  /* ---------- V12.3 W1: two-finger swipe over the pane area ---------- */

  function resetSwipe() {
    var sw = state.swipe;
    if (!sw) return;
    if (sw.timer) { window.clearTimeout(sw.timer); sw.timer = null; }
    sw.accX = 0;
    sw.accY = 0;
  }

  // Wheel-based trackpad swipe detector (single and tabs only):
  // - deltaX and deltaY accumulate per gesture; a flip needs
  //   |accX| > SWIPE_MIN_PX (40) AND |accX| > |accY| * SWIPE_DOMINANCE (1.5),
  //   so vertical message scrolling never flips a screen.
  // - One flip max per SWIPE_DEBOUNCE_MS (350); the accumulator resets
  //   SWIPE_MOMENTUM_MS (150) after the last wheel event, closing the
  //   momentum tail of a flick as one gesture.
  // - preventDefault ONLY on the event that fires the flip (passive:false is
  //   required for that alone); every other event passes through untouched.
  // - Ctrl/meta wheel is the pane zoom path: hands off entirely.
  // Natural direction: fingers left (deltaX > 0) reveals the NEXT screen,
  // fingers right goes back, wrapping, exactly like OS desktop switching.
  function onSwipeWheel(ev) {
    if (ev.ctrlKey || ev.metaKey) { resetSwipe(); return; }
    if (!isScreenLayout()) { stackSwipeWheel(ev); return; } // V12.7 W2: stacked panes
    var sw = state.swipe;
    var k = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 100 : 1); // lines/pages -> px
    sw.accX += (ev.deltaX || 0) * k;
    sw.accY += (ev.deltaY || 0) * k;
    if (sw.timer) window.clearTimeout(sw.timer);
    sw.timer = window.setTimeout(function () {
      // Gesture closed (momentum ended): a later swipe starts from zero.
      state.swipe.accX = 0;
      state.swipe.accY = 0;
      state.swipe.timer = null;
    }, SWIPE_MOMENTUM_MS);
    var now = Date.now();
    if (now - sw.firedAt < SWIPE_DEBOUNCE_MS) return;
    var ax = Math.abs(sw.accX);
    var ay = Math.abs(sw.accY);
    if (ax <= SWIPE_MIN_PX) return;
    if (ax <= ay * SWIPE_DOMINANCE) return;
    var dir = sw.accX > 0 ? 1 : -1;
    sw.firedAt = now;
    sw.accX = 0;
    sw.accY = 0;
    if (sw.timer) { window.clearTimeout(sw.timer); sw.timer = null; }
    ev.preventDefault(); // only now; scrolling and zoom were never trapped
    switchScreen((state.screenIdx + dir + SCREENS) % SCREENS);
  }

  /* ---------- pane DOM ---------- */

  function ctrlBtn(cls, icon, label, title) {
    var b = h('button', cls);
    b.type = 'button';
    b.innerHTML = icon;
    b.setAttribute('aria-label', label);
    b.title = title || label;
    return b;
  }

  function buildPaneDom(slot) {
    var el = h('div', 'rpane');
    el.setAttribute('data-slot', String(slot));
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Pane ' + (slot + 1) + ', empty');
    el.setAttribute('tabindex', '-1'); // the central bar's chip can focus this pane

    var head = h('div', 'rpane-head');

    // V12.2 U1: the close X lives at the pane's top-left, BEFORE the face.
    // One click closes this conversation view through clearPerson; the
    // conversation itself stays on WhatsApp, so no confirmation gate.
    var bClose = ctrlBtn('rp-close', ICONS.close, 'Close conversation',
      'Close this view. The conversation stays on WhatsApp.');
    bClose.addEventListener('click', function (ev) {
      ev.stopPropagation();
      clearPerson(slot);
    });
    head.appendChild(bClose);

    // V14 T5: the platform badge (16px tile, visuals from T4's render.css
    // classes) sits between the X and the face: the avatar later lands
    // inside rpane-id, after this span. Hidden until a person or an
    // account home owns the pane; syncPlatformChrome swaps the class.
    var bPlat = h('span', 'rp-platform');
    bPlat.setAttribute('aria-hidden', 'true');
    bPlat.hidden = true;
    head.appendChild(bPlat);

    var id = h('div', 'rpane-id');
    var dot = h('span', 'rp-dot');
    var title = h('span', 'rp-title', '');
    var acct = h('span', 'rp-acct', '');
    id.appendChild(dot);
    id.appendChild(title);
    id.appendChild(acct);

    // V12.5 Y2: typing dots. Hidden by default (render.css); the pane class
    // is-typing swaps them in for the account-name text while the spine's
    // eng:on-typing push lists this pane's person.
    var typing = h('span', 'rp-typing');
    typing.setAttribute('aria-hidden', 'true');
    typing.appendChild(h('span', 'rp-tdot'));
    typing.appendChild(h('span', 'rp-tdot'));
    typing.appendChild(h('span', 'rp-tdot'));
    id.appendChild(typing);

    var unread = h('span', 'rp-unread', '');
    unread.hidden = true;
    id.appendChild(unread);

    var ctrl = h('div', 'rpane-ctrl');
    var bZout = ctrlBtn('rp-btn rp-btn-z', ICONS.zout, 'Zoom out', 'Zoom out (Ctrl and scroll)');
    var zoomVal = h('span', 'rp-zoom', '100%');
    var bZin = ctrlBtn('rp-btn rp-btn-z', ICONS.zin, 'Zoom in', 'Zoom in (Ctrl and scroll)');
    var bMin = ctrlBtn('rp-btn rp-btn-min', ICONS.min, 'Minimize pane', 'Minimize');
    var bMax = ctrlBtn('rp-btn rp-btn-max', ICONS.max, 'Maximize pane', 'Maximize');
    ctrl.appendChild(bZout);
    ctrl.appendChild(zoomVal);
    ctrl.appendChild(bZin);
    ctrl.appendChild(bMin);
    ctrl.appendChild(bMax);

    head.appendChild(id);
    head.appendChild(ctrl);

    var body = h('div', 'rpane-body');
    var stateEl = h('div', 'rpane-state');
    stateEl.hidden = true;
    // V13 J2: the history strip rides ABOVE the bed, outside it. The bed is
    // wiped and rebuilt on every re-render, so a line inside it would not
    // survive a poll; this one does. Static text, no animation.
    var hist = h('div', 'rhist');
    hist.setAttribute('aria-live', 'polite');
    hist.hidden = true;
    var msgs = h('div', 'rpane-msgs');
    msgs.setAttribute('role', 'log');
    msgs.setAttribute('aria-label', 'Messages');
    // V13 J2: WhatsApp-phone law. Scrolling near the bed's top is the ONLY
    // trigger for older pages; no poll ever starts a history fetch.
    msgs.addEventListener('scroll', function () { onPaneMsgsScroll(slot); });
    body.appendChild(hist);
    body.appendChild(msgs);
    body.appendChild(stateEl);

    // No compose footer here (V12.1 T3): the hovering central bar is the
    // ONE entry box and owns every send for whichever pane it routes to.

    // V12.5 Y2: the progression rail, pinned UNDER the pane header and
    // ABOVE the message bed (full pane width, 2px). Invisible while idle;
    // the classes is-load / is-send / is-done / is-err drive every visual.
    var prog = h('div', 'rprog');
    prog.setAttribute('aria-hidden', 'true');
    prog.appendChild(h('span', 'rprog-bar'));

    el.appendChild(head);
    el.appendChild(prog);
    el.appendChild(body);

    var pane = {
      slot: slot,
      el: el,
      headEl: head,
      platEl: bPlat,    // V14 T5: platform badge span (between X and face)
      dotEl: dot,
      titleEl: title,
      acctEl: acct,
      unreadEl: unread,
      zOutBtn: bZout,
      zInBtn: bZin,
      zoomEl: zoomVal,
      minBtn: bMin,
      maxBtn: bMax,
      bodyEl: body,
      stateEl: stateEl,
      msgsEl: msgs,
      person: null,
      msgs: [],
      st: 'empty',
      zoom: 1,
      minimized: false,
      maximized: false,
      sending: false,     // guards the central bar while it sends for this pane
      fetching: false,
      bgFetching: false,  // V12.3 W1: unmounted-screen poll in flight
      loadSeq: 0,
      seenIds: null,       // known message ids -> reply detection
      seeded: false,       // first load seeds, only later new ids flash
      lastBgPoll: 0,       // background pane poll cadence
      lastScreenPoll: 0,   // V12.3 W1: unmounted screen poll cadence
      flashTimer: null,    // reply flare cleanup
      savedScroll: null,   // scrollTop captured at unmount, restored on mount
      draft: '',           // central-bar draft belonging to this conversation
      draftMount: false,   // V13 D1: this mount already adopted a stored draft
      hasNew: false,       // V12.3 W1: reply landed while unmounted -> dot blinks
      fullAcc: null,       // V12.3 W1: account id when this screen is full WhatsApp
      progEl: prog,        // V12.5 Y2: the 2px progression rail under the header
      progN: { load: 0, send: 0 }, // V12.5 Y2: in-flight ops behind the rail
      progTimer: null,     // V12.5 Y2: success-sweep cleanup (flashReply pattern)
      typingEl: typing,    // V12.5 Y2: the three header typing dots
      isTyping: false,     // V12.5 Y2: the spine push currently lists this person
      spineSig: null,      // V12.4 X2: person the spine was told this record shows
      pendingSpec: null,   // V12.6 Z2: open spec awaiting a resolvable chatId
      selfCheckTimer: null, // V12.6 Z2: fetched-vs-rendered verify timer
      histEl: hist,       // V13 J2: the quiet strip above the message bed
      histBusy: false,    // V13 J2: an older-pages fetch is in flight
      histDone: false,    // V13 J2: no earlier pages remain (beginning line latches)
      histCount: 0        // V13 J2: messages held, older pages included
    };

    /* pane events */

    bZout.addEventListener('click', function (ev) { ev.stopPropagation(); setPaneZoom(slot, -ZOOM_STEP); });
    bZin.addEventListener('click', function (ev) { ev.stopPropagation(); setPaneZoom(slot, ZOOM_STEP); });
    bMin.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (pane.minimized) restoreFromMin(slot); else minimizePane(slot);
    });
    bMax.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleMaximize(slot);
    });

    // The whole collapsed strip restores the pane.
    head.addEventListener('click', function () {
      if (pane.minimized) restoreFromMin(slot);
    });

    return pane;
  }

  // A pane record id is "visible" when some visible rect mounts it (in
  // single/tabs that is the active screen's record at rect 0).
  function slotVisibleNow(slot) {
    var rects = getRects();
    for (var i = 0; i < rects.length; i++) {
      if (paneIdForRect(parseInt(rects[i].slot, 10)) === slot) return true;
    }
    return false;
  }

  // Scroll belongs to the screen's conversation, so it is captured the
  // moment a pane leaves the DOM and put back when the pane returns.
  function savePaneScroll(pane) {
    if (!pane || !pane.msgsEl) return;
    try { pane.savedScroll = pane.msgsEl.scrollTop; } catch (e) { /* fine */ }
  }

  function ensurePane(slot) {
    var pane = state.panes[slot];
    if (pane && pane.el && pane.el.parentNode === state.root) return pane;
    if (!pane) {
      pane = buildPaneDom(slot);
      state.panes[slot] = pane;
    }
    if (!pane.el || pane.el.parentNode !== state.root) {
      // Attach only when a visible rect mounts this record; a hidden record
      // keeps its state (person, zoom, scroll, draft) and attaches when it
      // shows again, on a screen switch or a layout change.
      if (!slotVisibleNow(slot)) return pane;
      try { state.root.appendChild(pane.el); } catch (e) { return pane; }
    }
    applyZoom(slot);
    pane.el.classList.toggle('is-active', slot === state.activeSlot);
    if (pane.full) {
      // Full WhatsApp screen: the raw webview owns the rect; stay hidden.
      pane.el.style.display = 'none';
      return pane;
    }
    if (pane.home) {
      showAccountHome(slot, pane.home); // repaints header + chat list
      return pane;
    }
    updateIdentity(slot);
    if (pane.person) {
      // V12.5 Y2: mounting this screen VIEWS the conversation, so the engine
      // pre-opens it (speed law) and the rail shimmers while it flies.
      if (pane.person.chatId) firePreopen(slot, pane.person.accountId, pane.person.chatId);
      // V13 D1: a fresh mount adopts the conversation's stored draft (restart
      // recovery), then hands its draft to the bar once per mount. The guard
      // never fights the user: the bar takes the draft only when it is empty
      // or already shows this pane's own text.
      if (pane.person.chatId && !pane.draftMount) {
        pane.draftMount = true;
        if (!pane.draft) pane.draft = draftStorePeek(draftKey(pane.person));
        if (slot === state.activeSlot && state.gta &&
            (state.gta.value === '' || state.gta.value === (pane.draft || ''))) {
          state.gta.value = pane.draft || '';
        }
      }
      if (pane.minimized) {
        pane.el.classList.add('is-min');
        pane.el.style.height = '';
        updateMinUnread(slot);
      }
      if (pane.msgs && pane.msgs.length) {
        // Re-attached pane record: its history was already seen, so seed the
        // reply detector instead of flashing the whole backlog.
        if (!pane.seeded) { trackSeenMessages(pane, pane.msgs); pane.seeded = true; }
        renderMessages(slot, pane.msgs, {});
        scheduleSelfCheck(slot, pane.msgs.length); // V12.6 Z2: mount render is verifiable too
        if (pane.savedScroll != null) {
          try { pane.msgsEl.scrollTop = pane.savedScroll; } catch (e) { /* fine */ }
        }
        setState(slot, 'live');
        loadMessages(slot, { track: true }); // re-poll on mount: refresh the cached history
      } else {
        setState(slot, 'loading');
        loadMessages(slot, { forceScroll: true, track: true });
      }
      // V12.3 W1: this screen collected replies while unmounted (its dot was
      // blinking). Stop the blink and let the existing pane flare play.
      if (pane.hasNew) {
        pane.hasNew = false;
        flashReply(slot, pane, true); // silent: the spine already got the pane-reply event
        notifyScreensChanged();
      }
    } else {
      setState(slot, 'empty');
    }
    return pane;
  }

  function dropPaneDom(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    savePaneScroll(pane);
    pane.draftMount = false; // V13 D1: the next mount may adopt a stored draft again
    sweepMediaObservers(); // V12.7 F2: an unmounted pane's bubbles let go of the observer
    setPaneTyping(slot, false); // V12.5 Y2: unmounted screens show no dots; a later push re-lights them
    if (pane.maximized) demaximizePane(slot); // never leave the desk maxed on a hidden pane
    if (pane.el.parentNode) {
      try { pane.el.parentNode.removeChild(pane.el); } catch (e) { /* fine */ }
    }
  }

  /* ---------- reply detection + flash ---------- */

  // Stable id per message; engines always send one, mock fixtures too.
  function msgId(m, i) {
    if (m && m.id != null) return String(m.id);
    return 'idx_' + i + '_' + (m && m.ts);
  }

  // Records message ids as seen. Returns true when an INCOMING message id
  // shows up that this pane has never shown before (a new reply).
  function trackSeenMessages(pane, msgs) {
    var fresh = false;
    if (!pane.seenIds) pane.seenIds = { map: {}, n: 0 };
    var seen = pane.seenIds;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m) continue;
      var id = msgId(m, i);
      if (seen.map[id]) continue;
      seen.map[id] = 1;
      seen.n++;
      if (!m.fromMe && (m.kind || 'text') !== 'system') fresh = true;
    }
    // The 50-message window slides; ids scrolling out stay recorded until the
    // set grows heavy, then it reseeds from the current page only.
    if (seen.n > SEEN_CAP && msgs.length) {
      var compact = {};
      for (var j = 0; j < msgs.length; j++) compact[msgId(msgs[j], j)] = 1;
      pane.seenIds = { map: compact, n: msgs.length };
    }
    return fresh;
  }

  // New reply: flare the pane edge glow bright, settle back to dim, and tell
  // the desk (S1 debug panel, S3 rail pulses listen for this). Silent mode
  // (V12.3 W1) plays only the visual flare: the unmounted-screen poll
  // already pushed the debug event when it lit the dot.
  function flashReply(slot, pane, silent) {
    if (!pane || !pane.el) return;
    if (!silent) {
      try {
        window.dispatchEvent(new CustomEvent('wab:pane-reply', {
          detail: { slot: slot, accountId: (pane.person && pane.person.accountId) || null }
        }));
      } catch (e) { /* other modules react if present */ }
    }
    if (pane.flashTimer) {
      window.clearTimeout(pane.flashTimer);
      pane.el.classList.remove('is-reply');
    }
    // Restart the animation even when the previous flare is still running.
    try { void pane.el.offsetWidth; } catch (e) { /* fine */ }
    pane.el.classList.add('is-reply');
    pane.flashTimer = window.setTimeout(function () {
      try { pane.el.classList.remove('is-reply'); } catch (e) { /* pane gone */ }
      pane.flashTimer = null;
    }, FLASH_MS);
  }

  /* ---------- V12.5 Y2: progression rail (load + send) ---------- */

  // The 2px rail under the pane header reflects anything slow. Ops are
  // COUNTED per pane and kind, so an open (pre-open + messages fetch) holds
  // one shimmer until both land, and a forced refresh superseding an older
  // fetch never strands the rail. Transitions dispatch 'wab:progress'
  // {slot, kind, on} for the desk, and body.wab-busy is set while ANY pane
  // still holds an op in flight.
  function syncBusyClass() {
    var busy = false;
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var pane = state.panes[k];
      if (pane && pane.progN && (pane.progN.load > 0 || pane.progN.send > 0)) { busy = true; break; }
    }
    try { document.body.classList.toggle('wab-busy', busy); } catch (e) { /* fine */ }
  }

  function dispatchProgress(slot, kind, on) {
    try {
      window.dispatchEvent(new CustomEvent('wab:progress', {
        detail: { slot: slot, kind: kind, on: on }
      }));
    } catch (e) { /* other modules react if present */ }
    syncBusyClass();
  }

  function progressBegin(slot, kind) {
    var pane = state.panes[slot];
    if (!pane || !pane.progEl) return;
    if (kind !== 'send') kind = 'load';
    if (pane.progTimer) { window.clearTimeout(pane.progTimer); pane.progTimer = null; }
    pane.progEl.classList.remove('is-done', 'is-err'); // a new action clears settled states
    pane.progN[kind]++;
    if (pane.progN[kind] === 1) {
      pane.progEl.classList.add('is-' + kind);
      dispatchProgress(slot, kind, true);
    }
  }

  function progressEnd(slot, kind, ok) {
    var pane = state.panes[slot];
    if (!pane || !pane.progEl) return;
    if (kind !== 'send') kind = 'load';
    if (pane.progN[kind] <= 0) return;
    pane.progN[kind]--;
    if (pane.progN[kind] > 0) return; // another op of this kind still holds the rail
    pane.progEl.classList.remove('is-' + kind);
    dispatchProgress(slot, kind, false);
    if (ok) {
      // Success: one 300ms bright sweep, then the rail goes quiet. The
      // cleanup timer follows the flashReply / route-flash house pattern.
      pane.progEl.classList.add('is-done');
      pane.progTimer = window.setTimeout(function () {
        pane.progTimer = null;
        try { pane.progEl.classList.remove('is-done'); } catch (e) { /* pane gone */ }
      }, 340);
    } else {
      pane.progEl.classList.add('is-err'); // steady dim red until the next action
    }
  }

  // Closing or repurposing a pane drops any settled rail state; in-flight
  // ops end into a zeroed count and paint nothing. The V12.6 Z2 render
  // self-check is cancelled here too: the pane is being repurposed, so a
  // pending verify would name the wrong conversation.
  function resetProgress(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.progEl) return;
    pane.progN = { load: 0, send: 0 };
    if (pane.progTimer) { window.clearTimeout(pane.progTimer); pane.progTimer = null; }
    cancelSelfCheck(pane);
    pane.progEl.classList.remove('is-load', 'is-send', 'is-done', 'is-err');
    syncBusyClass();
  }

  // v12.4 speed law, now wired into the view path: opening or mounting a
  // conversation pre-opens it on the engine so Send is instant, and the
  // flight is part of the load shimmer. Quiet by design: a failed pre-open
  // never paints the rail red (the send path surfaces it when it matters).
  function firePreopen(slot, accountId, chatId) {
    if (!accountId || !chatId) return;
    if (!wabOk() || !window.wab.eng || typeof window.wab.eng.preopen !== 'function') return;
    progressBegin(slot, 'load');
    callQuiet(function () { return window.wab.eng.preopen(accountId, chatId); })
      .then(function () { progressEnd(slot, 'load', true); });
  }

  /* ---------- V12.5 Y2: typing dots (spine push eng:on-typing) ---------- */

  // The dots are pure pane class: .is-typing swaps the account-name text
  // for the three bouncing dots (render.css). No hidden-attribute juggling.
  function setPaneTyping(slot, on) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    on = !!on;
    if (pane.isTyping === on) return;
    pane.isTyping = on;
    pane.el.classList.toggle('is-typing', on);
  }

  // The spine pushes {accountId, titles:[...]} every 2s per linked engine.
  // When a push lists the MOUNTED pane's person title for that account the
  // dots come out; when a later push stops listing them the header
  // restores itself. Unmounted screens are skipped entirely: their screen
  // dot already blinks for attention.
  function onTypingPush(p) {
    if (!p || !p.accountId) return;
    var titles = Array.isArray(p.titles) ? p.titles : [];
    var normed = {};
    for (var i = 0; i < titles.length; i++) normed[norm(titles[i])] = true;
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var pane = state.panes[k];
      if (!pane || !pane.person) continue;
      if (pane.person.accountId !== p.accountId) continue; // push is for another account
      if (!pane.el || pane.el.parentNode !== state.root) continue; // unmounted: ignore
      setPaneTyping(parseInt(k, 10), !!normed[norm(pane.person.title)]);
    }
  }

  function wireTypingPush() {
    try {
      if (!wabOk() || !window.wab.eng || typeof window.wab.eng.onTyping !== 'function') return;
      window.wab.eng.onTyping(function (p) {
        try { onTypingPush(p); } catch (e) { /* degrade quietly */ }
      });
    } catch (e) { /* degrade quietly */ }
  }

  /* ---------- identity + state ---------- */

  // V12.6 Z2 law: is-empty means THE PICKER STATE ONLY (no person AND the
  // pane state is 'empty'). Before this, is-empty tracked "no person" alone,
  // so a resolve-in-flight or an error on a person-less pane painted its
  // skeleton or error over a transparent, rail-less, borderless pane: the
  // "I don't see the loading state fully" live complaint. A loading or
  // error pane always carries its glass surface and its rail now.
  function syncEmptyClass(pane) {
    if (!pane || !pane.el) return;
    var emptyish = !pane.person && pane.st === 'empty';
    pane.el.classList.toggle('is-empty', emptyish);
  }

  // V14 T5: platform of whatever the spine handed over. T3 stamps every
  // engPeople row and account record with platform; absent (mock fixtures,
  // older spine) means WhatsApp, so the smoke path stays byte-stable.
  function platformOf(v) {
    return v === 'telegram' ? 'telegram' : 'whatsapp';
  }

  // V14 T5: pane platform chrome, derived state only. The badge (T4
  // classes platform-badge-*) shows for a conversation OR an account home
  // (the home answers through its account record); the message bed carries
  // the platform class (T4 watermark) only while a conversation owns the
  // pane, because the bed is the conversation surface. updateIdentity,
  // showAccountHome and every clear path end here, so it never goes stale.
  function syncPlatformChrome(pane) {
    if (!pane || !pane.el) return;
    var hasPerson = !!pane.person;
    var homeAcc = pane.home ? accountByIdLocal(pane.home) : null;
    var pf = platformOf(hasPerson ? pane.person.platform : (homeAcc && homeAcc.platform));
    var badgeOn = hasPerson || !!homeAcc;
    try {
      if (pane.platEl) {
        pane.platEl.hidden = !badgeOn;
        pane.platEl.classList.toggle('platform-badge-whatsapp', badgeOn && pf === 'whatsapp');
        pane.platEl.classList.toggle('platform-badge-telegram', badgeOn && pf === 'telegram');
        pane.platEl.title = badgeOn ? (pf === 'telegram' ? 'Telegram' : 'WhatsApp') : '';
      }
    } catch (eB) { /* the badge is cosmetic */ }
    try {
      if (pane.msgsEl) {
        pane.msgsEl.classList.toggle('platform-whatsapp', hasPerson && pf === 'whatsapp');
        pane.msgsEl.classList.toggle('platform-telegram', hasPerson && pf === 'telegram');
      }
    } catch (eM) { /* the watermark is cosmetic */ }
  }

  function updateIdentity(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    var p = pane.person;
    syncEmptyClass(pane); // V12.6 Z2: derived state, never a bare !person toggle
    if (p) {
      pane.dotEl.style.background = p.accountColor || 'rgba(255,255,255,0.42)';
      pane.titleEl.textContent = p.title || 'Unknown';
      pane.acctEl.textContent = p.accountName || '';
      pane.el.setAttribute('aria-label', 'Conversation with ' + (p.title || 'Unknown') +
        (p.accountName ? ', account ' + p.accountName : ''));
      pane.el.style.setProperty('--wabr-acct', p.accountColor || 'rgba(255,255,255,0.42)');
      pane.el.style.setProperty('--wabr-acct-soft', acctSoft(p.accountColor));
      pane.el.style.setProperty('--wabr-glow-rgb', acctRGBTriplet(p.accountColor));
      // Face: the photo ONLY when a photo exists; the initials ring is the
      // fallback and never rides beside a photo.
      try {
        if (!pane.avatarEl) {
          pane.avatarEl = document.createElement('span');
          pane.avatarEl.className = 'ravatar';
          if (pane.dotEl && pane.dotEl.parentNode) {
            pane.dotEl.parentNode.insertBefore(pane.avatarEl, pane.dotEl);
          } else if (pane.headEl) {
            pane.headEl.insertBefore(pane.avatarEl, pane.headEl.firstChild);
          }
        }
        if (p.avatar) {
          pane.avatarEl.textContent = '';
          pane.avatarEl.style.backgroundImage = 'url("' + p.avatar + '")';
          pane.avatarEl.classList.add('has-img');
          pane.avatarEl.style.borderColor = ''; // photo only: no ring decoration
        } else {
          pane.avatarEl.style.backgroundImage = '';
          pane.avatarEl.classList.remove('has-img');
          pane.avatarEl.textContent = initialsOf(p.title);
          pane.avatarEl.style.borderColor = p.accountColor || 'rgba(255,255,255,0.42)';
        }
      } catch (eAv) { /* header shape drift: initials via dot still carry identity */ }
    } else {
      pane.titleEl.textContent = '';
      pane.acctEl.textContent = '';
      try { if (pane.avatarEl) { pane.avatarEl.textContent = ''; pane.avatarEl.style.backgroundImage = ''; pane.avatarEl.style.borderColor = ''; pane.avatarEl.classList.remove('has-img'); } } catch (eAv2) {}
      pane.el.setAttribute('aria-label', 'Pane ' + (slot + 1) + ', empty');
    }
    syncPlatformChrome(pane); // V14 T5: badge + bed follow the identity
    syncComposeBar();
  }

  function setState(slot, spec) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    var o = (typeof spec === 'string') ? { state: spec } : (spec || {});
    var kind = o.state || 'empty';
    pane.st = kind;

    var box = pane.stateEl;
    box.hidden = (kind === 'live');
    box.textContent = '';
    pane.el.classList.toggle('is-loading', kind === 'loading');
    pane.el.classList.toggle('is-error', kind === 'error');
    syncEmptyClass(pane); // V12.6 Z2: is-empty follows the new state immediately

    if (kind === 'loading') {
      var wrap = h('div', 'rp-skelwrap');
      for (var i = 0; i < 5; i++) {
        var s = h('div', 'rp-skel' + (i === 2 || i === 3 ? ' s-out' : ''));
        wrap.appendChild(s);
      }
      box.appendChild(wrap);
    } else if (kind === 'empty') {
      box.appendChild(buildPickerDom(slot));
      box.appendChild(h('div', 'rpane-note', 'Pick a person from the left, or press Ctrl+K.'));
    } else if (kind === 'error') {
      box.appendChild(h('div', 'rpane-err', o.message || 'Could not load this conversation.'));
      var retry = h('button', 'rpane-retry', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        var pn = state.panes[slot];
        if (!pn) return;
        if (pn.person && pn.person.chatId) {
          setState(slot, 'loading');
          loadMessages(slot, { force: true, forceScroll: true });
        } else if (pn.pendingSpec) {
          // V12.6 Z2: the open never resolved a chatId (engines still
          // loading, roster not hydrated). Retry the RESOLVE, not the empty
          // picker; the old path gave up here and looked like a dead desk.
          var spec2 = pn.pendingSpec;
          pn.pendingSpec = null;
          openFromSpecLive(slot, spec2);
        } else {
          setState(slot, 'empty');
        }
      });
      box.appendChild(retry);
    } else if (kind === 'nothread') {
      // V12.6 Z2: a user-initiated load that came back with ZERO messages.
      // The spine coerces a failed engine read to [], so an honest-looking
      // "No messages yet." can be a lie; this state keeps a Retry next to
      // the note so one click refetches instead of dead-ending.
      box.appendChild(h('div', 'rpane-note', 'No messages came back for this chat yet.'));
      var retry2 = h('button', 'rpane-retry', 'Retry');
      retry2.type = 'button';
      retry2.addEventListener('click', function () {
        var pn = state.panes[slot];
        if (!pn) return;
        if (pn.person && pn.person.chatId) {
          setState(slot, 'loading');
          loadMessages(slot, { force: true, forceScroll: true });
        } else {
          setState(slot, 'empty');
        }
      });
      box.appendChild(retry2);
    }
  }

  /* ---------- V12.6 Z2: render self-check ---------- */

  function cancelSelfCheck(pane) {
    if (!pane || !pane.selfCheckTimer) return;
    window.clearTimeout(pane.selfCheckTimer);
    pane.selfCheckTimer = null;
  }

  // After a load succeeds with count > 0 (or a mount renders a cached page),
  // verify 500ms later that the DOM actually holds bubbles. Zero groups in
  // the pane while st === 'live' means something between renderMessages and
  // the layout ate the page: name it loudly so the bug class is visible
  // instead of an empty pane pretending to be live.
  function scheduleSelfCheck(slot, expected) {
    var pane = state.panes[slot];
    if (!pane || !(expected > 0)) return;
    cancelSelfCheck(pane);
    pane.selfCheckTimer = window.setTimeout(function () {
      pane.selfCheckTimer = null;
      var pn = state.panes[slot];
      if (!pn || pn !== pane) return;         // record replaced meanwhile
      if (pn.st !== 'live') return;           // a later state already named a stage
      if (!pn.el || pn.el.parentNode !== state.root) return; // unmounted: cache only
      var shown = 0;
      try { shown = pn.msgsEl.querySelectorAll('.rgrp, .rsys').length; } catch (e) { shown = 0; }
      if (shown === 0) {
        debugStep('engine-error', (pn.person && pn.person.accountId) || '',
          'render self-check failed (0 of ' + expected + ')');
        progressBegin(slot, 'load');
        progressEnd(slot, 'load', false); // the rail reads this failure too
        setState(slot, { state: 'error', message: 'Messages were fetched but not rendered. Press Retry.' });
      }
    }, SELFCHECK_MS);
  }

  /* ---------- V12.7 F2: inline media + links (message rendering only) ---------- */

  /* Privacy law: media bytes flow engine -> data URL -> DOM, nothing else.
     Every message rendered here already passed the chat blindfold, so media
     shows only in allowed chats by construction. No media byte ever reaches
     a debug event, a toast or a log; debug text carries step names and
     counts only (conventions #7). The cache stores data URLs only, never
     remote URLs, and no IndexedDB: memory, capped, LRU. */

  var mediaCache = new Map(); // msgId -> {url:'data:...', mime}; survives every re-render
  var mediaInflight = {};     // msgId -> 1 while its one fetch flies
  var mediaFailed = {};       // msgId -> 1 after a failed fetch; the retry arrow clears it
  var mediaObserved = [];     // media bubbles awaiting visibility; swept when re-rendered away
  var mediaIO = null;         // the shared IntersectionObserver (lazy)
  var lbEl = null;            // lightbox overlay, built on first open
  var lbImg = null;           // its img, dropped on close to free the decode
  var lbCloseBtn = null;

  var URL_RE = /\bhttps?:\/\/[^\s<>"' ]+/gi;

  function engMediaOk() {
    return wabOk() && window.wab.eng && typeof window.wab.eng.media === 'function';
  }

  function svgWrap(icon, cls) {
    var s = h('span', cls || null);
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = icon;
    return s;
  }

  /* ----- links in text bubbles ----- */

  // External opens go through window.open so the engine-side window-open
  // handler routes them to the system browser; never an in-app navigation.
  function openExternalUrl(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toastRaw('Could not open the link.');
    }
  }

  // Trailing sentence punctuation and an unbalanced closing paren stay out
  // of the link, the way chat apps read URLs in prose.
  function trimUrlTail(u) {
    var cut = u.length;
    while (cut > 0 && '.,;:!'.indexOf(u.charAt(cut - 1)) !== -1) cut--;
    if (cut > 0 && u.charAt(cut - 1) === ')') {
      var opens = (u.slice(0, cut).match(/\(/g) || []).length;
      var closes = (u.slice(0, cut).match(/\)/g) || []).length;
      if (closes > opens) {
        cut--;
        while (cut > 0 && '.,;:!'.indexOf(u.charAt(cut - 1)) !== -1) cut--;
      }
    }
    return u.slice(0, cut);
  }

  function makeLink(url) {
    var a = document.createElement('a');
    a.className = 'wabr-link';
    a.textContent = url;
    a.href = url;
    a.rel = 'noopener noreferrer';
    a.title = url;
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      openExternalUrl(url);
    });
    a.addEventListener('auxclick', function (ev) {
      if (ev.button !== 1) return; // middle click opens externally too
      ev.preventDefault();
      openExternalUrl(url);
    });
    return a;
  }

  // Fills a text bubble: plain text stays plain (textContent), any http(s)
  // URL becomes an anchor. Returns the sole URL when the whole message is
  // exactly one URL, so appendGroup can add the link chip under the bubble.
  function fillTextBubble(bub, text) {
    var t = (text == null ? '' : String(text));
    var matches = [];
    URL_RE.lastIndex = 0;
    var mm;
    while ((mm = URL_RE.exec(t))) {
      var raw = trimUrlTail(mm[0]);
      if (/^https?:\/\/.+$/.test(raw)) matches.push({ start: mm.index, end: mm.index + raw.length, url: raw });
      if (mm.index === URL_RE.lastIndex) URL_RE.lastIndex++;
    }
    if (!matches.length) {
      bub.textContent = t;
      return null;
    }
    var sole = null;
    var trimmed = t.replace(/^\s+|\s+$/g, '');
    if (matches.length === 1 && trimmed === matches[0].url) sole = matches[0].url;
    var pos = 0;
    for (var i = 0; i < matches.length; i++) {
      var mt = matches[i];
      if (mt.start > pos) bub.appendChild(document.createTextNode(t.slice(pos, mt.start)));
      bub.appendChild(makeLink(mt.url));
      pos = mt.end;
    }
    if (pos < t.length) bub.appendChild(document.createTextNode(t.slice(pos)));
    return sole;
  }

  function urlParts(url) {
    var domain = '';
    var path = '';
    try {
      var u = new URL(url);
      domain = u.hostname || '';
      path = (u.pathname && u.pathname !== '/') ? u.pathname : '';
      if (u.search) path += u.search;
    } catch (e) {
      var m = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(url);
      if (m) { domain = m[1]; path = m[2] || ''; }
    }
    if (domain.indexOf('www.') === 0) domain = domain.slice(4);
    if (path.length > 28) path = path.slice(0, 27) + '…';
    return { domain: domain || 'link', path: path };
  }

  // The compact chip under a sole-URL bubble: domain strong, path truncated.
  function buildLinkChip(url) {
    var parts = urlParts(url);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'rlink-chip';
    b.title = url;
    b.setAttribute('aria-label', 'Open link to ' + parts.domain);
    b.appendChild(svgWrap(ICONS.linkExt));
    b.appendChild(h('span', 'rlink-domain', parts.domain));
    if (parts.path) b.appendChild(h('span', 'rlink-path', parts.path));
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openExternalUrl(url);
    });
    return b;
  }

  /* ----- media bubbles ----- */

  // The media id F1 attaches to placeholder messages; mId is the contract,
  // the engine message id is the working fallback for older payloads.
  function mediaIdOf(m) {
    var id = (m && m.mId != null) ? m.mId : ((m && m.id != null) ? m.id : null);
    return String(id == null ? '' : id);
  }

  // Engine answer -> {url, mime} or null. Data URLs only: a remote URL from
  // the engine is refused (privacy law + file:// safety), raw base64 is
  // wrapped with the mime the engine declared.
  function parseMediaRes(res) {
    if (!res || typeof res !== 'object') return null;
    if (res.ok === false) return null;
    var url = res.dataUrl || res.url || res.data || res.src;
    var mime = String(res.mime || res.mimetype || res.type || '').toLowerCase();
    if (typeof url !== 'string' || !url) return null;
    if (url.indexOf('data:') === 0) {
      var m = /^data:([^;,]+)/i.exec(url);
      return { url: url, mime: (m && m[1] ? m[1].toLowerCase() : mime) };
    }
    if (mime && /^[A-Za-z0-9+/=\r\n]+$/.test(url) && url.length > 32) {
      return { url: 'data:' + mime + ';base64,' + url.replace(/\s+/g, ''), mime: mime };
    }
    return null;
  }

  // What a fetched media blob renders as. Message metadata wins for stickers
  // and voice notes; the mime decides image vs video; WhatsApp stickers ship
  // as webp, so webp without metadata reads as a sticker.
  function mediaClassOf(m, parsed) {
    var mime = String((parsed && parsed.mime) || '').toLowerCase();
    var t = String((m && (m.mtype || m.mediatype || m.media || m.sub)) || '').toLowerCase();
    if (t.indexOf('sticker') !== -1) return 'sticker';
    if (mime.indexOf('audio/') === 0 || t === 'ptt' || t.indexOf('audio') !== -1) return 'audio';
    if (mime.indexOf('video/') === 0 || t.indexOf('video') !== -1 || t === 'gif') return 'video';
    if (mime === 'image/webp') return 'sticker';
    return 'image'; // includes image/gif: the img element animates it natively
  }

  // LRU put, data URLs only. Map preserves insertion order, so the oldest
  // key falls out first; a re-put refreshes recency.
  function cachePutMedia(id, parsed) {
    if (!id || !parsed || typeof parsed.url !== 'string' || parsed.url.indexOf('data:') !== 0) return;
    if (mediaCache.has(id)) mediaCache.delete(id);
    mediaCache.set(id, parsed);
    while (mediaCache.size > MEDIA_CACHE_MAX) {
      var oldest = null;
      try { oldest = mediaCache.keys().next().value; } catch (e) { oldest = null; }
      if (oldest === null || oldest === undefined) break;
      mediaCache.delete(oldest);
    }
  }

  function onMediaVisible(entries) {
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i];
      if (!en || !en.isIntersecting) continue;
      var el = en.target;
      if (mediaIO) { try { mediaIO.unobserve(el); } catch (e) { /* fine */ } }
      var ix = mediaObserved.indexOf(el);
      if (ix !== -1) mediaObserved.splice(ix, 1);
      var rec = el.wabMedia;
      if (rec) fetchMedia(el, rec);
    }
  }

  function getMediaObserver() {
    if (mediaIO) return mediaIO;
    if (typeof IntersectionObserver !== 'function') return null;
    try {
      mediaIO = new IntersectionObserver(onMediaVisible, {
        root: null,
        rootMargin: MEDIA_PRELOAD,
        threshold: 0.05
      });
    } catch (e) { mediaIO = null; }
    return mediaIO;
  }

  // Re-renders drop old bubbles wholesale; anything still observed but no
  // longer connected lets go here, so the observer never holds dead panes.
  function sweepMediaObservers() {
    if (!mediaObserved.length) return;
    for (var i = mediaObserved.length - 1; i >= 0; i--) {
      var el = mediaObserved[i];
      var gone = true;
      try { gone = !el.isConnected; } catch (e) { gone = true; }
      if (gone) {
        if (mediaIO) { try { mediaIO.unobserve(el); } catch (e2) { /* fine */ } }
        mediaObserved.splice(i, 1);
        try { delete el.wabMedia; } catch (e3) { /* fine */ }
      }
    }
  }

  function mediaNoteChip() {
    var chip = h('span', 'rmedia-note');
    chip.appendChild(svgWrap(ICONS.audio));
    chip.appendChild(h('span', null, 'Voice note (plays on the phone)'));
    return chip;
  }

  function paintMediaFail(el, m, rec) {
    try {
      el.classList.remove('is-loaded', 'is-wait');
      el.classList.add('is-failed');
      delete el.wabMedia;
    } catch (e) { /* fine */ }
    el.textContent = '';
    var chip = h('span', 'rmedia-fail');
    chip.appendChild(svgWrap(ICONS.media));
    chip.appendChild(h('span', null, 'Media unavailable on the desk'));
    if (rec) {
      var retry = ctrlBtn('rmedia-retry', ICONS.retry, 'Try this media again', 'Try again');
      retry.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!el.isConnected) return;
        var id = mediaIdOf(rec.m);
        if (id) delete mediaFailed[id]; // one refetch per click, never a storm
        el.classList.remove('is-failed');
        fetchMedia(el, rec);
      });
      chip.appendChild(retry);
    }
    el.appendChild(chip);
  }

  // Swaps a placeholder bubble to its real media. Stickers drop the bubble
  // chrome entirely; audio never becomes a player (vNext); images open the
  // lightbox on click; videos loop muted, inline.
  function applyMediaResult(el, m, parsed) {
    if (!el || !parsed) return;
    var k = mediaClassOf(m, parsed);
    try { el.classList.remove('is-wait', 'is-failed'); el.classList.add('is-loaded'); delete el.wabMedia; } catch (e) { /* fine */ }
    if (k === 'audio') {
      el.classList.add('is-audio');
      el.textContent = '';
      el.appendChild(mediaNoteChip());
      return;
    }
    if (k === 'sticker') {
      el.classList.add('is-sticker');
      el.textContent = '';
      var st = h('img', 'rmedia-stick');
      st.alt = 'Sticker';
      st.addEventListener('error', function () { if (el.isConnected) paintMediaFail(el, m, null); });
      st.src = parsed.url;
      el.appendChild(st);
      return;
    }
    var frame = null;
    try { frame = el.querySelector('.rmedia-frame'); } catch (e) { frame = null; }
    if (!frame) {
      el.textContent = '';
      frame = h('div', 'rmedia-frame');
      el.appendChild(frame);
    }
    frame.classList.remove('is-wait');
    frame.textContent = '';
    if (k === 'video') {
      var v = document.createElement('video');
      v.className = 'rmedia-video';
      v.muted = true;
      v.loop = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.autoplay = true;
      v.src = parsed.url;
      frame.appendChild(v);
      try {
        var pr = v.play();
        if (pr && typeof pr.catch === 'function') pr.catch(function () { /* autoplay refused: it sits there, loop still works after a click */ });
      } catch (e) { /* fine */ }
      return;
    }
    var img = h('img', 'rmedia-img');
    img.alt = 'Photo';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', 'Open this image full size');
    img.title = 'Open full size';
    img.addEventListener('error', function () { if (el.isConnected) paintMediaFail(el, m, null); });
    img.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openLightbox(parsed.url);
    });
    img.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      ev.stopPropagation();
      openLightbox(parsed.url);
    });
    img.src = parsed.url;
    frame.appendChild(img);
  }

  // The one fetch per media message: cache first, then the in-flight guard,
  // then the engine. The bubble may be replaced by a re-render while the
  // call flies; the answer lands in the cache either way, and paints only
  // into an element still connected to the DOM.
  function fetchMedia(el, rec) {
    var m = rec && rec.m;
    var id = mediaIdOf(m);
    if (!id) { paintMediaFail(el, m, rec); return; }
    if (mediaCache.has(id)) { applyMediaResult(el, m, mediaCache.get(id)); return; }
    if (mediaInflight[id]) return;
    if (mediaFailed[id]) { paintMediaFail(el, m, rec); return; }
    if (!engMediaOk() || !rec.acct || !rec.chat) {
      mediaFailed[id] = 1;
      paintMediaFail(el, m, rec);
      return;
    }
    mediaInflight[id] = true;
    debugStep('open-step', rec.acct, 'media read sent');
    callQuiet(function () { return window.wab.eng.media(rec.acct, rec.chat, id); })
      .then(function (res) {
        delete mediaInflight[id];
        var parsed = parseMediaRes(res);
        if (parsed) {
          cachePutMedia(id, parsed);
          debugStep('open-step', rec.acct, 'media read ok');
        } else {
          mediaFailed[id] = 1;
          debugStep('engine-error', rec.acct, 'media read failed');
        }
        if (el && el.isConnected) {
          if (parsed) applyMediaResult(el, m, parsed);
          else paintMediaFail(el, m, rec);
        }
      });
  }

  // Builds a media bubble: the 4/3 glass frame with its icon, then either an
  // instant paint from the cache, the failed chip, or observation until the
  // bubble scrolls into view. rec captures the account and chat AT BUILD
  // time, so a person change mid-flight can never fetch into the wrong chat.
  function buildMediaBubble(pane, m, cls) {
    var bub = h('div', cls + ' is-media is-wait');
    var frame = h('div', 'rmedia-frame is-wait');
    frame.appendChild(svgWrap(ICONS.media, 'rmedia-ico'));
    bub.appendChild(frame);
    var id = mediaIdOf(m);
    if (id && mediaCache.has(id)) {
      applyMediaResult(bub, m, mediaCache.get(id));
      return bub;
    }
    if (id && mediaFailed[id]) {
      paintMediaFail(bub, m, null); // no retry without a chat context
      return bub;
    }
    if (!id || !pane || !pane.person || !pane.person.accountId || !pane.person.chatId) {
      paintMediaFail(bub, m, null);
      return bub;
    }
    var rec = { acct: pane.person.accountId, chat: pane.person.chatId, m: m };
    bub.wabMedia = rec;
    if (getMediaObserver()) {
      mediaIO.observe(bub);
      mediaObserved.push(bub);
    } else {
      fetchMedia(bub, rec); // ancient engine with no IntersectionObserver: fetch now
    }
    return bub;
  }

  /* ----- lightbox ----- */

  // Full-size image overlay: click-away closes, Esc closes, the image itself
  // never closes on click. The Esc listener is a document CAPTURE listener,
  // so it also outranks the maximize-restore Esc while the lightbox is open.
  function ensureLightbox() {
    if (lbEl) return lbEl;
    lbEl = h('div', 'rmedia-lightbox');
    lbEl.hidden = true;
    lbEl.setAttribute('role', 'dialog');
    lbEl.setAttribute('aria-modal', 'true');
    lbEl.setAttribute('aria-label', 'Image preview. Press Escape or click outside to close.');
    lbCloseBtn = ctrlBtn('rmlb-close', ICONS.close, 'Close preview', 'Close (Escape)');
    lbCloseBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeLightbox();
    });
    lbEl.appendChild(lbCloseBtn);
    lbEl.addEventListener('click', function (ev) {
      if (ev.target === lbEl) closeLightbox();
    });
    document.body.appendChild(lbEl);
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || !lbEl || lbEl.hidden) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      closeLightbox();
    }, true);
    return lbEl;
  }

  function openLightbox(url) {
    if (typeof url !== 'string' || url.indexOf('data:') !== 0) return; // data URLs only
    var ov = ensureLightbox();
    if (lbImg) { try { lbImg.parentNode.removeChild(lbImg); } catch (e) { /* fine */ } lbImg = null; }
    lbImg = h('img', 'rmlb-img');
    lbImg.alt = 'Image from the conversation';
    lbImg.addEventListener('click', function (ev) { ev.stopPropagation(); });
    lbImg.src = url;
    ov.insertBefore(lbImg, ov.firstChild);
    ov.hidden = false;
    try { lbCloseBtn.focus(); } catch (e) { /* fine */ }
  }

  function closeLightbox() {
    if (!lbEl || lbEl.hidden) return;
    lbEl.hidden = true;
    if (lbImg) {
      try { if (lbImg.parentNode) lbImg.parentNode.removeChild(lbImg); } catch (e) { /* fine */ }
      lbImg = null; // frees the decoded bitmap, the data URL lives on in the cache
    }
  }

  /* ---------- messages ---------- */

  function isNearBottom(pane) {
    var box = pane.msgsEl;
    return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
  }

  function renderMessages(slot, msgs, opts) {
    opts = opts || {};
    var pane = state.panes[slot];
    if (!pane || !pane.el || pane.el.parentNode !== state.root) {
      if (pane) pane.msgs = msgs || [];
      return;
    }
    if (!Array.isArray(msgs)) msgs = [];
    pane.msgs = msgs;
    pane.histCount = msgs.length; // V13 J2: every render restates the held count
    var box = pane.msgsEl;
    var near = opts.forceScroll ? true : isNearBottom(pane);
    var keepTop = box.scrollTop;
    box.textContent = '';
    sweepMediaObservers(); // V12.7 F2: bubbles replaced by this re-render let go of the observer

    if (!msgs.length) {
      box.appendChild(h('div', 'rnonote', 'No messages yet.'));
    } else {
      var groups = [];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (!m) continue;
        var kind = m.kind || 'text';
        var fromMe = !!m.fromMe;
        if (kind === 'system') {
          groups.push({ system: true, items: [m] });
          continue;
        }
        var g = groups[groups.length - 1];
        if (g && !g.system && g.fromMe === fromMe) g.items.push(m);
        else groups.push({ system: false, fromMe: fromMe, items: [m] });
      }
      for (var gi = 0; gi < groups.length; gi++) appendGroup(pane, box, groups[gi]);
    }

    if (near) box.scrollTop = box.scrollHeight;
    else box.scrollTop = keepTop;
  }

  function appendGroup(pane, box, g) {
    if (g.system) {
      box.appendChild(h('div', 'rsys', (g.items[0] && g.items[0].text) || ''));
      return;
    }
    var wrap = h('div', 'rgrp ' + (g.fromMe ? 'g-out' : 'g-in'));
    var last = g.items.length - 1;
    if (!g.fromMe && pane.person && pane.person.title) {
      wrap.appendChild(h('div', 'rname', pane.person.title));
    }
    for (var i = 0; i <= last; i++) {
      var m = g.items[i];
      var kind = m.kind || 'text';
      var cls = 'rbub ' + (g.fromMe ? 'out' : 'in') +
        (i === 0 ? ' first' : '') + (i === last ? ' last' : '');
      if (kind === 'media-placeholder') {
        // V12.7 F2: the glass media frame; bytes arrive on visibility.
        wrap.appendChild(buildMediaBubble(pane, m, cls));
      } else {
        // V12.7 F2: linkified text; a sole-URL message adds its chip below.
        var tb = h('div', cls);
        var sole = fillTextBubble(tb, m.text);
        wrap.appendChild(tb);
        if (sole) wrap.appendChild(buildLinkChip(sole));
      }
    }
    var t = fmtTime(g.items[last] && g.items[last].ts);
    if (t) wrap.appendChild(h('div', 'rtime', t));
    box.appendChild(wrap);
  }

  /* ---------- V13 J2: scroll-up history (WhatsApp-phone law) ---------- */

  // Scroll up = the phone: pause, load older pages, prepend, keep reading
  // until yesterday or the day before. Only the scroll event starts a
  // history fetch (the 2s fresh poll never does), the strip above the bed
  // says what is happening, and the prepend is scroll-anchored so the
  // message on screen stays on screen. Spine contract (wired after J1):
  //   wab.eng.history(accountId, chatId, pages) -> {ok, messages[], grewBy, hasMore}
  //   wab.eng.hasMore(accountId, chatId) -> {ok, hasMore}
  // The history result already carries hasMore, so this path never calls
  // the separate probe; a spine without wab.eng.history simply never fires.

  // The strip: 'busy' while a page flies, 'done' once the engine says this
  // is the beginning, 'off' hides it. Plain text swaps, nothing animates.
  function histLine(slot, mode) {
    var pane = state.panes[slot];
    if (!pane || !pane.histEl) return;
    var el = pane.histEl;
    el.classList.remove('is-busy', 'is-done');
    if (mode === 'busy') {
      el.textContent = 'Loading earlier messages';
      el.classList.add('is-busy');
      el.hidden = false;
    } else if (mode === 'done') {
      el.textContent = 'Beginning of conversation';
      el.classList.add('is-done');
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  // The history flags belong to the person: every person change, close,
  // home hop and full-WhatsApp hop calls this after clearing the pane.
  function resetHistState(pane) {
    if (!pane) return;
    pane.histBusy = false;
    pane.histDone = false;
    pane.histCount = (pane.msgs && pane.msgs.length) || 0;
    if (pane.histEl) {
      pane.histEl.classList.remove('is-busy', 'is-done');
      pane.histEl.textContent = '';
      pane.histEl.hidden = true;
    }
  }

  // Scroll detection on the bed: near the top edge (under HIST_TOP_PX),
  // person live, nothing in flight, pages still to come, engine able.
  function onPaneMsgsScroll(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.person || !pane.person.chatId) return;
    if (pane.st !== 'live' || pane.histBusy || pane.histDone) return;
    if (!engOk() || !window.wab.eng || typeof window.wab.eng.history !== 'function') return;
    var box = pane.msgsEl;
    if (!box || box.scrollTop >= HIST_TOP_PX) return;
    loadHistory(slot);
  }

  // Fresh tail from a poll or a forced reload: the window REPLACES the
  // tail; ids the window no longer lists are exactly the older pages this
  // pane scrolled up for, kept in order ahead of it. Pure helper: returns
  // the merged array, writes nothing. An empty window (the spine coerces
  // failed reads to []) hands callers back an empty list on purpose, so
  // they can keep the pages they already hold instead of erasing them.
  function mergeFreshWindow(pane, fresh) {
    if (!Array.isArray(fresh)) fresh = [];
    if (!pane.msgs || !pane.msgs.length || !fresh.length) return fresh;
    var have = {};
    for (var i = 0; i < fresh.length; i++) have[msgId(fresh[i], i)] = 1;
    var kept = [];
    for (var j = 0; j < pane.msgs.length; j++) {
      var m = pane.msgs[j];
      if (!m || have[msgId(m, j)]) continue;
      kept.push(m);
    }
    return kept.concat(fresh);
  }

  // Older page from the engine: prepend what is new, drop ids already held
  // (pages can overlap the loaded window). Returns how many ids landed.
  function mergeOlderPage(pane, older) {
    if (!Array.isArray(older)) older = [];
    if (!older.length) return 0;
    var have = {};
    for (var j = 0; j < pane.msgs.length; j++) have[msgId(pane.msgs[j], j)] = 1;
    var add = [];
    for (var i = 0; i < older.length; i++) {
      var m = older[i];
      if (!m || have[msgId(m, i)]) continue;
      have[msgId(m, i)] = 1;
      add.push(m);
    }
    if (!add.length) return 0;
    pane.msgs = add.concat(pane.msgs);
    return add.length;
  }

  function loadHistory(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.person || !pane.person.chatId) return;
    if (pane.histBusy || pane.histDone || pane.st !== 'live') return;
    pane.histBusy = true;
    histLine(slot, 'busy');
    var acctId = pane.person.accountId;
    var chatId = pane.person.chatId;
    var myPerson = pane.person;
    debugStep('open-step', acctId, 'history sent (pages ' + HIST_PAGES + ')');
    callQuiet(function () { return window.wab.eng.history(acctId, chatId, HIST_PAGES); })
      .then(function (res) {
        var pn = state.panes[slot];
        if (pn !== pane || pane.person !== myPerson) {
          pane.histBusy = false; // a reset path owns the flags now
          return;
        }
        if (!res || typeof res !== 'object' || !Array.isArray(res.messages)) {
          // No answer or wrong shape (also the pre-J1 spine): quiet, the
          // next scroll retries. A scroll-up never paints the rail red.
          pane.histBusy = false;
          histLine(slot, 'off');
          debugStep('engine-error', acctId, 'history failed (no answer)');
          return;
        }
        // Anchor law: capture the bed geometry BEFORE the re-render; after
        // it, pin scrollTop so the first visible message stays visible.
        var box = pane.msgsEl;
        var mounted = !!(box && pane.el && pane.el.parentNode === state.root);
        var oldH = 0, oldTop = 0;
        if (mounted) {
          try { oldH = box.scrollHeight; oldTop = box.scrollTop; } catch (e) { mounted = false; }
        }
        var added = mergeOlderPage(pane, res.messages);
        if (added > 0) {
          // Record the older ids as seen so no later poll flares them as a
          // reply. The return value is ignored on purpose: history is never
          // a reply, and the full list (not just the page) keeps the seen
          // set honest when it compacts.
          trackSeenMessages(pane, pane.msgs);
          renderMessages(slot, pane.msgs, {});
          pane.histCount = pane.msgs.length;
          debugStep('open-step', acctId, 'history ok (+' + added + ' to ' + pane.histCount + ')');
        }
        if (mounted) {
          try { pane.msgsEl.scrollTop = pane.msgsEl.scrollHeight - oldH + oldTop; } catch (e) { /* fine */ }
        }
        // End conditions: the engine says no more, the fetch grew nothing,
        // or everything it returned was already held (an overlapping page
        // means the window has reached the top). Latch, quiet line.
        if (res.hasMore === false || res.grewBy === 0 || added === 0) {
          pane.histBusy = false;
          pane.histDone = true;
          histLine(slot, 'done');
          debugStep('open-step', acctId, 'history end');
          return;
        }
        pane.histBusy = false;
        histLine(slot, 'off');
        // Still pinned at the very top after the prepend (a short page can
        // leave scrollTop under the trigger): keep the phone going.
        if (mounted && pane.msgsEl.scrollTop < 4) loadHistory(slot);
      });
  }

  /* ---------- conversation open + loads ---------- */

  // Where an open lands: the ACTIVE screen in single/tabs (its record owns
  // the one visible rect), else the active slot when visible, else the
  // first visible slot. Rail, palette and command-bar opens all go here,
  // so a new person never steals another screen's conversation. This is
  // the V12.4 X2 invariant in code: only the mounted ACTIVE screen's
  // record is ever replaced by an open.
  function targetOpenSlot() {
    if (isScreenLayout()) return state.screenIdx;
    var rects = getRects();
    if (!rects.length) return -1;
    var best = null;
    for (var i = 0; i < rects.length; i++) {
      var s = parseInt(rects[i].slot, 10);
      if (isNaN(s)) continue;
      var id = paneIdForRect(s); // V12.7 W2: the record this rect mounts
      if (id === state.activeSlot) return id;
      if (best === null || s < best) best = s;
    }
    return (best === null) ? -1 : paneIdForRect(best); // V12.7 W2: a record id, not a raw slot
  }

  function setPerson(slot, person, opts) {
    opts = opts || {};
    var pane = ensurePane(slot);
    if (!pane) return;
    var prev = pane.person;
    leaveStack(slot, false); // V12.7 W2: the new conversation owns the slot alone
    if (prev && prev.chatId && slot === state.activeSlot && state.gta) {
      // V13 D1: the flying text belongs to the person it was written for.
      persistDraftForPerson(prev, state.gta.value || '');
    }
    pane.person = person;
    if (!prev || !person ||
        prev.accountId !== person.accountId ||
        norm(prev.title) !== norm(person.title)) {
      pane.msgs = [];
      pane.seenIds = null;     // new conversation: reply detection starts fresh
      pane.seeded = false;
      pane.savedScroll = null; // fresh conversation opens at the bottom
      pane.draft = draftStorePeek(draftKey(person)); // V13 D1: reopening adopts a stored draft
      pane.hasNew = false;     // V12.3 W1: a new conversation starts unblinking
      pane.pendingSpec = null; // V12.6 Z2: resolved now; no resolve retry owed
      setPaneTyping(slot, false); // V12.5 Y2: the dots belonged to the previous person
      cancelSelfCheck(pane);     // V12.6 Z2: any pending verify named the old person
      resetHistState(pane);      // V13 J2: the older pages belonged to the previous person
      // V13 D1: the bar opens on the conversation's own draft (usually empty).
      if (state.gta && slot === state.activeSlot) state.gta.value = pane.draft || '';
    }
    updateIdentity(slot);
    if (pane.minimized) restoreFromMin(slot);
    // A maximized pane stays maximized across person changes.
    setState(slot, 'loading');
    updateMinUnread(slot);
    syncRailHighlight();
    notifyScreensChanged();
    reportSpine(slot); // V12.4 X2: the spine mirrors what this record shows
    if (person && person.chatId) {
      firePreopen(slot, person.accountId, person.chatId); // V12.5 Y2: viewing = pre-opening
      loadMessages(slot, { force: true, forceScroll: true, focus: !!opts.focus });
    } else {
      progressBegin(slot, 'load');
      progressEnd(slot, 'load', false); // V12.5 Y2: an unresolvable open paints the rail red
      debugStep('engine-error', person && person.accountId, 'open without chat id');
      setState(slot, { state: 'error', message: 'Could not resolve this chat. Refresh the people list.' });
    }
  }

  function loadMessages(slot, opts) {
    opts = opts || {};
    var pane = state.panes[slot];
    if (!pane || !pane.person || !pane.person.chatId) {
      // V12.6 Z2: a load that cannot even start says so when the USER asked
      // for it (open, retry, mount). Background polls stay silent.
      if (pane && (opts.force || opts.track)) {
        debugStep('engine-error', pane.person && pane.person.accountId, 'read blocked (no chat id)');
        progressBegin(slot, 'load');
        progressEnd(slot, 'load', false);
        setState(slot, { state: 'error', message: 'This conversation has no chat id yet. Press Retry after the engines load.' });
      }
      return;
    }
    if (!engOk()) {
      progressBegin(slot, 'load');
      progressEnd(slot, 'load', false); // V12.5 Y2: the rail reads this failure too
      setState(slot, { state: 'error', message: 'Conversations need the latest app version. Update Chat Bridge.' });
      return;
    }
    // Consent-first: a USER-driven load for a locked account says so
    // explicitly instead of surfacing the blindfold's refusal shape. Silent
    // background polls skip the check; the blindfold holds them regardless.
    if (opts.force || opts.track) {
      accountLocked(pane.person.accountId).then(function (locked) {
        if (state.panes[slot] !== pane) return; // pane was replaced mid-check
        if (locked) {
          debugStep('engine-error', pane.person.accountId, 'read blocked (account locked)');
          progressBegin(slot, 'load');
          progressEnd(slot, 'load', false);
          setState(slot, { state: 'error', message: lockedMessage() });
          return;
        }
        loadMessagesFetch(slot, opts, pane);
      });
      return;
    }
    loadMessagesFetch(slot, opts, pane);
  }

  function loadMessagesFetch(slot, opts, pane) {
    if (pane.fetching && !opts.force) return;
    var seq = ++pane.loadSeq;
    pane.fetching = true;
    cancelSelfCheck(pane); // a superseding fetch owns the next verify
    // V12.5 Y2: user-initiated loads (open, retry, mount, post-send refresh)
    // drive the rail; the silent 2s/4s background polls never do.
    var track = !!(opts.force || opts.track);
    if (track) progressBegin(slot, 'load');
    var acctId = pane.person.accountId;
    var chatId = pane.person.chatId;
    if (track) debugStep('open-step', acctId, 'read sent (' + MSG_LIMIT + ')'); // V12.6 Z2
    callQuiet(function () { return window.wab.eng.messages(acctId, chatId, MSG_LIMIT); })
      .then(function (res) {
        pane.fetching = false;
        // The rail count ends BEFORE the stale check: a superseded fetch
        // must release its hold even when its result is discarded.
        if (track) progressEnd(slot, 'load', res !== null && Array.isArray(res));
        var pn = state.panes[slot];
        if (!pn || pn !== pane || seq !== pane.loadSeq) return; // stale or replaced
        if (res === null) {
          // The invoke rejected (callQuiet caught it): engine or IPC down.
          debugStep('engine-error', acctId, 'read failed (no answer)');
          setState(slot, { state: 'error', message: 'Could not load this conversation. The engine did not answer.' });
          return;
        }
        if (!Array.isArray(res)) {
          // V12.6 Z2 law: a non-array is a failure, never a quiet '[]'.
          debugStep('engine-error', acctId, 'read failed (non-array)');
          // Surface the spine's own reason when it sent one (e.g. the blindfold
          // refusing a restricted chat) instead of a generic shape error.
          const reason = (res && res.ok === false && res.error) ? res.error : '';
          setState(slot, { state: 'error', message: reason || 'Messages came back in an unexpected shape. Press Retry.' });
          return;
        }
        // Reply detection: the first page of a conversation only seeds the
        // known ids; any later unknown INCOMING id is a new reply.
        var seeded = pane.seeded;
        var freshReply = trackSeenMessages(pane, res);
        pane.seeded = true;
        // V13 J2: the poll must not eat the scroll-up pages. The fresh
        // window replaces the tail; ids it no longer lists are the older
        // pages this pane holds, kept in order ahead of it. An empty window
        // (the spine coerces failed reads to []) keeps the loaded pages.
        var render = res.length ? mergeFreshWindow(pane, res) : pane.msgs;
        renderMessages(slot, render, { forceScroll: !!opts.forceScroll });
        if (render.length) {
          debugStep('open-step', acctId, 'read ok (' + res.length + ')');
          setState(slot, 'live');
          scheduleSelfCheck(slot, render.length); // V12.6 Z2: verify the DOM kept them
        } else if (track) {
          // V12.6 Z2: user asked, engine answered zero. The spine coerces
          // failed reads to [], so this stays retryable, never a dead end.
          debugStep('open-step', acctId, 'read empty');
          setState(slot, 'nothread');
        } else {
          setState(slot, 'live'); // background poll: silent, keep the bed note
        }
        if (freshReply && seeded) flashReply(slot, pane);
        if (opts.focus && state.gta) {
          // The central bar is the one entry box: opening a chat focuses it.
          try { state.gta.focus(); } catch (e) { /* fine */ }
        }
      });
  }

  // V12.6 Z2: open a RESOLVED person, never silently. openConversationIn
  // returns false when no visible rect mounts the slot this frame (boot
  // race, layout mid-switch); that used to swallow the whole click. Now:
  // resync the panes, retry once on the next frame, and say it loud if the
  // rect still is not there.
  function openResolved(slot, person, opts) {
    if (openConversationIn(slot, person, opts || {})) return true;
    scheduleSync();
    window.setTimeout(function () {
      var pn = state.panes[slot];
      if (pn && pn.person && norm(pn.person.title) === norm(person.title) &&
          pn.person.accountId === person.accountId) return; // a retry path already landed it
      if (!openConversationIn(slot, person, opts || {})) {
        toastRaw('No conversation pane is visible. Pick a layout first.');
      }
    }, 120);
    return false;
  }

  function openConversationIn(slot, spec, opts) {
    var rects = getRects();
    var visible = false;
    for (var i = 0; i < rects.length; i++) {
      if (paneIdForRect(parseInt(rects[i].slot, 10)) === slot) { visible = true; break; }
    }
    if (!visible) return false;
    var pane = state.panes[slot];
    if (pane) {
      // Leaving full-WhatsApp / home mode: the conversation pane takes the slot back.
      if (pane.full || pane.home) {
        pane.full = false;
        pane.fullAcc = null;
        pane.home = null;
        pane.el.style.display = '';
      }
    }
    var person = resolveForOpen(spec);
    setPerson(slot, person, opts || {});
    return true;
  }

  // The existing close path, now also behind every pane header's X. Clears
  // the conversation view (person, messages, scroll, draft, min/max) and
  // drops back to the empty picker. The chat itself stays on WhatsApp.
  function clearPerson(slot) {
    var pane = state.panes[slot];
    if (!pane) return;
    if (pane.person && pane.person.chatId && state.gta && slot === state.activeSlot) {
      pane.draft = state.gta.value || ''; // V13 D1: closing still files the bar text first
    }
    persistPaneDraft(pane); // V13 D1: before the person goes, the key needs it
    pane.person = null;
    leaveStack(slot, true); // V12.7 W2: mounted stack member hands its rect on
    pane.msgs = [];
    pane.savedScroll = null;
    pane.draft = '';
    pane.minimized = false;
    pane.seenIds = null;
    pane.seeded = false;
    pane.full = false;
    pane.fullAcc = null;
    pane.home = null;
    pane.hasNew = false;
    pane.pendingSpec = null; // V12.6 Z2: closed means no retry owed
    setPaneTyping(slot, false); // V12.5 Y2: closing kills the dots too
    resetProgress(slot);        // V12.5 Y2: no settled rail state on an empty pane (cancels the self-check)
    resetHistState(pane);       // V13 J2: a closed pane owes no history state
    try { pane.el.style.display = ''; } catch (e) { /* fine */ }
    pane.el.classList.remove('is-min');
    if (pane.maximized) demaximizePane(slot);
    if (state.gta && slot === state.activeSlot) state.gta.value = '';
    updateIdentity(slot);
    setState(slot, 'empty');
    syncRailHighlight();
    notifyScreensChanged();
    reportSpine(slot); // V12.4 X2: report the close so the spine cannot resurrect it
    // Single/tabs: closing the mounted screen hops to the next occupied
    // screen; with none left, this screen shows the empty state.
    if (isScreenLayout() && slot === state.screenIdx) advanceScreenAfterClose(slot);
  }

  /* ---------- send ---------- */

  // Sending lives in the central bar only (dispatchCentral below). The old
  // per-pane footer send path is structurally gone (V12.1 T3).

  /* ---------- zoom ---------- */

  function applyZoom(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    pane.el.style.fontSize = (Math.round(BASE_FONT * pane.zoom * 10) / 10) + 'px';
    if (pane.zoomEl) pane.zoomEl.textContent = Math.round(pane.zoom * 100) + '%';
  }

  function setPaneZoom(slot, delta) {
    slot = parseInt(slot, 10);
    if (isNaN(slot)) return;
    var pane = state.panes[slot];
    if (!pane) return;
    var z = Math.round((pane.zoom + delta) * 10) / 10;
    z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (z === pane.zoom && delta !== 0) return;
    pane.zoom = z;
    applyZoom(slot);
    if (prefsOk()) {
      if (state.zoomTimers[slot]) window.clearTimeout(state.zoomTimers[slot]);
      state.zoomTimers[slot] = window.setTimeout(function () {
        state.zoomTimers[slot] = null;
        persistPrefs(slot);
      }, 400);
    }
  }

  function persistPrefs(slot) {
    var pane = state.panes[slot];
    if (!pane || !prefsOk()) return;
    callQuiet(function () {
      return window.wab.app.setPanePrefs(slot, { zoom: pane.zoom, minimized: !!pane.minimized });
    });
  }

  function loadPrefs() {
    if (!wabOk() || !window.wab.app || typeof window.wab.app.getPanePrefs !== 'function') return;
    callQuiet(function () { return window.wab.app.getPanePrefs(); })
      .then(function (res) {
        if (!res || typeof res !== 'object') return;
        for (var k in res) {
          if (!Object.prototype.hasOwnProperty.call(res, k)) continue;
          var slot = parseInt(k, 10);
          if (isNaN(slot)) continue;
          var p = res[k] || {};
          var pane = state.panes[slot];
          if (!pane) continue;
          var z = Number(p.zoom);
          if (isFinite(z) && z > 0) pane.zoom = clamp(Math.round(z * 10) / 10, ZOOM_MIN, ZOOM_MAX);
          pane.minimized = !!p.minimized;
          applyZoom(slot);
          if (pane.minimized && pane.person) {
            pane.el.classList.add('is-min');
            pane.el.style.height = '';
            updateMinUnread(slot);
          }
        }
      });
  }

  /* ---------- maximize / minimize ---------- */

  function toggleMaximize(slot) {
    slot = parseInt(slot, 10);
    if (isNaN(slot)) return;
    var pane = state.panes[slot];
    if (!pane || !pane.el || pane.el.parentNode !== state.root) return;
    if (!pane.person) return;

    if (pane.maximized) {
      demaximizePane(slot);
      syncPanes();
    } else {
      if (state.maxSlot !== null && state.maxSlot !== slot) toggleMaximize(state.maxSlot);
      if (pane.minimized) restoreFromMin(slot); // first, so its style reset cannot bite
      pane.maximized = true;
      state.maxSlot = slot;
      pane.el.classList.add('is-max');
      pane.el.style.left = '0';
      pane.el.style.top = '0';
      pane.el.style.width = '100%';
      pane.el.style.height = '100%';
      pane.maxBtn.innerHTML = ICONS.restoreMax;
      pane.maxBtn.setAttribute('aria-label', 'Restore pane size');
      pane.maxBtn.title = 'Restore size';
      document.body.classList.add('wab-maximized');
    }
  }

  // Quiet record-level un-maximize: works on detached panes too (a maximized
  // pane being unmounted or cleared must not leave the desk maxed).
  function demaximizePane(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.maximized) return;
    pane.maximized = false;
    try {
      pane.el.classList.remove('is-max');
      pane.el.style.left = '';
      pane.el.style.top = '';
      pane.el.style.width = '';
      pane.el.style.height = '';
      pane.maxBtn.innerHTML = ICONS.max;
      pane.maxBtn.setAttribute('aria-label', 'Maximize pane');
      pane.maxBtn.title = 'Maximize';
    } catch (e) { /* fine */ }
    if (state.maxSlot === slot) state.maxSlot = null;
    if (state.maxSlot === null) document.body.classList.remove('wab-maximized');
  }

  function minimizePane(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.person || pane.minimized) return;
    if (pane.maximized) toggleMaximize(slot); // a chip row never fills the area
    pane.minimized = true;
    pane.el.classList.add('is-min');
    pane.el.style.height = '';
    pane.minBtn.innerHTML = ICONS.restoreMin;
    pane.minBtn.setAttribute('aria-label', 'Restore pane');
    pane.minBtn.title = 'Restore pane';
    updateMinUnread(slot);
    persistPrefs(slot);
  }

  function restoreFromMin(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.minimized) return;
    pane.minimized = false;
    pane.el.classList.remove('is-min');
    pane.minBtn.innerHTML = ICONS.min;
    pane.minBtn.setAttribute('aria-label', 'Minimize pane');
    pane.minBtn.title = 'Minimize';
    syncPanes();
    persistPrefs(slot);
  }

  function toggleMinimize(slot) {
    slot = parseInt(slot, 10);
    if (isNaN(slot)) return;
    var pane = state.panes[slot];
    if (!pane || !pane.person) return;
    if (pane.minimized) restoreFromMin(slot);
    else minimizePane(slot);
  }

  function updateMinUnread(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.unreadEl) return;
    var n = 0;
    if (pane.person) {
      var hit = cacheLookup(pane.person.accountId, pane.person.title);
      if (hit) n = parseInt(hit.unread, 10) || 0;
    }
    pane.unreadEl.textContent = n > 0 ? String(n) : '';
    pane.unreadEl.hidden = !(n > 0);
    pane.unreadEl.setAttribute('aria-label', n > 0 ? n + ' unread' : '');
  }

  function updateAllMinUnread() {
    for (var slot in state.panes) {
      if (Object.prototype.hasOwnProperty.call(state.panes, slot)) updateMinUnread(parseInt(slot, 10));
    }
  }

  /* ---------- active pane ---------- */

  function setActiveSlot(slot, opts) {
    slot = parseInt(slot, 10);
    if (isNaN(slot)) return;
    opts = opts || {};
    var changed = state.activeSlot !== slot;
    state.activeSlot = slot;
    if (changed) syncComposeBar();
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var pane = state.panes[k];
      if (pane && pane.el) pane.el.classList.toggle('is-active', parseInt(k, 10) === slot);
    }
    if (changed || opts.tell !== false) {
      var told = false;
      try {
        if (window.WABPeople && typeof window.WABPeople.setActivePane === 'function') {
          window.WABPeople.setActivePane(slot);
          told = true;
        }
      } catch (e) { /* degrade quietly */ }
      if (!told && wabOk() && window.wab.app && typeof window.wab.app.setActivePane === 'function') {
        callQuiet(function () { return window.wab.app.setActivePane(slot); });
      }
    }
    var active = state.panes[slot];
    // V12.6 Z2: the eager silent refresh runs ONLY for a pane that is
    // already mounted. On a screen switch the incoming screen is not
    // mounted yet (syncPanes mounts it right after); this early fetch used
    // to hold pane.fetching so the mount's TRACKED fetch bounced at the
    // fetching guard and the mount showed no shimmer at all.
    if (active && active.el && active.el.parentNode === state.root &&
        active.person && active.st === 'live' && !active.fetching) {
      loadMessages(slot, {});
    }
    syncRailHighlight();
  }

  // people.js tracks the active slot in its chip layer; follow it when the
  // operator cycles panes with Ctrl and the arrow keys. Only followed when
  // that record is actually mounted, so a hidden chip layer can never route
  // the central bar to an unmounted screen.
  function readActiveChip() {
    var host = $('wab-pane-chips');
    if (!host) return;
    var chips = host.querySelectorAll('.pane-chip');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      if (!c.classList || !c.classList.contains('is-active')) continue;
      var m = /Pane (\d+)/.exec(c.getAttribute('aria-label') || '');
      if (m) {
        var slot = parseInt(m[1], 10) - 1;
        if (!isNaN(slot) && slot !== state.activeSlot && slotVisibleNow(slot)) setActiveSlot(slot, { tell: false });
        return;
      }
    }
  }

  /* ---------- V12.4 X2: spine truth sync ---------- */

  // What the spine is told (or told us) about a pane record's person. A
  // close push is honored only when this is set: it proves the spine knew
  // the person it reports closed, instead of pushing empty bookkeeping.
  function paneSig(person) {
    return (person && person.accountId)
      ? String(person.accountId) + '|' + norm(person.title || '')
      : null;
  }

  // Reports the pane record's person to the spine (app:setPanePerson). The
  // spine keeps its own paneState per slot and pushes panes:onState for it
  // on every active-pane change; until V12.4 this module never reported, so
  // the spine believed every pane empty and its pushes destroyed live
  // conversations on every swipe (the persistence bug). Fire and forget,
  // guarded: on an old preload the local spineSig still tracks our truth.
  function reportSpine(slot) {
    var pane = state.panes[slot];
    if (!pane) return;
    var p = pane.person;
    pane.spineSig = paneSig(p);
    try {
      if (wabOk() && window.wab.app && typeof window.wab.app.setPanePerson === 'function') {
        callQuiet(function () {
          return window.wab.app.setPanePerson(
            slot,
            (p && p.chatId) ? p.accountId : null,
            (p && p.chatId) ? p.chatId : null,
            p ? String(p.title || '') : ''
          );
        });
      }
    } catch (e) { /* spine reporting is best effort */ }
  }

  // A spine-originated open for a screen that is not mounted right now
  // (legacy chats.open path with a stale active pane): record the person
  // into that screen's record with no DOM, no mount, no stealing. The
  // conversation is simply THERE when the operator next swipes to it, and
  // the mounted ACTIVE screen never changed. Grid modes never land here:
  // every visible slot is mounted there and opens visibly.
  function recordHiddenScreenPerson(slot, person, sig) {
    var pane = state.panes[slot];
    if (!pane) {
      pane = buildPaneDom(slot); // detached record only; syncPanes mounts it later
      state.panes[slot] = pane;
    }
    pane.spineSig = sig || null;
    pane.person = person;
    pane.msgs = [];
    pane.seenIds = null;
    pane.seeded = false;
    pane.savedScroll = null;
    pane.draft = '';
    pane.hasNew = false;
    pane.full = false;
    pane.fullAcc = null;
    pane.home = null;
    pane.pendingSpec = null; // V12.6 Z2
    resetHistState(pane);    // V13 J2: the record starts a new conversation
    try { pane.el.style.display = ''; } catch (e) { /* fine */ }
    notifyScreensChanged(); // that screen's dot fills with the account color
  }

  /* ---------- layout sync ---------- */

  function scheduleSync() {
    if (state.syncRaf !== null) return;
    state.syncRaf = window.requestAnimationFrame(function () {
      state.syncRaf = null;
      syncPanes();
    });
  }

  /* ---------- V12.7 W2: layout auto-distribution + pane stacks ---------- */

  // the owner's law (2026-11-21): switching layout re-deals the open
  // conversations across the visible slots. The ACCOUNT is the unit: every
  // account with something open gets one visible slot (accounts ordered by
  // their first open conversation, slots filled left-to-right), and the
  // account's extra conversations become that slot's STACK: their own pane
  // records, mounted one at a time, switched by the stack dots and a
  // pane-scoped swipe. Slots with no account stay empty. Single and tabs
  // never deal: the virtual screens keep their records exactly as they are.

  // A record's account key for grouping. Conversations group by account;
  // an account home and a full-WhatsApp screen form their own groups (they
  // are not conversations, so they never displace one).
  function accountKeyOf(pane) {
    if (!pane) return null;
    if (pane.person) return 'acct:' + (pane.person.accountId || 'none');
    if (pane.home) return 'home:' + pane.home;
    if (pane.full) return 'full:' + (pane.fullAcc || 'none');
    return null;
  }

  function clearStackMarks() {
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var p = state.panes[k];
      if (p) p.stackIds = null;
    }
  }

  // The deal itself. Reads only occupancy (person, home, full); it never
  // moves a person between records, so scroll, drafts, zoom and the spine's
  // per-record truth all survive untouched.
  function autoDistribute() {
    clearStackMarks();
    if (isScreenLayout()) { state.slotMap = null; return; } // screens: identity
    var rects = getRects();
    var slots = [];
    for (var i = 0; i < rects.length; i++) {
      var rs = parseInt(rects[i].slot, 10);
      if (!isNaN(rs)) slots.push(rs);
    }
    slots.sort(function (a, b) { return a - b; });
    if (!slots.length) { state.slotMap = null; return; }

    // Occupied records in screen (record) order, grouped by account key.
    var order = [];
    var groups = {};
    for (var r = 0; r < SCREENS; r++) {
      var key = accountKeyOf(state.panes[r]);
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(groups, key)) {
        groups[key] = [];
        order.push(key);
      }
      groups[key].push(r);
    }

    // One slot per account, left-to-right; the account's records become
    // that slot's stack (the first is mounted, the rest wait one swipe away).
    // GRIDS SPREAD instead (the owner's ruling, 2026-11-21): conversations are
    // dealt ONE PER SLOT first, round-robin across accounts (accounts in
    // first-conversation order); a stack forms only for overflow beyond the
    // visible slots, piling on that account's last dealt slot. grid4 with
    // 3 owner chats + 1 partner = three separate owner panes + one partner pane.
    var used = {};
    var assigned = 0;
    var map = {};
    if (currentLayout().indexOf('grid') === 0) {
      // Round-robin deal: one conversation per account per pass, one slot
      // each, until the slots or the conversations run out.
      var cursors = {};
      var remaining = true;
      while (assigned < slots.length && remaining) {
        remaining = false;
        for (var c = 0; c < order.length && assigned < slots.length; c++) {
          var cids = groups[order[c]];
          var ci = cursors[order[c]] || 0;
          if (ci >= cids.length) continue;
          map[slots[assigned]] = cids[ci];
          used[cids[ci]] = true;
          cursors[order[c]] = ci + 1;
          assigned++;
          remaining = true;
        }
      }
      // Overflow: each account's undealt records pile on that account's
      // LAST dealt record. An account the grid had no slot left for piles
      // on the last slot's record (degenerate desk; every dot still colors
      // by its own record's account).
      var lastRec = (assigned > 0) ? map[slots[assigned - 1]] : -1;
      var extra = {}; // anchor record id -> overflow records stacked behind it
      for (var og = 0; og < order.length; og++) {
        var oids = groups[order[og]];
        var lastDealt = -1;
        var rest = [];
        for (var oi = 0; oi < oids.length; oi++) {
          if (used[oids[oi]]) lastDealt = oids[oi];
          else rest.push(oids[oi]);
        }
        if (!rest.length) continue;
        var anchorRec = (lastDealt !== -1) ? lastDealt : lastRec;
        if (anchorRec === -1) continue;
        if (!extra[anchorRec]) extra[anchorRec] = [];
        extra[anchorRec] = extra[anchorRec].concat(rest);
        for (var om = 0; om < rest.length; om++) used[rest[om]] = true;
      }
      for (var ar in extra) {
        if (!Object.prototype.hasOwnProperty.call(extra, ar)) continue;
        var members = [parseInt(ar, 10)].concat(extra[ar]);
        for (var am = 0; am < members.length; am++) {
          var apr = state.panes[members[am]];
          if (apr) apr.stackIds = members; // shared array on every member
        }
      }
    } else {
      for (var g = 0; g < order.length && assigned < slots.length; g++, assigned++) {
        var ids = groups[order[g]];
        map[slots[assigned]] = ids[0];
        for (var m = 0; m < ids.length; m++) {
          var pr = state.panes[ids[m]];
          if (pr) pr.stackIds = ids; // shared array on every member
          used[ids[m]] = true;
        }
      }
    }
    // Leftover slots mount an EMPTY record, never a duplicate of a live one.
    for (var u = assigned; u < slots.length; u++) {
      var pick = -1;
      for (var e = 0; e < SCREENS && pick === -1; e++) {
        if (!used[e] && !screenOccupied(state.panes[e])) pick = e;
      }
      for (var f = 0; f < SCREENS && pick === -1; f++) {
        if (!used[f]) pick = f; // degenerate desk: any unclaimed record
      }
      if (pick === -1) pick = slots[u]; // last resort: the slot's own record
      map[slots[u]] = pick;
      used[pick] = true;
    }
    state.slotMap = map;
  }

  // Runs at the top of every syncPanes: a layout FLIP (and only a flip)
  // triggers the re-deal, before any pane mounts.
  function trackLayoutChange() {
    var lay = currentLayout();
    if (lay === state.lastLayout) return;
    state.lastLayout = lay;
    autoDistribute();
  }

  // Takes a record out of its stack. With remountNext, a mounted record
  // hands its rect to the next member first (the close path); without it
  // the record keeps its rect and the rest of the stack detaches (the
  // open path: the new conversation owns the slot now).
  function leaveStack(slot, remountNext) {
    var pane = state.panes[slot];
    if (!pane || !pane.stackIds) return;
    var ids = pane.stackIds;
    var keep = [];
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] !== slot) keep.push(ids[i]);
    }
    pane.stackIds = null;
    if (pane.stackEl) pane.stackEl.hidden = true;
    for (var j = 0; j < keep.length; j++) {
      var other = state.panes[keep[j]];
      if (other) other.stackIds = (keep.length > 1) ? keep : null;
    }
    if (remountNext && keep.length && state.slotMap) {
      for (var s in state.slotMap) {
        if (Object.prototype.hasOwnProperty.call(state.slotMap, s) &&
            state.slotMap[s] === slot) {
          state.slotMap[s] = keep[0];
          scheduleSync();
          break;
        }
      }
    }
  }

  // Pane-scoped swipe (split and grid): the screen-swipe math pointed at
  // the pane under the cursor. Panes without a stack ignore the gesture.
  function stackSwipeWheel(ev) {
    var host = null;
    try { host = document.elementFromPoint(ev.clientX, ev.clientY); } catch (e) { /* fine */ }
    var pr = host && host.closest ? host.closest('.rpane') : null;
    var recId = pr ? parseInt(pr.getAttribute('data-slot'), 10) : NaN;
    var pane = state.panes[recId];
    if (!pane || !pane.stackIds || pane.stackIds.length < 2 ||
        !pane.el || pane.el.parentNode !== state.root) {
      resetSwipe();
      return;
    }
    var sw = state.swipe;
    var k = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 100 : 1);
    sw.accX += (ev.deltaX || 0) * k;
    sw.accY += (ev.deltaY || 0) * k;
    if (sw.timer) window.clearTimeout(sw.timer);
    sw.timer = window.setTimeout(function () {
      state.swipe.accX = 0;
      state.swipe.accY = 0;
      state.swipe.timer = null;
    }, SWIPE_MOMENTUM_MS);
    var now = Date.now();
    if (now - sw.firedAt < SWIPE_DEBOUNCE_MS) return;
    var ax = Math.abs(sw.accX);
    var ay = Math.abs(sw.accY);
    if (ax <= SWIPE_MIN_PX) return;
    if (ax <= ay * SWIPE_DOMINANCE) return;
    var dir = sw.accX > 0 ? 1 : -1;
    sw.firedAt = now;
    sw.accX = 0;
    sw.accY = 0;
    if (sw.timer) { window.clearTimeout(sw.timer); sw.timer = null; }
    ev.preventDefault(); // same law as the screen swipe: only the firing event
    advanceStack(recId, dir);
  }

  // Mount the next (dir = 1) or previous stack member in the rect that
  // currently mounts recId.
  function advanceStack(recId, dir) {
    var rects = getRects();
    var rectSlot = -1;
    for (var i = 0; i < rects.length; i++) {
      var s = parseInt(rects[i].slot, 10);
      if (!isNaN(s) && paneIdForRect(s) === recId) { rectSlot = s; break; }
    }
    if (rectSlot === -1) return;
    var ids = state.panes[recId] && state.panes[recId].stackIds;
    if (!ids) return;
    var at = ids.indexOf(recId);
    if (at === -1) return;
    advanceStackTo(rectSlot, ids[(at + dir + ids.length) % ids.length]);
  }

  // Mount record rid in rectSlot. Mirrors switchScreen: scroll and the
  // compose draft ride the records, so the switch loses nothing.
  function advanceStackTo(rectSlot, rid) {
    var cur = paneIdForRect(rectSlot);
    var out = state.panes[cur];
    if (out) {
      savePaneScroll(out);
      if (state.gta && cur === state.activeSlot && out.person) {
        out.draft = state.gta.value || '';
        persistPaneDraft(out); // V13 D1: stack switches file the draft too
      }
    }
    if (!state.slotMap) state.slotMap = {};
    state.slotMap[rectSlot] = rid;
    if (state.activeSlot !== rid) setActiveSlot(rid, {});
    syncPanes();
    if (state.activeSlot === rid && state.gta) {
      var inc = state.panes[rid];
      state.gta.value = (inc && inc.person) ? (inc.draft || '') : '';
    }
  }

  // The stack dot row rides the pane record (it travels with the record
  // into whatever rect mounts it). One row per stacked pane, 2+ members.
  function ensureStackDots(pane) {
    if (pane.stackEl || !pane.el) return;
    var row = h('div', 'rstackdots');
    row.setAttribute('role', 'tablist');
    row.setAttribute('aria-label', 'Stacked conversations');
    row.hidden = true;
    pane.el.appendChild(row);
    pane.stackEl = row;
  }

  function makeStackDotClick(rectSlot, rid) {
    return function () {
      if (paneIdForRect(rectSlot) === rid) return;
      advanceStackTo(rectSlot, rid);
    };
  }

  // Repaints every mounted stack row: one dot per stacked record, filled
  // with that record's account color, the mounted one ringed, a hidden
  // member with new replies blinking. Runs on every pane sync.
  function renderStackDots() {
    if (isScreenLayout() || !state.root) return;
    var rects = getRects();
    for (var i = 0; i < rects.length; i++) {
      var rectSlot = parseInt(rects[i].slot, 10);
      if (isNaN(rectSlot)) continue;
      var id = paneIdForRect(rectSlot);
      var pane = state.panes[id];
      if (!pane) continue;
      var ids = pane.stackIds;
      if (!ids || ids.length < 2) {
        if (pane.stackEl) pane.stackEl.hidden = true;
        continue;
      }
      ensureStackDots(pane);
      if (!pane.stackEl) continue;
      pane.stackEl.hidden = false;
      pane.stackEl.textContent = '';
      for (var d = 0; d < ids.length; d++) {
        var rid = ids[d];
        var rec = state.panes[rid];
        var busy = screenOccupied(rec);
        var color = busy ? (screenDotColor(rec) || 'rgba(255, 255, 255, 0.88)') : '';
        var on = (rid === id);
        var hasNew = !!(rec && rec.hasNew);
        var dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'rstackdot' + (busy ? ' busy' : '') + (on ? ' on' : '') + (hasNew ? ' has-new' : '');
        dot.setAttribute('role', 'tab');
        dot.setAttribute('aria-selected', on ? 'true' : 'false');
        dot.setAttribute('aria-label', 'Conversation ' + (d + 1));
        dot.title = 'Conversation ' + (d + 1);
        if (busy && color) {
          dot.style.setProperty('--rsd-color', color);
          dot.style.setProperty('--rsd-rgb', acctRGBTriplet(color));
        }
        dot.addEventListener('click', makeStackDotClick(rectSlot, rid));
        pane.stackEl.appendChild(dot);
      }
    }
  }

  // Mounts and positions pane records against the visible rects. In
  // single/tabs the one rect mounts the active screen's record; in grid and
  // split layouts slots map straight to records. Records that no rect mounts
  // are detached with their scroll saved, never discarded.
  function syncPanes() {
    if (!state.root) return;
    trackLayoutChange(); // V12.7 W2: a layout flip re-deals the open conversations
    var rects = getRects();
    var rootR = state.root.getBoundingClientRect();
    var mounted = {};

    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var rectSlot = parseInt(r.slot, 10);
      if (isNaN(rectSlot) || r.w < 8 || r.h < 8) continue;
      var id = paneIdForRect(rectSlot);
      if (isNaN(id)) continue;
      mounted[id] = true;
      var pane = ensurePane(id);
      if (!pane || pane.maximized) continue;
      pane.el.style.left = (r.x - Math.round(rootR.left)) + 'px';
      pane.el.style.top = (r.y - Math.round(rootR.top)) + 'px';
      pane.el.style.width = r.w + 'px';
      if (!pane.minimized) pane.el.style.height = r.h + 'px';
    }

    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      if (!mounted[parseInt(k, 10)]) dropPaneDom(parseInt(k, 10));
    }

    if (!mounted[state.activeSlot]) {
      var first = -1;
      for (var kk in mounted) { first = parseInt(kk, 10); break; }
      if (first !== -1) setActiveSlot(first, {});
    }
    notifyScreensChanged();
    renderScreenDots(); // follows layout and resize even when the signature held
    renderStackDots(); // V12.7 W2: stack dot rows ride their mounted records
    positionComposeBar(); // V12.4 X2: the bar centers on this conversation area
  }

  /* ---------- pane state pushes (spine) ---------- */

  // V12.4 X2 law: the RENDERER is the truth about what a pane shows. The
  // spine's panes:onState pushes are echoes of what it was told (see
  // reportSpine) or legacy chats.open opens. A push can therefore NEVER
  // clear a person the spine was not told about. Before this guard, every
  // screen swipe reported app:setActivePane, the spine answered with
  // open:false for every pane in its never-informed paneState map, and
  // clearPerson wiped the conversation off the screen the owner had just left.
  // That was the whole swipe persistence loss.
  function onPaneState(p) {
    if (!p) return;
    var slot = parseInt(p.slot, 10);
    if (isNaN(slot)) return;
    var pane = state.panes[slot];

    // Close push: honored only when the spine actually knew this record's
    // person (we reported the open, or the open came through the spine).
    // Stale bookkeeping pushes for panes it was never told about are noise.
    if (p.open === false || (!p.accountId && !p.title)) {
      if (pane && pane.spineSig && pane.person) {
        pane.spineSig = null;
        clearPerson(slot); // clearPerson reports the close back to the spine
      }
      return;
    }
    if (!p.accountId || !p.title) return;

    var sig = String(p.accountId) + '|' + norm(p.title || '');
    var same = pane && pane.person &&
      pane.person.accountId === p.accountId &&
      norm(pane.person.title) === norm(p.title || '');

    // Echo of what we reported (or a refresh of the same person): identity
    // cosmetics only. Never a reopen, never a reset, never a mount.
    if (same) {
      if (!pane.spineSig) pane.spineSig = sig;
      if (p.accountName) pane.person.accountName = p.accountName;
      if (p.accountColor) pane.person.accountColor = p.accountColor;
      updateIdentity(slot);
      return;
    }

    // Spine-originated open (the legacy chats.open path): the same invariant
    // as every other open applies. Only the MOUNTED screen may show a
    // visible open; a hidden screen records the person quietly (see
    // recordHiddenScreenPerson). Grid slots are all mounted, so they keep
    // the direct open this path always had.
    var person = resolveForOpen({
      accountId: p.accountId,
      chatId: null,
      title: p.title,
      accountName: p.accountName,
      accountColor: p.accountColor
    });
    if (slotVisibleNow(slot)) {
      var target = state.panes[slot];
      if (target) target.spineSig = sig;
      openConversationIn(slot, person, {});
      return;
    }
    if (isScreenLayout()) recordHiddenScreenPerson(slot, person, sig);
  }

  /* ---------- v2.1: pane account picker + account home + full WhatsApp (owner spec 2026-11-21) ---------- */

  function linkedAccountsCached() { return state.accounts || []; }

  function loadAccounts() {
    try {
      if (wabOk() && window.wab.accounts && typeof window.wab.accounts.list === 'function') {
        window.wab.accounts.list().then(function (list) {
          if (Array.isArray(list)) {
            state.accounts = list;
            refreshAccountPickers();
            renderHomeLists();
            notifyScreensChanged(); // home/full dot colors may have changed
            syncPlatformStrip(); // V14 U4: the connected strip follows the live account list
          }
        }).catch(function () { /* degrade quietly */ });
      }
    } catch (e) { /* degrade quietly */ }
  }

  function accountByIdLocal(id) {
    var l = state.accounts || [];
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }

  // V14 U4: the connected platform strip, bottom-left of the desk. One
  // button per CONNECTED platform (linked accounts only), appended to #rail
  // as its last child so it sits under the sender cards. loadAccounts runs
  // on boot and on every accounts list change push, so a freshly linked
  // Telegram account joins the blue plane to the strip live and an
  // unlinked one leaves it. Clicking a button filters the people rail to
  // that platform (togglePlatformFilter below). Zero linked accounts hide
  // the strip wholesale: nothing connected, nothing shown.
  function syncPlatformStrip() {
    var rail = $('rail');
    if (!rail) return;
    var strip = $('wab-plat-strip');
    if (!strip) {
      strip = h('div', 'wab-plat-strip');
      strip.id = 'wab-plat-strip';
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', 'Connected platforms');
      rail.appendChild(strip); // seam: U2 owns the cards above, never this node
    }
    var linked = linkedAccountsCached().filter(function (a) { return a && a.status === 'linked'; });
    var present = { whatsapp: false, telegram: false };
    for (var i = 0; i < linked.length; i++) present[platformOf(linked[i].platform)] = true;
    var wanted = [];
    if (present.whatsapp) wanted.push('whatsapp');
    if (present.telegram) wanted.push('telegram');
    strip.hidden = wanted.length === 0;
    // A filter whose platform just disconnected has no button left to clear
    // it with: drop the class here so the rail can never stay filtered
    // invisibly.
    try {
      var filtered = '';
      if (document.body.classList.contains('wab-plat-filter-whatsapp')) filtered = 'whatsapp';
      else if (document.body.classList.contains('wab-plat-filter-telegram')) filtered = 'telegram';
      if (filtered && wanted.indexOf(filtered) === -1) {
        document.body.classList.remove('wab-plat-filter-whatsapp', 'wab-plat-filter-telegram');
      }
    } catch (e) { /* body drift */ }
    var sig = wanted.join(',');
    if (strip.getAttribute('data-sig') === sig) { syncStripPressed(); return; }
    strip.setAttribute('data-sig', sig);
    strip.textContent = '';
    wanted.forEach(function (pf) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wab-plat-strip-btn is-' + pf;
      btn.setAttribute('data-platform', pf);
      btn.setAttribute('aria-pressed', 'false');
      var logo = h('span', 'wab-plat-logo wab-plat-logo-' + pf);
      logo.setAttribute('aria-hidden', 'true');
      btn.appendChild(logo);
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        togglePlatformFilter(pf);
      });
      strip.appendChild(btn);
    });
    syncStripPressed();
  }

  // V14 U4: the quick platform toggle. One body class at most; clicking the
  // strip logo of the filtered platform clears the filter, clicking the
  // other one switches. The rail rows themselves are untouched: people.js
  // rows and the renderer takeover rows both carry data-platform (T5), the
  // render.css filter rules do the hiding, so every rail re-render keeps
  // the state and no hook in people.js is needed.
  function togglePlatformFilter(platform) {
    var pf = platformOf(platform);
    var cls = 'wab-plat-filter-' + pf;
    var on = false;
    try {
      on = document.body.classList.contains(cls);
      document.body.classList.remove('wab-plat-filter-whatsapp', 'wab-plat-filter-telegram');
      if (!on) document.body.classList.add(cls);
    } catch (e) { /* degrade quietly */ }
    syncStripPressed();
  }

  // V14 U4: mirror the active filter onto the strip buttons (aria-pressed
  // plus the label swap, so hover always states what the next click does).
  function syncStripPressed() {
    var strip = $('wab-plat-strip');
    if (!strip) return;
    var active = '';
    try {
      if (document.body.classList.contains('wab-plat-filter-whatsapp')) active = 'whatsapp';
      else if (document.body.classList.contains('wab-plat-filter-telegram')) active = 'telegram';
    } catch (e) { /* body drift */ }
    var btns = strip.querySelectorAll('.wab-plat-strip-btn');
    for (var i = 0; i < btns.length; i++) {
      var pf = btns[i].getAttribute('data-platform');
      var on = pf === active;
      var label = on ? 'Show every platform' : (pf === 'telegram' ? 'Show only Telegram' : 'Show only WhatsApp');
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      btns[i].setAttribute('aria-label', label);
      btns[i].title = label;
    }
  }

  // Empty panes re-render so the picker always shows the current linked accounts.
  function refreshAccountPickers() {
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var pane = state.panes[k];
      if (pane && pane.st === 'empty' && !pane.person && !pane.full) {
        setState(parseInt(k, 10), 'empty');
      }
    }
  }

  // V14 T5: the picker's connect buttons call the add-account flow with
  // the platform param. The shell owns the add modal, so the call rides
  // the wab:add-account window event (seam in this stage's CONTEXT.md:
  // shell listens, opens its modal with the platform preselected and
  // passes it through to accounts.add, which T3 already widened). When no
  // listener has claimed the event by the next tick, Settings opens
  // instead: Add account already lives there, so the click never
  // dead-ends. dispatchEvent is synchronous, so handled is trustworthy
  // inside the timeout.
  function connectPlatform(platform) {
    var detail = { platform: platform, handled: false };
    try {
      window.dispatchEvent(new CustomEvent('wab:add-account', { detail: detail }));
    } catch (eD) { detail.handled = false; }
    window.setTimeout(function () {
      if (detail.handled) return;
      try { window.dispatchEvent(new CustomEvent('wab:open-settings')); } catch (eS) { /* degrade quietly */ }
    }, 0);
  }

  function buildPickerDom(slot) {
    var box = h('div', 'rp-picker');
    box.appendChild(h('div', 'rp-picker-title', 'Pick the sender for this pane'));
    var linked = linkedAccountsCached().filter(function (a) { return a.status === 'linked'; });
    if (!linked.length) {
      box.appendChild(h('div', 'rpane-note', 'No linked accounts yet. Connect one below, or add it in Settings.'));
    } else {
      linked.forEach(function (acc) {
        var chip = h('button', 'rp-acc-chip');
        chip.type = 'button';
        // E3: the sender's own photo when set, else the initials ring.
        var av = h('span', 'dock-avatar', acc.avatar ? '' : initialsOf(acc.name));
        if (acc.avatar) {
          av.classList.add('has-img');
          try { av.style.backgroundImage = 'url("' + acc.avatar + '")'; } catch (eAv) { /* cosmetic */ }
        } else {
          av.style.borderColor = acc.color || '#426CA8';
        }
        chip.appendChild(av);
        chip.appendChild(platformLogoEl(acc.platform)); // V14 U4: the 24px logo replaces the T5 dot
        chip.appendChild(h('span', 'rp-acc-name', acc.name || 'Account'));
        chip.addEventListener('click', function () {
          try {
            window.dispatchEvent(new CustomEvent('wab:assign-pane', { detail: { slot: slot, accountId: acc.id } }));
          } catch (e) { /* shell listens if present */ }
          showAccountHome(slot, acc.id);
        });
        box.appendChild(chip);
      });
      box.appendChild(h('div', 'rp-picker-sub', 'Or pick a person from the left'));
    }
    // V14 T5: platform-first doors. Two separate buttons, one per
    // platform, so an empty desk reads multi-platform before any chat
    // opens. Styling: the picker chip look from render.css plus the
    // rp-connect-row layout from people.css.
    var connRow = h('div', 'rp-connect-row');
    [['whatsapp', 'Connect WhatsApp'], ['telegram', 'Connect Telegram']].forEach(function (def) {
      var btn = h('button', 'rp-acc-chip rp-connect-btn');
      btn.type = 'button';
      btn.setAttribute('data-platform', def[0]);
      btn.appendChild(platformDotEl(def[0]));
      btn.appendChild(h('span', 'rp-acc-name', def[1]));
      btn.title = def[1];
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        connectPlatform(def[0]);
      });
      connRow.appendChild(btn);
    });
    box.appendChild(connRow);
    return box;
  }

  function showAccountHome(slot, accountId) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    leaveStack(slot, false); // V12.7 W2: home takes the slot out of any stack
    if (pane.person && pane.person.chatId && state.gta && slot === state.activeSlot) {
      pane.draft = state.gta.value || ''; // V13 D1: routing home files the bar text first
    }
    persistPaneDraft(pane); // V13 D1: before the person goes, the key needs it
    pane.full = false;
    pane.fullAcc = null;
    pane.home = accountId;
    pane.person = null;
    pane.msgs = [];
    pane.seenIds = null;
    pane.seeded = false;
    pane.draft = '';
    pane.hasNew = false;
    pane.pendingSpec = null; // V12.6 Z2
    setPaneTyping(slot, false); // V12.5 Y2: no person, no dots
    resetProgress(slot);        // V12.5 Y2: home screens carry no rail state (cancels the self-check)
    resetHistState(pane);       // V13 J2: the home screen holds no conversation history
    if (state.gta && slot === state.activeSlot) state.gta.value = '';
    pane.el.style.display = '';
    var acc = accountByIdLocal(accountId);
    var color = (acc && acc.color) || 'rgba(255,255,255,0.42)';
    pane.dotEl.style.background = color;
    pane.titleEl.textContent = (acc && acc.name) || 'Account';
    pane.acctEl.textContent = 'chats';
    pane.el.classList.toggle('is-empty', false);
    pane.el.style.setProperty('--wabr-acct', color);
    pane.el.style.setProperty('--wabr-acct-soft', acctSoft(color));
    pane.el.style.setProperty('--wabr-glow-rgb', acctRGBTriplet(color));
    pane.el.setAttribute('aria-label', 'Chats of ' + ((acc && acc.name) || 'account'));
    syncPlatformChrome(pane); // V14 T5: home screens badge by account platform
    // E3: the sender's own photo takes the header seat on their account
    // home. No photo set: no face, exactly as before.
    try {
      if (pane.avatarEl) {
        pane.avatarEl.textContent = '';
        pane.avatarEl.style.backgroundImage = '';
        pane.avatarEl.style.borderColor = '';
        pane.avatarEl.classList.remove('has-img');
        if (acc && acc.avatar) {
          pane.avatarEl.classList.add('has-img');
          pane.avatarEl.style.backgroundImage = 'url("' + acc.avatar + '")';
        }
      }
    } catch (eAv) { /* header shape drift */ }

    pane.st = 'home';
    pane.stateEl.hidden = false;
    pane.stateEl.textContent = '';
    var wrap = h('div', 'rp-home');
    wrap.appendChild(h('div', 'rp-home-title', 'Chats'));
    pane.homeListEl = h('div', 'rp-home-list');
    wrap.appendChild(pane.homeListEl);
    pane.stateEl.appendChild(wrap);
    pane.msgsEl.textContent = '';
    renderHomeList(slot);
    notifyScreensChanged();
    reportSpine(slot); // V12.4 X2: the pane stopped showing a conversation
  }

  function renderHomeList(slot) {
    var pane = state.panes[slot];
    if (!pane || !pane.homeListEl) return;
    var accId = pane.home;
    var rows = (state.people || []).filter(function (p) { return p && p.accountId === accId; });
    var box = pane.homeListEl;
    box.textContent = '';
    if (!rows.length) {
      box.appendChild(h('div', 'rpane-note', 'No visible chats for this account yet.'));
      return;
    }
    rows.forEach(function (p) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'rp-home-row';
      row.appendChild(avatarEl(p.title, p.accountColor));
      var mid = h('span', 'rp-home-mid');
      mid.appendChild(h('span', 'rp-home-name', p.title || 'Unknown'));
      row.appendChild(mid);
      var u = parseInt(p.unread, 10) || 0;
      if (u > 0) row.appendChild(h('span', 'pal-unread', String(u)));
      row.title = (p.title || '') + (p.accountName ? ' · ' + p.accountName : '');
      row.addEventListener('click', function () {
        var person = resolveForOpen({
          accountId: accId,
          chatId: p.chatId || null,
          title: p.title,
          accountName: p.accountName,
          accountColor: p.accountColor
        });
        openConversationIn(slot, person, { focus: true });
      });
      box.appendChild(row);
    });
  }

  function renderHomeLists() {
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var pane = state.panes[k];
      if (pane && pane.st === 'home') renderHomeList(parseInt(k, 10));
    }
  }

  // Full WhatsApp: hide the conversation pane entirely so the raw webview shows.
  function openFullWhatsApp(slot, accountId) {
    var pane = state.panes[slot];
    if (!pane || !pane.el) return;
    leaveStack(slot, false); // V12.7 W2: the webview screen leaves the stack
    if (pane.person && pane.person.chatId && state.gta && slot === state.activeSlot) {
      pane.draft = state.gta.value || ''; // V13 D1: the webview screen files the bar text first
    }
    persistPaneDraft(pane); // V13 D1: before the person goes, the key needs it
    pane.full = true;
    pane.fullAcc = accountId || null; // dot color for this occupied screen
    pane.home = null;
    pane.person = null;
    pane.draft = '';
    pane.hasNew = false;
    pane.pendingSpec = null; // V12.6 Z2
    setPaneTyping(slot, false); // V12.5 Y2: the raw webview owns the screen now
    resetProgress(slot);        // V12.5 Y2: its rail would be invisible anyway (cancels the self-check)
    resetHistState(pane);       // V13 J2: the webview screen holds no conversation history
    setState(slot, 'empty');
    pane.el.style.display = 'none';
    notifyScreensChanged();
    reportSpine(slot); // V12.4 X2: the pane stopped showing a conversation
  }

  function wireShellEvents() {
    window.addEventListener('wab:open-full', function (ev) {
      var d = ev && ev.detail;
      if (!d) return;
      var slot = parseInt(d.slot, 10);
      if (isNaN(slot)) return;
      ensurePane(slot);
      openFullWhatsApp(slot, d.accountId);
    });
    window.addEventListener('wab:pane-home', function (ev) {
      var d = ev && ev.detail;
      if (!d || !d.accountId) return;
      var slot = parseInt(d.slot, 10);
      if (isNaN(slot)) return;
      ensurePane(slot);
      showAccountHome(slot, d.accountId);
    });
    try {
      if (wabOk() && window.wab.accounts && typeof window.wab.accounts.onListChanged === 'function') {
        window.wab.accounts.onListChanged(function () { loadAccounts(); });
      }
    } catch (e) { /* degrade quietly */ }
  }

  /* ---------- people rail upgrade ---------- */

  function avatarEl(name, color) {
    var a = h('span', 'wabr-avatar', initialsOf(name));
    a.style.setProperty('--wabr-ring', color || 'rgba(255,255,255,0.42)');
    return a;
  }

  // V14 T5: the 4px platform dot (people.css) shared by the takeover rail
  // rows, the takeover palette rows, the picker account chips and the
  // connect buttons. WhatsApp green is the base look; Telegram adds the
  // blue modifier class.
  function platformDotEl(platform) {
    var d = h('span', 'wabp-plat-dot' + (platformOf(platform) === 'telegram' ? ' is-telegram' : ''));
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  // V14 U4: the platform logo span (render.css wab-plat-logo system, the
  // U1 contract). Replaces T5's 4px dot on the picker account chips: 24px
  // at 1x zoom there, the logo IS the platform identifier. The connect
  // doors keep the dot: they are actions, not accounts.
  function platformLogoEl(platform) {
    var s = h('span', 'wab-plat-logo wab-plat-logo-' + platformOf(platform));
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  // Turns a people.js dot row into an initial-avatar row, in place.
  function decorateRow(row, dotCls, nameCls) {
    if (!row || row.querySelector('.wabr-avatar')) return;
    var dot = row.querySelector(dotCls);
    var nameEl = row.querySelector(nameCls);
    var title = (row.dataset && row.dataset.title) || (nameEl ? nameEl.textContent : '') || '';
    var color = dot ? dot.style.background : '';
    var acctName = '';
    var acctEl = row.querySelector('.pal-account');
    if (acctEl) acctName = acctEl.textContent || '';
    var hit = cacheLookup(row.dataset ? row.dataset.account : null, title, acctName);
    if ((!color || color === 'var(--wabp-dot-fallback)') && hit && hit.accountColor) color = hit.accountColor;
    var av = avatarEl(title, color || (hit && hit.accountColor));
    if (dot && dot.parentNode) dot.parentNode.replaceChild(av, dot);
    else row.insertBefore(av, row.firstChild);
    if (hit && hit.chatId && row.setAttribute) row.setAttribute('data-chat-id', hit.chatId);
  }

  function decorateRail() {
    var list = $('people-list');
    if (!list) return;
    var rows = list.querySelectorAll('.people-row');
    for (var i = 0; i < rows.length; i++) decorateRow(rows[i], '.people-dot', '.people-name');
  }

  function decoratePalette() {
    var box = $('palette-results');
    if (!box) return;
    var rows = box.querySelectorAll('.pal-row');
    for (var i = 0; i < rows.length; i++) decorateRow(rows[i], '.pal-dot', '.pal-name');
  }

  function buildRailRow(p) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'people-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('data-account', String(p && p.accountId || ''));
    row.setAttribute('data-title', String(p && p.title || ''));
    if (p && p.chatId) row.setAttribute('data-chat-id', String(p.chatId));
    row.setAttribute('data-platform', platformOf(p && p.platform)); // V14 T5
    row.appendChild(avatarEl(p && p.title, p && p.accountColor));
    row.appendChild(platformDotEl(p && p.platform)); // V14 T5: dot between face and name
    var name = h('span', 'people-name', (p && p.title) || 'Unknown');
    row.appendChild(name);
    var u = parseInt(p && p.unread, 10) || 0;
    if (u > 0) row.appendChild(h('span', 'people-unread', String(u)));
    row.title = ((p && p.title) || '') + ((p && p.accountName) ? ' · ' + p.accountName : '');
    return row;
  }

  function buildPalRow(p) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'pal-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.setAttribute('data-wabr-pal', '1');
    row.setAttribute('data-platform', platformOf(p && p.platform)); // V14 T5
    if (p && p.chatId) row.setAttribute('data-chat-id', String(p.chatId));
    row.appendChild(avatarEl(p && p.title, p && p.accountColor));
    row.appendChild(platformDotEl(p && p.platform)); // V14 T5: same dot as the rail
    row.appendChild(h('span', 'pal-name', (p && p.title) || 'Unknown'));
    if (p && p.accountName) row.appendChild(h('span', 'pal-account', p.accountName));
    var u = parseInt(p && p.unread, 10) || 0;
    if (u > 0) row.appendChild(h('span', 'pal-unread', String(u)));
    return row;
  }

  // Owns the rail only when people.js shows notes but no rows (its v2 data
  // path is gone) and the eng cache has people. Their filter is respected.
  function takeOverRail() {
    var list = $('people-list');
    if (!list) return;
    if (list.querySelector('.people-row')) { state.deadRefreshes = 0; return; }
    if (!state.people.length) return;
    var q = '';
    var filter = $('people-filter');
    if (filter) q = norm(filter.value);
    var shown = state.people;
    if (q) {
      shown = state.people.filter(function (p) {
        return norm(p && p.title).indexOf(q) !== -1;
      });
    }
    withSelfWrite(function () {
      list.textContent = '';
      if (!shown.length) {
        var note = h('div', 'people-note');
        note.appendChild(h('span', 'people-note-main', 'No one matches that filter'));
        list.appendChild(note);
        return;
      }
      for (var i = 0; i < shown.length; i++) list.appendChild(buildRailRow(shown[i]));
    });
  }

  // Same idea for the Ctrl+K palette: local results when its v2 search path
  // shows notes instead of rows.
  function takeOverPalette() {
    var box = $('palette-results');
    var palette = $('search-palette');
    if (!box || !palette || palette.hidden) return;
    if (box.querySelector('.pal-row')) return;
    if (!state.people.length) return;
    var input = $('palette-input');
    var q = input ? norm(input.value) : '';
    var shown = state.people;
    if (q) {
      shown = state.people.filter(function (p) {
        return norm(p && p.title).indexOf(q) !== -1;
      }).slice(0, 20);
    } else {
      shown = state.people.slice(0, 12);
    }
    withSelfWrite(function () {
      box.textContent = '';
      if (!shown.length) {
        var note = h('div', 'people-note');
        note.appendChild(h('span', 'people-note-main', q ? 'Nothing found' : 'No people yet'));
        note.appendChild(h('span', 'people-note-sub', q ? 'No person matches that search.' : 'Link an account to start.'));
        box.appendChild(note);
        return;
      }
      for (var i = 0; i < shown.length; i++) box.appendChild(buildPalRow(shown[i]));
    });
  }

  function syncRailHighlight() {
    var list = $('people-list');
    if (!list) return;
    var pane = state.panes[state.activeSlot];
    var wantA = (pane && pane.person && pane.person.accountId) || null;
    var wantT = (pane && pane.person && norm(pane.person.title)) || null;
    var rows = list.querySelectorAll('.people-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hit = !!(wantA && wantT &&
        row.getAttribute('data-account') === wantA &&
        norm(row.getAttribute('data-title')) === wantT);
      row.classList.toggle('is-open-person', hit);
      row.setAttribute('aria-selected', hit ? 'true' : 'false');
    }
  }

  function processRail() {
    decorateRail();
    takeOverRail();
    syncRailHighlight();
    renderHomeLists();
  }

  /* ---------- opening from the rail ---------- */

  function openFromRow(row) {
    if (!row) return;
    var accountId = row.getAttribute('data-account') || null;
    var title = row.getAttribute('data-title') || '';
    var chatId = row.getAttribute('data-chat-id') || null;
    var spec = { accountId: accountId, chatId: chatId, title: title,
      platform: row.getAttribute('data-platform') || null }; // V14 T5
    var slot = targetOpenSlot();
    if (slot === -1) {
      toastRaw('No conversation pane is visible. Pick a layout first.');
      return;
    }
    if (slot !== state.activeSlot) setActiveSlot(slot, {});
    openFromSpecLive(slot, spec);   // live-resolves on cache miss; never dead-ends
  }

  function openFromPalRow(row) {
    if (!row) return;
    var nameEl = row.querySelector('.pal-name');
    var acctEl = row.querySelector('.pal-account');
    var title = (nameEl ? nameEl.textContent : '') || '';
    var chatId = row.getAttribute('data-chat-id') || null;
    var spec = {
      chatId: chatId,
      title: title,
      accountName: acctEl ? acctEl.textContent : ''
    };
    try {
      if (window.WABPeople && typeof window.WABPeople.closePalette === 'function') {
        window.WABPeople.closePalette();
      }
    } catch (e) { /* degrade quietly */ }
    var slot = targetOpenSlot();
    if (slot === -1) {
      toastRaw('No conversation pane is visible. Pick a layout first.');
      return;
    }
    if (slot !== state.activeSlot) setActiveSlot(slot, {});
    openFromSpecLive(slot, spec);   // live-resolves on cache miss; never dead-ends
  }

  function wirePeopleRail() {
    var list = $('people-list');
    if (list) {
      // Capture phase beats people.js's own row listener, which still calls
      // the dead v2 open path. stopPropagation keeps that path dormant.
      list.addEventListener('click', function (ev) {
        var row = ev.target && ev.target.closest ? ev.target.closest('.people-row') : null;
        if (!row) return;
        ev.stopPropagation();
        openFromRow(row);
      }, true);

      try {
        new MutationObserver(function () {
          if (state.selfWrite) { state.selfWrite = false; return; }
          processRail();
        }).observe(list, { childList: true });
      } catch (e) { /* old engine: decorate on the poll cycle only */ }
    }

    var pal = $('palette-results');
    if (pal) {
      pal.addEventListener('click', function (ev) {
        var row = ev.target && ev.target.closest ? ev.target.closest('.pal-row') : null;
        if (!row) return;
        ev.stopPropagation();
        openFromPalRow(row);
      }, true);

      try {
        new MutationObserver(function () {
          if (state.selfWrite) { state.selfWrite = false; return; }
          decoratePalette();
          takeOverPalette();
        }).observe(pal, { childList: true });
      } catch (e) { /* old engine */ }
    }

    var palette = $('search-palette');
    if (palette) {
      palette.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        var input = $('palette-input');
        if (!input || ev.target !== input) return;
        var box = $('palette-results');
        if (!box) return;
        var row = box.querySelector('.pal-row.cursor') || box.querySelector('.pal-row');
        if (!row) return;
        ev.preventDefault();
        ev.stopPropagation();
        openFromPalRow(row);
      }, true);
    }

    var chips = $('wab-pane-chips');
    if (chips) {
      try {
        new MutationObserver(function () { readActiveChip(); }).observe(chips, { childList: true, subtree: true });
      } catch (e) { /* old engine */ }
    }
  }

  /* ---------- polling ---------- */

  function pollActivePane() {
    if (document.hidden || !engOk()) return;
    var pane = state.panes[state.activeSlot];
    if (!pane || !pane.person || !pane.person.chatId) return;
    if (pane.st !== 'live' || pane.fetching) return;
    loadMessages(state.activeSlot, {});
  }

  // Background panes poll slower than the active one, but they poll: a reply
  // landing in any pane of a grid4/grid6 desk flares where it arrives.
  // Unmounted screens do not poll here; pollUnmountedScreens covers those.
  function pollBackgroundPanes() {
    if (document.hidden || !engOk()) return;
    var now = Date.now();
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var slot = parseInt(k, 10);
      if (slot === state.activeSlot) continue;
      var pane = state.panes[k];
      if (!pane || !pane.person || !pane.person.chatId) continue;
      if (pane.st !== 'live' || pane.fetching) continue;
      if (!pane.el || pane.el.parentNode !== state.root) continue;
      if (now - (pane.lastBgPoll || 0) < POLL_BG_MS) continue;
      pane.lastBgPoll = now;
      loadMessages(slot, {});
    }
  }

  // V12.3 W1: UNMOUNTED occupied screens poll lightly (5s) so a reply that
  // lands on a hidden screen blinks its top dot. No DOM is touched: the
  // fetched page only refreshes the screen's cache, seeds reply detection,
  // and flips has-new on the first unseen incoming id. The spine debug
  // event is the same 'pane-reply' kind the mounted flare uses: accountId
  // only, never names, never message text. Mounting the screen clears
  // has-new and the normal pane flare plays.
  function pollUnmountedScreens() {
    if (document.hidden || !engOk()) return;
    if (!isScreenLayout()) {
      // V12.7 W2: in split/grid the hidden records one gesture away are the
      // STACK members (their stack dot blinks like a screen dot); every
      // other unmounted record waits for a layout change.
      var anyStack = false;
      for (var sk in state.panes) {
        if (Object.prototype.hasOwnProperty.call(state.panes, sk) &&
            state.panes[sk] && state.panes[sk].stackIds) { anyStack = true; break; }
      }
      if (!anyStack) return;
    }
    var now = Date.now();
    for (var k in state.panes) {
      if (!Object.prototype.hasOwnProperty.call(state.panes, k)) continue;
      var pane = state.panes[k];
      if (!pane || !pane.person || !pane.person.chatId) continue;
      if (pane.el && pane.el.parentNode === state.root) continue; // mounted: covered above
      if (!isScreenLayout() && !pane.stackIds) continue; // V12.7 W2: stacks only
      if (pane.fetching || pane.bgFetching) continue;
      if (now - (pane.lastScreenPoll || 0) < POLL_SCREEN_MS) continue;
      pane.lastScreenPoll = now;
      pane.bgFetching = true;
      var slot = parseInt(k, 10);
      var acctId = pane.person.accountId;
      var chatId = pane.person.chatId;
      var seq = ++pane.loadSeq; // a mount fetch supersedes this one cleanly
      callQuiet(function () { return window.wab.eng.messages(acctId, chatId, MSG_LIMIT); })
        .then(function (res) {
          pane.bgFetching = false;
          var pn = state.panes[slot];
          if (!pn || pn !== pane) return;      // record replaced meanwhile
          if (seq !== pane.loadSeq) return;    // mounted fetch took over
          if (!Array.isArray(res)) return;     // quiet: the next cycle retries
          // V13 J2: the mount cache keeps the scroll-up pages the same
          // way: merge the fresh tail in, never overwrite the held pages.
          if (res.length) pane.msgs = mergeFreshWindow(pane, res);
          pane.histCount = pane.msgs.length;
          var seeded = pane.seeded;
          var fresh = trackSeenMessages(pane, res);
          pane.seeded = true;
          if (fresh && seeded) {
            if (!pane.hasNew) {
              pane.hasNew = true;
              notifyScreensChanged();          // the dot starts blinking
              renderStackDots();               // V12.7 W2: the stack dot blinks too
            }
            // One debug event per reply batch, same contract as the mounted path.
            try {
              window.dispatchEvent(new CustomEvent('wab:pane-reply', {
                detail: { slot: slot, accountId: (pane.person && pane.person.accountId) || null }
              }));
            } catch (e) { /* spine listens if present */ }
          }
        });
    }
  }

  function maybeTheirRefresh() {
    var list = $('people-list');
    if (!list || !window.WABPeople || typeof window.WABPeople.refresh !== 'function') return;
    if (list.querySelector('.people-row')) return; // rail is alive on its own
    if (state.deadRefreshes >= 3) return;          // rail is mine now
    state.deadRefreshes++;
    try { window.WABPeople.refresh(); } catch (e) { /* degrade quietly */ }
  }

  // V14 T5: body.wab-loading marks the first-load and engine-reconnect
  // windows. people.css reads it to pulse the rail's refresh button. The
  // first successful people answer clears it (an empty list is an honest
  // engine answer, not a loading state); three misses in a row re-arm it.
  // Nothing else in the UI touches this class (grep-verified: count 0 in
  // build\ before this patch).
  function syncLoadingBody(on) {
    try {
      document.body.classList.toggle('wab-loading', !!on);
    } catch (eB) { /* degrade quietly */ }
  }

  function pollPeople() {
    if (!engOk()) return;
    callQuiet(function () { return window.wab.eng.people(); })
      .then(function (res) {
        if (res === null) {
          state.peopleFails++;
          if (state.peopleFails === 3) toastRaw('Could not refresh the people list');
          if (state.peopleFails >= 3) syncLoadingBody(true); // V14 T5: reconnect window
          return;
        }
        state.peopleFails = 0;
        if (!Array.isArray(res)) res = [];
        state.people = res;
        syncLoadingBody(false); // V14 T5: engines are serving people again
        withSelfWrite(function () { processRail(); });
        withSelfWrite(function () {
          decoratePalette();
          takeOverPalette();
        });
        updateAllMinUnread();
        maybeTheirRefresh();
      });
  }

  function startPolls() {
    if (state.pollsOn) return;
    state.pollsOn = true;
    window.setInterval(function () {
      pollActivePane();
      pollBackgroundPanes();
      pollUnmountedScreens(); // own 5s cadence inside the 2s tick
    }, POLL_MSGS_MS);
    window.setInterval(pollPeople, POLL_PEOPLE_MS);
    pollPeople();
  }

  /* ---------- root wiring ---------- */

  function overlayOpen() {
    var ids = ['ctx-menu', 'modal-add', 'modal-remove', 'settings', 'search-palette'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el && !el.hidden) return true;
    }
    return false;
  }

  function wireRoot() {
    // Clicking a pane makes it the active pane.
    state.root.addEventListener('mousedown', function (ev) {
      var paneEl = ev.target && ev.target.closest ? ev.target.closest('.rpane') : null;
      if (!paneEl) return;
      var slot = parseInt(paneEl.getAttribute('data-slot'), 10);
      if (!isNaN(slot) && slot !== state.activeSlot) setActiveSlot(slot, {});
    });

    // Ctrl and wheel over a pane zooms it.
    state.root.addEventListener('wheel', function (ev) {
      if (!ev.ctrlKey && !ev.metaKey) return;
      var paneEl = ev.target && ev.target.closest ? ev.target.closest('.rpane') : null;
      if (!paneEl) return;
      ev.preventDefault();
      var slot = parseInt(paneEl.getAttribute('data-slot'), 10);
      if (isNaN(slot)) return;
      setPaneZoom(slot, ev.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    }, { passive: false });

    // V12.3 W1: two-finger horizontal swipes over the pane area flip
    // screens (single and tabs only). passive:false is required solely so
    // the firing event can preventDefault; every non-firing event passes
    // through untouched, so vertical scrolling and zoom never fight it.
    state.root.addEventListener('wheel', onSwipeWheel, { passive: false });

    // Esc restores a maximized pane when nothing else is open.
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || state.maxSlot === null) return;
      if (overlayOpen()) return;
      toggleMaximize(state.maxSlot);
    });

    window.addEventListener('resize', scheduleSync);

    // V13 D1: quitting mid-typing still files the bar text with its
    // conversation, so a restart gives it back. Wire-time, once.
    window.addEventListener('pagehide', function () {
      var pane = state.panes[state.activeSlot];
      if (pane && pane.person && state.gta) {
        pane.draft = state.gta.value || '';
        persistPaneDraft(pane);
      }
    });

    try {
      if (window.WABSlots && typeof window.WABSlots.onLayoutChange === 'function') {
        window.WABSlots.onLayoutChange(function () { scheduleSync(); });
      }
    } catch (e) { /* degrade quietly */ }

    // Layout flips (data-layout) AND body class flips (rail fold
    // wab-rail-folded, pane maximize wab-maximized) move the conversation
    // area, so both resync the panes. V12.4 X2 also recenters the central
    // bar once the 200ms rail fold transition has landed (260ms later); the
    // slot-area ResizeObserver covers every intermediate frame meanwhile.
    try {
      new MutationObserver(function () {
        scheduleSync();
        if (state.barSettleTimer) window.clearTimeout(state.barSettleTimer);
        state.barSettleTimer = window.setTimeout(function () {
          state.barSettleTimer = null;
          positionComposeBar();
        }, 260);
      }).observe(document.body, { attributes: true, attributeFilter: ['data-layout', 'class'] });
    } catch (e) { /* old engine */ }

    try {
      if (wabOk() && window.wab.app && typeof window.wab.app.onPaneState === 'function') {
        window.wab.app.onPaneState(function (p) {
          try { onPaneState(p); } catch (e) { /* degrade quietly */ }
        });
      }
    } catch (e) { /* degrade quietly */ }
  }

  /* ---------- v3.1: live resolve, avatars, central compose (the owner's 2026-11-21 pass) ---------- */

  // Live people fetch for click resolution: never dead-end on a stale cache.
  // V12.6 Z2: fresh=true bypasses the cache ONCE. The old code reused a
  // non-empty cache even when the click had just failed to resolve against
  // it, so the boot race (first click against a not-yet-hydrated roster)
  // burned its one retry on the same stale titles.
  function ensurePeopleLive(fresh) {
    if (!fresh && state.people && state.people.length) return Promise.resolve(state.people);
    if (!engOk()) return Promise.resolve(null);
    return callQuiet(function () { return window.wab.eng.people(); }).then(function (res) {
      if (Array.isArray(res) && res.length) {
        state.people = res;
        state.peopleLoaded = true;
        return res;
      }
      return null;
    });
  }

  // V12.6 Z2: the open resolver, made honest end to end. The rail lights
  // BEFORE any await (loading visibility law); the spec is kept on the pane
  // so a failed resolve leaves a Retry that retries the RESOLVE; a miss
  // forces ONE fresh eng.people pull before giving up; and the resolved
  // open goes through openResolved, which never swallows a no-rect frame.
  // Consent-first: before any of that, an open aimed at a LOCKED account
  // fails loud with the locked message instead of a resolve miss.
  function openFromSpecLive(slot, spec) {
    var pane = state.panes[slot] || ensurePane(slot);
    if (pane) pane.pendingSpec = spec || {};
    accountLocked(spec && spec.accountId).then(function (locked) {
      if (locked) {
        progressBegin(slot, 'load');
        progressEnd(slot, 'load', false);
        debugStep('engine-error', spec && spec.accountId, 'open blocked (account locked)');
        setState(slot, { state: 'error', message: lockedMessage() });
        toastRaw('This account is locked until its owner picks contacts.');
        return;
      }
      openFromSpecLiveRun(slot, spec);
    });
  }

  function openFromSpecLiveRun(slot, spec) {
    var person = resolveForOpen(spec);
    if (person && person.chatId) {
      openResolved(slot, person, { focus: true });
      return;
    }
    progressBegin(slot, 'load'); // the rail lights from the FIRST line of the resolve
    setState(slot, { state: 'loading' });
    debugStep('open-step', spec && spec.accountId, 'open resolve live');
    ensurePeopleLive(true).then(function (list) {
      var again = resolveForOpen(spec);
      if (again && again.chatId) {
        debugStep('open-step', spec && spec.accountId, 'open resolve ok');
        progressEnd(slot, 'load', true); // setPerson's fetch takes the rail from here
        openResolved(slot, again, { focus: true });
        return;
      }
      void list;
      progressEnd(slot, 'load', false);
      debugStep('engine-error', spec && spec.accountId, 'open resolve failed');
      setState(slot, { state: 'error', message: 'Could not resolve this chat yet. Press Retry after the engines load.' });
      toastRaw('Chat not resolved yet. Engines may still be loading; press Retry in a moment.');
    });
  }

  // Central compose bar: the ONE big entry box, hovering at the bottom of
  // the CONVERSATION AREA, always bound to the active pane's conversation.
  // It is also the visible ROUTER (V12.1 T3): account-color edge strip,
  // 300ms pulse on route changes, and a chip that focuses the routed pane.
  // Since V12.2 the routed pane is the mounted SCREEN's record, so switching
  // screens reroutes the bar (with its pulse) while the draft stays with its
  // own conversation. V12.3 W1: the bar sits at its fixed bottom position in
  // EVERY mode. V12.4 X2: positionComposeBar centers it over the
  // conversation area (#slot-area, right of the rail) instead of the window.
  function buildComposeBar() {
    if (state.gbar) return;
    var bar = document.createElement('div');
    bar.id = 'gcompose';
    bar.className = 'gcompose';
    var strip = document.createElement('span');
    strip.className = 'gc-route';
    strip.setAttribute('aria-hidden', 'true');
    var chip = document.createElement('div');
    chip.className = 'gc-chip';
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.setAttribute('aria-label', 'Focus the pane this bar sends to');
    chip.title = 'Focus the pane this bar sends to';
    var av = document.createElement('span');
    av.className = 'gc-avatar';
    var idn = document.createElement('span');
    idn.className = 'gc-idn';
    var nameEl = document.createElement('span');
    nameEl.className = 'gc-name';
    var acctEl = document.createElement('span');
    acctEl.className = 'gc-acct';
    idn.appendChild(nameEl);
    idn.appendChild(acctEl);
    chip.appendChild(av);
    chip.appendChild(idn);
    var ta = document.createElement('textarea');
    ta.className = 'gc-ta';
    ta.rows = 1;
    ta.placeholder = 'Replying as the account shown. Enter sends, Shift+Enter adds a line.';
    ta.setAttribute('aria-label', 'Central compose box');
    var send = document.createElement('button');
    send.type = 'button';
    send.className = 'gc-send';
    send.textContent = 'Send';
    // V12.7 E1: the emoji button rides BETWEEN the identity chip and the
    // textarea. Hairline glass circle like the pane header controls, inline
    // SVG smiley (no emoji in UI chrome; the emojis themselves are content).
    var emobtn = document.createElement('button');
    emobtn.type = 'button';
    emobtn.className = 'gc-emoji-btn';
    emobtn.innerHTML = EMOJI_ICON;
    emobtn.setAttribute('aria-label', 'Insert emoji');
    emobtn.setAttribute('aria-expanded', 'false');
    emobtn.title = 'Insert emoji (or type : followed by a name in the box)';
    bar.appendChild(strip);
    bar.appendChild(chip);
    bar.appendChild(emobtn);
    bar.appendChild(ta);
    bar.appendChild(send);
    document.body.appendChild(bar);
    state.gbar = bar;
    state.gta = ta;
    state.gsend = send;
    state.gname = nameEl;
    state.gacct = acctEl;
    state.gavatar = av;
    state.gemoji = emobtn; // V12.7 E1: the smiley toggle

    // The chip answers "where does this go": focus the routed pane, nothing else.
    chip.addEventListener('click', function () { focusRoutedPane(); });
    chip.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      focusRoutedPane();
    });

    function submit() {
      var pane = state.panes[state.activeSlot];
      if (!pane || !pane.person || !pane.person.chatId) {
        toastRaw('Open a conversation first: click a person or press Ctrl+K.');
        return;
      }
      var text = (ta.value || '').trim();
      if (!text) return;
      dispatchCentral(pane, text);
    }
    send.addEventListener('click', submit);
    ta.addEventListener('keydown', function (ev) {
      // V12.7 E1: an ACTIVE colon suggestion consumes keys first (arrows
      // pick, Tab or plain Enter inserts, Esc closes). Without one, every
      // key falls through: Enter still sends, Shift+Enter still newlines.
      if (handleEmojiKeys(ev)) return;
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        submit();
      }
    });
    // V12.7 E1: colon autocomplete tracks the caret (input, caret moves,
    // clicks); an internal textarea scroll reanchors the popover; blur and
    // a route change close it. All are guarded no-ops until the bar exists.
    ta.addEventListener('input', updateColonSuggest);
    ta.addEventListener('click', updateColonSuggest);
    ta.addEventListener('scroll', onComposeScrolled);
    ta.addEventListener('keyup', function (ev) {
      if (ev && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' ||
        ev.key === 'Home' || ev.key === 'End')) updateColonSuggest();
    });
    ta.addEventListener('blur', function () { closeColonSuggest(); });
    emobtn.addEventListener('click', function () { toggleEmojiPicker(); });
    syncComposeBar();
    positionComposeBar(); // V12.4 X2: first centering over the conversation area
  }

  // V12.4 X2: the central bar centers over the CONVERSATION AREA, the
  // #render-root box (inset 0 of #slot-area, everything right of the rail),
  // never the raw window: viewport left:50% sat the bar too far right
  // whenever the rail was open, which was the owner's "not centered" complaint.
  // Measured rects instead of a --rail-w guess, so every rail width is
  // covered: 240px unfolded, 64px folded, 56px with a maximized pane, the
  // narrow-window media query, any window size, maximize included. Runs on
  // every pane sync (resize, layout switch, fold, ResizeObserver frames)
  // plus the 260ms settle after a body class flip. translateX(-50%) keeps
  // the centering; bottom stays fixed at 18px in page coordinates.
  function positionComposeBar() {
    if (!state.gbar || !state.root) return;
    var r = null;
    try { r = state.root.getBoundingClientRect(); } catch (e) { r = null; }
    if (!r || r.width < 8) {
      state.gbar.style.left = '50%'; // fragment not laid out yet: window center
      return;
    }
    state.gbar.style.left = Math.round(r.left + r.width / 2) + 'px';
    state.gbar.style.maxWidth = Math.max(240, Math.round(r.width - 48)) + 'px';
  }

  // The routed pane changed: one subtle 300ms pulse so the eye follows the route.
  function pulseBarRoute() {
    if (!state.gbar) return;
    if (state.gbarPulseTimer) window.clearTimeout(state.gbarPulseTimer);
    state.gbar.classList.remove('is-route-pulse');
    // Restart the animation even when a previous pulse is still running.
    try { void state.gbar.offsetWidth; } catch (e) { /* fine */ }
    state.gbar.classList.add('is-route-pulse');
    state.gbarPulseTimer = window.setTimeout(function () {
      try { state.gbar.classList.remove('is-route-pulse'); } catch (e) { /* bar gone */ }
      state.gbarPulseTimer = null;
    }, 320);
  }

  // Chip click: focus the routed pane and flash its edge. No other action.
  function focusRoutedPane() {
    var pane = state.panes[state.activeSlot];
    if (!pane || !pane.el || pane.el.parentNode !== state.root) return;
    try { pane.el.focus(); } catch (e) { /* fine */ }
    if (pane.routeTimer) window.clearTimeout(pane.routeTimer);
    pane.el.classList.remove('is-route');
    try { void pane.el.offsetWidth; } catch (e) { /* fine */ }
    pane.el.classList.add('is-route');
    pane.routeTimer = window.setTimeout(function () {
      try { pane.el.classList.remove('is-route'); } catch (e) { /* pane gone */ }
      pane.routeTimer = null;
    }, 320);
  }

  // V13 D8: the sidekick inserts into THE BAR, never the hidden engine
  // composer. accountId is optional: without a panel context any routed
  // conversation accepts; with one, only a bar routed to that account does
  // (a draft never crosses accounts). True when it landed.
  function insertIntoBar(accountId, text) {
    text = String(text == null ? '' : text);
    if (!text || !state.gta) return false;
    var pane = state.panes[state.activeSlot];
    var p = pane && pane.person;
    if (!p || !p.chatId) return false;
    if (accountId && String(accountId) !== String(p.accountId)) return false;
    var cur = state.gta.value || '';
    state.gta.value = cur ? (cur + '\n' + text) : text;
    pane.draft = state.gta.value; // V13 D1: the record follows the bar
    persistPaneDraft(pane);
    try { state.gta.focus(); } catch (e) { /* fine */ }
    try {
      state.gta.dispatchEvent(new Event('input', { bubbles: true })); // caret query listeners
    } catch (e2) { /* older engines: the value is already set */ }
    barAutoGrow();
    return true;
  }

  // V13 D8: fit the bar height to the inserted text once (CSS caps 140px).
  // Only the insert path calls this; typing behavior stays untouched.
  function barAutoGrow() {
    var ta = state.gta;
    if (!ta) return;
    try {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    } catch (e) { /* cosmetic */ }
  }

  // Sends through the engine for the routed pane; clears the bar on success.
  function dispatchCentral(pane, text) {
    closeColonSuggest(); // V12.7 E1: the draft is flying; no stale popover
    if (pane.sending) return;
    if (!engOk()) { toastRaw('Could not send. Conversations need the engines loaded.'); return; }
    pane.sending = true;
    progressBegin(pane.slot, 'send'); // V12.5 Y2: the rail pulses while the send flies
    state.gsend.disabled = true;
    state.gsend.textContent = 'Sending';
    callQuiet(function () { return window.wab.eng.send(pane.person.accountId, pane.person.chatId, text); })
      .then(function (res) {
        pane.sending = false;
        // Keyed to pane.slot (not the active slot): switching screens mid-send
        // must not strand the sending pane's rail or light a stranger's.
        progressEnd(pane.slot, 'send', !(res === null || (res && res.ok === false)));
        state.gsend.disabled = false;
        state.gsend.textContent = 'Send';
        if (res === null || (res && res.ok === false)) {
          // V13 D1: a failed send keeps the text in the bar AND files it
          // with its conversation. The toast stays honest about whether the
          // durable (restart) copy landed.
          var keep = (state.activeSlot === pane.slot && state.gta) ? (state.gta.value || '') : text;
          if (!keep) keep = text;
          pane.draft = keep;
          var saved = persistPaneDraft(pane);
          toastRaw('Could not send: ' + ((res && res.error) || 'engine busy') +
            (saved ? '. Your draft is saved with this conversation.' : '. Draft kept.'));
          try { state.gta.focus(); } catch (e) { /* fine */ }
          return;
        }
        // V13 D1: success clears only THIS conversation's bar. A route
        // change mid-send already moved the bar to another conversation;
        // its draft is not ours to wipe.
        if (!state.gta || state.activeSlot === pane.slot) state.gta.value = '';
        pane.draft = '';
        persistPaneDraft(pane); // V13 D1: sent means no draft left to restore
        // V12.6 Z2: refresh the SENDING pane's slot. The old code refreshed
        // the ACTIVE slot, so switching screens mid-send refreshed a
        // stranger and the sending pane kept its stale page.
        loadMessages(pane.slot, { force: true, forceScroll: true, focus: true });
      });
  }

  /* ---------- V13 D1: true draft persistence ---------- */

  // pane.draft keeps each conversation's bar text while the desk lives. The
  // 'wab-drafts' localStorage map (accountId|chatId -> text, 20 newest
  // entries) carries drafts across restarts. Storage is a bonus, never a
  // dependency: every read and write is guarded, and a storage failure only
  // means the restart copy is missing, never that the bar misbehaves.
  // wab.app.setPanePrefs is deliberately NOT used: its whitelist is fixed.

  var DRAFTS_KEY = 'wab-drafts';
  var DRAFTS_MAX = 20;       // conversations whose draft survives a restart
  var DRAFT_TEXT_MAX = 8000; // a draft is typing, not a manuscript

  function draftKey(person) {
    if (!person || !person.accountId || !person.chatId) return null;
    return String(person.accountId) + '|' + String(person.chatId);
  }

  function draftsLoad() {
    if (state.drafts) return state.drafts;
    var map = {};
    try {
      var raw = window.localStorage.getItem(DRAFTS_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (var k in parsed) {
            if (Object.prototype.hasOwnProperty.call(parsed, k) &&
                typeof parsed[k] === 'string') map[k] = parsed[k];
          }
        }
      }
    } catch (e) { map = {}; }
    state.drafts = map;
    return map;
  }

  // Saves (or removes, for empty text) one key. True when the durable copy
  // landed; false lets the failed-send toast stay honest.
  function draftStoreSave(key, text) {
    if (!key) return false;
    var map = draftsLoad();
    var ok = true;
    try {
      text = String(text == null ? '' : text);
      if (text) {
        delete map[key]; // reinsert so the key rides to the newest end
        map[key] = text.length > DRAFT_TEXT_MAX ? text.slice(0, DRAFT_TEXT_MAX) : text;
        var keys = Object.keys(map); // insertion order: oldest first
        while (keys.length > DRAFTS_MAX) delete map[keys.shift()];
      } else {
        delete map[key];
      }
      window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(map));
    } catch (e2) { ok = false; }
    return ok;
  }

  function draftStorePeek(key) {
    if (!key) return '';
    try { return draftsLoad()[key] || ''; } catch (e) { return ''; }
  }

  function persistDraftForPerson(person, text) {
    return draftStoreSave(draftKey(person), text);
  }

  // Files the record's draft under its person. Callers copy the bar into
  // pane.draft first when the bar belongs to that pane.
  function persistPaneDraft(pane) {
    if (!pane) return false;
    return draftStoreSave(draftKey(pane.person), pane.draft || '');
  }

  function syncComposeBar() {
    if (!state.gbar) return;
    var pane = state.panes[state.activeSlot];
    var p = pane && pane.person;
    state.gbar.classList.toggle('is-live', !!(p && p.chatId));
    // Router paint: the routed account's color rides the bar's left edge,
    // same --wabr-acct / --wabr-glow-rgb triplet pattern as the pane glow.
    var color = (p && p.accountColor) || '';
    state.gbar.style.setProperty('--wabr-acct', color || 'rgba(255,255,255,0.42)');
    state.gbar.style.setProperty('--wabr-glow-rgb', acctRGBTriplet(color));
    // A changed route (different pane, or a different person in the active
    // pane) pulses once; refreshes of the same route never do.
    var sig = state.activeSlot + '|' + ((p && p.accountId) || '') + '|' + norm((p && p.title) || '');
    if (sig !== state.gbarSig) {
      var known = state.gbarSig != null;
      // V13 D1: the text in the bar belongs to the OUTGOING route. File it
      // with that conversation before the chip repaints. Same-record person
      // swaps are excluded here: setPerson files those under the previous
      // person (P6), and their record draft was already reset by then.
      var outSlot = parseInt(state.gbarSlot, 10);
      var outPane = isNaN(outSlot) ? null : state.panes[outSlot];
      if (outPane && outPane.person && outSlot !== state.activeSlot && state.gta) {
        outPane.draft = state.gta.value || '';
        persistPaneDraft(outPane);
      }
      state.gbarSig = sig;
      state.gbarSlot = state.activeSlot;
      if (known) pulseBarRoute();
      closeColonSuggest(); // V12.7 E1: the draft swaps with the route; the popover's recorded anchors are stale
      // V13 D1: swap the bar text with the route (the switchScreen law, now
      // for split and grid routes too). The guard never fights the user: at
      // a route change the bar holds exactly what was just filed, or nothing.
      var incPane = state.panes[state.activeSlot];
      if (state.gta && incPane) {
        var swapOk = state.gta.value === '' ||
          (outPane && outSlot !== state.activeSlot &&
           state.gta.value === (outPane.draft || ''));
        if (swapOk) state.gta.value = incPane.person ? (incPane.draft || '') : '';
      }
    }
    if (p) {
      state.gname.textContent = p.title || 'Unknown';
      state.gacct.textContent = p.accountName || '';
      if (p.avatar) {
        state.gavatar.textContent = '';
        state.gavatar.style.backgroundImage = 'url("' + p.avatar + '")';
        state.gavatar.classList.add('has-img');
        state.gavatar.style.borderColor = ''; // photo only: no ring decoration
      } else {
        state.gavatar.style.backgroundImage = '';
        state.gavatar.classList.remove('has-img');
        state.gavatar.textContent = initialsOf(p.title);
        state.gavatar.style.borderColor = p.accountColor || 'rgba(255,255,255,0.42)';
      }
    } else {
      state.gname.textContent = 'No conversation';
      state.gacct.textContent = 'Pick a person, or press Ctrl+K';
      state.gavatar.textContent = '';
      state.gavatar.style.backgroundImage = '';
      state.gavatar.style.borderColor = '';
      state.gavatar.classList.remove('has-img');
    }
  }

  // Single initialsOf for every surface (was duplicated: hoisting made this
  // v3.1 definition the live one everywhere; now it is the only one).
  function initialsOf(title) {
    var t = String(title || '').trim();
    if (!t) return '';
    var parts = t.split(/\s+/);
    var s = parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '');
    return s.toUpperCase();
  }

  /* ---------- V12.7 E1: emoji in the central bar ---------- */

  /* the owner's ask (2026-11-21): "I'm unable to add a GIF or even type emojis.
     Colon and then start typing something, or press a button to add an
     emoji." Two entry paths, both scoped to the central bar ONLY:
     1. The smiley button left of the textarea opens a glass picker panel
        anchored above the bar: 8 category tabs (text labels), a Recent row
        first (last 16 used, persisted in localStorage, guarded), a curated
        inline set of ~250 emojis, max-height 240px, scroll.
     2. Typing ':' followed by 2+ word characters opens a caret-anchored
        suggestion popover (max 6 matches against name + aliases): arrows
        pick, Tab or plain Enter inserts the emoji and removes the :query,
        Esc closes. Enter WITHOUT an active suggestion still sends, and
        Shift+Enter still adds a line: the bar's praised behavior is
        untouched.
     Emojis are message CONTENT; the UI chrome itself stays emoji free
     (inline SVG icon, text tab labels). Sending is untouched too: the text
     with emojis passes through dispatchCentral and wab.eng.send exactly as
     before (the engine's insertText handles unicode). GIFs ride WhatsApp's
     own flow later and are out of scope here.
     Every E1 module var lives on the local `em` record so this section is
     one contiguous additive block (the shared state object only gains
     state.gemoji, set by buildComposeBar). */

  var EMOJI_ICON = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="5.4"/><path d="M4.6 8.3c.6 1 1.4 1.5 2.4 1.5s1.8-.5 2.4-1.5"/><path d="M5.1 5.5h.01M8.9 5.5h.01" stroke-width="1.7"/></svg>';
  var EMOJI_RECENT_KEY = 'wab-emoji-recent';
  var EMOJI_RECENT_MAX = 16;
  var EMOJI_SUG_MAX = 6;
  var EMOJI_CATS = ['Smileys', 'Gestures', 'Hearts', 'People', 'Objects', 'Food', 'Travel', 'Symbols'];

  // [emoji, shortname, aliases, category index]. The shortname doubles as
  // the :name: colon code (so :smile: :heart: :fire: :thumbsup: :tada: all
  // resolve); aliases are extra matching keywords, space separated. No
  // external assets, no network: the set is curated inline.
  var EMOJI_DATA = [
    /* Smileys */
    ['😀','grinning','happy grin',0],['😄','smile','cheerful',0],['😆','laughing','lol squint',0],['😅','sweatsmile','relieved',0],
    ['🤣','rofl','rolling',0],['😂','joy','tears laugh',0],['🙂','slightsmile','slight',0],['🙃','upsidedown','silly',0],
    ['😉','wink','winking',0],['😊','blush','pleased shy',0],['😇','innocent','halo angel',0],['🥰','lovehearts','inlove',0],
    ['😍','hearteyes','love crush',0],['🤩','starstruck','stars excited',0],['😘','kiss','kissing',0],['😋','yum','tasty delicious',0],
    ['😛','tongue','tongueout',0],['😜','tonguewink','prank playful',0],['🤪','zany','crazy wild',0],['🤑','moneyface','greedy rich',0],
    ['🤗','hug','hugging thanks',0],['🤭','handmouth','oops giggle',0],['🤫','shush','quiet secret',0],['🤔','thinking','hmm consider',0],
    ['😐','neutral','meh plain',0],['😏','smirk','smug',0],['😒','unamused','annoyed unimpressed',0],['🙄','eyeroll','rollingeyes',0],
    ['😬','grimace','awkward',0],['😌','relieved','peaceful calm',0],['😪','sleepy','tired',0],['😴','sleeping','asleep',0],
    ['😷','mask','sick health',0],['🥳','partyface','celebrate festive',0],['🥺','pleading','puppyeyes',0],['😢','cry','tear sad',0],
    ['😭','sob','crying',0],['😤','triumph','huff steam',0],['😡','rage','angry furious',0],['😱','scream','fear shocked',0],
    ['😨','fearful','scared',0],['🤯','mindblown','exploding',0],['😳','flushed','embarrassed',0],['😮','openmouth','wow surprised',0],
    ['😈','imp','devil',0],['💀','skull','dead',0],['👻','ghost','spooky',0],['👽','alien','extraterrestrial',0],
    ['🤖','robot','bot',0],['💩','poop','turd',0],['🤡','clown','clownface',0],
    /* Gestures */
    ['👍','thumbsup','+1 like approve',1],['👎','thumbsdown','-1 dislike',1],['👌','okhand','perfect',1],['✌️','victory','peace',1],
    ['🤞','crossedfingers','luck hope',1],['🤟','loveyou','ily',1],['🤘','rockon','horns metal',1],['🤙','callme','shaka',1],
    ['👈','pointleft','left',1],['👉','pointright','right',1],['👆','pointup','up',1],['👇','pointdown','down',1],
    ['✋','raisedhand','highfive stop',1],['🖖','spock','vulcan',1],['👋','wave','hello bye',1],['🙏','pray','thanks please',1],
    ['🤝','handshake','deal agreement',1],['💪','muscle','flex strong',1],['👏','clap','applause bravo',1],['🙌','raisedhands','hooray celebrating',1],
    ['👐','openhands','openarms',1],['🤲','palmsup','together',1],['✍️','writing','write',1],['🤳','selfie','photo me',1],
    /* Hearts */
    ['❤️','heart','love red',2],['🧡','orangeheart','',2],['💛','yellowheart','',2],['💚','greenheart','',2],
    ['💙','blueheart','',2],['💜','purpleheart','',2],['🖤','blackheart','',2],['🤍','whiteheart','',2],
    ['🤎','brownheart','',2],['💔','brokenheart','heartbreak',2],['💕','twohearts','affection',2],['💖','sparklingheart','shine',2],
    ['💗','growingheart','growing',2],['💓','beatingheart','pulse',2],['💞','revolvinghearts','revolving',2],['💘','heartarrow','cupid',2],
    /* People */
    ['🤦','facepalm','doh',3],['🤷','shrug','idk',3],['🙋','raisinghand','volunteer',3],['🙇','bow','respect sorry',3],
    ['👶','baby','infant',3],['🧒','child','kid',3],['👦','boy','',3],['👧','girl','',3],
    ['👨','man','guy',3],['👩','woman','lady',3],['🧑','person','human',3],['👴','oldman','grandpa',3],
    ['👵','oldwoman','grandma',3],['👮','cop','police officer',3],['💃','dancer','dancing',3],['🕺','mandancer','disco',3],
    ['🧘','meditation','yoga zen',3],['🏃','running','run',3],['🚶','walking','walk',3],['🤰','pregnant','expecting',3],
    ['🎅','santa','christmas',3],['🦸','superhero','hero',3],['🦹','supervillain','villain',3],['🧙','mage','wizard witch',3],
    ['🧚','fairy','pixie',3],['🧛','vampire','dracula',3],['🧟','zombie','undead',3],['👥','group','crowd',3],
    /* Objects */
    ['💻','laptop','computer',4],['📱','phone','mobile smartphone',4],['📷','camera','photo',4],['📞','telephone','call',4],
    ['📺','tv','television',4],['🔊','speaker','volume loud',4],['🔔','bell','notification alert',4],['🔕','bellmute','mute silence',4],
    ['⏰','alarmclock','alarm morning',4],['🔋','battery','charge',4],['💡','bulb','idea light',4],['🔦','flashlight','torch',4],
    ['🧯','extinguisher','fireextinguisher',4],['💸','moneyfly','cash',4],['💰','moneybag','money',4],['💳','creditcard','card payment',4],
    ['💎','gem','diamond jewel',4],['🔧','wrench','fix tool',4],['🔨','hammer','build',4],['⚙️','gear','settings',4],
    ['🔒','locked','lock secure',4],['🔓','unlocked','unlock',4],['🔑','key','password',4],['📌','pin','pinned',4],
    ['📎','clip','paperclip attachment',4],['✂️','scissors','cut',4],['📝','memo','note write',4],['✏️','pencil','edit',4],
    ['📚','books','library study',4],['📖','openbook','book reading',4],['📊','chart','graph stats',4],['📈','chartup','growth trending',4],
    ['📅','calendar','date schedule',4],['🔍','search','find magnifier',4],['🗑️','trash','delete bin',4],['🎁','gift','present',4],
    ['🎉','tada','party celebrate',4],['🎊','confetti','celebration',4],['🔥','fire','lit',4],['✨','sparkles','magic shiny',4],
    ['🎮','gamepad','gaming controller',4],['⚽','soccer','football',4],
    /* Food */
    ['☕','coffee','',5],['🍵','tea','',5],['🍺','beer','ale',5],['🍻','beers','cheers',5],
    ['🥂','champagne','toast',5],['🍷','wine','wineglass',5],['🍸','cocktail','martini',5],['🍹','tropical','tiki',5],
    ['🥤','soda','cup straw',5],['🍕','pizza','slice',5],['🍔','burger','hamburger',5],['🍟','fries','chips',5],
    ['🌭','hotdog','sausage',5],['🍿','popcorn','movie',5],['🥞','pancakes','breakfast',5],['🍳','cooking','egg',5],
    ['🥗','salad','healthy',5],['🍝','pasta','spaghetti',5],['🍜','ramen','noodles',5],['🍣','sushi','',5],
    ['🍦','icecream','softserve',5],['🍩','donut','doughnut',5],['🍪','cookie','biscuit',5],['🎂','cake','birthday',5],
    ['🍫','chocolate','choco',5],['🍬','candy','sweet',5],['🍎','apple','fruit',5],['🍌','banana','',5],
    ['🍇','grapes','',5],['🍓','strawberry','berry',5],['🥑','avocado','',5],['🍰','shortcake','dessert',5],
    /* Travel */
    ['🚗','car','drive',6],['🚕','taxi','cab',6],['🚌','bus','',6],['🚑','ambulance','',6],
    ['🚒','firetruck','fireengine',6],['🛵','scooter','',6],['🏍️','motorcycle','motorbike',6],['🚲','bicycle','bike cycle',6],
    ['✈️','plane','flight airplane',6],['🚀','rocket','launch',6],['🛸','ufo','saucer',6],['⛵','sailboat','sailing',6],
    ['🚂','train','railway',6],['🚢','ship','cruise ferry',6],['🗺️','map','world',6],['🧭','compass','navigate',6],
    ['🏔️','mountain','peak',6],['🏖️','beach','vacation seaside',6],['🏝️','island','tropical',6],['🌅','sunrise','dawn',6],
    ['🌇','sunset','dusk',6],['🌙','moon','night',6],['🌈','rainbow','pride colors',6],['☀️','sun','sunny weather',6],
    ['🌂','umbrella','rain',6],['❄️','snowflake','snow winter',6],['🌊','ocean','wave water',6],['🌍','globe','earth world',6],
    ['🎆','fireworks','firework',6],['🏠','house','home',6],
    /* Symbols */
    ['✅','check','done complete yes',7],['❌','cross','wrong no',7],['⚠️','warning','caution',7],['🚫','noentry','forbidden blocked',7],
    ['♻️','recycle','recycling eco',7],['💯','hundred','100 perfect',7],['⭐','star','stars favorite',7],['❓','question','questionmark unknown',7],
    ['❗','exclamation','important bang',7],['💤','zzz','sleep',7],['🔴','reddot','redcircle',7],['🟢','greendot','greencircle online',7],
    ['🔵','bluedot','bluecircle',7],['🔺','uptriangle','redtriangle',7],['♾️','infinity','forever',7],['🆗','ok','okbutton',7],
    ['🔁','repeat','loop',7],['➕','plus','add',7],['➖','minus','subtract',7],['➗','divide','division',7],
    ['🆕','new','fresh',7],['🆓','free','',7],['🔮','crystalball','fortune magic',7],['🎯','target','goal bullseye',7],
    ['🚩','flag','redflag marker',7],['⚡','zap','lightning thunder',7],['💥','boom','explosion collision',7],['✉️','envelope','mail email',7]
  ];

  var em = {
    index: null,       // flattened [{e, key}] name+alias lookup for colon search
    recent: null,      // last-used emojis, lazily loaded
    panel: null,       // the picker panel (child of the bar)
    tabsEl: null,      // the category tab row
    recEl: null,       // the Recent section
    gridEl: null,      // the active category grid
    open: false,       // picker open
    cat: 0,            // active picker category
    docWired: false,   // the document close listeners exist
    sugEl: null,       // the colon suggestion popover (child of body, fixed)
    sugOn: false,      // a suggestion popover is showing
    sugQ: '',          // the query it was opened for (without the colon)
    sugStart: -1,      // textarea index of the ':'
    sugEnd: -1,        // textarea caret index when it opened
    sugSel: 0,         // highlighted row
    matches: []        // current candidate rows
  };

  function emLower(s) { return String(s == null ? '' : s).toLowerCase(); }

  // Flattened name + alias index, built once. Keys are lowercase; one emoji
  // can sit under several keys, which is the point of aliases.
  function emIndex() {
    if (em.index) return em.index;
    var idx = [];
    for (var i = 0; i < EMOJI_DATA.length; i++) {
      var row = EMOJI_DATA[i];
      if (!row || !row[0] || !row[1]) continue;
      idx.push({ e: row[0], key: emLower(row[1]), nm: true });
      var al = String(row[2] || '').split(/\s+/);
      for (var a = 0; a < al.length; a++) {
        if (al[a]) idx.push({ e: row[0], key: emLower(al[a]), nm: false });
      }
    }
    em.index = idx;
    return idx;
  }

  function emByEmoji(emoji) {
    for (var i = 0; i < EMOJI_DATA.length; i++) {
      if (EMOJI_DATA[i][0] === emoji) return EMOJI_DATA[i];
    }
    return null;
  }

  /* Recent emojis. localStorage, guarded: the pane-prefs whitelist is fixed
     (zoom + minimized), so recents persist per machine instead of per pane
     and never touch wab.app.setPanePrefs. */
  function emRecentLoad() {
    if (em.recent) return em.recent;
    var out = [];
    try {
      var raw = window.localStorage.getItem(EMOJI_RECENT_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (Object.prototype.toString.call(arr) === '[object Array]') {
        for (var i = 0; i < arr.length && out.length < EMOJI_RECENT_MAX; i++) {
          if (typeof arr[i] === 'string' && arr[i] && emByEmoji(arr[i])) out.push(arr[i]);
        }
      }
    } catch (e) { /* storage blocked or corrupted: start fresh */ }
    em.recent = out;
    return out;
  }

  function emRecentSave(list) {
    try {
      window.localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(list));
    } catch (e) { /* private mode or quota: recents live for this session */ }
  }

  function emRemember(emoji) {
    var list = emRecentLoad().slice(0);
    var at = list.indexOf(emoji);
    if (at !== -1) list.splice(at, 1);
    list.unshift(emoji);
    if (list.length > EMOJI_RECENT_MAX) list.length = EMOJI_RECENT_MAX;
    em.recent = list;
    emRecentSave(list);
    if (em.open) emPaintRecent(); // an open picker follows along
  }

  /* Insertion: at the caret (selectionStart aware), never sends, keeps the
     textarea focused. A selected range is replaced by the emoji. */
  function emInsert(emoji) {
    var ta = state.gta;
    if (!ta) return;
    var pos = ta.selectionStart;
    var end = ta.selectionEnd;
    if (typeof pos !== 'number' || isNaN(pos)) {
      ta.value = (ta.value || '') + emoji;
    } else {
      var v = ta.value || '';
      ta.value = v.slice(0, pos) + emoji + v.slice(typeof end === 'number' ? end : pos);
      pos = pos + emoji.length;
      try { ta.setSelectionRange(pos, pos); } catch (e) { /* fine */ }
    }
    emRemember(emoji);
    try { ta.focus(); } catch (e2) { /* fine */ }
    updateColonSuggest(); // the text around the caret may now hold a query
  }

  /* ---------- the picker panel ---------- */

  function emBtn() { return state.gemoji || null; }

  function emBuildPanel() {
    if (em.panel || !state.gbar) return;
    var p = document.createElement('div');
    p.className = 'gc-emopick';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Emoji picker');
    p.hidden = true;
    // Mousedown inside the panel never moves focus: the caret stays in the
    // textarea, so every insert lands exactly where the operator left it.
    p.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    var tabs = document.createElement('div');
    tabs.className = 'gc-emotabs';
    tabs.setAttribute('role', 'tablist');
    for (var c = 0; c < EMOJI_CATS.length; c++) {
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'gc-emotab';
      t.setAttribute('role', 'tab');
      t.setAttribute('data-cat', String(c));
      t.title = EMOJI_CATS[c];
      t.appendChild(document.createTextNode(EMOJI_CATS[c]));
      t.addEventListener('click', (function (cat) {
        return function () { em.cat = cat; emPaint(); };
      })(c));
      tabs.appendChild(t);
    }
    var scroll = document.createElement('div');
    scroll.className = 'gc-emoscroll';
    var rec = document.createElement('div');
    rec.className = 'gc-emorecent';
    rec.hidden = true; // paints only when recents exist
    var grid = document.createElement('div');
    grid.className = 'gc-emogrid';
    scroll.appendChild(rec);
    scroll.appendChild(grid);
    p.appendChild(tabs);
    p.appendChild(scroll);
    state.gbar.appendChild(p);
    em.panel = p;
    em.tabsEl = tabs;
    em.recEl = rec;
    em.gridEl = grid;
  }

  function emGridButton(emoji) {
    var row = emByEmoji(emoji);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gc-emoji';
    b.appendChild(document.createTextNode(emoji));
    b.title = row ? ':' + row[1] + ':' : '';
    b.setAttribute('aria-label', 'Insert ' + (row ? row[1] : 'emoji'));
    b.addEventListener('click', function () { emInsert(emoji); });
    return b;
  }

  function emPaintGrid() {
    if (!em.gridEl) return;
    em.gridEl.textContent = '';
    for (var i = 0; i < EMOJI_DATA.length; i++) {
      if (EMOJI_DATA[i][3] !== em.cat) continue;
      em.gridEl.appendChild(emGridButton(EMOJI_DATA[i][0]));
    }
  }

  function emPaintRecent() {
    if (!em.recEl) return;
    var list = emRecentLoad();
    em.recEl.textContent = '';
    em.recEl.hidden = !list.length;
    if (!list.length) return;
    em.recEl.appendChild(h('div', 'gc-emolabel', 'Recent'));
    var g = h('div', 'gc-emogrid is-recent');
    for (var i = 0; i < list.length; i++) g.appendChild(emGridButton(list[i]));
    em.recEl.appendChild(g);
  }

  function emPaint() {
    if (!em.panel || !em.tabsEl) return;
    var tabs = em.tabsEl.children;
    for (var i = 0; i < tabs.length; i++) {
      var on = parseInt(tabs[i].getAttribute('data-cat'), 10) === em.cat;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    emPaintRecent();
    emPaintGrid();
  }

  // The panel anchors at the bar's left edge; if it would run past the
  // viewport's right side (narrow window), slide it left to stay on screen.
  function emPositionPanel() {
    var p = em.panel;
    if (!p) return;
    p.style.left = '0px';
    try {
      var pr = p.getBoundingClientRect();
      var over = pr.right - (window.innerWidth - 8);
      if (over > 0) p.style.left = Math.round(Math.min(0, -over - 2)) + 'px';
    } catch (e) { /* fine */ }
  }

  function closeEmojiPicker() {
    if (!em.open) return;
    em.open = false;
    if (em.panel) em.panel.hidden = true;
    var b = emBtn();
    if (b) {
      b.classList.remove('on');
      b.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleEmojiPicker() {
    if (!state.gbar) return;
    if (em.open) { closeEmojiPicker(); return; }
    emBuildPanel();
    if (!em.panel) return;
    em.open = true;
    em.panel.hidden = false;
    emPaint();
    emPositionPanel();
    var b = emBtn();
    if (b) {
      b.classList.add('on');
      b.setAttribute('aria-expanded', 'true');
    }
    emWireDoc();
  }

  // Close-on-outside-click and Esc, wired once. Both listeners are capture
  // phase so Esc is settled BEFORE the pane-maximize Esc handler and the
  // textarea's own keydown can react to a closed picker.
  function emWireDoc() {
    if (em.docWired) return;
    em.docWired = true;
    document.addEventListener('keydown', function (ev) {
      if (!ev || ev.key !== 'Escape') return;
      if (em.open) {
        ev.preventDefault();
        ev.stopPropagation();
        closeEmojiPicker();
      } else if (em.sugOn) {
        ev.preventDefault();
        ev.stopPropagation();
        closeColonSuggest();
      }
    }, true);
    document.addEventListener('mousedown', function (ev) {
      if (!em.open) return;
      var t = ev.target;
      if (t && em.panel && em.panel.contains(t)) return;
      var b = emBtn();
      if (t && b && b.contains(t)) return;
      closeEmojiPicker();
    }, true);
  }

  /* ---------- colon autocomplete ---------- */

  // The live query at the caret: ':' followed by 2 or more word characters
  // (letters, digits, _ + -, so :+1: and :-1: work), where the character
  // before the ':' is not itself a word character. That boundary rule keeps
  // times (12:30) and urls (https://) from ever opening the popover.
  // Returns null unless a collapsed caret sits right after a query.
  function emQueryAt(ta) {
    try {
      var pos = ta.selectionStart;
      if (typeof pos !== 'number' || isNaN(pos) || pos !== ta.selectionEnd) return null;
      var v = ta.value || '';
      var m = /:([a-z0-9_+-]{2,})$/i.exec(v.slice(0, pos));
      if (!m) return null;
      var start = pos - m[1].length - 1; // index of the ':'
      if (start > 0 && /[a-z0-9_+-]/i.test(v.charAt(start - 1))) return null;
      return { q: emLower(m[1]), start: start, end: pos };
    } catch (e) {
      return null;
    }
  }

  // Candidates for a query. Tiers: exact key, then canonical shortnames
  // that start with the query (shortest first, so :smile: outranks
  // slightsmile), then alias prefixes (a name is a better answer than an
  // alias: :sm: means smile, not smug), then substrings from 3 characters.
  // Deduped by emoji, capped at 6 rows.
  function emSearch(q) {
    var idx = emIndex();
    var cands = [];
    for (var i = 0; i < idx.length; i++) {
      var k = idx[i].key;
      if (k === q || k.indexOf(q) === 0 || (q.length >= 3 && k.indexOf(q) !== -1)) cands.push(idx[i]);
    }
    function tier(c) {
      if (c.key === q) return 0;
      if (c.key.indexOf(q) === 0) return c.nm ? 1 : 2;
      return c.nm ? 3 : 4;
    }
    cands.sort(function (a, b) {
      var ta2 = tier(a);
      var tb = tier(b);
      if (ta2 !== tb) return ta2 - tb;
      return a.key.length - b.key.length;
    });
    var hits = [];
    var seen = {};
    for (var j = 0; j < cands.length && hits.length < EMOJI_SUG_MAX; j++) {
      if (seen[cands[j].e]) continue;
      seen[cands[j].e] = 1;
      hits.push(cands[j]);
    }
    return hits;
  }

  function emSugBuild() {
    if (em.sugEl) return;
    var d = document.createElement('div');
    d.className = 'gc-emsug';
    d.setAttribute('role', 'listbox');
    d.setAttribute('aria-label', 'Emoji suggestions');
    d.hidden = true;
    // Same law as the picker: mousedown never steals the caret from the
    // textarea, so a click inserts where the operator is typing.
    d.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    document.body.appendChild(d);
    em.sugEl = d;
  }

  function closeColonSuggest() {
    if (!em.sugOn && !em.sugEl) return;
    em.sugOn = false;
    if (em.sugEl) {
      em.sugEl.hidden = true;
      em.sugEl.textContent = '';
    }
    em.sugQ = '';
    em.sugStart = -1;
    em.sugEnd = -1;
    em.sugSel = 0;
    em.matches = [];
  }

  // Caret x in viewport coordinates, measured through a mirror div that
  // copies the textarea's font, width and wrapping. Only x is needed: the
  // popover anchors above the bar, which is a fixed box.
  function emCaretX(ta) {
    var fallback = 0;
    try {
      var r = ta.getBoundingClientRect();
      fallback = r.left;
      var cs = window.getComputedStyle(ta);
      var d = document.createElement('div');
      var props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'textTransform',
        'wordSpacing', 'tabSize'];
      for (var i = 0; i < props.length; i++) {
        try { d.style[props[i]] = cs[props[i]]; } catch (eSt) { /* keep default */ }
      }
      d.style.position = 'absolute';
      d.style.visibility = 'hidden';
      d.style.left = '0';
      d.style.top = '0';
      d.style.width = ta.clientWidth + 'px';
      d.style.whiteSpace = 'pre-wrap';
      d.style.wordWrap = 'break-word';
      d.style.overflowWrap = 'break-word';
      d.textContent = (ta.value || '').slice(0, ta.selectionStart || 0);
      var mark = document.createElement('span');
      mark.textContent = '​';
      d.appendChild(mark);
      document.body.appendChild(d);
      var x = mark.offsetLeft - (ta.scrollLeft || 0);
      document.body.removeChild(d);
      var out = r.left + x;
      if (out < r.left) out = r.left;
      if (out > r.right) out = r.right;
      return out;
    } catch (e) {
      return fallback;
    }
  }

  function emPositionSug() {
    var ta = state.gta;
    var el = em.sugEl;
    if (!ta || !el || !em.sugOn) return;
    var x = emCaretX(ta);
    el.style.left = '0px';
    var w = el.offsetWidth || 240;
    var l = Math.round(x);
    if (l + w > window.innerWidth - 8) l = Math.max(8, window.innerWidth - 8 - w);
    if (l < 8) l = 8;
    el.style.left = l + 'px';
    var tr = ta.getBoundingClientRect();
    el.style.top = 'auto';
    el.style.bottom = Math.round(window.innerHeight - tr.top + 8) + 'px';
  }

  function emSugRow(cand, i) {
    var meta = emByEmoji(cand.e);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gc-emrow';
    b.setAttribute('role', 'option');
    b.setAttribute('data-i', String(i));
    var g = document.createElement('span');
    g.className = 'gc-em-glyph';
    g.appendChild(document.createTextNode(cand.e));
    var n = document.createElement('span');
    n.className = 'gc-em-name';
    n.appendChild(document.createTextNode(':' + (meta ? meta[1] : cand.key) + ':'));
    b.appendChild(g);
    b.appendChild(n);
    b.addEventListener('click', function () { emPickSug(i); });
    return b;
  }

  function emPaintSugSel() {
    if (!em.sugEl) return;
    var rows = em.sugEl.querySelectorAll('.gc-emrow');
    for (var i = 0; i < rows.length; i++) {
      var on = i === em.sugSel;
      rows[i].classList.toggle('on', on);
      rows[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  // Typing the CLOSING colon completes an exact code: when the character at
  // the caret is the ':' that just closed a ':name:' token (same boundary
  // law as the query scan) and the name is an exact match, the whole token
  // becomes the emoji right away, no popover needed. Misses stay literal
  // text, so ordinary prose with colons is never rewritten.
  function emTryClosedQuery(ta) {
    try {
      var pos = ta.selectionStart;
      if (typeof pos !== 'number' || isNaN(pos) || pos !== ta.selectionEnd) return false;
      var v = ta.value || '';
      if (pos < 4 || v.charAt(pos - 1) !== ':') return false;
      var m = /:([a-z0-9_+-]{2,}):$/i.exec(v.slice(0, pos));
      if (!m) return false;
      var start = pos - m[1].length - 2;
      if (start > 0 && /[a-z0-9_+-]/i.test(v.charAt(start - 1))) return false;
      var q = emLower(m[1]);
      var hits = emSearch(q);
      if (!hits.length || hits[0].key !== q) return false; // only exact matches convert
      var cand = hits[0];
      ta.value = v.slice(0, start) + cand.e + v.slice(pos);
      var np = start + cand.e.length;
      try { ta.setSelectionRange(np, np); } catch (e) { /* fine */ }
      emRemember(cand.e);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Runs on every input, caret move and click inside the textarea: find the
  // query at the caret, search, and show / refresh / hide the popover.
  function updateColonSuggest() {
    var ta = state.gta;
    if (!ta) return;
    var hit = emQueryAt(ta);
    if (!hit) {
      // The query is gone: either it never was one, or a closing ':' may
      // have just completed an exact token. Then no popover is needed.
      emTryClosedQuery(ta);
      closeColonSuggest();
      return;
    }
    var matches = emSearch(hit.q);
    if (!matches.length) { closeColonSuggest(); return; }
    emSugBuild();
    if (!em.sugEl) return;
    if (!em.sugOn || hit.q !== em.sugQ || hit.start !== em.sugStart) em.sugSel = 0;
    if (em.sugSel >= matches.length) em.sugSel = matches.length - 1;
    em.sugOn = true;
    em.sugQ = hit.q;
    em.sugStart = hit.start;
    em.sugEnd = hit.end;
    em.matches = matches;
    em.sugEl.textContent = '';
    for (var i = 0; i < matches.length; i++) em.sugEl.appendChild(emSugRow(matches[i], i));
    em.sugEl.hidden = false;
    emPaintSugSel();
    emPositionSug();
    emWireDoc();
  }

  function onComposeScrolled() {
    if (em.sugOn) emPositionSug(); // the textarea scrolled inside: reanchor
  }

  // Insert the picked row: the ':query' span (from the ':' to the caret)
  // becomes the emoji, the caret lands right after it, focus never leaves.
  function emPickSug(i) {
    var ta = state.gta;
    if (!ta || !em.sugOn || !em.matches || !em.matches[i]) return;
    // Stale guard: the value must still hold ':query' exactly where the
    // popover recorded it (a route change or send can swap the draft with
    // no input event). Otherwise this click is aimed at dead anchors.
    var v = ta.value || '';
    if (v.slice(em.sugStart, em.sugEnd) !== ':' + em.sugQ) { closeColonSuggest(); return; }
    var cand = em.matches[i];
    ta.value = v.slice(0, em.sugStart) + cand.e + v.slice(em.sugEnd);
    var pos = em.sugStart + cand.e.length;
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* fine */ }
    closeColonSuggest();
    emRemember(cand.e);
    try { ta.focus(); } catch (e2) { /* fine */ }
    updateColonSuggest();
  }

  // First gate of the textarea's keydown (see buildComposeBar). True means
  // the key was consumed by the emoji layer; false falls through untouched,
  // so Enter sends and Shift+Enter newlines exactly as before whenever no
  // suggestion is active.
  function handleEmojiKeys(ev) {
    if (!ev) return false;
    if (em.sugOn) {
      var ta = state.gta;
      var stale = true;
      if (ta) {
        var v = ta.value || '';
        stale = v.slice(em.sugStart, em.sugEnd) !== ':' + em.sugQ;
      }
      if (stale) {
        closeColonSuggest();
        return false; // dead popover: the key belongs to the normal handlers
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var n = em.matches ? em.matches.length : 0;
        if (n) {
          em.sugSel = (em.sugSel + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
          emPaintSugSel();
        }
        return true;
      }
      if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey)) {
        ev.preventDefault();
        emPickSug(em.sugSel);
        return true;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeColonSuggest();
        return true;
      }
      return false; // any other key keeps typing; the input listener re-queries
    }
    if (em.open && ev.key === 'Escape') {
      ev.preventDefault();
      closeEmojiPicker();
      return true;
    }
    return false;
  }

  /* ---------- boot ---------- */

  function initInternal() {
    if (state.inited) return;
    if (!mountRoot()) return; // fragment not pasted yet; a later init() can still run
    state.inited = true;
    syncLoadingBody(true); // V14 T5: first-load window; the first people answer clears it

    // Panes carry the reply-as identity, so the v2 chip layer stands down.
    document.body.classList.add('wab-render-live');
    // The central compose bar is the ONE entry box. Panes are built without
    // compose footers at all (V12.1 T3), so no stand-down class is needed.

    wireRoot();
    wirePeopleRail();
    buildComposeBar();
    buildScreenDots(); // V12.3 W1: the top dot row, before the first sync paints it
    wireShellEvents();
    wireTypingPush(); // V12.5 Y2: eng:on-typing -> header typing dots

    syncPanes();
    loadPrefs();
    loadAccounts();
    startPolls();
  }

  /* ---------- public surface (exactly the contract + the V12.2 screen API) ---------- */

  window.WABRender = {
    init: function () {
      try { initInternal(); } catch (e) { /* degrade quietly */ }
    },
    openConversation: function (spec) {
      try {
        var slot = targetOpenSlot();
        if (slot === -1) {
          toastRaw('No conversation pane is visible. Pick a layout first.');
          return;
        }
        if (slot !== state.activeSlot) setActiveSlot(slot, {});
        // V12.6 Z2: never a silent no-rect drop; openResolved resyncs,
        // retries once on the next frame, and toasts if the rect is gone.
        var pane = state.panes[slot] || ensurePane(slot);
        if (pane) pane.pendingSpec = spec || {};
        var person = resolveForOpen(spec || {});
        openResolved(slot, person, { focus: true });
      } catch (e) { /* degrade quietly */ }
    },
    // V12.2 U1: virtual screens. switchScreen mounts screen idx (0..5) into
    // the visible rect in single/tabs mode; screenInfo feeds the top dots
    // and any other consumer (busy = occupied, colors = account colors,
    // hasNew = a reply landed while the screen was unmounted).
    switchScreen: function (idx) {
      try { return switchScreen(idx); } catch (e) { return false; }
    },
    screenInfo: function () {
      try { return screenInfoData(); } catch (e) { return null; }
    },
    setPaneZoom: function (slot, delta) {
      try { setPaneZoom(slot, typeof delta === 'number' ? delta : (delta > 0 ? ZOOM_STEP : -ZOOM_STEP)); } catch (e) { /* degrade quietly */ }
    },
    toggleMaximize: function (slot) {
      try { toggleMaximize(slot); } catch (e) { /* degrade quietly */ }
    },
    toggleMinimize: function (slot) {
      try { toggleMinimize(slot); } catch (e) { /* degrade quietly */ }
    },
    renderMessages: function (slot, msgs) {
      try {
        slot = parseInt(slot, 10);
        if (isNaN(slot)) return;
        ensurePane(slot);
        renderMessages(slot, msgs || [], {});
        var pane = state.panes[slot];
        if (pane && pane.st !== 'live') setState(slot, 'live');
      } catch (e) { /* degrade quietly */ }
    },
    setState: function (slot, spec) {
      try {
        slot = parseInt(slot, 10);
        if (isNaN(slot)) return;
        ensurePane(slot);
        setState(slot, spec || { state: 'empty' });
      } catch (e) { /* degrade quietly */ }
    },
    // V13 D8: the sidekick's insert lands in the central compose bar. True
    // when it landed; false when the bar is not routed to a conversation,
    // or not to accountId when a context was given.
    insertIntoBar: function (accountId, text) {
      try { return insertIntoBar(accountId, text); } catch (e) { return false; }
    }
  };

  /* Auto-boot like the other UI modules; WABRender.init() stays a safe no-op
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
