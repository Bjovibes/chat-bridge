// engine-inject.js - Chat Bridge v12 engine-room bridge (owner D, contract V3 + V12 S2 + V12.1 T1 lid + V12.4 X1 send-speed + V12.5 Y1 typing + V12.6 Z1 model-first open + V12.7 F1 engine-sync).
// NOT a CommonJS module. Main reads this file as TEXT and runs it via
// webContents.executeJavaScript in each engine WebContentsView, main
// world. Idempotent (double-injection guard). Everything is guarded: no path
// throws and no returned promise ever rejects.
//
// Defines in the page world, exactly (contract "D - engine inject"):
//   window.__wabEng = {
//     ready(): Promise<bool>,                                  // idb reachable AND module runtime alive
//     listChats(): Promise<[{chatId, title, unread, t, archived}]>,
//     getContact(chatId): Promise<{name, phone}|null>,
//     getMessages(chatId, limit?): Promise<[{id, fromMe, text, ts, kind}]>,  // kind: text|system|media-placeholder; media rows carry mId = the msg id for getMedia
//     getMedia(chatId, msgId): Promise<{ok, kind, data, mime} | {ok:false, error}>, // V12.7 F1: media bytes fetched in page, dataURL capped at 1.5 MB
//     hasNewMessages(chatId): Promise<bool>,                   // V12.7 F1: msgs collection longer than the last getMessages count
//     openChat(chatId): Promise<{ok, error}>,
//     send(text): Promise<{ok, error}>,
//     getAvatars(limit?): Promise<[{title, avatar}]>,          // chat-list photos as dataURLs (2026-11-21)
//     getTyping(): Promise<[title, ...]>,                      // V12.5 Y1: chat titles with a live typing indicator
//     searchTargetCoords(query): Promise<{ok,boxX,boxY,firstRowX,firstRowY}|{ok:false,error}>, // V13 H4 D7: real-input search targets, css px centers
//     searchResultCoords(digits, title?): Promise<{x,y}|null>, // V13 H4 D7 + J1: data-id digit match first; optional title arg adds the fallback tier for id-less overlay rows
//     searchDone(): Promise<bool>,                             // V13 H4 D7: restore the curtains searchTargetCoords lifted
//     debugTitles(): Promise<number>,                          // V13 H4 D3: titles the last listChats run filled via the data-id tier (count only)
//     getMessagesHistory(chatId, pages?): Promise<{ok, messages, grewBy, hasMore, pagesRun}|{ok:false,error}>, // V13 J1: paged loader walk, full ascending read, never sends
//     hasMoreHistory(chatId): Promise<bool>,                   // V13 J1: one-load growth probe (cheap scroll decision)
//     insertDraft(text): Promise<{ok, verified, cleared}>,     // V13 J1 D6: passive composer insert + immediate clear; never the send button
//     debugTail(): [string],                                   // V12: last 20 open/send step names (+ J1 history/draft fixed tokens)
//     health(): Promise<{idb, modules, lastError}>
//   }
//
// Laws honored:
// - IndexedDB: READ-ONLY. Existence check via indexedDB.databases() BEFORE
//   any open (a versionless open creates the DB if absent, so never open a
//   missing DB). Versionless open (never upgrades an existing DB). Close on
//   onversionchange so WhatsApp's own upgrades are never blocked (Ferdium
//   pattern, notes/WAWEB-IDB-RESEARCH-2026-11-21.md section 6). Every read
//   is its own short readonly transaction; nothing is ever written.
// - Module runtime: WhatsApp's own in-page runtime, probed defensively via
//   the page's own window.require (whatsapp-web.js route) or a webpackChunk*
//   shim chunk (notes/WAWEB-DOM-RESEARCH-2026-11-21.md section 3). Absence
//   degrades: getMessages -> [], openChat -> DOM search fallback, health
//   reports modules:false. 3 s probe timeout, 5 s retry spacing.
// - V12 covered-page law: the engine views are WebContentsViews at FULL
//   window size, permanently COVERED by the UI view (never visible to the
//   operator). Covered elements still lay out (client rects exist) and still
//   take programmatic .click(), so every DOM tier below works blind. All
//   "visible" checks are layout checks, never eyes.
// - Privacy: no plaintext contact names or message text in ANY error, step,
//   or tail string. Errors and debugTail entries carry fixed step names and
//   selector-tier numbers ONLY (an exception contributes at most its
//   .message/.name, and only browser-generated ones ever reach that path).
//   No console output at all.
// - send(): ONLY the normative sequence from
//   notes/WAWEB-SEND-HIDDEN-RESEARCH-2026-11-21.md RECOMMENDED PATTERN
//   (composer resolve chain, focus, Selection range-replace insertText,
//   exact-match verify with one fresh-node retry, aria-first send button
//   then the wds-ic-send-filled SVG title token, visible-guard, plain real
//   click, delivery ack poll). V12 addition: after the click, if the
//   composer still holds the exact text at the end of the registration
//   window the click landed on nothing (stale node) -> re-resolve a FRESH
//   button and click once more before failing with 'send click did not
//   register' (X1: that window is 0.8 s and polled adaptively, exiting the
//   moment the draft provably leaves the box). Never synthesizes
//   Enter (dead by design: isTrusted:false is ignored). Refuses unless a
//   chat is open. The duplicate-send guard holds: the retry click fires only
//   when the draft provably never left the box.
// - V12.1 T1 lid law (the observed contact classes): every id compare and every id
//   key flows through idKey() (one parsed {raw, user, domain} per id, all
//   observed shapes). listChats joins names in four tiers: row fields,
//   then a contact-store index (raw id, then digit user part with an
//   ambiguity guard), then DOM chat-list titles matched by position, which
//   fill ONLY missing names, anchor-checked and conflict-checked, and never
//   guess (uncertain order stays Unknown). openChat/getMessages locate
//   chat models across id shapes (plain string, {._serialized}, {.$1},
//   {user,server}, .wid) and across the July 2026 @lid/@c.us remote flip
//   (same digit user part = the same human's twin keying), with the
//   collection's own find()/get() as an extra validated tier when exposed
//   (notes/WAWEB-IDB-RESEARCH-2026-11-21.md section 5.1). The send()
//   sequence steps, the debugTail contract and the privacy rules were
//   left unchanged by T1 (budgets were later tightened by the X1 law).
// - V12.4 X1 send-speed law (the "time to send should speed up
//   tremendously" ask): openChat keeps a lastOpenedChatId belief in module
//   scope; when the module route is alive AND the requested id equals the
//   last SUCCESSFUL open, one bounded liveness probe (strong
//   conversation-panel evidence first, else a live composer, else a still
//   resolvable model, all inside 300 ms) returns ok immediately instead of
//   re-running the pipeline ('open fast-path'). Any other id runs the full
//   pipeline under tightened budgets: ONE module verify attempt of 1.5 s,
//   the whole module phase capped at 2 s (probe and locate are
//   deadline-raced), then the DOM search route with its own 4 s cap, 6 s
//   overall. send() skips the fresh-open composer grace entirely when a
//   composer is already live at entry ('send fast-path'), polls click
//   registration adaptively (0.8 s cap) and returns on the FIRST positive
//   delivery signal inside a 2.5 s cap. The honesty law outranks every
//   budget: exact-match text verify, the wds-ic-send-filled button
//   discipline, retry-once only when the draft provably never left the
//   box, and a false "sent" remains worse than slow. A fast path that
//   cannot prove liveness falls through to the full pipeline; it never
//   guesses.
// - V12.5 Y1 typing law: getTyping() reports ONLY chat titles whose chat
//   currently shows WhatsApp's own typing state. Tier order, fastest
//   first: module runtime presence fields (chat.presence chatstate
//   'composing' and siblings, plus ONE bounded module-cache grep for a
//   presence collection: 500 ms cap, 30 s retry spacing, property reads
//   only, silent degrade), then the DOM chat list (the same LIST_CHAIN
//   rows the search fallback reads). A DOM row trips on (a) WEAK: an
//   aria-label/title attribute exactly equal to an EN typing string,
//   (b) STRONG: a data-icon containing 'typing', or a live CSS animation
//   on a tiny text-free element in the row's status line (right of the
//   avatar band, lower part of the row; locale-free), (c) BEST-EFFORT:
//   a status-line span exactly equal to an EN typing string. One pass,
//   no polling, max 100 rows, result cached 1 s (the spine polls every
//   2 s). Never throws, always resolves an array (empty when unknown).
//   Titles only: no message text, no contact names in any error or tail
//   string, and the open/send TAIL is never touched by this path.
// - V12.6 Z1 model-first open law (live probe 2026-11-21: the chat MODEL
//   resolves, the Cmd module is MISSING, and the DOM search can never
//   match a row for an untitled lid chat - the cannot-send bug). When
//   locateChatModel resolves the model, open THROUGH the model: after
//   the Cmd attempt, a bounded ladder enumerates open-ish callables
//   (the collections module's own export object, any webpack-cached
//   module export - or its .default - carrying a function named
//   /^openChat/ or showChat, and the model's own open/show/navigate
//   plus trigger('open')), tries each one safely (try/catch per call,
//   argument shapes {chat}, {chatId}, the bare model, the bare id
//   string) and verifies with the same domChatOpen heuristics after
//   EVERY call; the first verified win is cached (fn + shape) in
//   module scope and later opens reuse it as a one-call fast path.
//   Enumeration is bounded 500 ms using this file's own runtime capture
//   (the RUNTIME.req shim stash, else one fresh shim chunk, stashed
//   back), the whole ladder is bounded LADDER_TOTAL_MS inside the X1
//   6 s open budget, and a total miss spaces the next full ladder like
//   the runtime probe (PROBE_RETRY_MS) so the module cache is never
//   re-grepped on every open. Empty-title law: the DOM search route
//   NEVER runs with an empty or whitespace title (a guaranteed
//   no-match). When no title exists anywhere, the chat-list row whose
//   data-id matches the chat (idKey compare, idSibling twin-aware;
//   message-shaped ids containing '_' are skipped) donates its
//   rendered fallback title; still nothing -> the named honest error
//   'chat not openable (no title and no model route)'. getMessages,
//   send, typing and every X1 budget and fast path are untouched.
// - V12.7 F1 engine-sync law (live report 2026-11-21: sends die with
//   'chat did not open' because no open route lands, and fresh incoming
//   messages never reach getMessages for chats the engine itself never
//   opened). Root cause class: WhatsApp's per-chat message collections
//   LOAD LAZILY - a chat never opened in the engine's own WhatsApp holds
//   an empty or partial in-memory msgs collection, so reads are stale and
//   new arrivals never land in it. getMessages is now WARM-THEN-READ:
//   after locating the model, when msgs/messages exists its load-ish
//   functions (/load|fetch/i; the collection first, then the chat model
//   itself - whatsapp-web.js keeps loadEarlierMessages on the model) are
//   each invoked once, try/caught, thenables awaited once, all inside one
//   MSG_WARM_MS 1.5 s budget with an 8-call cap; a warm that grew nothing
//   spaces the next attempt by MSG_WARM_RETRY_MS so the spine poll never
//   re-burns the budget. The read returns whatever the collection then
//   holds, falling back to the pre-warm models when warming lost rows.
//   Media rows (sticker/image/video/audio/...) map to kind
//   'media-placeholder' with mId = the message id, and the renderer can
//   pull the bytes: getMedia(chatId, msgId) locates the message model
//   (T1-style strict serialized compare, then a validated bare-id +
//   remote-sibling compare), finds a URL (clienturl, then
//   mediaAttributes, then declaredThumbnail, then direct URL fields and a
//   data: body), fetches it IN PAGE and answers {ok, kind, data, mime}
//   with the dataURL capped at MEDIA_CAP 1.5 MB ('media too large' past
//   it, 'media unavailable' when nothing resolves); never throws, and
//   media bytes never reach any debug, tail or health string. V13 M1:
//   a msg miss first re-runs the getMessages warm (same WARMBK spacing)
//   and retries once before the unavailable label. openChat
//   grows three tiers around the DOM search: (a) WARM-OPEN after the Z1
//   ladder is exhausted - model.trigger with 'open'/'chat:open'/
//   'navigate' plus every /^setActiveChat/ export (added to the ladder
//   ranks as rank 3 and re-enumerated name-filtered so the candidate cap
//   cannot crowd them out), each call verified with domChatOpen, the
//   winner cached for one-call reuse; (b) PHONE SEARCH, in priority
//   before the title search for lid chats (a rendered +phone row can
//   never be matched by a stored name) and as the only search when no
//   usable title exists (never an empty-title search): derive the
//   contact's phone digits (classic id user part, the model's contact,
//   the contact store, the row-donated title's digits) and search with
//   the digit string - WhatsApp's own search resolves numbers; (c) when a
//   title search ran and found no row, ONE retry with the phone digits.
//   Wins record 'open: warm-open win' / 'open: phone search win'.
//   hasNewMessages compares the live msgs collection length (a bounded
//   readonly IDB message-store getAllKeys filter only when no model
//   resolves) against the per-chat lastCount getMessages records in
//   module scope after warming - the cheaper live source always decides.
//   Warming in getMessages IS the sync fix. The Z1 ladder mechanics, X1
//   budgets and fast paths, Y1 typing, T1 joins, avatars, the debugTail
//   discipline and the privacy laws are otherwise unchanged.
(function () {
  'use strict';
  try {
    if (typeof window === 'undefined' || !window.document) return;
    var W = window;
    var D = window.document;
    if (W.__wabEngInstalled) return; // double-injection guard
    W.__wabEngInstalled = true;

    // ============================ budgets (ms) ============================
    var PROBE_TIMEOUT = 3000;    // module runtime probe
    var PROBE_RETRY_MS = 5000;   // min spacing between failed probes
    var OPEN_TIMEOUT = 6000;     // X1: whole openChat budget (was 8 s)
    var MODULE_PHASE_MS = 2000;  // X1: whole module phase (probe + locate +
                                 // cmd + verify); the DOM route starts the
                                 // moment it passes, so a silent cmd can
                                 // never starve the DOM route again
    var MODULE_VERIFY_MS = 1500; // X1: ONE module-route verify attempt
                                 // (was 2 attempts x 2.5 s)
    var DOM_ROUTE_MS = 4000;     // X1: DOM search route internal cap (value
                                 // unchanged; now also hard-clamped against
                                 // the overall deadline)
    var FAST_LIVENESS_MS = 300;  // X1: open fast-path liveness probe
    var BOX_TIMEOUT = 500;       // search box appears
    var CLICK_GRACE = 1200;      // before the synthetic mouse fallback
    var STEP_MS = 150;           // generic poll step
    var BUTTON_TRIES = 12;       // send button poll: 12 x 100 ms
    var BUTTON_STEP_MS = 100;
    var ACK_TIMEOUT = 2500;      // X1: delivery ack poll cap (was 5 s);
                                 // returns on the FIRST positive signal
    var ACK_STEP_MS = 150;       // X1: ack poll step (was 250)
    var COMPOSE_GRACE_MS = 1200; // X1: fresh-open grace (was 1.5 s); runs
                                 // ONLY when no composer was live on the
                                 // first try (footer renders async)
    var CLICK_REGISTRATION_MS = 800; // X1: click-registration window cap
                                 // (was a fixed 1.5 s sleep); polled
                                 // adaptively at CLICK_REG_STEP_MS
    var CLICK_REG_STEP_MS = 100; // X1: adaptive registration poll step
    var TAIL_CAP = 20;           // V12: debugTail ring size
    var ROSTER_CAP = 500;        // listChats cap
    var MSG_CAP = 500;           // getMessages limit clamp
    var LOCATE_FIND_MS = 500;    // V12.1 T1: cap on one collection find() wait
    var TYPING_CACHE_MS = 1000;       // V12.5 Y1: getTyping result cache
    var TYPING_PROBE_MS = 500;        // V12.5 Y1: cap on the presence cache grep
    var TYPING_PRESENCE_RETRY_MS = 30000; // V12.5 Y1: spacing between presence greps
    var TYPING_PRESENCE_CAP = 200;    // V12.5 Y1: presence models read per pass
    var TYPING_ROW_CAP = 100;         // V12.5 Y1: DOM rows scanned per pass
    var TYPING_ANIM_CAP = 60;         // V12.5 Y1: per-row animation candidates
    var TYPING_PASS_MS = 400;         // V12.5 Y1: soft wall for one DOM pass
    var LADDER_ENUM_MS = 500;         // V12.6 Z1: enumerate open-ish callables
    var LADDER_TOTAL_MS = 2000;       // V12.6 Z1: whole model-first ladder cap
                                      // (the cmd attempt keeps its X1
                                      // MODULE_PHASE_MS; the ladder runs after
                                      // it, deadline-clamped inside the X1
                                      // overall OPEN_TIMEOUT)
    var LADDER_VERIFY_MS = 350;       // V12.6 Z1: per-call open verify window
    var LADDER_VERIFY_STEP_MS = 70;   // V12.6 Z1: ladder verify poll step
    var LADDER_CACHE_MS = 600;        // V12.6 Z1: cached-winner fast-path verify
    var LADDER_MAX_CANDS = 10;        // V12.6 Z1: candidates enumerated per open
    var LADDER_MAX_CALLS = 20;        // V12.6 Z1: hard call cap; the deadline
                                      // usually cuts first
    var MSG_WARM_MS = 1500;           // V12.7 F1: total warm budget per getMessages read
    var MSG_WARM_FN_CAP = 8;          // V12.7 F1: max load-ish calls per read
    var MSG_WARM_RETRY_MS = 10000;    // V12.7 F1: spacing after a no-growth warm
    var MEDIA_CAP = 1572864;          // V12.7 F1: dataURL cap (1.5 MB)
    var MEDIA_FETCH_MS = 8000;        // V12.7 F1: in-page media fetch bound
    var MEDIA_BLOB_MS = 2500;         // V12.7 F1: blob() / FileReader bound
    var MSG_KEY_CAP = 5000;           // V12.7 F1: IDB message-store key scan cap
    var WARM_OPEN_MS = 1000;          // V12.7 F1: warm-open tier cap
    var WARM_ENUM_MS = 250;           // V12.7 F1: setActiveChat enumeration bound
    var HIST_TOTAL_MS = 25000;        // V13 J1: whole getMessagesHistory budget
    var HIST_PAGE_MAX = 20;           // V13 J1: hard page-loop cap (endless-
                                      // scroll law: 20 pages per call; the
                                      // renderer calls again to go deeper)
    var HIST_SETTLE_MS = 700;         // V13 J1: post-warm growth settle poll
                                      // per page (STEP_MS steps, exits the
                                      // moment the collection grows)

    var MODEL_DB = 'model-storage'; // the only DB we ever touch (research law)

    // ============================ health record ============================
    var HEALTH = { idb: false, modules: false, lastError: null };
    // step is a fixed string. A string payload is always one of our own
    // fixed labels; an exception contributes ONLY its class name (e.name,
    // e.g. TypeError), never its message text, so even a foreign
    // WhatsApp-thrown exception can never carry a contact name or message
    // text into health.lastError.
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

    // ============================ X1 open belief ============================
    // lastOpenedChatId: the raw id of the most recent openChat that returned
    // ok:true during THIS injection's lifetime. The only actors that can
    // change which chat the engine view shows are our own openChat calls
    // (the engine views are permanently covered, no human ever clicks them;
    // every open that succeeds refreshes this belief) and a page reload
    // (which wipes this whole scope, belief included). So belief + a
    // liveness probe is an honest fast path, and a belief that cannot be
    // proven live falls through to the full pipeline. Compared via idEq
    // only (same domain, never a bare string compare); never surfaced in
    // any error, step, or tail string.
    var lastOpenedChatId = '';

    // ============================ V12.7 F1 sync bookkeeping ============================
    // MSGCOUNT: per-chat message count getMessages records AFTER warming;
    // the drift baseline hasNewMessages compares the live collection
    // against. WARMBK: per-chat warm spacing so a collection that never
    // grows does not re-burn the warm budget on every spine poll. Keys are
    // raw chat ids; values are numbers/booleans only - never names, never
    // message text (privacy law).
    var MSGCOUNT = {};
    var WARMBK = {};
    function msgCountKey(id) {
      try { var k = keyOf(id); return (k && k.raw) ? k.raw : ''; } catch (e) { return ''; }
    }
    function msgCountNote(id, n) {
      try {
        var k = msgCountKey(id);
        if (!k || typeof n !== 'number') return;
        if (MSGCOUNT[k] === undefined) {
          var keys = Object.keys(MSGCOUNT);
          if (keys.length >= 400) delete MSGCOUNT[keys[0]]; // bounded map
        }
        MSGCOUNT[k] = n;
      } catch (e) {}
    }

    // ============================ V12 step tail ============================
    // debugTail() ring: the last TAIL_CAP step strings pushed by the open /
    // send paths. Fixed step names + selector-tier numbers ONLY (privacy
    // law: never a contact name, never message text). Cleared at the start
    // of every openChat / send call, so the tail always describes the most
    // recent operation. The spine (debug panel) reads it via
    // window.__wabEng.debugTail().
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
      // whitespace-insensitive compare helper: a contenteditable DOM loses
      // explicit newlines in textContent, so exact string equality is checked
      // with whitespace collapsed on both sides
      try { return String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
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
    // poll fn() until it returns truthy or the wall-clock deadline passes.
    // setTimeout chain, first check immediate, never a busy loop.
    function pollUntil(deadline, fn, stepMs) {
      return new W.Promise(function (resolve) {
        var tick = function () {
          var v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) { resolve(v); return; }
          if (Date.now() >= deadline) { resolve(null); return; }
          W.setTimeout(tick, stepMs || STEP_MS);
        };
        tick();
      });
    }
    // fixed-count poll (send button): re-queries the DOM every tick, the
    // node is never cached (the footer re-renders on empty/filled swaps)
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
    // X1: bound a promise at a wall-clock deadline. Resolves with the
    // promise's value when it settles in time, else null. The underlying
    // promise keeps running and may still update module state (a late probe
    // win is not wasted); we simply stop waiting, so a slow probe or a hung
    // collection find can never eat a phase budget. Callers treat null as a
    // miss and hand over to the next route; never as failure.
    function raceDeadline(p, deadline) {
      var remain = deadline - Date.now();
      if (remain <= 0) return W.Promise.resolve(null);
      return W.Promise.race([
        W.Promise.resolve(p),
        sleep(remain).then(function () { return null; })
      ]);
    }

    // ============================ ID normalization ============================
    // One canonical string out of every id shape WhatsApp has shipped:
    // plain string | {._serialized} (pre Jul 2026) | {.$1} (Jul 2026 rename,
    // whatsapp-web.js issue #201833) | {fromMe, remote, id} (message id
    // objects, remote may be @lid) | {user, server}. Returns '' when no
    // canonical form is recoverable, so callers fail closed.
    function normId(v) {
      try {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        if (typeof v === 'object') {
          if (typeof v._serialized === 'string') return v._serialized;
          if (typeof v.$1 === 'string') return v.$1;
          if (typeof v.remote === 'string' && v.id !== undefined) {
            // message id object: rebuild the serialized form
            return (v.fromMe === true ? 'true' : 'false') + '_' + v.remote + '_' + normId(v.id);
          }
          if (typeof v.user === 'string' && typeof v.server === 'string') {
            return v.user + '@' + v.server;
          }
        }
      } catch (e) {}
      return '';
    }

    // ============================ V12.1 T1: idKey ============================
    // THE canonical id parser (July 2026 id churn, whatsapp-web.js issue
    // #201833). Every id compare and every id key in this file goes through
    // these helpers. Observed input shapes -> one parsed key {raw, user,
    // domain}:
    //
    //   shape                             raw                    user       domain
    //   --------------------------------  ---------------------  ---------  -------
    //   "123456789@c.us"                  "123456789@c.us"       123456789  c.us
    //   "123456789@lid"                   "123456789@lid"        123456789  lid
    //   "1203630...@g.us" (group)         unchanged              digits     g.us
    //   {._serialized:"...@c.us"}         the _serialized value  digits     from raw
    //   {.$1:"...@lid"}                   the $1 value           digits     from raw
    //   {user:"...", server:"lid"}        user + "@" + server    digits     from raw
    //   {fromMe, remote, id} (message)    fromMe_remote_id       digits     from raw
    //   model.wid (any shape above)       ditto                  digits     from raw
    //   anything unrecoverable            '' (fails closed)      -          -
    //
    // user = the digit run immediately before the @remote; ids without one
    // (status@broadcast) parse with user ''. idEq demands the SAME domain;
    // idSibling additionally accepts the @lid/@c.us TWIN (same digits,
    // different remote), which is how the July 2026 churn splits one human
    // across two store keyings. Digit bridges only ever fire at >= 6 digits,
    // and only in the name join, the contact bridge and the model locator,
    // never in a bare key compare.
    function idKey(v) {
      var raw = normId(v);
      if (!raw) return null;
      try {
        var m = /(\d+)@([A-Za-z0-9.]+)/.exec(raw);
        if (!m) return { raw: raw, user: '', domain: '' };
        return { raw: raw, user: m[1], domain: m[2] };
      } catch (e) { return { raw: raw, user: '', domain: '' }; }
    }
    // accepts an already-parsed key or any raw id shape
    function keyOf(v) {
      if (v && typeof v === 'object' && typeof v.raw === 'string') return v;
      return idKey(v);
    }
    function idEq(a, b) {
      var ka = keyOf(a), kb = keyOf(b);
      if (!ka || !kb) return false;
      if (ka.raw === kb.raw) return true;
      return !!(ka.user && ka.domain && ka.user === kb.user && ka.domain === kb.domain);
    }
    function idSibling(a, b) {
      var ka = keyOf(a), kb = keyOf(b);
      if (!ka || !kb) return false;
      if (idEq(ka, kb)) return true;
      return !!(ka.user && ka.user.length >= 6 && ka.user === kb.user &&
                ka.domain && kb.domain && ka.domain !== kb.domain);
    }
    // id of a live chat model: .id first (any shape), then .wid
    function modelIdKey(ch) {
      var k = null;
      try { k = idKey(ch && ch.id); } catch (e) {}
      if (!k) { try { k = idKey(ch && ch.wid); } catch (e2) {} }
      return k;
    }

    // ============================ IndexedDB (read-only) ============================
    var idbDb = null; // cached connection, dropped on versionchange

    function reqP(req) {
      return new W.Promise(function (res, rej) {
        try {
          req.onsuccess = function () { res(req.result); };
          req.onerror = function () { rej(req.error || new Error('idb request failed')); };
        } catch (e) { rej(e); }
      });
    }

    // Ferdium pattern: existence check FIRST (a versionless open of a missing
    // DB creates it), versionless open (never upgrades an existing DB),
    // onversionchange closes (never blocks WhatsApp's own upgrades). No
    // onupgradeneeded handler is registered anywhere in this file.
    function ensureOpen() {
      if (idbDb) return W.Promise.resolve(idbDb);
      return new W.Promise(function (resolve, reject) {
        var done = false;
        var fail = function (msg) {
          if (done) return; done = true;
          HEALTH.idb = false;
          noteError('idb', msg); // msg is always one of the fixed labels below
          reject(msg);
        };
        try {
          if (!W.indexedDB || typeof W.indexedDB.databases !== 'function') {
            fail('indexeddb unavailable'); return;
          }
          W.indexedDB.databases().then(function (list) {
            if (done) return;
            var found = false;
            for (var i = 0; i < (list || []).length; i++) {
              if (list[i] && list[i].name === MODEL_DB) { found = true; break; }
            }
            if (!found) { fail('model-storage absent'); return; } // not logged in yet: never create it
            var req;
            try { req = W.indexedDB.open(MODEL_DB); } // versionless: no upgrade attempt
            catch (eO) { fail('open failed'); return; }
            req.onsuccess = function () {
              if (done) return;
              var db = req.result;
              var hasChat = false;
              try { hasChat = !!(db.objectStoreNames && db.objectStoreNames.contains('chat')); }
              catch (eS) { hasChat = false; }
              if (!hasChat) {
                // raced creation or still schemaless: do not cache, do not use
                try { db.close(); } catch (eC) {}
                fail('model-storage not readable'); return;
              }
              db.onversionchange = function () {
                try { db.close(); } catch (eV) {}
                if (idbDb === db) { idbDb = null; HEALTH.idb = false; }
              };
              idbDb = db;
              HEALTH.idb = true;
              done = true;
              resolve(db);
            };
            req.onerror = function () { fail('open failed'); };
            req.onblocked = function () { /* versionless opens never queue an upgrade; ignore */ };
          }).catch(function () { fail('databases check failed'); });
        } catch (e) { fail('open failed'); }
      });
    }

    // one short readonly transaction per call, auto-committed when its
    // single request settles; nothing is ever written
    function openStore(name) {
      return ensureOpen().then(function (db) {
        if (!db.objectStoreNames || !db.objectStoreNames.contains(name)) {
          throw 'store unavailable: ' + name; // fixed label; store names are static strings
        }
        return db.transaction(name, 'readonly').objectStore(name);
      });
    }
    function getAllFrom(name) {
      return openStore(name).then(function (os) { return reqP(os.getAll()); });
    }
    function getFrom(name, key) {
      return openStore(name).then(function (os) { return reqP(os.get(key)); });
    }

    // ============================ module runtime ============================
    // Goal: WhatsApp's own collections (WAWebCollections: .Chat .Msg ...)
    // and cmd (WAWebCmd: openChatBottom). Routes, in order:
    //   1. the page's own window.require with known module names
    //      (whatsapp-web.js technique; W.require is the PAGE's function,
    //      never a Node global)
    //   2. webpackChunk* scan + shim chunk whose factory captures the real
    //      require, then a shape walk of the require.c module cache
    //      (hsperker technique, WAWEB-DOM-RESEARCH section 3)
    // health.modules tracks collections availability; cmd is optional
    // (without it openChat falls to the Z1 model-first ladder, then the
    // DOM search route).
    var RUNTIME = { collections: null, cmd: null, ok: false, lastTry: 0 };

    function looksLikeCollections(x) {
      return !!(x && typeof x === 'object' && x.Chat && x.Msg);
    }
    function looksLikeCmd(x) {
      return !!(x && typeof x === 'object' && typeof x.openChatBottom === 'function');
    }

    function tryNamedRequire(req) {
      var out = { collections: null, cmd: null };
      var colNames = ['WAWebCollections', 'WAWebStore', 'Store'];
      var cmdNames = ['WAWebCmd', 'WAWebCmdImpl'];
      var i, m, c;
      for (i = 0; i < colNames.length; i++) {
        try {
          m = req(colNames[i]);
          c = (m && m.default && !looksLikeCollections(m)) ? m.default : m;
          if (looksLikeCollections(c)) { out.collections = c; break; }
        } catch (e) {}
      }
      for (i = 0; i < cmdNames.length; i++) {
        try {
          m = req(cmdNames[i]);
          c = (m && m.default && !looksLikeCmd(m)) ? m.default : m;
          if (looksLikeCmd(c)) { out.cmd = c; break; }
        } catch (e) {}
      }
      return (out.collections || out.cmd) ? out : null;
    }

    function chunkArrays() {
      var out = [], keys;
      try { keys = Object.keys(W); } catch (e) { return out; }
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('webpackChunk') === 0) {
          try { if (Array.isArray(W[keys[i]])) out.push(W[keys[i]]); } catch (e1) {}
        }
      }
      return out;
    }

    // shim chunk: whatsapp-web.js form [ [chunkId], {}, factory ]. The factory
    // receives the real webpack require as an argument; capture any argument
    // that looks like it (a function with a .c module cache, or a runtime
    // object with .c/.m), falling back to the last function argument.
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
      } catch (e) {}
      return captured;
    }

    function walkCache(req) {
      var cache = null;
      try { cache = req.c; } catch (e) { cache = null; }
      if (!cache) return null;
      var out = { collections: null, cmd: null };
      try {
        for (var k in cache) {
          var exp;
          try { exp = cache[k] && cache[k].exports; } catch (e1) { continue; }
          if (!exp) continue;
          if (!out.collections && looksLikeCollections(exp)) { out.collections = exp; continue; }
          if (!out.cmd && looksLikeCmd(exp)) { out.cmd = exp; continue; }
          try {
            if (exp.default && exp.default !== exp) {
              if (!out.collections && looksLikeCollections(exp.default)) { out.collections = exp.default; continue; }
              if (!out.cmd && looksLikeCmd(exp.default)) { out.cmd = exp.default; continue; }
            }
          } catch (e2) {}
        }
      } catch (e3) {}
      return (out.collections || out.cmd) ? out : null;
    }

    // D1: cheap synchronous liveness of the CAPTURED runtime. Never pushes
    // a shim chunk and never costs more than a few property reads (the
    // req.c walk stops at the first key). It can only DOWNGRADE a cached
    // ok; only a real probe may set ok=true. Idiom mirrors the existing
    // RUNTIME.req.c reads in the presence grep and getMedia.
    function runtimeAlive() {
      try {
        if (typeof W.require === 'function' && W.require.c) return true;
        if (RUNTIME.req && typeof RUNTIME.req.c === 'object' && RUNTIME.req.c) {
          for (var kAlive in RUNTIME.req.c) return true; // first key proves a live non-empty cache
        }
        if (RUNTIME.collections && looksLikeCollections(RUNTIME.collections)) return true;
      } catch (eA) {}
      return false;
    }

    function probeRuntime(force) {
      // V12: force=true bypasses BOTH the ok short-circuit and the retry
      // spacing, so openChat can demand one fresh probe when the captured
      // runtime holds a stale/empty Chat collection. All other callers pass
      // false and see unchanged behavior.
      // D1: the ok short-circuit now proves liveness first. A cached ok
      // whose captured runtime is gone (page world survived, its bundle
      // did not) is cleared on the spot and the same call runs a fresh
      // probe, so a stale true can never outlive the runtime it promised.
      if (RUNTIME.ok && !force) {
        if (runtimeAlive()) return W.Promise.resolve(true);
        RUNTIME.ok = false; HEALTH.modules = false;
        HEALTH.lastError = 'module runtime unavailable';
      }
      var now = Date.now();
      if (!force && now - RUNTIME.lastTry < PROBE_RETRY_MS) return W.Promise.resolve(false);
      RUNTIME.lastTry = now;
      var probeStart = now;
      return new W.Promise(function (resolve) {
        var settled = false;
        var timer = W.setTimeout(function () {
          if (settled) return; settled = true;
          RUNTIME.ok = false; HEALTH.modules = false;
          HEALTH.lastError = 'module runtime unavailable';
          resolve(false);
        }, PROBE_TIMEOUT);
        var finish = function (ok) {
          if (settled) return; settled = true;
          try { W.clearTimeout(timer); } catch (eT) {}
          RUNTIME.ok = ok;
          HEALTH.modules = ok;
          if (!ok) {
            HEALTH.lastError = 'module runtime unavailable';
            // D1: an INSTANT fail (no webpack arrays on the page, the dead
            // shell case) costs nothing; roll the retry clock back so the
            // very next API call probes again instead of skipping. A probe
            // that burned real time (timeout at 3 s, or a slow cache walk)
            // keeps its spacing.
            if (Date.now() - probeStart < 250) RUNTIME.lastTry = 0;
          }
          resolve(ok);
        };
        try {
          var found = null;
          // route 1: the page's own require
          if (typeof W.require === 'function') {
            try { found = tryNamedRequire(W.require); } catch (eR) {}
          }
          // route 2: webpack shim + cache walk
          if (!found) {
            var arrs = chunkArrays();
            for (var i = 0; i < arrs.length; i++) {
              var req = captureViaShim(arrs[i]);
              if (!req) continue;
              try { RUNTIME.req = req; } catch (eStash) {} // V12.5 Y1: reused by the typing presence grep so a second shim chunk is never pushed
              var named = null;
              try { named = tryNamedRequire(req); } catch (eN) {}
              var walked = null;
              try { walked = walkCache(req); } catch (eW) {}
              if (named || walked) {
                found = {
                  collections: (named && named.collections) || (walked && walked.collections) || null,
                  cmd: (named && named.cmd) || (walked && walked.cmd) || null
                };
                break;
              }
            }
          }
          if (found && found.collections) {
            RUNTIME.collections = found.collections;
            if (found.cmd) RUNTIME.cmd = found.cmd;
            finish(true); // collections are what health.modules promises
          } else if (found && found.cmd && !found.collections) {
            // cmd alone: useful for openChat, but modules flag tracks collections
            RUNTIME.cmd = found.cmd;
            finish(false);
          } else {
            finish(false);
          }
        } catch (eP) { finish(false); }
      });
    }

    // collection model extraction, defensive across collection shapes
    function collectionModels(col) {
      try {
        if (!col) return null;
        if (typeof col.getModelsArray === 'function') {
          var a = col.getModelsArray();
          if (Array.isArray(a)) return a;
        }
        if (Array.isArray(col.models)) return col.models;
        if (Array.isArray(col._models)) return col._models;
        if (typeof col.getAll === 'function') {
          var b = col.getAll();
          if (Array.isArray(b)) return b;
        }
      } catch (e) {}
      return null;
    }

    // V12.1 T1: strict model finder (getMessages core, shared with the
    // locator below). Accepts every id shape via idKey (id.$1,
    // id._serialized, {user,server}, .wid, plain string); equality is idKey
    // equality (raw, or same digits under the SAME domain), never a bare
    // string compare, never cross-domain.
    function findChatModel(chatId) {
      var col = null;
      try { col = RUNTIME.collections && RUNTIME.collections.Chat; } catch (e) { col = null; }
      var models = collectionModels(col);
      if (!models) return null;
      var want = keyOf(chatId);
      if (!want) return null;
      for (var i = 0; i < models.length; i++) {
        try {
          var k = modelIdKey(models[i]);
          if (k && idEq(k, want)) return models[i];
        } catch (e2) {}
      }
      return null;
    }

    // V12 (openChat only): is the captured Chat collection stale/empty?
    // Empty here means: no collection at all, or zero models in it (early
    // injection, roster not yet hydrated). A NON-empty collection without
    // our chat is not stale, it just does not hold that chat.
    function chatCollectionEmpty() {
      try {
        var col = RUNTIME.collections && RUNTIME.collections.Chat;
        if (!col) return true;
        var m = collectionModels(col);
        return !m || m.length === 0;
      } catch (e) { return true; }
    }

    // V12.1 T1 (openChat + getMessages) model locator. The strict core
    // (findChatModel) is shape-tolerant but same-domain. locateChatModel
    // adds two bounded lid-era tiers on top, in order:
    //   1. strict:  findChatModel (idKey equality, same domain)
    //   2. find:    the collection's own search (find(), then get()), tried
    //               with the raw id and the twin remote forms (digits@lid /
    //               digits@c.us). Every result is VALIDATED (same digit user
    //               part, >= 6 digits) before use, so a foreign hit can
    //               never be accepted. A thenable find is awaited under
    //               LOCATE_FIND_MS so it can never eat the open budget.
    //   3. twin:    scan the collection for the @lid/@c.us twin model with
    //               the same digit user part (>= 6 digits). The July 2026
    //               churn splits one human across two keyings; when the
    //               digits match, it is the same human, and when they do
    //               not, nothing fires (different digits are different
    //               chats, full stop; no fuzzy matching exists here).
    // LOCATE.tier records which tier hit ('strict' | 'find' | 'twin') for
    // the step tail (fixed tokens only).
    var LOCATE = { tier: '' };
    function resolveChatModel(id) {
      return findChatModel(id); // strict, shape-tolerant, same-domain
    }
    function validFoundModel(m, want) {
      if (!m || !want || !want.user || want.user.length < 6) return null;
      var k = modelIdKey(m);
      if (!k || !k.user || k.user !== want.user) return null;
      return m;
    }
    async function collectionSearchModel(want) {
      var col = null;
      try { col = RUNTIME.collections && RUNTIME.collections.Chat; } catch (e0) { col = null; }
      if (!col || !want || !want.user || want.user.length < 6) return null;
      var attempts = [];
      if (want.raw) attempts.push(want.raw);
      if (want.domain !== 'lid') attempts.push(want.user + '@lid');
      if (want.domain !== 'c.us') attempts.push(want.user + '@c.us');
      for (var i = 0; i < attempts.length; i++) {
        var m = null, r = null;
        try {
          if (typeof col.find === 'function') {
            r = col.find(attempts[i]);
            if (r && typeof r.then === 'function') {
              // bounded: a hung find can never eat the open/send budget
              r = await new W.Promise(function (res) {
                var done = false;
                W.setTimeout(function () { if (!done) { done = true; res(null); } }, LOCATE_FIND_MS);
                try {
                  r.then(function (x) { if (!done) { done = true; res(x); } },
                         function () { if (!done) { done = true; res(null); } });
                } catch (eT) { if (!done) { done = true; res(null); } }
              });
            }
            m = validFoundModel(r, want);
            if (m) return m;
          }
          if (typeof col.get === 'function') {
            m = validFoundModel(col.get(attempts[i]), want);
            if (m) return m;
          }
        } catch (eF) { /* next attempt */ }
      }
      return null;
    }
    function twinChatModel(want) {
      if (!want || !want.user || want.user.length < 6) return null;
      var col = null;
      try { col = RUNTIME.collections && RUNTIME.collections.Chat; } catch (e0) { col = null; }
      var models = collectionModels(col);
      if (!models) return null;
      for (var i = 0; i < models.length; i++) {
        var k = null;
        try { k = modelIdKey(models[i]); } catch (e1) { k = null; }
        if (k && k.user === want.user && k.domain && k.domain !== want.domain) return models[i];
      }
      return null;
    }
    async function locateChatModel(id) {
      LOCATE.tier = '';
      var want = keyOf(id);
      if (!want) return null;
      var m = resolveChatModel(want); // strict core, never bridges domains
      if (m) { LOCATE.tier = 'strict'; return m; }
      try {
        m = await collectionSearchModel(want);
        if (m) { LOCATE.tier = 'find'; return m; }
      } catch (eS) {}
      m = twinChatModel(want);
      if (m) { LOCATE.tier = 'twin'; return m; }
      LOCATE.tier = '';
      return null;
    }

    function modelTitle(chat) {
      if (!chat) return '';
      var c = chat.contact;
      return firstStr(
        chat.name, chat.formattedName, chat.formattedTitle, chat.subject,
        (c && (c.name || c.pushname || c.formattedName))
      );
    }

    // ============================ title normalization ============================
    // (KEEP IN SYNC with privacy-inject.js / open-chat-inject.js /
    // src/shared/normalize.js; used by the openChat DOM fallback only,
    // never surfaced in any error string)
    var EMOJI_RE = (function () {
      try { return new RegExp('[\\p{Extended_Pictographic}]', 'gu'); }
      catch (e) { return /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu; }
    })();
    var STRIP_RE = (function () {
      try { return new RegExp('[\\p{P}\\p{S}\\p{M}\\p{C}]', 'gu'); }
      catch (e) { return /[!-/:-@[-`{-\u007F]/gu; }
    })();
    var DIGITS_RE = (function () {
      try { return new RegExp('[\\p{Nd}]+', 'gu'); }
      catch (e) { return /[0-9]+/g; }
    })();
    function normalizeTitle(str) {
      if (typeof str !== 'string') return '';
      var t = str.normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[​-‏﻿]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ');
      try {
        t = t.replace(EMOJI_RE, '').replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
      } catch (e) { t = t.trim(); }
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

    // ============================ DOM helpers ============================
    var TIME_ONLY_RE = /^\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i;

    function firstText(sel) {
      var el = qsa(sel)[0];
      return el ? collapsed(el) : '';
    }
    function headerTitle() {
      var t = firstText('header [data-testid="conversation-info-header-chat-title"]');
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
          var x = collapsed(s);
          if (x.length > n) { best = x; n = x.length; }
        });
        if (best) return best;
      } catch (e) {}
      return '';
    }
    function setDeclutter(on) {
      try { if (typeof W.__wabSetDeclutter === 'function') W.__wabSetDeclutter(on); } catch (eS) {}
      try {
        if (on) D.documentElement.classList.add('wab-declutter');
        else D.documentElement.classList.remove('wab-declutter');
      } catch (eC) {}
    }
    function setThreadCrop(on) {
      try { if (typeof W.__wabSetThreadCrop === 'function') W.__wabSetThreadCrop(on); } catch (eS) {}
      try {
        if (on) D.documentElement.classList.add('wab-threadcrop');
        else D.documentElement.classList.remove('wab-threadcrop');
      } catch (eC) {}
    }

    // ---- openChat verification (strong: message data-id remote part equals
    // the chatId; weak: conversation-container evidence (a live composer or
    // the messages pane) plus header title match; the intro panel still
    // present means nothing is open). Title comparisons stay internal,
    // they are never surfaced in error strings. ----
    function domChatOpen(chatId, title) {
      try {
        if (D.querySelector('[data-testid="intro-panel"]')) return false; // bonus signal only (testid unverified)
        var wraps = qsa('[data-id]');
        for (var i = 0; i < wraps.length; i++) {
          var v = wraps[i].getAttribute('data-id') || '';
          var parts = v.split('_'); // serialized: ${fromMe}_${remote}_${id}
          // V12.1 T1: idKey compare; idSibling also accepts the @lid/@c.us
          // twin (same digits) so a bridged lid open still verifies strong
          if (parts.length >= 3 && idSibling(parts[1], chatId)) return true;
        }
        // V12 conversation-container evidence: a live composer OR the
        // messages pane exists (research: absence of
        // [data-testid="conversation-panel-messages"] = no chat open)
        var compose = D.querySelector('#main footer div[contenteditable="true"]') ||
                      D.querySelector('footer div[contenteditable="true"]');
        var container = !!compose || !!D.querySelector('[data-testid="conversation-panel-messages"]');
        if (container && title && titlesMatch(headerTitle(), title)) return true; // weak signal
        return false;
      } catch (e) { return false; }
    }

    // ---- search machinery for the openChat DOM fallback (v2 pattern) ----
    // Tier order: the 2026 chat-list-search-container first (verified
    // 2026-07), then the chatlist-header block (2026-07), then the legacy
    // title-attr and #side shapes. BOX_TIER records which link hit for the
    // step tail.
    var BOX_CHAIN = [
      '[data-testid="chat-list-search-container"] div[contenteditable="true"]',
      '[data-testid="chat-list-search-container"] input[type="text"]',
      '[data-testid="chatlist-header"] div[contenteditable="true"]',
      'div[title="Search input textbox"]',
      '#side header div[data-tab="3"]',
      '#side header div[contenteditable="true"]',
      '#side div[contenteditable="true"]',
      '#side header input[type="text"]'
    ];
    var BOX_TIER = 0;
    function findSearchBox() {
      for (var i = 0; i < BOX_CHAIN.length; i++) {
        var el = qsa(BOX_CHAIN[i])[0];
        if (el) { BOX_TIER = i + 1; return el; }
      }
      BOX_TIER = 0;
      return null;
    }
    function typeIntoBox(box, title) {
      var isInput = false;
      try { isInput = (box.tagName || '').toLowerCase() === 'input'; } catch (eT) { isInput = false; }
      if (isInput) {
        try {
          box.value = title;
          box.dispatchEvent(new W.Event('input', { bubbles: true }));
        } catch (eV) {}
        try { return String(box.value) === title; } catch (eR) { return false; }
      }
      try { box.focus(); } catch (eF) {}
      try {
        var sel = W.getSelection();
        var range = D.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (eSel) {}
      var inserted = false;
      try { inserted = !!D.execCommand('insertText', false, title); } catch (eI) { inserted = false; }
      var probe = normWs(title).slice(0, 24);
      if (probe && normWs(box.textContent || '').indexOf(probe) !== -1) return true;
      try {
        box.dispatchEvent(new W.InputEvent('input', { inputType: 'insertText', data: title, bubbles: true }));
      } catch (eE) {}
      return !!probe && normWs(box.textContent || '').indexOf(probe) !== -1;
    }
    function visible(el) {
      // COVERED-page law: covered elements still lay out, so client rects
      // exist; this is a layout check, not an eyes check.
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
    // V12: BOTH 2026 result surfaces are collected on every call (the old
    // code returned the overlay exclusively when it existed, so a late or
    // partial overlay blocked the live-filtered list from ever matching):
    //   overlay      - the search dropdown ([data-testid="overlay"]), role=button rows
    //   matched-name - .matched-name highlights anywhere (overlay or list)
    //   list         - the live-filtered chat list; the roster narrows as
    //                  you type and small result sets may spawn no overlay
    // Candidates are deduped by element; overlay candidates come first, so
    // the strongest surface still wins a tie. Each candidate carries its
    // source for the step tail.
    function findResultCandidates() {
      var out = [], seen = [], i, j, rows;
      function add(el, src) {
        if (!el || seen.indexOf(el) !== -1) return;
        seen.push(el);
        out.push({ el: el, src: src });
      }
      rows = qsa('[data-testid="overlay"] [role="button"]');
      for (i = 0; i < rows.length; i++) add(rows[i], 'overlay');
      var names = qsa('.matched-name');
      for (i = 0; i < names.length; i++) add(clickableAncestor(names[i]), 'matched-name');
      var overlays = qsa('[data-testid="overlay"]');
      for (i = 0; i < overlays.length; i++) {
        rows = qsa('[role="button"], [role="listitem"], [role="row"]', overlays[i]);
        for (j = 0; j < rows.length; j++) add(rows[j], 'overlay');
        if (!rows.length) {
          var kids = qsa('span[dir="auto"], div[dir="auto"]', overlays[i]);
          for (j = 0; j < kids.length; j++) {
            add(clickableAncestor(kids[j]) || kids[j].parentElement, 'overlay');
          }
        }
      }
      for (i = 0; i < LIST_CHAIN.length; i++) {
        rows = qsa(LIST_CHAIN[i]).filter(visible);
        for (j = 0; j < rows.length; j++) add(rows[j], 'list');
      }
      return out;
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

    // ============================ D2: structure-free row titles ============================
    // Live truth (2026-11-22): chat rows render (36 rows, real rects, emoji
    // IMGs in the preview line) but carry NONE of the census-era semantic
    // hooks - no data-testid="cell-frame-title", no span[title], no
    // span[dir="auto"] / div[dir="auto"] (firstTitleLen 0 on every row),
    // and no data-id on the walked elements (K1). The span tiers stay
    // first (mock + older builds), then three tiers that read ONLY what
    // any rendered row must have: aria-label, innerText lines, and
    // rect-banded text nodes (the title sits in the row's top band, the
    // preview below). Titles stay data (privacy law): nothing here ever
    // reaches an error, tail or health string.
    var TITLE_DATE_ONLY_RE = /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$|^yesterday$|^today$/i;
    function titleCandidateOk(t) {
      if (!t) return false;
      try { t = normWs(t); } catch (eN) { t = ''; }
      if (!t || t.length < 2) return false;
      if (TIME_ONLY_RE.test(t) || TITLE_DATE_ONLY_RE.test(t)) return false;
      if (digitsOnly(t) === t) return false; // unread badge / pure number
      try {
        if (!t.replace(EMOJI_RE, '').replace(/[\s​‍︎️]/g, '')) return false; // emoji-only line
      } catch (eE) {}
      return true;
    }
    function rowTitleFromAria(row) {
      // WhatsApp composes the row's accessible name as
      // "Name, preview, time, N unread" (the string screen readers get).
      // Cut at the first ", ", drop a "chat with " prefix; a name that
      // survives uncut is still accepted (comma-in-name shape).
      try {
        var els = [row].concat(qsa('[aria-label]', row));
        for (var i = 0; i < els.length; i++) {
          var v = '';
          try { v = els[i].getAttribute('aria-label') || ''; } catch (eA) { v = ''; }
          v = normWs(v);
          if (!v) continue;
          var cut = v.indexOf(', ') !== -1 ? v.slice(0, v.indexOf(', ')) : v;
          cut = cut.replace(/^chat with\s+/i, '');
          if (titleCandidateOk(cut)) return cut;
          if (titleCandidateOk(v)) return v;
        }
      } catch (e) {}
      return '';
    }
    function rowTitleFromLines(row) {
      // innerText keeps the row's visual line structure: line 1 is the
      // title band (title + timestamp), line 2 the preview. Return the
      // first line that survives validation, with a trailing timestamp
      // stripped. Immune to span/class/testid churn by construction.
      try {
        var txt = row.innerText || '';
        if (!txt) return '';
        var lines = String(txt).split(/\n+/);
        for (var i = 0; i < lines.length; i++) {
          var t = normWs(lines[i].replace(/\s+\d{1,2}:\d{2}(\s?[ap]\.?m\.?)?$/i, ''));
          if (titleCandidateOk(t)) return t;
        }
      } catch (e) {}
      return '';
    }
    function rowTitleFromNodes(row) {
      // Floor tier: walk the row's TEXT NODES (textContent-level, works
      // even where innerText comes back empty). With geometry (covered-
      // page law: rects always exist) keep only nodes whose parent sits
      // in the row's TITLE BAND - top 55% - and take the longest
      // survivor (timestamp and unread badge die in validation).
      // Without geometry, document order decides: the title precedes the
      // preview in WhatsApp's row DOM.
      try {
        var rr = null;
        try { rr = row.getBoundingClientRect(); } catch (eR) { rr = null; }
        var haveBand = !!(rr && rr.height > 8);
        var walker = D.createTreeWalker(row, NodeFilter.SHOW_TEXT, null, false);
        var bandBest = '', docFirst = '', n;
        while ((n = walker.nextNode())) {
          var t = '';
          try { t = normWs(n.nodeValue); } catch (eV) { t = ''; }
          if (!titleCandidateOk(t)) continue;
          var p = n.parentElement;
          if (!p) continue;
          if (!docFirst) docFirst = t;
          if (haveBand) {
            var pr = null;
            try { pr = p.getBoundingClientRect(); } catch (eP) { pr = null; }
            if (pr && pr.height > 0 && (pr.top - rr.top) < rr.height * 0.55) {
              if (t.length > bandBest.length) bandBest = t;
            }
          }
        }
        return bandBest || docFirst;
      } catch (e) {}
      return '';
    }
    function rowTitleGeneric(row) {
      if (!row) return '';
      try {
        var t = spansText(row, 'span[dir="auto"]') || spansText(row, 'div[dir="auto"]');
        if (t && !TIME_ONLY_RE.test(t)) return normWs(t); // census-era spans (mock, older builds)
      } catch (eS) {}
      try { var a = rowTitleFromAria(row); if (a) return a; } catch (eA) {}
      try { var l = rowTitleFromLines(row); if (l) return l; } catch (eL) {}
      try { var n2 = rowTitleFromNodes(row); if (n2) return n2; } catch (eN) {}
      try { // legacy title-attr span, lowest (the attr is gone on 2026 rows)
        var q = row.querySelector('[data-testid="cell-frame-title"] span[title], span[title]');
        if (q) {
          var v = normWs(q.getAttribute('title') || '');
          if (titleCandidateOk(v)) return v;
        }
      } catch (eQ) {}
      return '';
    }

    function resultRowTitle(row) {
      if (!row) return '';
      var tg = rowTitleGeneric(row); // D2: structure-free tiers first
      if (tg) return tg;
      try {
        var t = spansText(row, 'span[dir="auto"]');
        if (t) return t;
        t = spansText(row, 'div[dir="auto"]');
        if (t) return t;
        var al = row.getAttribute && (row.getAttribute('aria-label') || row.getAttribute('title'));
        if (al && normWs(al)) return normWs(al);
        var m = qsa('.matched-name', row), acc = '';
        for (var i = 0; i < m.length; i++) acc += ' ' + (m[i].innerText || m[i].textContent || '');
        acc = normWs(acc);
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

    // ============================ V12.1 T1: DOM chat-list titles ============================
    // Last-resort name source for listChats: the SAME list chains the search
    // fallback uses (LIST_CHAIN), read blind (covered-page law: rows still
    // lay out). Titles stay data; they never reach an error or tail string.
    // Only the row's own title spans count (never the whole-row text, which
    // would glue the message preview onto the name).
    function domChatListTitles() {
      var rows = [], seen = [], i, j;
      for (i = 0; i < LIST_CHAIN.length; i++) {
        var found = qsa(LIST_CHAIN[i]).filter(visible);
        for (j = 0; j < found.length; j++) {
          if (seen.indexOf(found[j]) === -1) { seen.push(found[j]); rows.push(found[j]); }
        }
      }
      var titles = [];
      for (i = 0; i < rows.length; i++) {
        var t = rowTitleGeneric(rows[i]); // D2: structure-free row title
        if (t) titles.push(t);
      }
      return titles;
    }
    // Positional fill: ONLY when the DOM list and the non-archived IDB roster
    // have the SAME length, and ONLY into rows whose title is still empty
    // (an existing join is never overwritten). Every position where a title
    // is already known acts as an anchor: one conflict with the DOM order
    // (pinned chats, sort drift) aborts the whole fill; zero anchors means
    // the order is unproven, which aborts too. A wrong name is worse than
    // Unknown, so uncertainty always leaves Unknown.
    function fillTitlesFromDom(out) {
      try {
        if (!out || !out.length) return;
        var live = [], missing = 0, i;
        for (i = 0; i < out.length; i++) {
          if (out[i].archived) continue;
          live.push(out[i]);
          if (!out[i].title) missing++;
        }
        if (!missing || !live.length) return;
        var titles = domChatListTitles();
        if (!titles.length || titles.length !== live.length) return;
        var anchors = 0;
        for (i = 0; i < live.length; i++) {
          if (!live[i].title) continue;
          if (!titlesMatch(live[i].title, titles[i])) return; // order conflict: never guess
          anchors++;
        }
        if (!anchors) return; // no alignment evidence: never guess
        for (i = 0; i < live.length; i++) {
          if (!live[i].title) live[i].title = titles[i];
        }
      } catch (e) {}
    }

    // ============================ V12.6 Z1: title via chat-row data-id ============================
    // The empty-title resolver. Chat LIST rows carry a data-id attribute
    // keyed by the chat's own id (no underscores; message-shaped data-ids
    // live in the conversation pane and always contain '_'). The row whose
    // data-id matches the requested chat (idKey compare, idSibling
    // twin-aware, T1 law) donates its rendered title span: WhatsApp
    // renders a fallback (+phone form) even when the stored name is
    // empty, which is exactly the untitled lid shape that doomed the DOM
    // search. Pure layout reads (covered-page law); the title stays data
    // and never reaches any error or tail string. Returns '' when no
    // matching row renders.
    function domTitleByChatId(id) {
      try {
        var want = keyOf(id);
        if (!want) return '';
        var els = qsa('#pane-side [data-id], [aria-label*="chat list" i] [data-id]');
        for (var i = 0; i < els.length; i++) {
          var v = '';
          try { v = els[i].getAttribute('data-id') || ''; } catch (eA) { v = ''; }
          if (!v || v.indexOf('_') !== -1) continue; // message-shaped ids never name a chat row
          if (!idEq(v, want) && !idSibling(v, want)) continue;
          // title extraction: nearest list row, else the holder subtree
          // (D2: rowTitleGeneric - span tiers first, then structure-free)
          var row = els[i];
          try {
            var p = els[i].closest('[role="row"], [role="listitem"]');
            if (p) row = p;
          } catch (eC) {}
          var t = rowTitleGeneric(row);
          if (t) return t;
          if (row !== els[i]) {
            var t2 = rowTitleGeneric(els[i]);
            if (t2) return t2;
          }
        }
      } catch (e) {}
      return '';
    }

    // ============================ V13 H4 D3: data-id title donation ============================
    // FINAL listChats name tier (after row fields, the contact index and
    // the positional DOM tier). One bounded pass over the same chat rows
    // domTitleByChatId reads, keyed by data-id instead of position: each
    // rendered row donates its title span into a map keyed by raw id and
    // by digit user part, and every roster row still missing a title
    // looks itself up (byRaw = the idEq tier, byUser = the idSibling
    // @lid/@c.us digit bridge, T1 law). Fill-only: an existing join is
    // NEVER overwritten. Ambiguity law (the tier-2 precedent): a digit
    // user part claimed by two different data-id rows with DIFFERENT
    // titles donates nothing for those digits - two rows that AGREE on
    // the title are the same human rendered twice and still donate; a
    // roster row with no unambiguous hit stays Unknown. Never guess a
    // wrong name. Pure layout reads (covered-page law); titles stay data
    // and never reach any error, tail or health string. TITLE_DONATED
    // feeds debugTitles (count only, never names).
    var TITLE_DONATED = 0; // titles the LAST listChats run filled via this tier
    var DOMROW_CAP = 300;  // data-id rows scanned per pass (bounded)
    function fillTitlesByDataId(out) {
      TITLE_DONATED = 0;
      try {
        if (!out || !out.length) return;
        var missing = 0, i;
        for (i = 0; i < out.length; i++) { if (!out[i].title) missing++; }
        if (!missing) return; // nothing to donate into
        var els = qsa('#pane-side [data-id], [aria-label*="chat list" i] [data-id]');
        var byRaw = {}, byUser = {}, ambUser = {}, seenDid = {};
        var scanned = 0;
        for (i = 0; i < els.length && scanned < DOMROW_CAP; i++) {
          var v = '';
          try { v = els[i].getAttribute('data-id') || ''; } catch (eA) { v = ''; }
          if (!v || v.indexOf('_') !== -1) continue; // message-shaped ids never name a chat row
          var k = idKey(v);
          if (!k || !k.raw) continue;
          if (seenDid[k.raw]) continue; // one entry per data-id value (row + inner chip dedupe)
          seenDid[k.raw] = true;
          scanned++;
          // title extraction: nearest list row, else the holder subtree (domTitleByChatId law)
          // (D2: rowTitleGeneric - span tiers first, then structure-free)
          var row = els[i];
          try {
            var p = els[i].closest('[role="row"], [role="listitem"]');
            if (p) row = p;
          } catch (eC) {}
          var t = rowTitleGeneric(row);
          if (!t && row !== els[i]) {
            t = rowTitleGeneric(els[i]);
          }
          if (!t) continue;
          t = normWs(t);
          if (!t) continue;
          if (byRaw[k.raw] === undefined) byRaw[k.raw] = t;
          if (k.user && k.user.length >= 6) {
            if (ambUser[k.user]) continue;
            if (byUser[k.user] === undefined) byUser[k.user] = t;
            else if (byUser[k.user] !== t) { delete byUser[k.user]; ambUser[k.user] = true; }
          }
        }
        if (!scanned) return;
        for (i = 0; i < out.length; i++) {
          var o = out[i];
          if (!o || o.title) continue; // fill-only, never overwrite
          var kk = idKey(o.chatId);
          if (!kk) continue;
          var pick = '';
          if (kk.raw && byRaw[kk.raw] !== undefined) pick = byRaw[kk.raw]; // idEq tier
          if (!pick && kk.user && kk.user.length >= 6 && byUser[kk.user] !== undefined) {
            pick = byUser[kk.user]; // idSibling digit bridge (@lid <-> @c.us twin)
          }
          if (pick) { o.title = pick; TITLE_DONATED++; }
        }
      } catch (e) {}
    }

    // ============================ impl: ready / health ============================
    async function readyImpl() {
      var idbOk = false, modOk = false;
      try { await ensureOpen(); idbOk = true; } catch (eI) { idbOk = false; }
      try { modOk = await probeRuntime(false); } catch (eM) { modOk = false; }
      return idbOk && modOk;
    }

    // ============================ impl: listChats ============================
    // V12.1 T1 name join, three tiers; a later tier NEVER overwrites an
    // earlier hit, and every tier only ever fills a MISSING title:
    //   1. row:   the chat row's own fields (name/formattedName/subject)
    //   2. index: contact index built ONCE per listChats call from the
    //              contact store getAll - by raw id first, then by digit
    //              user part (id digits + phone-field digits). A digit set
    //              claimed by two DIFFERENT names is ambiguous and is never
    //              used (never guess a wrong name).
    //   3. dom:   positional DOM chat-list titles (fillTitlesFromDom)
    //   4. domId: per-row data-id donation (fillTitlesByDataId, V13 H4 D3),
    //              the domTitleByChatId resolver applied to the roster
    var CONTACT_PHONE_FIELDS = ['phone', 'phoneNumber'];
    async function buildContactIndex() {
      var byRaw = {}, byUser = {}, amb = {};
      try {
        var cs = await getAllFrom('contact');
        for (var i = 0; i < cs.length; i++) {
          var c = cs[i];
          if (!c) continue;
          var nm = firstStr(c.name, c.formattedName, c.pushname, c.shortName);
          if (!nm) continue;
          var k = idKey(c.id);
          if (k && k.raw && byRaw[k.raw] === undefined) byRaw[k.raw] = nm;
          var digitSets = {};
          if (k) {
            if (k.user && k.user.length >= 6) digitSets[k.user] = true;
            var idAll = digitsOnly(k.raw);
            if (idAll.length >= 6) digitSets[idAll] = true;
          }
          for (var p = 0; p < CONTACT_PHONE_FIELDS.length; p++) {
            var pd = digitsOnly(String(c[CONTACT_PHONE_FIELDS[p]] || ''));
            if (pd.length >= 6) digitSets[pd] = true;
          }
          for (var d in digitSets) {
            if (amb[d]) continue;
            if (byUser[d] === undefined) byUser[d] = nm;
            else if (byUser[d] !== nm) { delete byUser[d]; amb[d] = true; }
          }
        }
      } catch (e) {}
      return { byRaw: byRaw, byUser: byUser };
    }
    async function listChatsImpl() {
      try {
        var rows = await getAllFrom('chat');
        var idx = await buildContactIndex(); // T1 tier 2: once per call
        var out = [];
        for (var j = 0; j < rows.length; j++) {
          var c = rows[j];
          if (!c) continue;
          var k = idKey(c.id);
          if (!k) continue;
          var title = firstStr(c.name, c.formattedName, c.subject); // tier 1
          if (!title && idx.byRaw[k.raw]) title = idx.byRaw[k.raw]; // tier 2a: raw id
          if (!title && k.user && k.user.length >= 6 && idx.byUser[k.user]) {
            title = idx.byUser[k.user]; // tier 2b: digit user part (lid <-> classic)
          }
          out.push({
            chatId: k.raw,
            title: title || '',
            unread: (typeof c.unreadCount === 'number' && c.unreadCount > 0) ? c.unreadCount : 0,
            t: firstNum(c.t, c.sortTime), // seconds epoch (research section 2)
            archived: c.archive === true  // Ferdium-verified field
          });
        }
        out.sort(function (a, b) { return b.t - a.t; }); // newest first
        if (out.length > ROSTER_CAP) out.length = ROSTER_CAP;
        fillTitlesFromDom(out); // T1 tier 3: positional DOM titles, missing only
        fillTitlesByDataId(out); // V13 H4 D3: final tier, data-id row donation, fill-only
        return out;
      } catch (eL) {
        noteError('listChats', eL);
        return [];
      }
    }

    // V13 H4 D3: selftest probe. Re-runs the full listChats join and
    // returns ONLY how many titles this run filled via the data-id
    // donation tier (count only; no names ever leave the page).
    async function debugTitlesImpl() {
      await listChatsImpl();
      return TITLE_DONATED;
    }

    // ============================ impl: getContact ============================
    // V12.1 T1: raw lookup, then raw scan (idKey equality), then the digit
    // user-part bridge for the lid-era split (chat keyed @lid while the
    // contact store holds the @c.us record, or vice versa). A digit set
    // claimed by two DIFFERENT names is ambiguous and never used. phone is
    // only ever reported from a @c.us form; @lid ids carry no phone.
    async function getContactImpl(chatId) {
      var id = (typeof chatId === 'string') ? chatId : normId(chatId);
      if (!id) return null;
      var key = idKey(id);
      var row = null;
      try { row = await getFrom('contact', id); } catch (eG) { row = null; }
      if (!row) {
        // unkeyed fallback: scan (store keys may be Wid objects on 2026 builds)
        var all = null;
        try {
          all = await getAllFrom('contact');
          for (var i = 0; i < all.length; i++) {
            if (idEq(all[i] && all[i].id, key)) { row = all[i]; break; }
          }
        } catch (eA) {
          noteError('getContact', eA);
          return null;
        }
        // T1 twin bridge: same digit user part under the other remote
        if (!row && key && key.user && key.user.length >= 6 && all) {
          var hitName = '', amb = false;
          for (var j = 0; j < all.length; j++) {
            var r2 = all[j];
            if (!r2) continue;
            var nm = firstStr(r2.name, r2.formattedName, r2.pushname, r2.shortName);
            if (!nm) continue;
            var k2 = idKey(r2.id);
            var digs = k2 ? (k2.user || digitsOnly(k2.raw)) : '';
            if (!digs || digs.length < 6 || digs !== key.user) continue;
            if (!hitName) hitName = nm;
            else if (hitName !== nm) { amb = true; break; }
          }
          if (!amb && hitName) {
            // resolve the winning name back to a concrete record
            for (var j2 = 0; j2 < all.length; j2++) {
              var r3 = all[j2];
              if (!r3) continue;
              var nm3 = firstStr(r3.name, r3.formattedName, r3.pushname, r3.shortName);
              if (nm3 !== hitName) continue;
              var k3 = idKey(r3.id);
              var d3 = k3 ? (k3.user || digitsOnly(k3.raw)) : '';
              if (d3 === key.user) { row = r3; break; }
            }
          }
        }
      }
      if (!row) return null;
      var phone = null;
      var rk = idKey(row.id);
      if (rk && rk.domain === 'c.us' && rk.user) phone = rk.user;
      else if (key && key.domain === 'c.us' && key.user) phone = key.user;
      return { name: firstStr(row.name, row.formattedName, row.pushname, row.shortName), phone: phone };
    }

    // ============================ impl: getMessages ============================
    function kindOf(m) {
      try {
        var t = m.type;
        if (m.isSystem === true || t === 'system' || t === 'notification' ||
            t === 'e2e_notification' || t === 'revoke') return 'system';
        if (t === undefined || t === null || t === '' || t === 'chat') return 'text';
        return 'media-placeholder'; // image/video/audio/ptt/document/sticker/... : metadata only, no body extraction
      } catch (e) { return 'text'; }
    }
    function mapMsg(m, idx) {
      var ts = (typeof m.t === 'number') ? m.t : 0; // seconds epoch
      var kind = kindOf(m);
      var text = '';
      if (kind !== 'media-placeholder' && typeof m.body === 'string') text = m.body;
      var fromMe = false;
      try { fromMe = (m.fromMe === true) || !!(m.id && m.id.fromMe === true); } catch (eF) {}
      var id = normId(m.id) || ('idx_' + idx + '_' + ts);
      var out = {
        id: id,
        fromMe: fromMe,
        text: text,
        ts: ts,
        kind: kind
      };
      // V12.7 F1: media placeholders carry their message id as mId so the
      // renderer can request the bytes (getMedia) without a second lookup
      if (kind === 'media-placeholder') out.mId = id;
      return out;
    }
    function chatMsgModels(chat) {
      var msgs = null;
      try { msgs = chat.msgs; } catch (e) { msgs = null; }
      return collectionModels(msgs);
    }
    // V12.7 F1: the chat's message collection, msgs first then messages
    function msgCollection(chat) {
      var m = null;
      try { m = chat.msgs; } catch (e1) { m = null; }
      if (!m) { try { m = chat.messages; } catch (e2) { m = null; } }
      return m || null;
    }
    // V12.7 F1: await a thenable exactly once, bounded by a wall-clock
    // deadline. A rejection or a timeout resolves null; never rejects.
    function awaitOnce(v, deadline) {
      try {
        if (v && typeof v.then === 'function') {
          return raceDeadline(
            W.Promise.resolve(v).then(function () { return true; }, function () { return null; }),
            deadline
          );
        }
      } catch (e) {}
      return W.Promise.resolve(null);
    }
    // V12.7 F1: WARM the per-chat message collection. WhatsApp loads chat
    // message collections lazily: a chat the engine's own WhatsApp never
    // opened holds an empty or partial in-memory collection, so reads are
    // stale and fresh arrivals never land. Every load-ish callable
    // (/load|fetch/i) on the COLLECTION first, then on the chat MODEL
    // itself (whatsapp-web.js keeps loadEarlierMessages there), is invoked
    // once: try/catch each, thenable results awaited once, all inside ONE
    // MSG_WARM_MS budget with a hard call cap. Silent degrade everywhere;
    // a failure surfaces only as a health.lastError class note.
    async function warmMsgCollection(chat) {
      var col = msgCollection(chat);
      var hosts = [];
      if (col) hosts.push(col);
      hosts.push(chat);
      var deadline = Date.now() + MSG_WARM_MS;
      var fired = 0;
      var seen = [];
      for (var h = 0; h < hosts.length && Date.now() < deadline; h++) {
        var host = hosts[h];
        if (!host || typeof host !== 'object') continue;
        var keys;
        try { keys = Object.keys(host); } catch (eK) { continue; }
        for (var i = 0; i < keys.length && fired < MSG_WARM_FN_CAP && Date.now() < deadline; i++) {
          if (!/load|fetch/i.test(keys[i])) continue;
          var fn = null;
          try { fn = host[keys[i]]; } catch (eG) { fn = null; }
          if (typeof fn !== 'function' || seen.indexOf(fn) !== -1) continue;
          seen.push(fn);
          fired++; // attempts count toward the cap, thrown calls included
          try {
            var r = fn.call(host);
            await awaitOnce(r, deadline); // a hung loader eats only the remaining warm budget
          } catch (eC) {
            try { noteError('getMessages', eC); } catch (eN) {}
          }
        }
      }
      return fired;
    }
    async function getMessagesImpl(chatId, limit) {
      var id = (typeof chatId === 'string') ? chatId : normId(chatId);
      if (!id) return [];
      var lim = 50;
      try {
        var n = parseInt(limit, 10);
        if (isFinite(n) && n > 0) lim = Math.min(MSG_CAP, Math.floor(n));
      } catch (eN) {}
      var ok = false;
      try { ok = await probeRuntime(false); } catch (eP) { ok = false; }
      if (!ok) { HEALTH.lastError = 'module runtime unavailable'; return []; } // message text is encrypted at rest in IDB; without the runtime there is nothing honest to return
      // V12.1 T1: strict core first, then the lid-era tiers (collection
      // find/get, twin remote) before giving up
      var chat = findChatModel(id);
      if (!chat) chat = await locateChatModel(id);
      if (!chat) { HEALTH.lastError = 'chat not in memory'; return []; }
      // V12.7 F1: WARM-THEN-READ. A short collection may simply be an
      // unloaded one; warm it (bounded) and read again. A warm that grew
      // nothing spaces the next attempt (WARMBK) so the spine poll never
      // re-burns the budget on a dead collection. The pre-warm models are
      // kept: if warming somehow lost rows, whatever existed is returned.
      var preModels = chatMsgModels(chat) || [];
      var models = preModels;
      if (preModels.length < lim) {
        var bk = msgCountKey(id);
        var bkPrev = bk ? WARMBK[bk] : null;
        var due = !(bkPrev && bkPrev.at && !bkPrev.grew &&
                    (Date.now() - bkPrev.at) < MSG_WARM_RETRY_MS);
        if (due) {
          try { await warmMsgCollection(chat); }
          catch (eW) { try { noteError('getMessages', eW); } catch (eN2) {} }
          var postModels = chatMsgModels(chat) || [];
          if (bk) WARMBK[bk] = { at: Date.now(), grew: postModels.length > preModels.length };
          if (postModels.length >= preModels.length) models = postModels;
        }
      }
      var mapped = [];
      for (var i = 0; i < models.length; i++) {
        try { if (models[i]) mapped.push(mapMsg(models[i], i)); } catch (eM) {}
      }
      mapped.sort(function (a, b) { return a.ts - b.ts; }); // ascending: newest last
      if (mapped.length > lim) mapped = mapped.slice(mapped.length - lim);
      // V12.7 F1: the post-warm collection size is the drift baseline
      // hasNewMessages compares against (also attached non-enumerably so an
      // in-page debugger sees it; the wire shape is unchanged)
      msgCountNote(id, models.length);
      try {
        Object.defineProperty(mapped, 'wabCount', { value: models.length, enumerable: false });
      } catch (eD) {}
      return mapped;
    }

    // ============================ V13 J1: impl: getMessagesHistory / hasMoreHistory ============================
    // THE OWNER'S ENDLESS-SCROLL LAW (2026-11-21): pulling the full history of
    // a chat must work exactly like WhatsApp on his phone - scroll up, a
    // pause, then more history loads, repeat, all the way back.
    // getMessages(chatId, limit) reads whatever the in-memory collection
    // already holds (capped MSG_CAP 500) and its F1 warm fires the
    // load-ish calls only ONCE per read; it cannot walk years back.
    // getMessagesHistory closes the gap the same way the phone does: PAGE
    // the loader. Per page it re-runs the proven F1 warm set (every
    // /load|fetch/i callable on the collection, then on the chat model
    // itself - whatsapp-web.js keeps loadEarlierMessages there), waits a
    // short settle window for the collection to grow, and counts. Loop
    // laws: at most HIST_PAGE_MAX 20 pages per call, the whole call
    // bounded by HIST_TOTAL_MS 25 s, stop early after TWO consecutive
    // pages that grew nothing (one flat page can be a busy loader; two is
    // an exhausted collection). The read after the loop is FULL (no
    // MSG_CAP slice - this call IS the deep read; the renderer slices
    // what it shows) and ascending. NEVER SENDS: no composer, no button,
    // no DOM tier - model-world reads and loader calls only. An explicit
    // history request always attempts (the WARMBK due-check belongs to
    // the background getMessages poll, not to an operator-driven pull);
    // afterwards WARMBK/HISTBK are stamped so the cheap probe and the
    // background warm stay coherent. Tail tokens: fixed
    // 'history: page N (+M)' strings, counts only.
    // hasMoreHistory is the cheap renderer probe: ONE warm attempt plus
    // the settle window; growth means more history is loadable, a flat
    // attempt means the collection is (currently) exhausted. A flat
    // probe is spaced by HISTBK (10 s, the F1 spacing law) so a scrolling
    // renderer cannot re-burn the loader on every scroll tick; a probe
    // that GREW never spaces a follow-up (and its side effect is one
    // more loaded page, which is what scrolling wanted anyway).
    var HISTBK = {}; // V13 J1: hasMoreHistory flat-probe spacing (raw chat id -> ms)
    async function getMessagesHistoryImpl(chatId, pages) {
      var id = (typeof chatId === 'string') ? chatId : normId(chatId);
      if (!id) return { ok: false, error: 'bad id', messages: [], grewBy: 0, hasMore: false, pagesRun: 0 };
      var pg = 5; // default pull when the caller passes nothing
      try {
        var pn = parseInt(pages, 10);
        if (isFinite(pn) && pn > 0) pg = Math.min(HIST_PAGE_MAX, Math.floor(pn));
      } catch (eP) {}
      var ok = false;
      try { ok = await probeRuntime(false); } catch (ePr) { ok = false; }
      if (!ok) return { ok: false, error: 'module runtime unavailable', messages: [], grewBy: 0, hasMore: false, pagesRun: 0 };
      // same locate tiers as getMessages (strict core, then the lid-era ones)
      var chat = findChatModel(id);
      if (!chat) chat = await locateChatModel(id);
      if (!chat) return { ok: false, error: 'chat not in memory', messages: [], grewBy: 0, hasMore: false, pagesRun: 0 };
      var deadline = Date.now() + HIST_TOTAL_MS;
      var prev = (chatMsgModels(chat) || []).length;
      var grewBy = 0, flat = 0, lastGrew = false, ran = 0;
      for (var page = 1; page <= pg; page++) {
        if (Date.now() >= deadline) break;
        ran = page;
        try { await warmMsgCollection(chat); } // the F1 warm set, fresh budget per page
        catch (eW) { try { noteError('getMessagesHistory', eW); } catch (eN) {} }
        // settle window: loaders are async; growth inside it exits early
        var grewTo = await pollUntil(
          Math.min(deadline, Date.now() + HIST_SETTLE_MS),
          function () {
            var n = (chatMsgModels(chat) || []).length;
            return n > prev ? n : null;
          },
          STEP_MS
        );
        var now = grewTo || (chatMsgModels(chat) || []).length;
        var delta = now - prev;
        prev = now;
        tail('history: page ' + page + ' (+' + (delta > 0 ? delta : 0) + ')');
        if (delta > 0) { grewBy += delta; flat = 0; lastGrew = true; }
        else { flat++; lastGrew = false; if (flat >= 2) break; } // two flat pages = exhausted
      }
      // FULL read after all pages: every model the collection now holds,
      // mapped and ascending, no slice
      var models = chatMsgModels(chat) || [];
      var mapped = [];
      for (var i = 0; i < models.length; i++) {
        try { if (models[i]) mapped.push(mapMsg(models[i], i)); } catch (eM) {}
      }
      mapped.sort(function (a, b) { return a.ts - b.ts; }); // ascending: newest last
      // keep the F1 drift baseline honest (hasNewMessages compares against
      // it) and stamp the spacing maps
      msgCountNote(id, models.length);
      var bk = msgCountKey(id);
      if (bk) {
        WARMBK[bk] = { at: Date.now(), grew: grewBy > 0 };
        if (grewBy > 0) delete HISTBK[bk];
        else HISTBK[bk] = Date.now();
      }
      return { ok: true, messages: mapped, grewBy: grewBy, hasMore: lastGrew, pagesRun: ran };
    }
    async function hasMoreHistoryImpl(chatId) {
      var id = (typeof chatId === 'string') ? chatId : normId(chatId);
      if (!id) return false;
      var ok = false;
      try { ok = await probeRuntime(false); } catch (ePr) { ok = false; }
      if (!ok) return false;
      var chat = findChatModel(id);
      if (!chat) chat = await locateChatModel(id);
      if (!chat) return false;
      var bk = msgCountKey(id);
      if (bk) {
        // a FLAT probe inside the spacing window answers false without
        // re-burning the loader; a probe that GREW is never spaced out
        var lastAt = HISTBK[bk];
        if (typeof lastAt === 'number' && (Date.now() - lastAt) < MSG_WARM_RETRY_MS) return false;
      }
      var before = (chatMsgModels(chat) || []).length;
      try { await warmMsgCollection(chat); } // ONE load attempt, F1 budget
      catch (eW) { try { noteError('hasMoreHistory', eW); } catch (eN) {} }
      var grewTo = await pollUntil(
        Date.now() + HIST_SETTLE_MS,
        function () {
          var n = (chatMsgModels(chat) || []).length;
          return n > before ? n : null;
        },
        STEP_MS
      );
      var more = !!(grewTo && grewTo > before);
      if (bk) {
        if (more) delete HISTBK[bk];
        else {
          try {
            var keys = Object.keys(HISTBK);
            if (keys.length >= 400) delete HISTBK[keys[0]]; // bounded map (MSGCOUNT law)
          } catch (eK) {}
          HISTBK[bk] = Date.now();
        }
      }
      return more;
    }

    // ============================ V12.7 F1: impl: getMedia ============================
    // getMedia(chatId, msgId): the bytes behind a media-placeholder row.
    // Locate the message model (strict serialized compare, then a validated
    // bare-id + remote-sibling compare - the T1 locate logic applied to
    // messages), find a URL (clienturl, then the mediaAttributes payload,
    // then declaredThumbnail, then direct URL fields and a data: body),
    // fetch it IN PAGE (the page's own fetch: same-origin blob/data forms
    // and the https forms WhatsApp itself uses) and answer a dataURL
    // capped at MEDIA_CAP. Never throws; media bytes NEVER reach
    // health.lastError, any tail string or any debug output (fixed labels
    // only). Kinds are the fixed set image | video | sticker | audio.
    var MEDIA_URL_RE = /^(https?:|blob:|data:)/i;
    function firstMediaUrlIn(x, depth) {
      try {
        if (depth > 3 || x === null || x === undefined) return '';
        if (typeof x === 'string') return MEDIA_URL_RE.test(x) ? x : '';
        if (Array.isArray(x)) {
          for (var i = 0; i < x.length; i++) {
            var r = firstMediaUrlIn(x[i], depth + 1);
            if (r) return r;
          }
          return '';
        }
        if (typeof x === 'object') {
          var ks;
          try { ks = Object.keys(x); } catch (eK) { return ''; }
          for (var j = 0; j < ks.length; j++) {
            var r2 = '';
            try { r2 = firstMediaUrlIn(x[ks[j]], depth + 1); } catch (eR) { r2 = ''; }
            if (r2) return r2;
          }
        }
      } catch (e) {}
      return '';
    }
    // V13 M1 E4: what the live probe proved (2026-11-21 night, both
    // accounts, ptt + video, tier strict): media is ENCRYPTED AT REST.
    // The msg attributes carry deprecatedMms3Url (https ciphertext URL,
    // mmg host, ~194 chars), mediaKey (base64, 32 bytes) and the type;
    // body is empty. The old plaintext-URL chain fields stay as fallback
    // url sources for other builds; the bytes always come back via the
    // E4b decrypt (or a ready local blob, route A in the impl below).
    function msgAttrMap(m) {
      var sources = [];
      try { sources.push(m); } catch (e0) {}
      try {
        if (m && m.attributes && typeof m.attributes === 'object') sources.push(m.attributes);
      } catch (eA) {}
      var lowerMap = {};
      for (var s = 0; s < sources.length; s++) {
        var src = sources[s];
        if (!src || typeof src !== 'object') continue;
        var keys;
        try { keys = Object.keys(src); } catch (eK) { continue; }
        for (var q = 0; q < keys.length; q++) {
          try {
            var lk = String(keys[q]).toLowerCase();
            if (lowerMap[lk] === undefined) lowerMap[lk] = src[keys[q]];
          } catch (eG) {}
        }
      }
      return lowerMap;
    }
    function mediaTypeOf(m) {
      var t = '';
      try { t = String((m && m.type) || '').toLowerCase(); } catch (eT) {}
      if (!t) {
        try { t = String((m && m.attributes && m.attributes.type) || '').toLowerCase(); } catch (eT2) {}
      }
      return t;
    }
    var MEDIA_INFO = {
      image: 'WhatsApp Image Keys',
      video: 'WhatsApp Video Keys',
      audio: 'WhatsApp Audio Keys',
      ptt: 'WhatsApp Ptt Keys',
      document: 'WhatsApp Document Keys',
      sticker: 'WhatsApp Sticker Keys'
    };
    var MEDIA_MIME = {
      image: 'image/jpeg',
      video: 'video/mp4',
      audio: 'audio/mpeg',
      ptt: 'audio/ogg; codecs=opus',
      document: 'application/octet-stream',
      sticker: 'image/webp'
    };
    function mediaFamilyOf(t) {
      if (t === 'ptt_voice' || t === 'voice') return 'ptt';
      return MEDIA_INFO[t] ? t : '';
    }
    // answers { url, keyB64, infos } or null. No key = no honest decrypt
    // (the URL alone serves ciphertext); unknown family = no decrypt.
    // Names and bytes never leave this function.
    function mediaCipherInfo(m) {
      var lm = msgAttrMap(m);
      var fam = mediaFamilyOf(mediaTypeOf(m));
      if (!fam) return null;
      var keyB64 = '';
      try {
        if (typeof lm['mediakey'] === 'string' && lm['mediakey'].length >= 40) keyB64 = lm['mediakey'];
      } catch (eK) {}
      if (!keyB64) return null;
      var u = '';
      var names = ['deprecatedmms3url', 'clienturl', 'mediaurl', 'url', 'mediadirectlink'];
      for (var f = 0; f < names.length && !u; f++) {
        try {
          if (typeof lm[names[f]] === 'string' && MEDIA_URL_RE.test(lm[names[f]])) u = lm[names[f]];
        } catch (eF) {}
      }
      if (!u) { try { u = firstMediaUrlIn(lm['mediaattributes'], 0); } catch (eMa) { u = ''; } }
      if (!u) {
        try {
          if (typeof lm['declaredthumbnail'] === 'string' && MEDIA_URL_RE.test(lm['declaredthumbnail'])) u = lm['declaredthumbnail'];
        } catch (eTh) {}
      }
      if (!u) return null;
      // ptt is the one family whose HKDF info string is not settled lore:
      // Ptt first, Audio as the single fallback (route B loops them).
      var infos = [MEDIA_INFO[fam]];
      if (fam === 'ptt') infos.push(MEDIA_INFO.audio);
      return { url: u, keyB64: keyB64, infos: infos };
    }
    function mediaMimeOf(m) {
      var own = '';
      try {
        own = String(firstStr((m && m.mimetype), (m && m.mimeType),
          (m && m.attributes && m.attributes.mimetype),
          (m && m.attributes && m.attributes.mimeType)) || '').trim();
      } catch (eM) {}
      if (own) return own;
      var fam = mediaFamilyOf(mediaTypeOf(m));
      return (fam && MEDIA_MIME[fam]) || 'application/octet-stream';
    }
    // route A only: a ready LOCAL artifact (the page already decrypted and
    // downloaded it). https is refused here on purpose - it serves
    // ciphertext. Depth-capped like firstMediaUrlIn (mediaData's parent
    // pointer can cycle).
    var LOCAL_URL_RE = /^(blob:|data:)/i;
    function firstLocalUrlIn(x, depth) {
      try {
        if (depth > 3 || x === null || x === undefined) return '';
        if (typeof x === 'string') return LOCAL_URL_RE.test(x) ? x : '';
        if (Array.isArray(x)) {
          for (var i = 0; i < x.length; i++) {
            var r = firstLocalUrlIn(x[i], depth + 1);
            if (r) return r;
          }
          return '';
        }
        if (typeof x === 'object') {
          var ks;
          try { ks = Object.keys(x); } catch (eK) { return ''; }
          for (var j = 0; j < ks.length; j++) {
            var r2 = '';
            try { r2 = firstLocalUrlIn(x[ks[j]], depth + 1); } catch (eR) { r2 = ''; }
            if (r2) return r2;
          }
        }
      } catch (e) {}
      return '';
    }
    function msgMediaData(m) {
      try {
        var md = msgAttrMap(m)['mediadata'];
        return (md && typeof md === 'object') ? md : null;
      } catch (e) { return null; }
    }
    function mediaKindOf(m) {
      try {
        var t = String((m && m.type) || '').toLowerCase();
        if (t === 'sticker') return 'sticker';
        if (t === 'video') return 'video';
        if (t === 'image') return 'image';
        if (t === 'audio' || t === 'ptt' || t === 'ptt_voice' || t === 'voice') return 'audio';
        var mime = '';
        try {
          mime = String(firstStr(m.mimetype, m.mimeType,
            (m.attributes && m.attributes.mimetype), (m.attributes && m.attributes.mimeType)) || '').toLowerCase();
        } catch (eM) {}
        var isSticker = false;
        try { isSticker = (m.isSticker === true) || !!(m.attributes && m.attributes.isSticker === true); } catch (eS) {}
        if (isSticker) return 'sticker'; // sticker mime is image/webp: the flag outranks the prefix
        if (/^video\//.test(mime)) return 'video';
        if (/^audio\//.test(mime)) return 'audio';
        return 'image'; // image/... and the honest default inside the fixed kind set
      } catch (e) { return 'image'; }
    }
    // T1 locate logic applied to messages: strict serialized equality
    // first, then a validated fallback (same bare id tail AND a remote that
    // ids the same chat, idEq or the @lid/@c.us sibling) so a
    // renderer-passed id in the twin keying still resolves. The fallback
    // runs only on ids whose remote part parses as a real chat id.
    function findMsgModel(chat, msgId) {
      var models = chatMsgModels(chat) || [];
      var want = (typeof msgId === 'string') ? msgId : normId(msgId);
      if (!want) return null;
      for (var i = 0; i < models.length; i++) {
        try { if (normId(models[i] && models[i].id) === want) return models[i]; } catch (e) {}
      }
      var parts = want.split('_');
      if (parts.length >= 3) {
        var wRemote = parts[1];
        var wBare = parts.slice(2).join('_');
        var wKey = keyOf(wRemote);
        if (wBare && wKey && wKey.domain) {
          for (var j = 0; j < models.length; j++) {
            try {
              var mid = normId(models[j] && models[j].id);
              if (!mid) continue;
              var p = mid.split('_');
              if (p.length >= 3 && p.slice(2).join('_') === wBare &&
                  (idEq(p[1], wRemote) || idSibling(p[1], wRemote))) return models[j];
            } catch (e2) {}
          }
        }
      }
      return null;
    }
    function blobToDataURL(blob, deadline) {
      return raceDeadline(new W.Promise(function (res) {
        try {
          var fr = new W.FileReader();
          fr.onload = function () { res(String(fr.result || '')); };
          fr.onerror = function () { res(''); };
          try { fr.readAsDataURL(blob); } catch (eR) { res(''); }
        } catch (e) { res(''); }
      }), deadline);
    }
    // V13 M1 E4: WhatsApp media crypto, in page, via the page's own
    // WebCrypto (the engine page is a secure context). HKDF-SHA256 with an
    // empty salt and the 'WhatsApp <Type> Keys' info expands the 32-byte
    // mediaKey to 112 bytes: 16 IV | 32 cipherKey | 32 macKey | 32 refKey.
    // The served body is ciphertext || 10-byte MAC; the MAC is stripped,
    // not verified (the page's own client makes the same choice).
    // AES-256-CBC then answers the plaintext. Bounded by MEDIA_DECRYPT_MS;
    // resolves null on every miss, never rejects; no byte reaches any
    // string.
    var MEDIA_DECRYPT_MS = 4000;
    function b64ToBytes(b64) {
      try {
        var bin = W.atob(String(b64));
        var out = new W.Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
        return out;
      } catch (e) { return null; }
    }
    function asciiBytes(s) {
      var out = new W.Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    async function decryptMediaBytes(buf, keyB64, infoStr) {
      try {
        var deadline = Date.now() + MEDIA_DECRYPT_MS;
        var CS = W.crypto && W.crypto.subtle;
        if (!CS) return null;
        var keyBytes = b64ToBytes(keyB64);
        if (!keyBytes || !buf || buf.byteLength < 26) return null;
        var body = new W.Uint8Array(buf);
        var cut = body.length - 10; // strip the trailing MAC
        if (cut <= 0 || (cut % 16) !== 0) return null;
        var mk = await CS.importKey('raw', keyBytes, 'HKDF', false, ['deriveBits']);
        var derived = await raceDeadline(
          CS.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: new W.Uint8Array(0), info: asciiBytes(infoStr) },
            mk, 896),
          deadline);
        if (!derived || derived.byteLength !== 112) return null;
        var d = new W.Uint8Array(derived);
        var aesKey = await CS.importKey('raw', d.subarray(16, 48), { name: 'AES-CBC' }, false, ['decrypt']);
        var plain = await raceDeadline(
          CS.decrypt({ name: 'AES-CBC', iv: d.subarray(0, 16) }, aesKey, body.subarray(0, cut)),
          deadline);
        return plain || null;
      } catch (eD) { return null; }
    }
    async function getMediaImpl(chatId, msgId) {
      try {
        var id = (typeof chatId === 'string') ? chatId : normId(chatId);
        var mid = (typeof msgId === 'string') ? msgId : normId(msgId);
        if (!id || !mid) return { ok: false, error: 'media unavailable' };
        var rtOk = false;
        try { rtOk = await probeRuntime(false); } catch (eP) { rtOk = false; }
        if (!rtOk) return { ok: false, error: 'media unavailable' };
        var chat = findChatModel(id);
        if (!chat) chat = await locateChatModel(id);
        if (!chat) return { ok: false, error: 'media unavailable' };
        var m = findMsgModel(chat, mid);
        // V13 M1: the getMessages WARM-THEN-READ law, applied to the media
        // read. getMessages warms the lazily-loaded msgs collection before
        // it reads (a chat the engine never opened holds a short one); a
        // getMedia on a cold collection missed rows getMessages served
        // minutes earlier and answered the fixed unavailable label. Miss ->
        // ONE bounded warm under the same WARMBK spacing law -> one retry.
        if (!m) {
          var bk = msgCountKey(id);
          var bkPrev = bk ? WARMBK[bk] : null;
          var due = !(bkPrev && bkPrev.at && !bkPrev.grew &&
                      (Date.now() - bkPrev.at) < MSG_WARM_RETRY_MS);
          if (due) {
            var preLen = (chatMsgModels(chat) || []).length;
            try { await warmMsgCollection(chat); }
            catch (eW) { try { noteError('getMedia', eW); } catch (eN2) {} }
            var postLen = (chatMsgModels(chat) || []).length;
            if (bk) WARMBK[bk] = { at: Date.now(), grew: postLen > preLen };
            m = findMsgModel(chat, mid);
          }
        }
        if (!m) return { ok: false, error: 'media unavailable' };
        // V13 M1 E4, route A: a ready LOCAL blob. Some builds expose a
        // plaintext blob:/data: URL inside mediaData once the page itself
        // has downloaded the media; https is refused here (ciphertext).
        // A stale (revoked) blob URL simply falls through to route B.
        var dataUrl = '';
        var mimeOut = '';
        try {
          var localUrl = firstLocalUrlIn(msgMediaData(m), 0);
          if (localUrl) {
            var lresp = null;
            try { lresp = await raceDeadline(W.fetch(localUrl, { credentials: 'include' }), Date.now() + MEDIA_FETCH_MS); } catch (eLF) { lresp = null; }
            if (lresp && lresp.ok) {
              var lblob = null;
              try { lblob = await raceDeadline(lresp.blob(), Date.now() + MEDIA_BLOB_MS); } catch (eLB) { lblob = null; }
              if (lblob) {
                var ldata = '';
                try { ldata = (await blobToDataURL(lblob, Date.now() + MEDIA_BLOB_MS)) || ''; } catch (eLD) { ldata = ''; }
                if (ldata && ldata.length <= MEDIA_CAP) {
                  dataUrl = ldata;
                  try { mimeOut = String(lblob.type || ''); } catch (eLM) {}
                }
              }
            }
          }
        } catch (eL) { dataUrl = ''; }
        if (!dataUrl) {
          // V13 M1 E4, route B: fetch the CIPHERTEXT, decrypt in page.
          // mediaKey -> HKDF-SHA256 (empty salt, 'WhatsApp <Type> Keys')
          // -> 112 bytes (16 IV | 32 cipherKey | 32 macKey | 32 refKey);
          // AES-256-CBC over the body minus its trailing 10-byte MAC.
          var info = mediaCipherInfo(m);
          if (!info) return { ok: false, error: 'media unavailable' };
          var resp = null;
          try { resp = await raceDeadline(W.fetch(info.url, { credentials: 'include' }), Date.now() + MEDIA_FETCH_MS); } catch (eF) { resp = null; }
          if (!resp || !resp.ok) return { ok: false, error: 'media fetch failed' };
          var buf = null;
          try { buf = await raceDeadline(resp.arrayBuffer(), Date.now() + MEDIA_BLOB_MS); } catch (eB) { buf = null; }
          if (!buf) return { ok: false, error: 'media fetch failed' };
          var plain = null;
          for (var ci = 0; ci < info.infos.length && !plain; ci++) {
            try { plain = await decryptMediaBytes(buf, info.keyB64, info.infos[ci]); }
            catch (eD) { try { noteError('getMedia', eD); } catch (eN3) {} plain = null; }
          }
          if (!plain) return { ok: false, error: 'media decrypt failed' };
          var mime = mediaMimeOf(m);
          var blob2 = null;
          try { blob2 = new W.Blob([plain], { type: mime }); } catch (eBl) { blob2 = null; }
          if (!blob2) return { ok: false, error: 'media unavailable' };
          var d2 = '';
          try { d2 = (await blobToDataURL(blob2, Date.now() + MEDIA_BLOB_MS)) || ''; } catch (eD2) { d2 = ''; }
          if (!d2) return { ok: false, error: 'media unavailable' };
          if (d2.length > MEDIA_CAP) return { ok: false, error: 'media too large' };
          dataUrl = d2;
          mimeOut = mime;
        }
        return { ok: true, kind: mediaKindOf(m), data: dataUrl, mime: mimeOut };
      } catch (eG) {
        try { noteError('getMedia', eG); } catch (eN) {}
        return { ok: false, error: 'media unavailable' };
      }
    }

    // ============================ V12.7 F1: impl: hasNewMessages ============================
    // The sync heartbeat. getMessages records the post-warm collection size
    // per chat (msgCountNote); hasNewMessages compares the LIVE size
    // against it. The cheaper live source decides: the model's msgs
    // collection length first (no transaction at all); only when no model
    // resolves does a bounded readonly getAllKeys scan of the IDB message
    // store count this chat's keys. First sight adopts the live count and
    // answers false (no baseline, no guess); an unknown chat is never
    // "new". Never throws, never writes, never touches the tail.
    function idbMsgCount(key) {
      return openStore('message').then(function (os) {
        return reqP(os.getAllKeys());
      }, function () { return null; }).then(function (keys) {
        if (!keys) return null;
        var n = 0;
        for (var i = 0; i < keys.length && i < MSG_KEY_CAP; i++) {
          try {
            var s = normId(keys[i]);
            if (!s || s.indexOf(key.user) === -1) continue;
            if (s.indexOf(key.raw) !== -1 || s.indexOf(key.user + '@' + key.domain) !== -1) n++;
          } catch (e) {}
        }
        return n;
      }, function () { return null; });
    }
    async function hasNewMessagesImpl(chatId) {
      try {
        var id = (typeof chatId === 'string') ? chatId : normId(chatId);
        if (!id) return false;
        var key = keyOf(id);
        if (!key || !key.user) return false;
        var last = (MSGCOUNT[key.raw] !== undefined) ? MSGCOUNT[key.raw] : null;
        var live = null;
        if (RUNTIME.ok) {
          try {
            var chat = findChatModel(id);
            if (!chat) chat = twinChatModel(key);
            var col = chat ? msgCollection(chat) : null;
            var models = collectionModels(col);
            if (models) live = models.length;
          } catch (eM) { live = null; }
        }
        if (live === null) {
          if (last === null) return false; // no baseline, no model, no store: never guess
          var cnt = await idbMsgCount(key);
          if (cnt === null) return false;
          live = cnt;
        }
        if (last === null) { msgCountNote(id, live); return false; } // first sight adopts the baseline
        return live > last;
      } catch (eH) {
        try { noteError('hasNewMessages', eH); } catch (eN) {}
        return false;
      }
    }

    // ============================ impl: openChat ============================
    async function idbChatTitle(id) {
      try {
        var want = keyOf(id);
        if (!want) return '';
        var rows = await getAllFrom('chat');
        var row = null;
        for (var i = 0; i < rows.length; i++) {
          if (idEq(rows[i] && rows[i].id, want)) { row = rows[i]; break; }
        }
        if (!row) return '';
        var t = firstStr(row.name, row.formattedName, row.subject);
        if (t) return t;
        // V12.1 T1: same join tiers as listChats (raw id, then digit user
        // part), then getContact's twin bridge. A lid chat with no row name
        // and no contact join has no title, and the DOM route then fails
        // loud with its fixed step name.
        var idx = await buildContactIndex();
        var k = idKey(row.id);
        if (k) {
          if (idx.byRaw[k.raw]) return idx.byRaw[k.raw];
          if (k.user && k.user.length >= 6 && idx.byUser[k.user]) return idx.byUser[k.user];
        }
        var c = await getContactImpl(want.raw);
        return (c && c.name) || '';
      } catch (e) { return ''; }
    }

    async function openChatViaSearch(id, title, deadline) {
      var hadDeclutter = false, hadCrop = false;
      try {
        try { hadDeclutter = D.documentElement.classList.contains('wab-declutter'); } catch (e0) {}
        try { hadCrop = D.documentElement.classList.contains('wab-threadcrop'); } catch (e1) {}
        setDeclutter(false); // search box must reappear if curtains are up
        setThreadCrop(false);

        var box = await pollUntil(Math.min(Date.now() + BOX_TIMEOUT, deadline), findSearchBox, STEP_MS);
        if (!box) {
          tail('open: search box miss');
          return { ok: false, error: 'search box not found' };
        }
        tail('open: search box tier ' + BOX_TIER + ' hit');

        if (!typeIntoBox(box, title)) {
          tail('open: search text rejected');
          return { ok: false, error: 'search box would not accept text' };
        }
        tail('open: search text accepted');

        var matchSrc = 'unknown';
        var cand = await pollUntil(deadline, function () {
          var cs = findResultCandidates();
          for (var i = 0; i < cs.length; i++) {
            if (titlesMatch(resultRowTitle(cs[i].el), title)) {
              matchSrc = cs[i].src;
              return cs[i];
            }
          }
          return null;
        }, STEP_MS);
        if (!cand) {
          tail('open: no matching row'); // never names the target
          return { ok: false, error: 'search did not match' };
        }
        tail('open: row matched (' + matchSrc + ')');
        var row = cand.el;

        var clickedAt = Date.now();
        var synthSent = false;
        try { row.click(); } catch (eC) { syntheticClick(row); synthSent = true; }

        var confirmed = await pollUntil(deadline, function () {
          if (!synthSent && Date.now() - clickedAt >= CLICK_GRACE) {
            synthSent = true;
            tail('open: synthetic mouse fallback');
            syntheticClick(row);
          }
          return domChatOpen(id, title);
        }, STEP_MS);
        if (!confirmed) {
          tail('open: click did not open chat');
          return { ok: false, error: 'chat did not open' };
        }
        tail('open: dom-route hit');
        return { ok: true, error: null };
      } catch (eS) {
        noteError('openChat', eS);
        tail('open: exception');
        return { ok: false, error: 'open failed' };
      } finally {
        try { setDeclutter(hadDeclutter); } catch (eF1) {}
        try { setThreadCrop(hadCrop); } catch (eF2) {}
      }
    }

    // ============================ V13 H4 D7: real-typing search targets ============================
    // The engine lives in the page world and can NEVER type (no
    // sendInputEvent there, and the v12.8 trial proved synthetic typing
    // never executes WhatsApp's search anyway). The SPINE drives the real
    // input (sessions.engRealOpen pattern: wc.focus + sendInputEvent).
    // This section only SUPPLIES COORDINATES for that sequence:
    //   searchTargetCoords(query)  -> centers of the search box and of the
    //                                  first chat-shaped data-id row (css
    //                                  px; engine views render at zoom 1)
    //   searchResultCoords(digits) -> AFTER the caller typed for real,
    //                                  the center of the FIRST overlay or
    //                                  live-filtered list row whose
    //                                  chat-shaped data-id digits equal
    //                                  the target (overlay preferred: the
    //                                  2026 [data-testid="overlay"] rows
    //                                  via findResultCandidates; the
    //                                  live-filtered list accepted)
    //   searchDone()               -> restores the curtains
    //                                  searchTargetCoords lifted (the
    //                                  spine calls it in its finally)
    // Curtain law: under wab-declutter the search container is
    // display:none (declutter-inject.js), so searchTargetCoords LIFTS
    // declutter + threadcrop, records what was up, and leaves them down
    // until searchDone. The real click and the real typing happen between
    // the two calls; restoring any earlier would re-hide the box at click
    // time and the recorded coordinates would then click a list row (the
    // worst-case bug this split exists to prevent).
    // Geometry law: every element must truly lay out (width AND height >
    // 2 via getBoundingClientRect); the covered-page layout check is not
    // enough here because OS-level clicks need real on-screen geometry.
    // All coordinates are getBoundingClientRect centers in css px, zoom
    // is 1 in the engine views. One bounded pass per call; the SPINE
    // polls, never this file. No names in any string (privacy law):
    // errors are fixed tokens, the digit key is data.
    var SEARCHCURT = { hadDeclutter: false, hadCrop: false, lifted: false };
    var SR_BOX_MS = 800; // search box appear poll cap after the curtain lift
    var SR_CAP = 60;     // result candidates scanned per pass
    function centerOf(el) {
      try {
        var b = el.getBoundingClientRect();
        if (!b || !(b.width > 2) || !(b.height > 2)) return null;
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      } catch (e) { return null; }
    }
    // chat-shaped data-id digits of a result candidate: the element
    // itself, else its row ancestor, else the first chat-shaped data-id
    // inside its subtree. Message-shaped ids (containing '_') never match.
    function rowDataIdDigits(el) {
      try {
        if (!el) return '';
        var host = el, v = '';
        try { v = host.getAttribute('data-id') || ''; } catch (e0) {}
        if (!v || v.indexOf('_') !== -1) {
          try {
            var p = host.closest('[role="row"], [role="listitem"], [data-testid="cell-frame-container"]');
            if (p) host = p;
          } catch (e1) {}
          try { v = host.getAttribute('data-id') || ''; } catch (e2) {}
        }
        if (!v || v.indexOf('_') !== -1) {
          var inner = qsa('[data-id]', host);
          for (var i = 0; i < inner.length; i++) {
            var w = '';
            try { w = inner[i].getAttribute('data-id') || ''; } catch (e3) {}
            if (w && w.indexOf('_') === -1) { v = w; break; }
          }
        }
        if (!v || v.indexOf('_') !== -1) return '';
        return digitsOnly(v);
      } catch (e) { return ''; }
    }
    async function searchTargetCoordsImpl(query) {
      var q = (typeof query === 'string') ? query : '';
      if (!normWs(q)) return { ok: false, error: 'empty query' }; // Z1 law: never a doomed empty search
      try {
        if (!SEARCHCURT.lifted) {
          try { SEARCHCURT.hadDeclutter = D.documentElement.classList.contains('wab-declutter'); } catch (e0) {}
          try { SEARCHCURT.hadCrop = D.documentElement.classList.contains('wab-threadcrop'); } catch (e1) {}
          setDeclutter(false); // the search box is display:none under the curtain
          setThreadCrop(false);
          SEARCHCURT.lifted = true;
        }
        var box = await pollUntil(Date.now() + SR_BOX_MS, function () {
          var b = findSearchBox();
          if (!b) return null;
          var c = centerOf(b);
          return c ? { el: b, c: c } : null;
        }, STEP_MS);
        if (!box) return { ok: false, error: 'search box not found' };
        // First chat-shaped data-id row currently laid out: where the
        // first result usually renders (the list filters in place). -1
        // when the list is not rendered; the spine proceeds on the box
        // coordinates alone in that case.
        var firstRow = null, els = qsa('#pane-side [data-id]');
        for (var i = 0; i < els.length && !firstRow; i++) {
          var v = '';
          try { v = els[i].getAttribute('data-id') || ''; } catch (eA) { v = ''; }
          if (!v || v.indexOf('_') !== -1) continue;
          firstRow = centerOf(els[i]);
        }
        return {
          ok: true,
          boxX: box.c.x,
          boxY: box.c.y,
          firstRowX: firstRow ? firstRow.x : -1,
          firstRowY: firstRow ? firstRow.y : -1
        };
      } catch (eT) {
        noteError('searchTargetCoords', eT);
        return { ok: false, error: 'search target failed' };
      }
    }
    function searchResultCoordsImpl(matchDigits, matchTitle) {
      // One bounded pass; the SPINE polls this. null = no match YET.
      // Accepts raw digits or any id shape (digitsOnly inside), so the
      // spine can pass the chatId string straight through.
      // V13 J1 D7 fix: 2026 overlay rows often carry NO data-id at all,
      // so the digit-only law can never match them. The optional second
      // argument (the target chat's title, from the spine's roster) adds
      // a TITLE FALLBACK tier: data-id equality still decides FIRST
      // across the whole candidate set; the title tier then considers
      // ONLY rows with no chat-shaped data-id of their own (a row that
      // HAS one and did not match is provably another chat and is never
      // clicked on a title hunch). Title compare is the file's own
      // titlesMatch law (normalize-equals, or startsWith at >= 5 chars);
      // the title never reaches any error, tail or health string.
      var wd = digitsOnly(String(matchDigits == null ? '' : matchDigits));
      var wt = (typeof matchTitle === 'string') ? normalizeTitle(matchTitle) : '';
      var useDigits = !!(wd && wd.length >= 6); // digit bridge law: >= 6 digits
      if (!useDigits && !wt) return W.Promise.resolve(null);
      try {
        var cands = findResultCandidates(); // overlay first, then matched-name, then list
        var n = Math.min(cands.length, SR_CAP);
        var i, el, c;
        if (useDigits) {
          for (i = 0; i < n; i++) { // tier 1: data-id digit equality (H4 law, unchanged)
            el = cands[i] && cands[i].el;
            if (!el || !visible(el)) continue;
            if (rowDataIdDigits(el) !== wd) continue;
            c = centerOf(el);
            if (c) return W.Promise.resolve(c);
          }
        }
        if (wt) {
          for (i = 0; i < n; i++) { // tier 2: title fallback, id-less rows only
            el = cands[i] && cands[i].el;
            if (!el || !visible(el)) continue;
            if (rowDataIdDigits(el)) continue; // carries another chat's id: skip
            if (!titlesMatch(resultRowTitle(el), matchTitle)) continue;
            c = centerOf(el);
            if (c) return W.Promise.resolve(c);
          }
        }
      } catch (eS) { noteError('searchResultCoords', eS); }
      return W.Promise.resolve(null);
    }
    function searchDoneImpl() {
      try {
        if (SEARCHCURT.lifted) {
          try { setDeclutter(SEARCHCURT.hadDeclutter); } catch (e0) {}
          try { setThreadCrop(SEARCHCURT.hadCrop); } catch (e1) {}
          SEARCHCURT.lifted = false;
        }
        return W.Promise.resolve(true);
      } catch (e) { return W.Promise.resolve(false); }
    }

    // Cmd.openChatBottom invocation. First attempt uses the dispatch-style
    // {chat} argument (whatsapp-web.js shape); the V12 retry uses the bare
    // model, covering cmd signature drift between builds. Returns false on
    // a missing cmd or a thrown call; a non-throwing call that opens
    // nothing is caught by the verify poll, not here.
    function callOpenCmd(chat, bareArg) {
      try {
        if (!RUNTIME.cmd || typeof RUNTIME.cmd.openChatBottom !== 'function') return false;
        if (bareArg) RUNTIME.cmd.openChatBottom(chat);
        else RUNTIME.cmd.openChatBottom({ chat: chat });
        return true;
      } catch (eO) { noteError('openChat', eO); return false; }
    }

    // ============================ V12.6 Z1: model-first open ladder ============================
    // Live shape (2026-11-21): the model resolves, Cmd is missing, the DOM
    // search cannot match an untitled lid chat. Law: open THROUGH the
    // model. After the Cmd attempt fails or is absent, enumerate open-ish
    // callables and try each one safely until domChatOpen verifies:
    //   sources (rank order): the collections module's own export object
    //     and every webpack-cached module export (plus its .default)
    //     carrying a function named /^openChat/ or showChat -
    //     openChatBottom first (the whatsapp-web.js shape); then the
    //     model's own open/show/navigate; then model.trigger('open')
    //   shapes: {chat}, {chatId}, the bare model, the bare id string
    //     (trigger keeps its fixed 'open' event argument)
    //   verify: the standard domChatOpen heuristics after EVERY call, one
    //     small window per call; the first verified win is cached
    //     (fn + shape) and reused as a one-call fast path on later opens
    // Enumeration is bounded LADDER_ENUM_MS via this file's own runtime
    // capture (the RUNTIME.req shim stash, else the page require's cache,
    // else ONE fresh shim chunk, stashed back for every later grep); the
    // whole ladder is bounded LADDER_TOTAL_MS inside the X1 open budget;
    // a total miss spaces the next full ladder by PROBE_RETRY_MS. Every
    // call is individually try/catch-guarded and a thenable result has
    // its rejection swallowed, so a wrong shape can never throw into the
    // page or raise an unhandled rejection. Tail tokens are fixed
    // ('open: ladder ...'); callable names never reach any error or tail
    // string (source bucket + shape token only).
    var OPENLADDER = { fn: null, shape: '', evt: '', missAt: 0 };
    var LADDER_SHAPES = ['chat', 'chatId', 'model', 'id'];
    var OPEN_NAME_EXTRA = { showChat: true };
    // V12.7 F1: setActiveChat-ish exports join the ladder ranks (the app's
    // own active-chat setter is an open route in its own right)
    function setActiveChatName(name) {
      try { return /^setActiveChat/.test(String(name)); } catch (e) { return false; }
    }

    function openFnRank(name) {
      if (name === 'openChatBottom') return 0; // the whatsapp-web.js shape first
      if (/^openChat/.test(name)) return 1;
      if (OPEN_NAME_EXTRA[name]) return 2;
      if (setActiveChatName(name)) return 3; // F1 rank: the active-chat setter
      return 9;
    }
    function collectOpenFnsFromObj(obj, src, out, seen) {
      // own enumerable function properties matching the open-ish names,
      // deduped by function identity across all sources
      try {
        if (!obj || typeof obj !== 'object') return;
        var keys;
        try { keys = Object.keys(obj); } catch (eK) { return; }
        for (var i = 0; i < keys.length; i++) {
          var fn = null;
          try { fn = obj[keys[i]]; } catch (eG) { continue; }
          if (typeof fn !== 'function' || seen.indexOf(fn) !== -1) continue;
          if (!/^openChat/.test(keys[i]) && !OPEN_NAME_EXTRA[keys[i]] && !setActiveChatName(keys[i])) continue;
          seen.push(fn);
          out.push({ fn: fn, name: keys[i], src: src, evt: '', rank: openFnRank(keys[i]) });
        }
      } catch (e) {}
    }
    function collectModelOpenFns(chat, out, seen) {
      // the model's own navigation methods, ranked last: cheap, always
      // available, never force-loaded
      var names = ['open', 'show', 'navigate'];
      for (var i = 0; i < names.length; i++) {
        try {
          var fn = chat[names[i]];
          if (typeof fn !== 'function' || seen.indexOf(fn) !== -1) continue;
          seen.push(fn);
          out.push({ fn: fn, name: names[i], src: 'model', evt: '', rank: 4 });
        } catch (eM) {}
      }
      try {
        var trg = chat.trigger;
        if (typeof trg === 'function' && seen.indexOf(trg) === -1) {
          seen.push(trg);
          out.push({ fn: trg, name: 'trigger', src: 'model', evt: 'open', rank: 5 });
        }
      } catch (eT) {}
    }
    // the file's existing runtime capture (probeRuntime technique): the
    // stashed shim require first, else the page require when it carries a
    // module cache, else ONE fresh shim chunk (stashed back into
    // RUNTIME.req so every later grep reuses it and no second chunk is
    // ever pushed)
    function ensureLadderRequire() {
      try { if (RUNTIME.req && RUNTIME.req.c) return RUNTIME.req; } catch (e0) {}
      try { if (typeof W.require === 'function' && W.require.c) return W.require; } catch (e1) {}
      var arrs = chunkArrays();
      for (var i = 0; i < arrs.length; i++) {
        var r = captureViaShim(arrs[i]);
        if (!r) continue;
        try { RUNTIME.req = r; } catch (eS) {}
        if (r.c) return r;
      }
      return null;
    }
    function collectCacheOpenFns(deadline, out, seen) {
      var req = ensureLadderRequire();
      if (!req) return;
      var cache = null;
      try { cache = req.c; } catch (eC) { cache = null; }
      if (!cache) return;
      var n = 0, k;
      try {
        for (k in cache) {
          if ((++n & 63) === 0 && Date.now() > deadline) return; // enum bound
          var exp = null;
          try { exp = cache[k] && cache[k].exports; } catch (e1) { continue; }
          if (!exp) continue;
          collectOpenFnsFromObj(exp, 'cache', out, seen);
          try {
            if (exp.default && exp.default !== exp && typeof exp.default === 'object') {
              collectOpenFnsFromObj(exp.default, 'cache', out, seen);
            }
          } catch (e2) {}
        }
      } catch (e3) {}
    }
    function enumerateOpenFns(chat, enumDeadline) {
      var out = [], seen = [];
      try { collectOpenFnsFromObj(RUNTIME.collections, 'collections', out, seen); } catch (e1) {}
      try { collectCacheOpenFns(enumDeadline, out, seen); } catch (e2) {}
      try { collectModelOpenFns(chat, out, seen); } catch (e3) {}
      out.sort(function (a, b) { return a.rank - b.rank; }); // likely winners first
      if (out.length > LADDER_MAX_CANDS) out.length = LADDER_MAX_CANDS;
      return out;
    }
    function ladderInvoke(fn, shape, evt, chat, id) {
      // one guarded call; a thrown call is just a miss for that shape
      try {
        var r;
        if (evt) r = fn.call(chat, evt); // model.trigger('open')
        else if (shape === 'chat') r = fn({ chat: chat });
        else if (shape === 'chatId') r = fn({ chatId: id });
        else if (shape === 'model') r = fn(chat);
        else r = fn(id);
        if (r && typeof r.then === 'function') {
          try { r.then(function () {}, function () {}); } catch (eT) {} // never a page-level unhandled rejection
        }
        return true;
      } catch (eI) { return false; }
    }
    async function ladderTryCall(chat, id, title, fn, shape, evt, verifyMs, deadline) {
      try { ladderInvoke(fn, shape, evt, chat, id); } catch (eI0) {}
      return !!await pollUntil(
        Math.min(Date.now() + verifyMs, deadline),
        function () { return domChatOpen(id, title); },
        LADDER_VERIFY_STEP_MS
      );
    }
    async function ladderOpen(chat, id, title, deadline) {
      try {
        if (Date.now() >= deadline) return false;
        // fast path: a previously VERIFIED winner (fn + shape) is reused
        // directly: one call, one verify window
        if (OPENLADDER.fn && typeof OPENLADDER.fn === 'function') {
          tail('open: ladder cache try');
          if (await ladderTryCall(chat, id, title, OPENLADDER.fn, OPENLADDER.shape, OPENLADDER.evt, LADDER_CACHE_MS, deadline)) {
            tail('open: ladder cache win');
            return true;
          }
          // stale winner (shape drift, module reload): drop it and run
          // the full enumeration once
          OPENLADDER.fn = null; OPENLADDER.shape = ''; OPENLADDER.evt = '';
          tail('open: ladder cache stale');
          if (Date.now() >= deadline) return false;
        } else if (OPENLADDER.missAt && Date.now() - OPENLADDER.missAt < PROBE_RETRY_MS) {
          // a recent full ladder verified nothing: no module-cache re-grep
          // on every open (the DOM route stays available meanwhile)
          tail('open: ladder spaced');
          return false;
        }
        var cands = enumerateOpenFns(chat, Date.now() + LADDER_ENUM_MS);
        if (!cands.length) {
          OPENLADDER.missAt = Date.now();
          tail('open: ladder enum miss');
          return false;
        }
        tail('open: ladder enum hit (' + cands.length + ')');
        var calls = 0;
        for (var ci = 0; ci < cands.length; ci++) {
          var shapes = cands[ci].evt ? ['evt'] : LADDER_SHAPES;
          for (var si = 0; si < shapes.length; si++) {
            if (calls >= LADDER_MAX_CALLS || Date.now() >= deadline) {
              OPENLADDER.missAt = Date.now();
              tail('open: ladder miss (budget)');
              return false;
            }
            calls++;
            if (await ladderTryCall(chat, id, title, cands[ci].fn, shapes[si], cands[ci].evt, LADDER_VERIFY_MS, deadline)) {
              OPENLADDER.fn = cands[ci].fn;
              OPENLADDER.shape = shapes[si];
              OPENLADDER.evt = cands[ci].evt || '';
              OPENLADDER.missAt = 0;
              tail('open: ladder win (' + cands[ci].src + ' ' + shapes[si] + ')');
              return true;
            }
          }
        }
        OPENLADDER.missAt = Date.now();
        tail('open: ladder miss');
        return false;
      } catch (eL) {
        tail('open: ladder exception');
        return false;
      }
    }

    // ============================ V12.7 F1: warm-open tier + phone search helpers ============================
    // Tier (a) WARM-OPEN: the Z1 ladder is exhausted (every explicit open
    // fn missed), so open THROUGH the model's event bus and the app's own
    // active-chat state: model.trigger with the common open events, then
    // every /^setActiveChat/ export (name-filtered re-enumeration over the
    // same webpack capture, so the ladder's candidate cap can never crowd
    // them out). Every call is verified with domChatOpen; the winner is
    // cached for one-call reuse, a full miss spaces the next attempt like
    // the runtime probe. Fixed tail tokens only.
    var WARMLADDER = { fn: null, shape: '', evt: '', missAt: 0 };
    var WARM_EVT_NAMES = ['open', 'chat:open', 'navigate'];

    function collectSetActiveFnsFromObj(obj, src, out, seen) {
      try {
        if (!obj || typeof obj !== 'object') return;
        var keys;
        try { keys = Object.keys(obj); } catch (eK) { return; }
        for (var i = 0; i < keys.length; i++) {
          if (!setActiveChatName(keys[i])) continue;
          var fn = null;
          try { fn = obj[keys[i]]; } catch (eG) { continue; }
          if (typeof fn !== 'function' || seen.indexOf(fn) !== -1) continue;
          seen.push(fn);
          out.push({ fn: fn, name: keys[i], src: src, evt: '', rank: 0 });
        }
      } catch (e) {}
    }
    function collectCacheSetActiveFns(deadline, out, seen) {
      var req = ensureLadderRequire();
      if (!req) return;
      var cache = null;
      try { cache = req.c; } catch (eC) { cache = null; }
      if (!cache) return;
      var n = 0, k;
      try {
        for (k in cache) {
          if ((++n & 63) === 0 && Date.now() > deadline) return; // enum bound
          var exp = null;
          try { exp = cache[k] && cache[k].exports; } catch (e1) { continue; }
          if (!exp) continue;
          collectSetActiveFnsFromObj(exp, 'cache', out, seen);
          try {
            if (exp.default && exp.default !== exp && typeof exp.default === 'object') {
              collectSetActiveFnsFromObj(exp.default, 'cache', out, seen);
            }
          } catch (e2) {}
        }
      } catch (e3) {}
    }
    function enumerateSetActiveFns(enumDeadline) {
      var out = [], seen = [];
      try { collectSetActiveFnsFromObj(RUNTIME.collections, 'collections', out, seen); } catch (e1) {}
      try { collectCacheSetActiveFns(enumDeadline, out, seen); } catch (e2) {}
      if (out.length > LADDER_MAX_CANDS) out.length = LADDER_MAX_CANDS;
      return out;
    }
    async function warmOpenTier(chat, id, title, deadline) {
      try {
        if (Date.now() >= deadline) return false;
        // cached winner: one call, one verify window
        if (WARMLADDER.fn && typeof WARMLADDER.fn === 'function') {
          tail('open: warm cache try');
          if (await ladderTryCall(chat, id, title, WARMLADDER.fn, WARMLADDER.shape, WARMLADDER.evt, LADDER_CACHE_MS, deadline)) {
            tail('open: warm-open win');
            return true;
          }
          WARMLADDER.fn = null; WARMLADDER.shape = ''; WARMLADDER.evt = '';
          tail('open: warm cache stale');
          if (Date.now() >= deadline) return false;
        } else if (WARMLADDER.missAt && Date.now() - WARMLADDER.missAt < PROBE_RETRY_MS) {
          tail('open: warm spaced');
          return false;
        }
        // 1. model.trigger with the common open events, each verified
        var trg = null;
        try { trg = chat.trigger; } catch (eT) { trg = null; }
        if (typeof trg === 'function') {
          for (var ei = 0; ei < WARM_EVT_NAMES.length; ei++) {
            if (Date.now() >= deadline) break;
            if (await ladderTryCall(chat, id, title, trg, 'evt', WARM_EVT_NAMES[ei], LADDER_VERIFY_MS, deadline)) {
              WARMLADDER.fn = trg; WARMLADDER.shape = 'evt'; WARMLADDER.evt = WARM_EVT_NAMES[ei]; WARMLADDER.missAt = 0;
              tail('open: warm-open win');
              return true;
            }
          }
        }
        // 2. setActiveChat-ish exports, every shape, each verified
        var cands = enumerateSetActiveFns(Date.now() + WARM_ENUM_MS);
        for (var ci = 0; ci < cands.length; ci++) {
          for (var si = 0; si < LADDER_SHAPES.length; si++) {
            if (Date.now() >= deadline) break;
            if (await ladderTryCall(chat, id, title, cands[ci].fn, LADDER_SHAPES[si], '', LADDER_VERIFY_MS, deadline)) {
              WARMLADDER.fn = cands[ci].fn; WARMLADDER.shape = LADDER_SHAPES[si]; WARMLADDER.evt = ''; WARMLADDER.missAt = 0;
              tail('open: warm-open win');
              return true;
            }
          }
          if (Date.now() >= deadline) break;
        }
        WARMLADDER.missAt = Date.now();
        tail('open: warm-open miss');
        return false;
      } catch (eW) {
        tail('open: warm-open exception');
        return false;
      }
    }

    // Phone digits for the phone-search tier. Sources in order: the chat
    // id's own digit user part when the remote is classic @c.us (that IS
    // the phone), the model's contact record (a lid chat's contact often
    // carries the @c.us wid or phone fields), the model id when classic,
    // the contact store's same-domain record phone fields, and finally the
    // digits inside an already-resolved title (WhatsApp renders a +phone
    // fallback for untitled lid chats). Digits are DATA: they never reach
    // any error, tail or health string.
    async function chatPhoneDigits(id, chat, title) {
      try {
        var key = keyOf(id);
        if (!key) return '';
        var okLen = function (d) { return d.length >= 7 && d.length <= 15; };
        if (key.domain === 'c.us' && okLen(key.user)) return key.user;
        if (chat && typeof chat === 'object') {
          try {
            var c = chat.contact;
            if (c && typeof c === 'object') {
              for (var p = 0; p < CONTACT_PHONE_FIELDS.length; p++) {
                var pd = digitsOnly(String(c[CONTACT_PHONE_FIELDS[p]] || ''));
                if (okLen(pd)) return pd;
              }
              var ck = modelIdKey(c);
              if (ck && ck.domain === 'c.us' && okLen(ck.user)) return ck.user;
            }
          } catch (eC) {}
          var mk = modelIdKey(chat);
          if (mk && mk.domain === 'c.us' && okLen(mk.user)) return mk.user;
        }
        try {
          var row = null;
          try { row = await getFrom('contact', key.raw); } catch (eG) { row = null; }
          if (!row) {
            var all = await getAllFrom('contact');
            for (var i = 0; i < all.length; i++) {
              if (idEq(all[i] && all[i].id, key)) { row = all[i]; break; }
            }
          }
          if (row) {
            for (var p2 = 0; p2 < CONTACT_PHONE_FIELDS.length; p2++) {
              var d2 = digitsOnly(String(row[CONTACT_PHONE_FIELDS[p2]] || ''));
              if (okLen(d2)) return d2;
            }
          }
        } catch (eS) {}
        if (title) {
          var td = digitsOnly(String(title));
          if (okLen(td)) return td;
        }
        return '';
      } catch (e) { return ''; }
    }

    async function openChatImpl(chatId) {
      tailReset(); // V12: the tail describes THIS operation only
      tail('open: begin');
      var id = (typeof chatId === 'string') ? chatId : normId(chatId);
      if (!id) {
        tail('open: bad chat id');
        return { ok: false, error: 'bad chat id' };
      }

      // X1 fast path: module route alive AND this id is the last SUCCESSFUL
      // open -> one bounded liveness probe (FAST_LIVENESS_MS) instead of the
      // whole pipeline. Strong evidence first: the open conversation panel
      // literally shows this chat's data-id (domChatOpen's strong branch,
      // sibling-aware, no title needed). Then the spec pair: a live
      // composer, or a still resolvable model. Any hit returns ok; any miss
      // falls through to the full pipeline. The fast path never fails on
      // its own: unproven liveness is verified properly, not guessed.
      var rtAlive = false;
      try { rtAlive = RUNTIME.ok === true; } catch (eA) { rtAlive = false; }
      if (rtAlive && lastOpenedChatId && idEq(lastOpenedChatId, id)) {
        var liveSig = await pollUntil(Date.now() + FAST_LIVENESS_MS, function () {
          if (domChatOpen(id, '')) return 'strong';
          if (getComposer()) return 'composer';
          if (findChatModel(id)) return 'model';
          return null;
        }, 60);
        if (liveSig) {
          tail('open fast-path (' + liveSig + ')');
          return { ok: true, error: null };
        }
        tail('open: fast-path liveness miss');
      }

      var deadline = Date.now() + OPEN_TIMEOUT; // whole call: X1 6 s budget
      var moduleDeadline = Date.now() + MODULE_PHASE_MS; // X1: module phase cap
      var title = '';

      // route 1: module runtime Cmd.openChatBottom (whatsapp-web.js pattern).
      // X1: ONE verify attempt (MODULE_VERIFY_MS) and the WHOLE module phase
      // is capped at MODULE_PHASE_MS: the probe, the model locate and the
      // forced re-probe are all deadline-raced, so the DOM route starts by
      // 2 s after entry no matter what a silent cmd or a hung find does.
      var rtOk = false;
      try { rtOk = (await raceDeadline(probeRuntime(false), moduleDeadline)) === true; } catch (eP) { rtOk = false; }
      if (!rtOk) {
        tail('open: runtime miss');
      } else {
        tail('open: runtime hit');
        var chat = await raceDeadline(locateChatModel(id), moduleDeadline); // V12.1 T1: strict -> find -> twin, X1 deadline-raced
        if (!chat && chatCollectionEmpty() && Date.now() < moduleDeadline - 300) {
          // stale/empty Chat collection (early injection, roster not yet
          // hydrated): ONE forced re-probe, bypassing PROBE_RETRY_MS, still
          // inside the module phase cap
          tail('open: model miss, forced re-probe');
          try { await raceDeadline(probeRuntime(true), moduleDeadline); } catch (eR2) {}
          if (RUNTIME.ok) chat = await raceDeadline(locateChatModel(id), moduleDeadline);
        }
        if (!chat) {
          tail('open: model miss');
        } else {
          tail('open: model hit' +
               (LOCATE.tier && LOCATE.tier !== 'strict' ? ' (' + LOCATE.tier + ')' : ''));
          title = modelTitle(chat);
          // Z1 empty-title law, part 1: a chat with no stored title (the
          // untitled lid shape) must never drop into a title-less verify
          // or a title-less search. Its chat-list row renders a fallback
          // title under a data-id that matches the chat (idSibling
          // twin-aware); donate it HERE so the ladder's verification and,
          // if needed, the DOM search both run with a real title. Pure
          // layout reads (covered-page law); the title stays data.
          if (!title) {
            var rowTitle = domTitleByChatId(id);
            if (rowTitle) {
              title = rowTitle;
              tail('open: title via row data-id');
            }
          }
          var haveCmd = false;
          try { haveCmd = !!(RUNTIME.cmd && typeof RUNTIME.cmd.openChatBottom === 'function'); } catch (eHc) { haveCmd = false; }
          if (!haveCmd) tail('open: cmd miss');
          var opened = false;
          if (haveCmd) {
            // X1: single attempt. One dispatch-style call (the
            // whatsapp-web.js shape), one verify window clamped to the
            // phase cap. The old second attempt (fresh model + bare-arg
            // retry + its own 2.5 s window) is gone: a silent or thrown
            // cmd hands straight over to the Z1 model-first ladder below
            // instead of the DOM route.
            var called1 = callOpenCmd(chat, false);
            tail(called1 ? 'open: cmd call 1 ok' : 'open: cmd call 1 failed');
            if (called1) {
              opened = !!await pollUntil(
                Math.min(Date.now() + MODULE_VERIFY_MS, moduleDeadline, deadline),
                function () { return domChatOpen(id, title); }, 200
              );
            }
          }
          if (opened) {
            tail('open: module-route hit');
            lastOpenedChatId = id; // X1 belief: this open returned ok
            return { ok: true, error: null };
          }
          // Z1 model-first ladder: Cmd is missing or silent, so open
          // THROUGH the resolved model. Bounded (enum + calls) inside the
          // overall open budget; a verified win is cached for later opens.
          var ladderOk = await ladderOpen(chat, id, title, Math.min(deadline, Date.now() + LADDER_TOTAL_MS));
          if (ladderOk) {
            tail('open: ladder-route hit');
            lastOpenedChatId = id; // X1 belief: this open returned ok
            return { ok: true, error: null };
          }
          // F1 tier (a) WARM-OPEN: every explicit open fn missed; open
          // through the model's event bus and the app's active-chat setter
          var warmOk = await warmOpenTier(chat, id, title, Math.min(deadline, Date.now() + WARM_OPEN_MS));
          if (warmOk) {
            tail('open: warm-route hit');
            lastOpenedChatId = id; // X1 belief: this open returned ok
            return { ok: true, error: null };
          }
          tail('open: module-route miss');
        }
      }

      // route 2: DOM search fallback (v2 open-chat pattern, inlined),
      // cover-proof: typing, matching and clicking all work while the
      // engine view sits permanently under the UI view. X1: the route gets
      // its own DOM_ROUTE_MS cap, clamped inside the overall deadline.
      // Z1 empty-title law: NEVER search with an empty or whitespace
      // title, it is a guaranteed no-match (the untitled lid bug). Title
      // chain: model title, then the IDB join, then the chat-row data-id
      // scan; still nothing -> fail named and honest, never run a doomed
      // search.
      tail('open: dom-route begin');
      if (!title) title = await idbChatTitle(id);
      if (!title) title = domTitleByChatId(id);
      // F1 phone digits (data only; never surfaced in any string)
      var phone = '';
      try { phone = await chatPhoneDigits(id, chat || null, title); } catch (ePh) { phone = ''; }
      var isLid = false;
      try { var dKey = keyOf(id); isLid = !!(dKey && dKey.domain === 'lid'); } catch (eK) { isLid = false; }
      var phoneTried = false;
      // F1 tier (b) PHONE SEARCH, in priority before the title search for
      // lid chats (a rendered +phone row can never be matched by a stored
      // name) and the ONLY search when no usable title exists (never an
      // empty-title search). WhatsApp's own search resolves phone numbers.
      if (phone && (isLid || !title || !normWs(title))) {
        phoneTried = true;
        tail((isLid && title && normWs(title)) ? 'open: phone search (lid)' : 'open: phone search (no title)');
        var viaPhone = await openChatViaSearch(id, phone, Math.min(deadline, Date.now() + DOM_ROUTE_MS));
        if (viaPhone && viaPhone.ok) {
          tail('open: phone search win');
          lastOpenedChatId = id; // X1 belief: this open returned ok
          return viaPhone;
        }
      }
      if (!title || !normWs(title)) {
        tail('open: chat not openable');
        return { ok: false, error: 'chat not openable (no title and no model route)' };
      }
      var viaDom = await openChatViaSearch(id, title, Math.min(deadline, Date.now() + DOM_ROUTE_MS));
      if (viaDom && viaDom.ok) {
        lastOpenedChatId = id; // X1 belief: this open returned ok
        return viaDom;
      }
      // F1 tier (c): the title search found no row -> ONE retry with the
      // phone digits (never repeated after a phone search already ran)
      if (viaDom && viaDom.error === 'search did not match' && phone && !phoneTried) {
        tail('open: phone search (row retry)');
        var viaPhone2 = await openChatViaSearch(id, phone, Math.min(deadline, Date.now() + DOM_ROUTE_MS));
        if (viaPhone2 && viaPhone2.ok) {
          tail('open: phone search win');
          lastOpenedChatId = id; // X1 belief: this open returned ok
          return viaPhone2;
        }
        return viaPhone2;
      }
      return viaDom;
    }

    // ============================ impl: send ============================
    // Composer chain, exactly the research chain (ekko live 2026-07-12,
    // vortex1024 Oct 2026). COMPOSER_TIER records which link hit (1
    // data-tab=10 legacy, 2 #main footer contenteditable, 3 footer-wide)
    // for the step tail.
    var COMPOSER_TIER = 0;
    function getComposer() {
      COMPOSER_TIER = 0;
      var el = D.querySelector('#main footer div[contenteditable="true"][data-tab="10"]');
      if (el) { COMPOSER_TIER = 1; return el; }
      el = D.querySelector('#main footer div[contenteditable="true"]');
      if (el) { COMPOSER_TIER = 2; return el; }
      el = D.querySelector('footer [contenteditable="true"]');
      if (el) { COMPOSER_TIER = 3; return el; }
      return null;
    }
    function composeLive() {
      // send() ONLY after openChat: refuse when no conversation is open
      try {
        if (D.querySelector('[data-testid="intro-panel"]')) return false;
        return !!getComposer();
      } catch (e) { return false; }
    }
    // Selection range-replace insertText. NEVER execCommand('selectAll'/'delete')
    // to clear: the current build ignores those (ekko 2026-07-17). A range
    // covering the whole box REPLACES whatever draft is there, so stale text
    // can never stack. INSERT_FALLBACK records whether the honored path was
    // execCommand or the synthetic-beforeinput fallback (tail info only).
    var INSERT_FALLBACK = false;
    function insertViaSelection(box, text) {
      INSERT_FALLBACK = false;
      try {
        try { box.focus(); } catch (eF) {}
        var sel = W.getSelection();
        var range = D.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
        var okInsert = false;
        try { okInsert = !!D.execCommand('insertText', false, text); } catch (eE) { okInsert = false; }
        if (okInsert) return true;
        // fallback for a rejected execCommand: synthetic beforeinput over the
        // same range (delete the old content, then insert), React honors these
        INSERT_FALLBACK = true;
        try {
          box.dispatchEvent(new W.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
          box.dispatchEvent(new W.InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
          box.dispatchEvent(new W.InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
        } catch (eV) {}
        return composerEquals(box, text);
      } catch (e) { return false; }
    }
    // EXACT match law (ekko): the box must hold exactly the intended text
    // before the click. Whitespace-collapsed on both sides because a
    // contenteditable DOM loses explicit newlines in textContent.
    function composerEquals(box, text) {
      try { return normWs(box.textContent || '') === normWs(text) && normWs(text).length > 0; }
      catch (e) { return false; }
    }

    // ============================ V13 J1 D6: impl: insertDraft (passive) ============================
    // The H2 selftest's COMPOSER probe wanted exactly this seam (its
    // first-choice name): test the composer INSERT step send() uses
    // (selection-replace execCommand insertText, unicode/emoji payloads
    // included) with zero send risk. NEVER touches the send button - no
    // findTextSendButton call, no click, nothing but the composer box.
    // Flow: resolve the composer (the send() tier chain), insert via the
    // SAME insertViaSelection, verify the EXACT text law
    // (composerEquals), then IMMEDIATELY clear the box - whole-box
    // selection + insertText '' plus the synthetic-beforeinput fallback,
    // the same mechanism family the insert uses (execCommand
    // selectAll/delete is NEVER used: the ekko law says this build
    // ignores those). One fresh re-resolve retry when a clear leaves
    // text behind (the stale-node law). The probe draft therefore never
    // lingers in a real chat's composer. An empty-string call is a
    // CLEAR-ONLY call (the selftest's second invocation shape). Fixed
    // token tail entries only; the payload never reaches any string.
    function clearViaSelection(box) {
      try {
        try { box.focus(); } catch (eF) {}
        var sel = W.getSelection();
        var range = D.createRange();
        range.selectNodeContents(box); // select-all: a range over the whole box
        sel.removeAllRanges();
        sel.addRange(range);
        var okDel = false;
        try { okDel = !!D.execCommand('insertText', false, ''); } catch (eE) { okDel = false; }
        if (!okDel) {
          // the insertViaSelection fallback shape: delete via beforeinput
          try {
            box.dispatchEvent(new W.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
            box.dispatchEvent(new W.InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
          } catch (eV) {}
        }
        return normWs(box.textContent || '').length === 0; // empty IS the verify (composerEquals needs non-empty)
      } catch (e) { return false; }
    }
    async function insertDraftImpl(text) {
      var t = (typeof text === 'string') ? text : '';
      var box = getComposer();
      if (!box) return { ok: false, verified: false, cleared: false, error: 'no composer' };
      if (!normWs(t)) {
        // clear-only shape (insertDraft(''))
        var cOnly = clearViaSelection(box);
        if (!cOnly) {
          var cb = getComposer();
          if (cb) cOnly = clearViaSelection(cb); // one fresh re-resolve retry
        }
        tail(cOnly ? 'draft: clear ok' : 'draft: clear fail');
        return { ok: cOnly, verified: false, cleared: cOnly };
      }
      var okIns = false;
      try { okIns = insertViaSelection(box, t); }
      catch (eI) { okIns = false; }
      var verified = okIns && composerEquals(box, t); // EXACT match law, same as send()
      tail(verified ? 'draft: insert ok' : 'draft: insert fail');
      // IMMEDIATE clear: a probe draft never lingers in a real chat
      var cleared = clearViaSelection(box);
      if (!cleared) {
        var cb2 = getComposer();
        if (cb2) cleared = clearViaSelection(cb2); // one fresh re-resolve retry
      }
      tail(cleared ? 'draft: clear ok' : 'draft: clear fail');
      return { ok: !!(verified && cleared), verified: verified, cleared: cleared };
    }

    // Text-send button ONLY. aria-label first (ekko, aria-first), then the
    // SVG <title> token wds-ic-send-filled (vortex1024 exact-match technique),
    // then the data-icon attribute form (ekko). NEVER the bare token
    // ic-send-filled: that is the VOICE-note button. The token compare is
    // exact equality, so the voice token can never match. BTN_TIER records
    // which tier resolved (1 aria, 2 svg title, 3 data-icon) for the tail.
    var BTN_TIER = 0;
    function findTextSendButton() {
      BTN_TIER = 0;
      var footer = null;
      try { footer = D.querySelector('footer'); } catch (e0) { return null; }
      if (!footer) return null;
      var b = null;
      try {
        b = footer.querySelector('button[aria-label="Send"], [role="button"][aria-label="Send"]');
      } catch (e1) {}
      if (b) { BTN_TIER = 1; }
      if (!b) {
        try {
          var titles = footer.querySelectorAll('title');
          for (var i = 0; i < titles.length; i++) {
            if ((titles[i].textContent || '').trim() === 'wds-ic-send-filled') {
              var cand = titles[i].closest('button, [role="button"]');
              if (cand) { b = cand; BTN_TIER = 2; break; }
            }
          }
        } catch (e2) {}
      }
      if (!b) {
        try {
          var ic = footer.querySelector('[data-icon="wds-ic-send-filled"]');
          if (ic) { b = ic.closest('button, [role="button"]'); BTN_TIER = 3; }
        } catch (e3) {}
      }
      if (!b) return null;
      // visible/enable guard (vortex1024 + defensive aria-disabled).
      // COVERED-page law: getClientRects is a layout check; a covered
      // button still has rects, so the guard passes blind.
      try {
        if (b.disabled) return null;
        if (b.getAttribute('aria-hidden') === 'true') return null;
        if (b.getAttribute('aria-disabled') === 'true') return null;
        if (!b.getClientRects().length) return null;
      } catch (e4) { return null; }
      return b;
    }
    // X1: adaptive click-registration poll. True the moment the composer no
    // longer holds the EXACT draft (the click provably registered), or when
    // no composer exists at all (nothing retryable; the delivery ack poll
    // decides the truth). False ONLY when the window ends with the exact
    // draft still sitting in the box, which is the one condition that arms
    // the single retry. Never waits past CLICK_REGISTRATION_MS.
    async function clickRegistered(text) {
      var deadline = Date.now() + CLICK_REGISTRATION_MS;
      while (true) {
        var box = getComposer();
        if (!box) return true;
        if (!composerEquals(box, text)) return true;
        if (Date.now() >= deadline) return false;
        await sleep(CLICK_REG_STEP_MS);
      }
    }
    // delivery ack: poll the ack field on the outgoing message model (the
    // in-memory mirror of the message store). Presence of the outgoing
    // message counts as sent; ack >= 1 counts as delivered. Without the
    // runtime, fall back to the outgoing-bubble DOM echo (data-id starting
    // with true_), then to the consumed-draft signal (empty composer).
    // V12: resolves with a fixed tier token ('model' | 'dom' | 'draft' |
    // 'model-pending') or null; truthiness is unchanged.
    // X1: the loop returns on the FIRST positive signal (model ack or the
    // outgoing DOM bubble) inside a 2.5 s cap; the weaker draft-consumed
    // signal stays as the last resort and counts ONLY when a composer
    // exists and is empty.
    function scanAckModels(startedAtMs, want) {
      try {
        var chats = collectionModels(RUNTIME.collections && RUNTIME.collections.Chat) || [];
        for (var ci = 0; ci < chats.length; ci++) {
          var msgs = chatMsgModels(chats[ci]) || [];
          for (var mi = msgs.length - 1; mi >= msgs.length - 6 && mi >= 0; mi--) {
            var m = msgs[mi];
            if (!m) continue;
            try {
              if (m.fromMe !== true) continue;
              var tms = (typeof m.t === 'number') ? m.t * 1000 : 0;
              if (tms < startedAtMs - 4000) continue; // older than this send
              if (typeof m.body !== 'string' || normWs(m.body) !== want) continue;
              if (typeof m.ack === 'number' && m.ack >= 1) return 'ack';
              return 'pending'; // the message exists, ack not landed yet
            } catch (eM) {}
          }
        }
      } catch (eS) {}
      return null;
    }
    function scanAckDom(want) {
      try {
        var wraps = qsa('[data-id]');
        for (var i = 0; i < wraps.length; i++) {
          var v = wraps[i].getAttribute('data-id') || '';
          if (v.indexOf('true_') !== 0) continue; // outgoing only
          if (want && normWs(wraps[i].textContent || '').indexOf(want) !== -1) return true;
        }
      } catch (eD) {}
      return false;
    }
    async function waitDeliveryAck(startedAtMs, text) {
      var want = normWs(text);
      var runtimeOk = false;
      try { runtimeOk = await probeRuntime(false); } catch (eP) { runtimeOk = false; }
      var deadline = Date.now() + ACK_TIMEOUT; // X1: 2.5 s cap, first positive returns
      var sawMsg = false;
      while (Date.now() < deadline) {
        if (runtimeOk) {
          var r = scanAckModels(startedAtMs, want);
          if (r === 'ack') return 'model';
          if (r === 'pending') sawMsg = true;
          if (scanAckDom(want)) return 'dom';
        } else if (scanAckDom(want)) {
          return 'dom';
        }
        await sleep(ACK_STEP_MS);
      }
      if (sawMsg) return 'model-pending'; // sent; ack field not observed inside the window
      // last resort: WhatsApp consumed the draft (empty box shows the mic).
      // X1 law: this weaker signal is success ONLY when a composer exists
      // AND is empty; a missing composer proves nothing.
      try {
        var box = getComposer();
        if (box && normWs(box.textContent || '') === '') return 'draft';
      } catch (eC) {}
      return null;
    }
    async function sendImpl(text) {
      tailReset(); // V12: the tail describes THIS operation only
      tail('send: begin');
      var startedAt = Date.now();
      try {
        if (typeof text !== 'string' || !normWs(text)) {
          tail('send: empty text');
          return { ok: false, error: 'empty text' };
        }
        if (!composeLive()) {
          // V12 fresh-open grace: right after openChat the conversation
          // footer can still be rendering; give the composer a short
          // window before refusing. This was the Bruce shape: open had
          // just returned, send refused instantly with 'no chat open'.
          // X1: the grace runs ONLY when no composer was live on the first
          // try, and the window is 1.2 s (was 1.5 s).
          var live = await pollUntil(Date.now() + COMPOSE_GRACE_MS, composeLive, 150);
          if (!live) {
            tail('send: no chat open');
            return { ok: false, error: 'no chat open' };
          }
          tail('send: composer after grace');
        } else {
          // X1: a composer was already live at entry (pre-opened chat):
          // the fresh-open grace is skipped entirely
          tail('send fast-path');
        }

        // step: resolve composer fresh, focus
        var box = getComposer();
        if (!box) {
          tail('send: composer miss');
          return { ok: false, error: 'composer not found' };
        }
        tail('send: composer resolved tier ' + COMPOSER_TIER);
        // step: Selection range-replace insert
        if (!insertViaSelection(box, text)) {
          tail('send: insert failed');
          return { ok: false, error: 'insert failed' };
        }
        tail(INSERT_FALLBACK ? 'send: insert via fallback events' : 'send: insert via selection');
        // step: exact-match verify, one fresh-node retry (the composer node
        // can be replaced mid-send when the footer re-renders)
        if (!composerEquals(box, text)) {
          tail('send: text verify mismatch once, retried');
          box = getComposer();
          if (!box) {
            tail('send: composer replaced');
            return { ok: false, error: 'composer replaced' };
          }
          try { box.focus(); } catch (eF2) {}
          if (!insertViaSelection(box, text)) {
            tail('send: insert retry failed');
            return { ok: false, error: 'insert retry failed' };
          }
          if (!composerEquals(box, text)) {
            tail('send: text verify failed');
            return { ok: false, error: 'insert verify failed' };
          }
          tail('send: text verify ok after retry');
        } else {
          tail('send: text verify ok');
        }
        // step: text-send button (never the voice button), re-resolved per tick
        var btn = await pollTries(findTextSendButton, BUTTON_TRIES, BUTTON_STEP_MS);
        if (!btn) {
          tail('send: send button miss');
          return { ok: false, error: 'send button not found' };
        }
        tail('send: button tier ' + BTN_TIER + ' hit');
        // step: plain real click (a bare synthetic .click() verifiably sends)
        try { btn.click(); } catch (eC) {
          tail('send: click 1 failed');
          return { ok: false, error: 'click failed' };
        }
        tail('send: click 1 sent');

        // V12 step: click registration. A click on a node the footer
        // re-rendered away is a silent no-op that leaves the draft in the
        // box. X1: the window is an ADAPTIVE poll capped at
        // CLICK_REGISTRATION_MS (was a fixed 1.5 s sleep): the moment the
        // composer no longer holds the EXACT text, the click registered and
        // the ack phase starts immediately. Only a composer still holding
        // the EXACT text at the cap arms the ONE retry, on a freshly
        // resolved button (never the stale node), then it fails naming the
        // step. The duplicate-send guard holds: the retry fires only when
        // the draft provably never left the box.
        var registered = await clickRegistered(text);
        if (!registered) {
          tail('send: click 1 did not register');
          var btn2 = await pollTries(findTextSendButton, BUTTON_TRIES, BUTTON_STEP_MS);
          if (!btn2) {
            tail('send: send button miss on retry');
            return { ok: false, error: 'send click did not register' };
          }
          tail('send: button tier ' + BTN_TIER + ' hit (retry)');
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

        // step: delivery ack. X1: 2.5 s cap, returns on the FIRST positive
        // signal. Never re-click a dead node.
        var ack = await waitDeliveryAck(startedAt, text);
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

    // ============================ V12.5 Y1: typing state ============================
    // getTyping(): the chat TITLES currently showing WhatsApp's own typing
    // indicator. Titles only (already public in the people list); no message
    // text, no contact names in any error string, the open/send TAIL is
    // never touched, nothing is written anywhere. Tiers, fastest first,
    // results merged and deduped by normalized title:
    //   tier 1 module (opportunistic, silent degrade): chat models carrying
    //     a composing state (chat.presence chatstate 'composing' /
    //     isComposing / isTyping, chat.isComposing / chat.isTyping /
    //     chat.typing), plus a presence collection located ONCE via named
    //     require then a bounded module-cache grep (TYPING_PROBE_MS cap,
    //     TYPING_PRESENCE_RETRY_MS spacing) whose composing entries are
    //     joined back to chat titles through the same strict + twin
    //     locator openChat uses.
    //   tier 2 DOM (always available, the primary truth): one bounded pass
    //     (no polling, max TYPING_ROW_CAP rows) over the same LIST_CHAIN
    //     rows the search fallback reads, blind per the covered-page law.
    //     A row trips on:
    //     (a) WEAK  an aria-label or title attribute exactly equal to an
    //          EN typing string;
    //     (b) STRONG  a data-icon containing 'typing', or a running CSS
    //          animation on a tiny text-free element in the row's status
    //          line (right of the avatar band, lower part of the row) -
    //          locale-free;
    //     (c) BEST-EFFORT  a status-line span exactly equal to an EN
    //          typing string.
    // Row titles use the same spansText extraction domChatListTitles uses.
    // The whole result is cached TYPING_CACHE_MS (the spine polls every
    // 2 s; callers inside that window reuse the pass for free).
    var TYPING = { at: 0, val: [], presCol: null, presTryAt: 0 };
    var TYPING_LABELS = { 'typing...': true, 'typing': true };
    function isTypingLabel(s) {
      // exact EN typing strings only ('typing...', 'typing…',
      // 'typing'); the ellipsis folds to three dots before the compare
      try {
        if (typeof s !== 'string') return false;
        var t = s.toLowerCase().replace(/…/g, '...').replace(/\s+/g, ' ').trim();
        return TYPING_LABELS[t] === true;
      } catch (e) { return false; }
    }
    function pushTypingTitle(out, seen, title) {
      try {
        var t = normWs(title);
        if (!t) return;
        var k = t.toLowerCase();
        if (seen[k]) return;
        seen[k] = true;
        out.push(t);
      } catch (e) {}
    }

    // ---- tier 1a: chat models with a composing state ----
    function presenceModelComposing(m) {
      try {
        if (!m || typeof m !== 'object') return false;
        if (m.isComposing === true || m.isTyping === true) return true;
        var st = m.chatstate;
        if (typeof st !== 'string') st = m.state;
        if (typeof st === 'string' && st.toLowerCase() === 'composing') return true;
        var at = (m.attributes && typeof m.attributes === 'object') ? m.attributes : null;
        if (at) {
          if (at.isComposing === true || at.isTyping === true) return true;
          var st2 = at.chatstate;
          if (typeof st2 !== 'string') st2 = at.state;
          if (typeof st2 === 'string' && st2.toLowerCase() === 'composing') return true;
        }
      } catch (e) {}
      return false;
    }
    function chatModelComposing(ch) {
      try {
        if (!ch || typeof ch !== 'object') return false;
        if (ch.isComposing === true || ch.isTyping === true || ch.typing === true) return true;
        var p = null;
        try { p = ch.presence; } catch (eP) { p = null; }
        if (p && typeof p === 'object' && presenceModelComposing(p)) return true;
      } catch (e) {}
      return false;
    }
    function typingFromChatModels(out, seen) {
      var col = null;
      try { col = RUNTIME.collections && RUNTIME.collections.Chat; } catch (e0) { col = null; }
      var models = collectionModels(col);
      if (!models || !models.length) return;
      for (var i = 0; i < models.length && i < ROSTER_CAP; i++) {
        try {
          if (!chatModelComposing(models[i])) continue;
          var t = modelTitle(models[i]);
          if (t) pushTypingTitle(out, seen, t);
        } catch (eR) {}
      }
    }

    // ---- tier 1b: a presence collection from the module cache ----
    // Detection is pure property reading (no method calls), bounded by
    // TYPING_PROBE_MS wall clock, retried at most every
    // TYPING_PRESENCE_RETRY_MS, silent on every miss. The grep reuses the
    // webpack require probeRuntime already captured (RUNTIME.req stash), so
    // it never pushes a second shim chunk into the page.
    function modelHasChatstate(m) {
      try {
        if (!m || typeof m !== 'object') return false;
        if (typeof m.chatstate === 'string' || typeof m.isComposing === 'boolean') return true;
        var at = (m.attributes && typeof m.attributes === 'object') ? m.attributes : null;
        if (at && (typeof at.chatstate === 'string' || typeof at.isComposing === 'boolean')) return true;
      } catch (e) {}
      return false;
    }
    function presenceExportsLike(x) {
      try {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
        if (Array.isArray(x.models) && x.models.length && modelHasChatstate(x.models[0])) return true;
        if (x.presences && typeof x.presences === 'object' && !Array.isArray(x.presences)) {
          for (var k in x.presences) {
            return modelHasChatstate(x.presences[k]); // first entry decides
          }
        }
      } catch (e) {}
      return false;
    }
    function typingRequire() {
      try { if (RUNTIME.req && RUNTIME.req.c) return RUNTIME.req; } catch (e0) {}
      try { if (typeof W.require === 'function' && W.require.c) return W.require; } catch (e1) {}
      return null;
    }
    function ensurePresenceCollection() {
      if (TYPING.presCol) return; // found once, kept
      var now = Date.now();
      if (TYPING.presTryAt && now - TYPING.presTryAt < TYPING_PRESENCE_RETRY_MS) return;
      TYPING.presTryAt = now;
      var req = typingRequire();
      if (!req) return;
      // named modules first (cheap, silent)
      var names = ['WAWebPresenceCollection', 'WAWebChatPresenceCollection', 'PresenceCollection'];
      for (var i = 0; i < names.length; i++) {
        try {
          var m = req(names[i]);
          var c = (m && m.default && !presenceExportsLike(m)) ? m.default : m;
          if (presenceExportsLike(c)) { TYPING.presCol = c; return; }
        } catch (eN) {}
      }
      // then the module cache grep, wall-clock bounded
      var cache = null;
      try { cache = req.c; } catch (eC) { cache = null; }
      if (!cache) return;
      var deadline = now + TYPING_PROBE_MS;
      var n = 0, k;
      try {
        for (k in cache) {
          if ((++n & 63) === 0 && Date.now() > deadline) return;
          var exp = null;
          try { exp = cache[k] && cache[k].exports; } catch (e1) { continue; }
          if (!exp) continue;
          if (presenceExportsLike(exp)) { TYPING.presCol = exp; return; }
          try {
            if (exp.default && exp.default !== exp && presenceExportsLike(exp.default)) {
              TYPING.presCol = exp.default; return;
            }
          } catch (e2) {}
        }
      } catch (e3) {}
    }
    function presenceModelChatId(m) {
      try {
        if (!m || typeof m !== 'object') return null;
        if (m.chatId !== undefined) return m.chatId;
        var at = (m.attributes && typeof m.attributes === 'object') ? m.attributes : null;
        if (at) {
          if (at.chatId !== undefined) return at.chatId;
          if (at.id !== undefined) return at.id;
        }
        if (m.id !== undefined) return m.id;
        if (m.wid !== undefined) return m.wid;
      } catch (e) {}
      return null;
    }
    function addPresenceTitle(out, seen, id) {
      try {
        var k = keyOf(id);
        if (!k) return;
        var chat = findChatModel(k) || twinChatModel(k); // strict, then the @lid/@c.us twin
        var t = chat ? modelTitle(chat) : '';
        if (t) pushTypingTitle(out, seen, t);
      } catch (e) {}
    }
    function presenceTypingTitles(out, seen) {
      var col = TYPING.presCol;
      if (!col) return;
      try {
        var ms = collectionModels(col);
        if (ms && ms.length) {
          for (var i = 0; i < ms.length && i < TYPING_PRESENCE_CAP; i++) {
            try {
              if (!presenceModelComposing(ms[i])) continue;
              addPresenceTitle(out, seen, presenceModelChatId(ms[i]));
            } catch (eM) {}
          }
          return;
        }
      } catch (eC) {}
      try {
        var pr = col.presences;
        if (pr && typeof pr === 'object') {
          var n = 0;
          for (var pk in pr) {
            if (n++ >= TYPING_PRESENCE_CAP) break;
            try {
              if (!presenceModelComposing(pr[pk])) continue;
              addPresenceTitle(out, seen, pk);
            } catch (eK) {}
          }
        }
      } catch (eP) {}
    }

    // ---- tier 2: DOM chat-list rows (one bounded pass) ----
    function rowAnimatedTyping(row) {
      // a live CSS animation on a tiny text-free element sitting in the
      // status line (right of the avatar band, lower part of the row):
      // the typing dots. Layout checks only (covered-page law).
      try {
        var rr = null;
        try { rr = row.getBoundingClientRect(); } catch (e0) { rr = null; }
        if (!rr || rr.width <= 0 || rr.height <= 0) rr = null;
        var kids = qsa('*', row);
        var checks = 0;
        for (var i = 0; i < kids.length && checks < TYPING_ANIM_CAP; i++) {
          var el = kids[i];
          var txt = '';
          try { txt = collapsed(el); } catch (eT) { txt = '?'; }
          if (txt) continue; // the dots carry no text
          var r = null;
          try { r = el.getBoundingClientRect(); } catch (eR) { r = null; }
          if (!r || r.width <= 0 || r.height <= 0) continue;
          if (r.width > 24 || r.height > 24) continue; // tiny only
          if (rr && (r.left - rr.left) < 48) continue; // past the avatar band
          if (rr && (r.top - rr.top) < rr.height * 0.35) continue; // status line: lower part
          checks++;
          var an = '';
          try { an = W.getComputedStyle(el).animationName; } catch (eC) { an = ''; }
          if (an && an !== 'none') return true;
        }
      } catch (e) {}
      return false;
    }
    function rowTypingMarker(row) {
      // 1 = weak aria/title, 2 = strong icon/animation, 3 = best-effort
      // status text, 0 = no marker
      try {
        var i, el, v;
        var attrs = qsa('[aria-label], [title]', row);
        for (i = 0; i < attrs.length; i++) {
          el = attrs[i];
          try {
            v = el.getAttribute('aria-label');
            if (isTypingLabel(v)) return 1;
            v = el.getAttribute('title');
            if (isTypingLabel(v)) return 1;
          } catch (eA) {}
        }
        var icons = qsa('[data-icon]', row);
        for (i = 0; i < icons.length; i++) {
          try {
            v = icons[i].getAttribute('data-icon') || '';
            if (v.toLowerCase().indexOf('typing') !== -1) return 2;
          } catch (eI) {}
        }
        if (rowAnimatedTyping(row)) return 2;
        var spans = qsa('span[dir="auto"], div[dir="auto"]', row);
        for (i = 0; i < spans.length; i++) {
          try { if (isTypingLabel(collapsed(spans[i]))) return 3; } catch (eS) {}
        }
        return 0;
      } catch (e) { return 0; }
    }
    function typingFromDomRows(out, seen) {
      var t0 = Date.now();
      var rows = [], nodes = [], i, j;
      for (i = 0; i < LIST_CHAIN.length; i++) {
        var found = qsa(LIST_CHAIN[i]).filter(visible);
        for (j = 0; j < found.length; j++) {
          if (nodes.indexOf(found[j]) === -1) { nodes.push(found[j]); rows.push(found[j]); }
          if (rows.length >= TYPING_ROW_CAP) break;
        }
        if (rows.length >= TYPING_ROW_CAP) break;
      }
      for (i = 0; i < rows.length; i++) {
        if ((i & 7) === 7 && Date.now() - t0 > TYPING_PASS_MS) break; // soft wall
        try {
          if (!rowTypingMarker(rows[i])) continue;
          var t = rowTitleGeneric(rows[i]); // D2: structure-free row title
          if (t) pushTypingTitle(out, seen, t);
        } catch (eR) {}
      }
    }

    async function typingImpl() {
      var now = Date.now();
      if (TYPING.at && now - TYPING.at < TYPING_CACHE_MS) {
        return TYPING.val.slice(); // spine polls every 2 s; never double-work
      }
      var out = [], seen = {};
      var rtOk = false;
      try { rtOk = await probeRuntime(false); } catch (eP) { rtOk = false; }
      if (rtOk) {
        try { typingFromChatModels(out, seen); } catch (eM) {}
        try {
          ensurePresenceCollection();
          presenceTypingTitles(out, seen);
        } catch (eC) {}
      }
      try { typingFromDomRows(out, seen); } catch (eD) {} // always available
      TYPING.at = Date.now();
      TYPING.val = out;
      return out.slice();
    }

    // ============================ public surface ============================
    // guard(): every method resolves, never rejects, failures carry step names
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

    // Avatars (E2): pull the chat-list faces the page already rendered, keyed
    // by D2's rowTitleGeneric. 2026 truth: rows keep role="row" but the
    // census-era hooks are gone; the FIRST img in a row can be an emoji in
    // the preview line (class token 'emoji'), and the avatar itself may be
    // a canvas or a background-image div. So the harvest is a band-scoped
    // tier ladder per row: img -> canvas -> shadow (one level) -> bg. Every
    // tier converts through one path that enforces the MIME LAW: the result
    // must be a data:image/ dataURL under 60 KB or the tier answers null -
    // a failed fetch can never deliver HTML or a blank as a "face". Tier
    // counts land in the tail and in debugAvatarTiers (numbers only).
    var AVATAR_PASS_MS = 2500;  // soft wall for the whole harvest pass
    var AVATAR_W = { rows: 0, img: 0, canvas: 0, shadow: 0, bg: 0, miss: 0 };
    function avatarSrcOk(raw) {
      if (!raw) return false;
      var s = String(raw);
      if (s.charAt(0) === '#') return false; // 2026 placeholder src: never fetch
      return s.indexOf('blob:') === 0 || s.indexOf('data:image/') === 0 ||
             s.indexOf('https:') === 0 || s.indexOf('http:') === 0;
    }
    function imgEmojiish(el) {
      try {
        var c = ' ' + String(el.className || '').replace(/\s+/g, ' ') + ' ';
        return c.indexOf(' emoji ') !== -1 || c.indexOf(' sticker ') !== -1;
      } catch (e) { return true; } // unreadable class: do not trust the img
    }
    function inLeftBand(row, el) {
      // covered-page law: rects always exist. The avatar zone is the left
      // ~30% of the row; preview emojis and thumbs die here when classes lie.
      try {
        var rr = row.getBoundingClientRect();
        var er = el.getBoundingClientRect();
        if (!rr || !rr.width || !er || !er.width) return true; // no geometry: order decides
        if (er.left < rr.left - 2) return false;
        if ((er.left - rr.left) > rr.width * 0.3) return false;
        if ((er.right - er.left) > rr.width * 0.5) return false;
        return true;
      } catch (eG) { return true; }
    }
    function avatarFromUrl(u) {
      return W.fetch(u).then(function (r) { return r ? r.blob() : null; }).then(function (b) {
        if (!b || String(b.type || '').indexOf('image/') !== 0) return null; // MIME law
        return new W.Promise(function (res2) {
          var fr = new W.FileReader();
          fr.onload = function () {
            var s = String(fr.result || '');
            res2(s.indexOf('data:image/') === 0 && s.length < 60000 ? s : null);
          };
          fr.onerror = function () { res2(null); };
          fr.readAsDataURL(b);
        });
      }).then(null, function () { return null; });
    }
    function avatarFromImgEl(img) {
      try {
        var raw = '';
        try { raw = img.getAttribute('src') || ''; } catch (eA) { raw = ''; }
        if (raw.indexOf('data:image/') === 0) return W.Promise.resolve(raw.length < 60000 ? raw : null);
        if (!avatarSrcOk(raw) || imgEmojiish(img)) return W.Promise.resolve(null);
        var abs = '';
        try { abs = img.src || ''; } catch (eS) { abs = ''; }
        if (!abs || abs.indexOf('data:') === 0) return W.Promise.resolve(null);
        return avatarFromUrl(abs);
      } catch (eE) { return W.Promise.resolve(null); }
    }
    function avatarCanvasIn(scope, tier) {
      try {
        var cvs = qsa('canvas', scope);
        for (var i = 0; i < cvs.length; i++) {
          var cv = cvs[i];
          var w = 0;
          try { w = cv.width || 0; } catch (eW) { w = 0; }
          if (w < 16 || w > 512) continue;
          var s = cv.toDataURL('image/png'); // tainted canvas throws -> caught
          if (s && s.indexOf('data:image/') === 0 && s.length < 60000) return { tier: tier, avatar: s };
        }
      } catch (eC) {}
      return null;
    }
    function avatarImgIn(row, scope, tier) {
      var imgs = qsa('img', scope);
      var hit = W.Promise.resolve(null);
      for (var i = 0; i < imgs.length; i++) {
        (function (img) {
          hit = hit.then(function (prev) {
            if (prev) return prev;
            var raw = '';
            try { raw = img.getAttribute('src') || ''; } catch (eA) { raw = ''; }
            if (!avatarSrcOk(raw) || imgEmojiish(img) || !inLeftBand(row, img)) return null;
            return avatarFromImgEl(img).then(function (a) { return a ? { tier: tier, avatar: a } : null; });
          });
        })(imgs[i]);
      }
      return hit;
    }
    function avatarBgIn(row, scope, tier) {
      var els = qsa('*', scope);
      var tested = 0;
      var hit = W.Promise.resolve(null);
      for (var i = 0; i < els.length && tested < 16; i++) {
        var el = els[i];
        var v = '';
        try { v = (el.style && el.style.backgroundImage) || ''; } catch (eI) { v = ''; }
        if ((!v || v === 'none') && !inLeftBand(row, el)) continue; // computed style only in-band
        if (!v || v === 'none') {
          try { v = (W.getComputedStyle(el, null) || {}).backgroundImage || ''; } catch (eC) { v = ''; }
        }
        if (!v || v === 'none' || v.indexOf('url(') === -1) continue;
        tested++;
        (function (val) {
          hit = hit.then(function (prev) {
            if (prev) return prev;
            var m = /url\((['"]?)([^'")]+)\1\)/.exec(val);
            if (!m) return null;
            var u = m[2];
            if (u.indexOf('data:image/') === 0) return u.length < 60000 ? { tier: tier, avatar: u } : null;
            if (!avatarSrcOk(u)) return null;
            return avatarFromUrl(u).then(function (a) { return a ? { tier: tier, avatar: a } : null; });
          });
        })(v);
      }
      return hit;
    }
    function avatarShadowIn(row) {
      // D2's named residual risk, banded + capped: one shadowRoot level,
      // only hosts inside the avatar zone, max 6 hosts, img+canvas+bg inside.
      var hosts = [];
      var els = qsa('*', row);
      for (var i = 0; i < els.length && hosts.length < 6; i++) {
        try { if (els[i].shadowRoot && inLeftBand(row, els[i])) hosts.push(els[i]); } catch (eS) {}
      }
      var hit = W.Promise.resolve(null);
      for (var h = 0; h < hosts.length; h++) {
        (function (host) {
          hit = hit.then(function (prev) {
            if (prev) return prev;
            var sr = host.shadowRoot;
            return avatarImgIn(row, sr, 'shadow').then(function (ih) {
              if (ih) return ih;
              var ch = avatarCanvasIn(sr, 'shadow');
              if (ch) return ch;
              return avatarBgIn(row, sr, 'shadow');
            });
          });
        })(hosts[h]);
      }
      return hit;
    }
    function avatarForRow(row) {
      return avatarImgIn(row, row, 'img').then(function (ih) {
        if (ih) return ih;
        var ch = avatarCanvasIn(row, 'canvas');
        if (ch) return ch;
        return avatarShadowIn(row).then(function (sh) {
          if (sh) return sh;
          return avatarBgIn(row, row, 'bg');
        });
      });
    }
    function getAvatarsImpl(limit) {
      var cap = Math.max(1, Math.min(120, parseInt(limit, 10) || 60));
      return new W.Promise(function (resolve) {
        try {
          var t0 = Date.now();
          var nodes = [], rows = [], i, j, found;
          var chains = LIST_CHAIN.concat(['[data-testid="cell-frame-container"]']); // old builds
          for (i = 0; i < chains.length; i++) {
            try { found = qsa(chains[i]).filter(visible); } catch (eC) { found = []; }
            for (j = 0; j < found.length; j++) {
              if (nodes.indexOf(found[j]) === -1) { nodes.push(found[j]); rows.push(found[j]); }
              if (rows.length >= cap) break;
            }
            if (rows.length >= cap) break;
          }
          AVATAR_W = { rows: 0, img: 0, canvas: 0, shadow: 0, bg: 0, miss: 0 };
          var out = [];
          var tasks = [];
          var over = false;
          rows.forEach(function (row) {
            if (over) return;
            try {
              if (Date.now() - t0 > AVATAR_PASS_MS) { over = true; return; } // soft wall
              var title = rowTitleGeneric(row); // D2: structure-free row title
              if (!title) return;
              AVATAR_W.rows++;
              tasks.push(avatarForRow(row).then(function (hit) {
                if (!hit) { AVATAR_W.miss++; return; }
                AVATAR_W[hit.tier]++;
                out.push({ title: title, avatar: hit.avatar });
              }).then(null, function () { AVATAR_W.miss++; }));
            } catch (eRow) { /* skip row */ }
          });
          W.Promise.all(tasks).then(function () {
            tail('avatars rows=' + AVATAR_W.rows + ' img=' + AVATAR_W.img + ' canvas=' + AVATAR_W.canvas +
                 ' shadow=' + AVATAR_W.shadow + ' bg=' + AVATAR_W.bg + ' miss=' + AVATAR_W.miss);
            resolve(out);
          }).then(null, function () { resolve([]); });
        } catch (eA) { resolve([]); }
      });
    }

    W.__wabEng = {
      ready: guard('ready', false, readyImpl),
      listChats: guard('listChats', [], listChatsImpl),
      getContact: guard('getContact', null, getContactImpl),
      getMessages: guard('getMessages', [], getMessagesImpl),
      getMedia: guard('getMedia', { ok: false, error: 'media unavailable' }, getMediaImpl),
      hasNewMessages: guard('hasNewMessages', false, hasNewMessagesImpl),
      openChat: guard('openChat', { ok: false, error: 'open failed' }, openChatImpl),
      send: guard('send', { ok: false, error: 'send failed' }, sendImpl),
      getAvatars: guard('getAvatars', [], getAvatarsImpl),
      debugAvatarTiers: function () { try { return AVATAR_W; } catch (eD) { return {}; } },
      getTyping: guard('getTyping', [], typingImpl),
      searchTargetCoords: guard('searchTargetCoords', { ok: false, error: 'search unavailable' }, searchTargetCoordsImpl),
      searchResultCoords: guard('searchResultCoords', null, searchResultCoordsImpl),
      searchDone: guard('searchDone', false, searchDoneImpl),
      debugTitles: guard('debugTitles', 0, debugTitlesImpl),
      getMessagesHistory: guard('getMessagesHistory', { ok: false, messages: [], grewBy: 0, hasMore: false, pagesRun: 0 }, getMessagesHistoryImpl),
      hasMoreHistory: guard('hasMoreHistory', false, hasMoreHistoryImpl),
      insertDraft: guard('insertDraft', { ok: false, verified: false, cleared: false }, insertDraftImpl),
      debugTail: function () {
        // V12: last 20 open/send step strings (fixed names + tier numbers
        // only), cleared at the start of each openChat/send call. The spine
        // surfaces these via the debug panel.
        try { return TAIL.slice(); } catch (eD) { return []; }
      },
      health: function () {
        // D1 heartbeat: every health() call re-checks the CAPTURED runtime
        // (runtimeAlive: a few property reads, no shim chunk, no 3 s probe)
        // and downgrades a stale ok. modules is never a frozen boolean:
        // true always means the capture is still live, and a downgrade
        // clears RUNTIME.ok so the next API call runs a real probe. It
        // never upgrades false to true; only a real probe does that, so a
        // healthy engine pays nothing extra here.
        try {
          if (RUNTIME.ok && !runtimeAlive()) {
            RUNTIME.ok = false; HEALTH.modules = false;
            HEALTH.lastError = 'module runtime unavailable';
          }
        } catch (eHb) {}
        return W.Promise.resolve({
          idb: HEALTH.idb === true,
          modules: HEALTH.modules === true,
          lastError: HEALTH.lastError || null
        });
      },
      // v13.1 diagnostic: the media gate probe. Field NAMES + types + url-shape
      // ONLY (scheme + host), never bytes, never names.
      __dumpMsgFields: guard('__dumpMsgFields', { note: 'not found' }, async function (chatId, msgId) {
        // V13 M1: THE getMessagesImpl RESOLUTION PATH, VERBATIM. The old
        // body called locateChatModel WITHOUT await - an async function
        // answers a Promise, so 'model' was a hollow shell with no
        // attributes and no msgs (the probe's {note:'no model',
        // hasAttrs:false, attrKeys:''} every time) - and it never probed
        // the module runtime. Resolution here now IS resolution there:
        // probeRuntime, then the strict findChatModel core, then the
        // locateChatModel tiers, then the same findMsgModel getMedia uses.
        var id = (typeof chatId === 'string') ? chatId : normId(chatId);
        if (!id) return { note: 'no id' };
        var ok = false;
        try { ok = await probeRuntime(false); } catch (eP) { ok = false; }
        if (!ok) return { note: 'module runtime unavailable' };
        var chat = findChatModel(id);
        if (chat) { LOCATE.tier = 'strict'; }
        if (!chat) chat = await locateChatModel(id);
        if (!chat) return { note: 'no model', tier: LOCATE.tier || '', hasAttrs: false, attrKeys: '' };
        var models = chatMsgModels(chat) || [];
        var target = null;
        try { target = findMsgModel(chat, (typeof msgId === 'string') ? msgId : normId(msgId)); } catch (eF) { target = null; }
        if (!target) return { note: 'msg not in memory', tier: LOCATE.tier || '', msgsLen: models.length };
        var out = {
          note: 'live',
          tier: LOCATE.tier || '',
          msgsLen: models.length,
          ctor: (target.constructor && target.constructor.name) || null,
          msgType: '',
          idVia: '',
          urlish: {},
          mediarish: {}
        };
        try { out.msgType = String(target.type || (target.attributes && target.attributes.type) || ''); } catch (eT) {}
        // which serialized shape the msg id took: the mId round-trip test
        try {
          if (target.id && typeof target.id === 'object') {
            out.idVia = (typeof target.id._serialized === 'string') ? '_serialized'
              : (typeof target.id.$1 === 'string') ? '$1'
              : (target.id.remote !== undefined) ? 'fromMe-remote-id' : 'other';
          } else if (target.id !== undefined) { out.idVia = 'plain'; }
        } catch (eI) {}
        var src = target;
        try { if (target.attributes) src = target.attributes; } catch (eA) {}
        for (var k in src) {
          try {
            var v = src[k];
            var t = typeof v;
            if (t === 'function' || v === null || v === undefined) continue;
            if (/url|media|body|file|thumb|blob|data|enc|src/i.test(k)) {
              var entry = { t: t };
              if (t === 'string') {
                entry.len = v.length;
                entry.head = v.slice(0, 12);
              } else if (t === 'object') {
                entry.keys = Object.keys(v).slice(0, 6).join(',');
              } else entry.v = String(v).slice(0, 10);
              if (/url/i.test(k)) out.urlish[k] = entry; else out.mediarish[k] = entry;
            }
          } catch (eK) { /* skip key */ }
        }
        out.attrCount = Object.keys(src).length;
        return out;
      })
    };
  } catch (eBoot) {
    // never throw out of the injection; the spine sees a missing __wabEng
    // and health via the next injection attempt after reload
  }
})();
