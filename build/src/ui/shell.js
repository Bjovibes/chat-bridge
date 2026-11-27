/* Chat Bridge shell.js, builder C. Classic script, no modules.
   Exposes window.WABSlots and window.WABTabs for the spine.

   V12 S4 evolution (panes): grid4 (2x2) and grid6 (3x2) layout modes.
   The toolbar buttons and the 6th slot element are injected from here because
   index.html is S3's file; if index.html ever ships its own grid4/grid6
   buttons or a data-slot="5" element, the injections below stand down.

   V12.1 T3 evolution (the owner ruling 2026-11-21): the bottom-left account dock
   is gone. The rail's sender cards (renderCards) already show each account's
   link status, so the dock only duplicated the rail; nothing renders dock
   chips anymore.

   V12.2 U1 evolution (owner spec 2026-11-21): the single-mode switcher flips
   VIRTUAL SCREENS instead of accounts. WABRender owns up to 6 screen panes;
   arrows and Ctrl+1..6 cycle them, and people.js's Ctrl+arrow cycling is
   relayed through WABShell.cycleSingleAccount. Account homes and full
   WhatsApp land on the ACTIVE screen's pane, not blindly on slot 0.

   V12.3 W1 evolution (the owner ruling 2026-11-21): the bottom switcher UI is
   DEAD. It displaced the hovering chat bar and is unwanted in split modes,
   so this shell removes the #screen-switcher element from the DOM at boot
   (index.html ships it hidden; its shell.css geometry goes inert). The only
   switcher UI left is the dot row render.js pins to the top of the pane area
   in single and tabs, plus the two-finger trackpad swipe render.js listens
   for. Everything else lives on under the hood: the wab:screens-changed
   event, the cycle functions (people.js Ctrl+arrows, WABShell API) and the
   Ctrl+1..6 jumps. The central bar keeps its fixed bottom position in every
   mode because nothing sits below it anymore.

   V12.4 X2 evolution (the owner live complaints, 2026-11-21): no shell change
   was needed for the swipe persistence fix, and this file says why. The loss
   never lived in the swipe math, the dots or the cycle keys: every screen
   switch reports app:setActivePane, and the spine answered by pushing
   panes:onState {open:false} for every pane in its own never-informed
   paneState map, which render.js's old onPaneState honored destructively.
   The fix is owned by render.js in two layers: it now reports every pane
   person through app:setPanePerson (the spine mirrors reality), and it
   ignores close pushes for panes the spine was never told about. The shell
   keeps its side of the contract unchanged: it caches wab:screens-changed,
   routes homes and full-WhatsApp opens to the ACTIVE screen via
   activeScreenSlot(), and the Ctrl+1..6 and Ctrl+arrow paths still land in
   WABRender.switchScreen. The app also opens maximized now (spine change):
   nothing here depends on window size, so maximized windows are safe.

   V14 U2 evolution (the owner ruling 2026-11-22): the rail's sender section is
   user-grouped platform cards. renderCards builds one .pucard per user
   (wab.users.list): bold name, a 24px WhatsApp + Telegram logo row, and one
   expandable section per CONNECTED platform holding the UNCHANGED account
   cards (buildCard: click assigns panes, right-click renames, colors,
   removes). Connected logos answer for status; unconnected logos and the
   bottom add button open the add modal with user + platform preselected
   through the same wab:add-account event the pane picker doors use.

   V14 D4 evolution (the owner ruling 2026-11-22): the logo IS the card. U2's
   sections still held the old flat account cards under the logo row, so a
   connected platform read twice. buildCard is deleted: the user card shows
   name + logo row only, a connected logo's click opens a compact detail
   section (.pucard-acc rows: color dot, name, link status, Re-link,
   Rename), clicking a row assigns panes (same onCardClick), double-clicking
   a connected logo assigns its primary account straight to a pane, and
   unread rides the logo alone. */

(function () {
  'use strict';

  var COLORS = ['#426CA8', '#2F855A', '#B7791F', '#C05621', '#9B2C2C', '#6B46C1', '#2C7A7B', '#4A5568'];
  var MODES = ['single', 'split2', 'split3', 'grid4', 'grid5', 'grid6', 'tabs'];
  var VISIBLE_SLOTS = { single: 1, split2: 2, split3: 3, grid4: 4, grid5: 5, grid6: 6, tabs: 1 };
  var SCREENS = 6;

  var BASEURL_PLACEHOLDER = {
    'openai-compatible': 'https://api.openai.com/v1',
    'anthropic': 'https://api.anthropic.com'
  };

  /* ---------- state ---------- */

  var accounts = [];                 // Account[]
  var users = [];                    // v14 U2: User[{id, name}] via wab.users.list
  var openSections = new Set();      // v14 U2: 'userId|platform' sections expanded
  var assignments = new Map();       // accountId -> slot index 0..5
  var unread = new Map();            // accountId -> {allowed, restricted}
  var layout = 'single';
  var activeTab = null;              // accountId in tabs mode
  var layoutCbs = [];
  var tabCbs = [];
  var removeTargetId = null;
  var ctxAccountId = null;
  var privacySelection = new Set();  // checked chat titles
  var privacyOnlyPick = null;        // single-choice title for 'only'
  var screenState = null;            // last wab:screens-changed detail (V12.3 W1)

  /* ---------- element refs ---------- */

  function $(id) { return document.getElementById(id); }

  var el = {
    bootError: null, shell: null, accountList: null, addBtn: null, emptyState: null,
    emptyAddBtn: null, slotArea: null, tabstrip: null, layoutSwitch: null,
    aiBtn: null, settingsBtn: null, settings: null, settingsClose: null,
    modalAdd: null, addName: null, addSwatches: null, addCreate: null,
    addPlatWa: null, addPlatTg: null, addPlatHint: null,
    addAvatarBtn: null, addAvatarPreview: null, avatarInput: null,
    modalRemove: null, removeConfirm: null, removeTitle: null,
    ctxMenu: null, ctxRename: null, ctxSwatches: null, ctxRemove: null,
    toasts: null,
    aiProvider: null, aiBaseUrl: null, aiModel: null, aiKey: null, aiMaxCtx: null,
    aiTest: null, aiSave: null, aiTestResult: null,
    privacyAccount: null, privacyMode: null, privacyChats: null,
    privacyHint: null, privacySave: null,
    privacyManualBlock: null, privacyPortalNote: null,
    settingsAddAccount: null,
    portalAccount: null, portalLink: null, portalLinkBlock: null,
    portalCopy: null, portalRevoke: null, portalGenerate: null, portalNote: null,
    portalRemoteBlock: null, portalRemoteStatus: null, portalRemoteToggle: null,
    portalPublicLinkBlock: null, portalPublicLink: null, portalPublicCopy: null
  };

  var slots = []; // .slot divs in order

  /* ---------- v12 S4: grid4 / grid6 plumbing ---------- */

  // grid6 needs a 6th slot. index.html is S3's file and ships 5, so the shell
  // creates data-slot="5" when missing. Runs before slots are collected.
  function ensureGridSlots() {
    if (!el.slotArea) return;
    if (el.slotArea.querySelector('.slot[data-slot="5"]')) return;
    var slot = document.createElement('div');
    slot.className = 'slot';
    slot.setAttribute('data-slot', '5');
    var name = document.createElement('div');
    name.className = 'slot-name';
    name.hidden = true;
    slot.appendChild(name);
    // Keep source order: slots 0..5, then the empty state (grid auto-placement).
    var anchor = el.slotArea.querySelector('.slot[data-slot="4"]');
    if (anchor && anchor.nextSibling) el.slotArea.insertBefore(slot, anchor.nextSibling);
    else el.slotArea.appendChild(slot);
  }

  // Toolbar buttons for the new modes, matching the existing SVG set. Injected
  // only when index.html does not provide them (S3's file owns the toolbar DOM).
  function ensureGridModeButtons() {
    if (!el.layoutSwitch) return;
    var grid5 = el.layoutSwitch.querySelector('.mode-btn[data-mode="grid5"]');
    if (!el.layoutSwitch.querySelector('.mode-btn[data-mode="grid4"]')) {
      var b4 = document.createElement('button');
      b4.type = 'button';
      b4.className = 'mode-btn';
      b4.dataset.mode = 'grid4';
      b4.title = 'Grid 4';
      b4.setAttribute('aria-label', 'Grid 4');
      b4.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1" y="1.2" width="5" height="5" rx="1"/><rect x="8" y="1.2" width="5" height="5" rx="1"/><rect x="1" y="7.2" width="5" height="5" rx="1"/><rect x="8" y="7.2" width="5" height="5" rx="1"/></svg>';
      el.layoutSwitch.insertBefore(b4, grid5); // grid4 reads before grid5
    }
    if (!el.layoutSwitch.querySelector('.mode-btn[data-mode="grid6"]')) {
      var b6 = document.createElement('button');
      b6.type = 'button';
      b6.className = 'mode-btn';
      b6.dataset.mode = 'grid6';
      b6.title = 'Grid 6';
      b6.setAttribute('aria-label', 'Grid 6');
      b6.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="0.8" y="1.2" width="3.4" height="5" rx="1"/><rect x="5.3" y="1.2" width="3.4" height="5" rx="1"/><rect x="9.8" y="1.2" width="3.4" height="5" rx="1"/><rect x="0.8" y="7.2" width="3.4" height="5" rx="1"/><rect x="5.3" y="7.2" width="3.4" height="5" rx="1"/><rect x="9.8" y="7.2" width="3.4" height="5" rx="1"/></svg>';
      var after = el.layoutSwitch.querySelector('.mode-btn[data-mode="grid5"]');
      if (after && after.nextSibling) el.layoutSwitch.insertBefore(b6, after.nextSibling);
      else el.layoutSwitch.appendChild(b6);
    }
  }

  // V12.3 W1: the bottom switcher is dead. index.html (S3's file) ships the
  // #screen-switcher markup and shell.css (also S3's) styles it; neither file
  // is ours, so the element is removed from the DOM here at boot. the owner's
  // ruling: it existed only for full screen, displaced the hovering chat
  // bar, and switching now happens by swipe, top dots, Ctrl+1..6 and
  // Ctrl+arrows. Split and grid modes never showed it anyway.
  function killScreenSwitcher() {
    var sw = $('screen-switcher');
    if (sw && sw.parentNode) sw.parentNode.removeChild(sw);
  }

  function grabElements() {
    el.bootError = $('boot-error');
    el.shell = $('shell');
    el.accountList = $('account-list');
    el.addBtn = $('add-account-btn');
    el.emptyState = $('empty-state');
    el.emptyAddBtn = $('empty-add-btn');
    el.slotArea = $('slot-area');
    el.tabstrip = $('tabstrip');
    el.layoutSwitch = $('layout-switch');
    el.aiBtn = $('ai-btn');
    el.settingsBtn = $('settings-btn');
    el.settings = $('settings');
    el.settingsClose = $('settings-close');
    el.modalAdd = $('modal-add');
    el.addName = $('add-name');
    el.addSwatches = $('add-swatches');
    el.addCreate = $('add-create');
    el.addPlatWa = $('add-plat-wa');     // V14 U3: modal platform selector
    el.addPlatTg = $('add-plat-tg');
    el.addPlatHint = $('add-plat-hint');
    el.addAvatarBtn = $('add-avatar-btn');       // E3: modal photo picker
    el.addAvatarPreview = $('add-avatar-preview');
    el.modalRemove = $('modal-remove');
    el.removeConfirm = $('remove-confirm');
    el.removeTitle = $('remove-title');
    el.ctxMenu = $('ctx-menu');
    el.ctxRename = $('ctx-rename');
    el.ctxSwatches = $('ctx-swatches');
    el.ctxRemove = $('ctx-remove');
    el.toasts = $('toasts');
    el.aiProvider = $('ai-provider');
    el.aiBaseUrl = $('ai-baseurl');
    el.aiModel = $('ai-model');
    el.aiKey = $('ai-key');
    el.aiMaxCtx = $('ai-maxctx');
    el.aiTest = $('ai-test');
    el.aiSave = $('ai-save');
    el.aiTestResult = $('ai-test-result');
    el.privacyAccount = $('privacy-account');
    el.privacyMode = $('privacy-mode');
    el.privacyChats = $('privacy-chats');
    el.privacyHint = $('privacy-hint');
    el.privacyFilter = $('privacy-filter');
    el.privacySave = $('privacy-save');
    el.privacyManualBlock = $('privacy-manual-block');
    el.privacyPortalNote = $('privacy-portal-note');
    el.settingsAddAccount = $('settings-add-account');
    // Consent portal block (mirrors the privacy refs).
    el.portalAccount = $('portal-account');
    el.portalLink = $('portal-link');
    el.portalLinkBlock = $('portal-link-block');
    el.portalCopy = $('portal-copy');
    el.portalRevoke = $('portal-revoke');
    el.portalGenerate = $('portal-generate');
    el.portalNote = $('portal-note');
    // Remote access row (public HTTPS tunnel for partners outside the LAN).
    el.portalRemoteBlock = $('portal-remote-block');
    el.portalRemoteStatus = $('portal-remote-status');
    el.portalRemoteToggle = $('portal-remote-toggle');
    el.portalPublicLinkBlock = $('portal-public-link-block');
    el.portalPublicLink = $('portal-public-link');
    el.portalPublicCopy = $('portal-public-copy');
    // v12 S4: grid4/grid6 need the 6th slot and their toolbar buttons before
    // slots are collected and mode buttons are wired. V12.3 W1: the bottom
    // switcher dies before anything can show it.
    killScreenSwitcher();
    ensureGridSlots();
    ensureGridModeButtons();
    slots = Array.prototype.slice.call(document.querySelectorAll('.slot'));
  }

  /* ---------- wab guard ---------- */

  function wabOk() { return typeof window.wab === 'object' && window.wab !== null; }

  // Runs a wab call, catches rejection, toasts the error, returns the result or null.
  function call(fn, fallback) {
    if (!wabOk()) { toast('Shell failed to start: preload missing'); return null; }
    try {
      return Promise.resolve().then(fn).catch(function (err) {
        toast(errText(err, fallback));
        return null;
      });
    } catch (e) {
      toast(errText(e, fallback));
      return null;
    }
  }

  function errText(err, fallback) {
    var msg = err && (err.message || err.error);
    return (typeof msg === 'string' && msg) ? msg : (fallback || 'Something went wrong');
  }

  /* ---------- toast ---------- */

  function toast(message, kind) {
    if (!el.toasts) return;
    var card = document.createElement('div');
    card.className = 'toast t-' + (kind || 'info');
    card.textContent = message; // exact text, never embellished
    el.toasts.appendChild(card);
    window.setTimeout(function () {
      card.classList.add('out');
      window.setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
      }, 300);
    }, 5000);
  }

  /* ---------- rendering ---------- */

  function accountById(id) {
    for (var i = 0; i < accounts.length; i++) if (accounts[i].id === id) return accounts[i];
    return null;
  }

  function statusLabel(status) {
    if (status === 'linking') return 'waiting for QR scan';
    if (status === 'linked') return 'linked';
    return 'logged out';
  }

  function renderCards() {
    if (!el.accountList) return;
    // Never rebuild under an open rename input; it commits and re-renders itself.
    if (el.accountList.querySelector('.card-name-input')) return;
    el.accountList.textContent = '';
    // v14 U2 + D4: user-grouped platform cards, one per user. The flat
    // account list is gone and so are the old account cards (D4): the user
    // card is name + logo row, and the per-platform sections hold compact
    // detail rows (.pucard-acc) that only render while expanded.
    userGroups().forEach(function (g) {
      el.accountList.appendChild(buildUserCard(g));
    });
    // The add button rides at the bottom of the scrolled list, pre-seeding
    // the chooser with the user nearest the middle of the visible list. If
    // index.html ever ships its own #add-account-btn outside the list,
    // el.addBtn is set at boot and this injection stands down.
    if (!el.addBtn) el.accountList.appendChild(buildAddBtn());
  }

  /* ---------- v14 U2 + D4: user-grouped platform cards ---------- */

  // D4: the detail row that replaces the old flat account card inside a
  // platform section. The logo above is the identity; this row is ONLY the
  // controls: color dot, name, link status, then Rename (always) and
  // Re-link (logged-out only). Click anywhere on the row (or Enter/Space)
  // assigns panes through the same onCardClick the old card used; the
  // buttons stop propagation so they never assign. Right-click keeps the
  // ctx menu (rename, color, remove). No unread badge here: unread rides
  // the logo alone now.

  // E3: the account's own avatar circle. Photo when set, else the first two
  // letters of the name on the account color (the old card-dot's job). The
  // circle is a button: click opens the file picker; stopPropagation keeps
  // the row's pane-assign click out of it. No data-platform attribute on
  // purpose: people.js's delegated logo handler must not claim it.
  function buildAccAvatar(acc) {
    var av = document.createElement('button');
    av.type = 'button';
    av.className = 'acc-avatar';
    if (acc.avatar) {
      av.classList.add('has-img');
      try { av.style.backgroundImage = 'url("' + acc.avatar + '")'; } catch (e) { /* cosmetic */ }
    } else {
      av.textContent = accInitials(acc.name);
      av.style.background = acc.color || COLORS[0];
    }
    av.title = 'Change photo';
    av.setAttribute('aria-label', 'Change profile photo for ' + (acc.name || 'this account'));
    av.addEventListener('click', function (ev) {
      ev.stopPropagation();
      pickAvatarFor(acc.id);
    });
    return av;
  }

  function buildAccRow(acc) {
    var row = document.createElement('div');
    row.className = 'pucard-acc';
    row.dataset.id = acc.id;
    row.tabIndex = 0;
    row.title = (acc.name || 'Account') + ' - click to open in a pane';
    if (assignments.has(acc.id)) row.classList.add(layout === 'tabs' ? 'is-selected' : 'is-open');

    var main = document.createElement('div');
    main.className = 'pucard-acc-main';

    main.appendChild(buildAccAvatar(acc));   // E3: avatar circle replaces the color dot

    var name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = acc.name || 'Account';
    main.appendChild(name);

    var status = document.createElement('span');
    status.className = 'card-status st-' + (acc.status || 'logged-out');
    var sd = document.createElement('span');
    sd.className = 'status-dot';
    var sl = document.createElement('span');
    sl.className = 'status-label';
    sl.textContent = statusLabel(acc.status);
    status.appendChild(sd);
    status.appendChild(sl);
    main.appendChild(status);
    row.appendChild(main);

    var tools = document.createElement('div');
    tools.className = 'pucard-acc-tools';
    var ren = document.createElement('button');
    ren.type = 'button';
    ren.className = 'acc-tool-btn';
    ren.textContent = 'Rename';
    ren.addEventListener('click', function (ev) {
      ev.stopPropagation();
      startRename(acc.id);
    });
    tools.appendChild(ren);
    if (acc.status === 'logged-out') {
      var relink = document.createElement('button');
      relink.type = 'button';
      relink.className = 'relink-btn';
      relink.textContent = 'Re-link';
      relink.addEventListener('click', function (ev) {
        ev.stopPropagation();
        relinkAccount(acc.id);
      });
      tools.appendChild(relink);
    }
    row.appendChild(tools);

    row.addEventListener('click', function () { onCardClick(acc.id); });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onCardClick(acc.id); }
    });
    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      openCtxMenu(acc.id, ev.clientX, ev.clientY);
    });

    return row;
  }

  function platformName(p) {
    return p === 'telegram' ? 'Telegram' : 'WhatsApp';
  }

  // The 24px logo button shared by the rail cards and the add modal's
  // platform chooser. people.css paints the glyph and the state classes.
  function buildPlatformBtn(platform) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'plat-logo';
    b.dataset.platform = platform;
    var g = document.createElement('span');
    g.className = 'plat-glyph ' + (platform === 'telegram' ? 'plat-glyph-telegram' : 'plat-glyph-whatsapp');
    g.setAttribute('aria-hidden', 'true');
    b.appendChild(g);
    return b;
  }

  function secKey(userId, platform) {
    return String(userId || '') + '|' + platform;
  }

  function unreadSum(list) {
    var n = 0;
    list.forEach(function (a) {
      var u = unread.get(a.id);
      if (u && u.allowed > 0) n += u.allowed;
    });
    return n;
  }

  // Users from wab.users.list, each with its accounts split by platform.
  // A user with no accounts still gets a card (both logos dashed, the
  // connect door the owner asked for). Accounts whose owner id no longer
  // resolves drift into a trailing 'Other accounts' card, so no account
  // ever leaves the rail.
  function userGroups() {
    var base = users.length ? users : [{ id: '', name: 'Accounts' }];
    var groups = [];
    var byId = {};
    base.forEach(function (u) {
      var g = { user: u, whatsapp: [], telegram: [] };
      byId[String(u.id)] = g;
      groups.push(g);
    });
    var orphans = null;
    accounts.forEach(function (a) {
      if (!a) return;
      var plat = a.platform === 'telegram' ? 'telegram' : 'whatsapp';
      var g = byId[String(a.userId || '')];
      if (g) { g[plat].push(a); return; }
      if (!orphans) orphans = { user: { id: '__other', name: 'Other accounts' }, whatsapp: [], telegram: [] };
      orphans[plat].push(a);
    });
    if (orphans) groups.push(orphans);
    return groups;
  }

  // One user card: bold name, the 24px logo row, then one expandable section
  // per CONNECTED platform holding the existing account cards.
  function buildUserCard(group) {
    var card = document.createElement('div');
    card.className = 'pucard';
    card.dataset.userId = group.user.id;
    card.dataset.userName = group.user.name || ''; // V14 U3: people.js reads the group's user name

    var head = document.createElement('div');
    head.className = 'pucard-head';
    var name = document.createElement('span');
    name.className = 'pucard-name';
    name.textContent = group.user.name || 'User';
    head.appendChild(name);
    card.appendChild(head);

    var logos = document.createElement('div');
    logos.className = 'pucard-logos';
    logos.setAttribute('role', 'group');
    logos.setAttribute('aria-label', 'Platforms for ' + (group.user.name || 'user'));
    logos.appendChild(buildUserLogo(group, 'whatsapp'));
    logos.appendChild(buildUserLogo(group, 'telegram'));
    card.appendChild(logos);

    var body = document.createElement('div');
    body.className = 'pucard-body';
    ['whatsapp', 'telegram'].forEach(function (plat) {
      if (group[plat].length) body.appendChild(buildPlatformSec(group, plat));
    });
    card.appendChild(body);
    return card;
  }

  // Connected (at least one account for this user + platform): full-color
  // glyph, brand corner badge, click toggles the expansion below that holds
  // that platform's account cards. Unconnected: dashed, plus on hover, click
  // knocks on the same wab:add-account door the pane picker uses.
  function buildUserLogo(group, platform) {
    var list = group[platform];
    var connected = list.length > 0;
    var userId = group.user.id;
    var btn = buildPlatformBtn(platform);
    if (connected) btn.classList.add('is-on');

    if (connected) {
      var key = secKey(userId, platform);
      var secId = 'pusec-' + String(userId || 'x').replace(/[^a-zA-Z0-9_-]/g, '') + '-' + platform;
      var badge = document.createElement('span');
      badge.className = 'plat-logo-badge' + (platform === 'telegram' ? ' is-telegram' : '');
      btn.appendChild(badge);
      var n = unreadSum(list);
      if (n > 0) {
        var pill = document.createElement('span');
        pill.className = 'unread-badge';
        pill.textContent = String(n);
        btn.appendChild(pill);
      }
      var linked = 0;
      list.forEach(function (a) { if (a.status === 'linked') linked++; });
      btn.title = platformName(platform) + ' for ' + (group.user.name || 'this user') + ': ' +
        list.length + (list.length === 1 ? ' account' : ' accounts') + ', ' + linked + ' linked';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-controls', secId);
      btn.setAttribute('aria-expanded', openSections.has(key) ? 'true' : 'false');
      if (openSections.has(key)) btn.classList.add('is-expanded');
      // D4: toggle the detail section in place. No renderCards() here: the
      // rebuild would flash the rail on every click and replace this button
      // mid-gesture, which eats the double-click below.
      btn.addEventListener('click', function () {
        var opening = !openSections.has(key);
        if (opening) openSections.add(key);
        else openSections.delete(key);
        var secNode = document.getElementById(secId);
        if (secNode) secNode.hidden = !opening;
        btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
        btn.classList.toggle('is-expanded', opening);
      });
      // D4: double-click skips the ceremony and assigns this platform's
      // primary account (first linked, else first) straight to a pane. The
      // two single clicks before it opened then closed the section; the
      // add below re-opens it so the row lands visible beside its logo.
      btn.addEventListener('dblclick', function () {
        var pick = null;
        list.forEach(function (a) { if (!pick && a.status === 'linked') pick = a; });
        if (!pick) pick = list[0];
        openSections.add(key);
        if (pick) onCardClick(pick.id);   // re-renders, section stays open
        else renderCards();
      });
    } else {
      // V14 U3: the is-unconnected marker is people.js's click contract
      // (its delegated listener opens the connect flow for these buttons).
      btn.classList.add('is-unconnected');
      btn.title = 'Connect ' + platformName(platform) + ' for ' + (group.user.name || 'this user');
      btn.setAttribute('aria-label', btn.title);
      btn.addEventListener('click', function () {
        requestAdd({ userId: userId, platform: platform });
      });
    }
    return btn;
  }

  // D4: the expansion below the logos is a DETAIL strip, not a card list:
  // platform label plus one compact control row (.pucard-acc) per account.
  // Nothing here renders unless the operator asked for it by clicking the
  // logo; the logo row above stays the only always-visible identity.
  function buildPlatformSec(group, platform) {
    var list = group[platform];
    var userId = group.user.id;
    var sec = document.createElement('div');
    sec.className = 'pucard-sec';
    sec.id = 'pusec-' + String(userId || 'x').replace(/[^a-zA-Z0-9_-]/g, '') + '-' + platform;
    sec.dataset.platform = platform;
    sec.dataset.userId = userId;
    if (!openSections.has(secKey(userId, platform))) sec.hidden = true;
    var label = document.createElement('div');
    label.className = 'pucard-sec-label';
    label.textContent = platformName(platform);
    sec.appendChild(label);
    list.forEach(function (acc) {
      sec.appendChild(buildAccRow(acc));
    });
    return sec;
  }

  // The bottom add button. index.html ships no #add-account-btn today, so
  // the rail builds its own inside the scrolled list (stand-down law: if
  // index.html ever ships one, el.addBtn is non-null at boot and the
  // injection in renderCards skips).
  function buildAddBtn() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'add-account-btn';
    btn.className = 'add-account-btn';
    btn.textContent = 'Add account';
    btn.addEventListener('click', function () {
      openAddModal({ userId: nearestUserId() });
    });
    return btn;
  }

  // Context for the add flow: the user whose card sits closest to the middle
  // of the visible list. At rest that is the first user.
  function nearestUserId() {
    if (!users.length) return '';
    var box = el.accountList.getBoundingClientRect();
    var mid = box.top + box.height / 2;
    var bestId = users[0].id;
    var bestD = Infinity;
    Array.prototype.forEach.call(el.accountList.querySelectorAll('.pucard'), function (node) {
      var r = node.getBoundingClientRect();
      if (!r.height) return;
      var d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bestD) { bestD = d; bestId = node.dataset.userId || bestId; }
    });
    return bestId;
  }

  // One door for every connect surface (the rail's unconnected logos here,
  // the pane picker doors in render.js T5): the wab:add-account window
  // event, claimed synchronously by the shell listener in wire(). The
  // self-open fallback only fires if that listener is gone.
  function requestAdd(ctx) {
    var detail = {
      platform: (ctx && ctx.platform) === 'telegram' ? 'telegram' : 'whatsapp',
      userId: (ctx && ctx.userId) || '',
      handled: false
    };
    try {
      window.dispatchEvent(new CustomEvent('wab:add-account', { detail: detail }));
    } catch (e) { detail.handled = false; }
    if (!detail.handled) openAddModal(ctx);
  }

  function renderSlots() {
    var slotOwner = {};
    assignments.forEach(function (slotIdx, accId) { slotOwner[slotIdx] = accId; });
    var empty = accounts.length === 0;

    slots.forEach(function (slot) {
      var idx = slot.dataset.slot;
      var nameEl = slot.querySelector('.slot-name');
      var accId = slotOwner[idx];
      slot.removeAttribute('data-color');
      slot.removeAttribute('data-account');
      slot.removeAttribute('title');
      if (nameEl) nameEl.hidden = true;
      slot.hidden = empty;

      if (!accId) return;
      var acc = accountById(accId);
      if (!acc) { assignments.delete(accId); return; }
      slot.setAttribute('data-account', accId);
      slot.setAttribute('data-color', '');
      slot.style.setProperty('--slot-color', acc.color || COLORS[0]);
      slot.setAttribute('title', acc.name || '');
      if (nameEl) {
        nameEl.textContent = acc.name || '';
        nameEl.hidden = false;
      }
    });
  }

  function renderTabstrip() {
    if (!el.tabstrip) return;
    var linked = accounts.filter(function (a) { return a.status === 'linked'; });
    if (layout !== 'tabs') {
      el.tabstrip.hidden = true;
      el.tabstrip.textContent = '';
      return;
    }
    el.tabstrip.hidden = false;
    el.tabstrip.textContent = '';

    if (linked.length === 0) {
      var hint = document.createElement('span');
      hint.className = 'tab-hint';
      hint.textContent = 'Linked accounts appear here as tabs';
      el.tabstrip.appendChild(hint);
      return;
    }

    if (!activeTab || !linked.some(function (a) { return a.id === activeTab; })) {
      activeTab = linked[0].id;
      syncTabAssignment();
    }

    linked.forEach(function (acc) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tab-chip' + (acc.id === activeTab ? ' active' : '');
      chip.dataset.account = acc.id;
      var dot = document.createElement('span');
      dot.className = 'chip-dot';
      dot.style.background = acc.color || COLORS[0];
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(acc.name || 'Account'));
      chip.addEventListener('click', function () { selectAccount(acc.id); });
      el.tabstrip.appendChild(chip);
    });
  }

  function renderEmptyState() {
    if (!el.emptyState) return;
    var empty = accounts.length === 0;
    el.emptyState.hidden = !empty;
  }

  /* ---------- linked accounts (shared helper) ---------- */

  function linkedAccounts() {
    return accounts.filter(function (a) { return a.status === 'linked'; });
  }

  /* ---------- V12.2 U1: virtual screen switching (no UI; under the hood) ---------- */

  // The renderer owns the screens and their dot row (V12.3 W1). When its
  // V12.2 API is present, cycling flips screens directly.
  function screensApi() {
    try {
      if (window.WABRender &&
          typeof window.WABRender.screenInfo === 'function' &&
          typeof window.WABRender.switchScreen === 'function') {
        return window.WABRender.screenInfo();
      }
    } catch (e) { /* degrade quietly */ }
    return null;
  }

  function screenLayout() {
    return layout === 'single' || layout === 'tabs';
  }

  function switchScreenExternal(idx) {
    try {
      if (window.WABRender && typeof window.WABRender.switchScreen === 'function') {
        window.WABRender.switchScreen(idx);
      }
    } catch (e) { /* degrade quietly */ }
  }

  // Which pane record the visible rect mounts right now (screen index in
  // single/tabs, else 0). Account homes and full WhatsApp land there.
  function activeScreenSlot() {
    var info = screensApi();
    if (info && typeof info.active === 'number') return info.active;
    return 0;
  }

  function switchSingleAccount(accId) {
    if (!accountById(accId)) return;
    if (layout !== 'single') setLayout('single');
    assignments.forEach(function (sv, key) { if (sv === 0) assignments.delete(key); });
    assignments.set(accId, 0);
    activeTab = accId;
    afterAssignmentChange();
    try {
      // V12.2: the account home opens on the ACTIVE screen's pane, so it
      // never has to steal a conversation to show itself.
      window.dispatchEvent(new CustomEvent('wab:pane-home', { detail: { slot: activeScreenSlot(), accountId: accId } }));
    } catch (e) { /* renderer listens if present */ }
  }

  function openAccountFull(accId) {
    if (!accountById(accId)) return;
    if (layout !== 'single') setLayout('single');
    assignments.forEach(function (sv, key) { if (sv === 0) assignments.delete(key); });
    assignments.set(accId, 0);
    activeTab = accId;
    afterAssignmentChange();
    try {
      window.dispatchEvent(new CustomEvent('wab:open-full', { detail: { slot: activeScreenSlot(), accountId: accId } }));
    } catch (e) { /* renderer listens if present */ }
    toast('Full WhatsApp: ' + (accountById(accId).name || 'account') + '. Pick a person on the left to come back.');
  }

  // Arrows (people.js's Ctrl+arrows in one-rect layouts) cycle screens
  // under the V12.2 model; the legacy fallback keeps cycling accounts.
  function cycleSingleAccount(dir) {
    var info = screensApi();
    if (info) {
      var active = (typeof info.active === 'number') ? info.active : 0;
      switchScreenExternal((active + (dir < 0 ? -1 : 1) + SCREENS) % SCREENS);
      return;
    }
    var linked = linkedAccounts();
    if (linked.length < 2) return;
    var current = accountInSlot0();
    var idx = 0;
    for (var i = 0; i < linked.length; i++) if (linked[i].id === current) { idx = i; break; }
    var next = linked[(idx + dir + linked.length) % linked.length];
    switchSingleAccount(next.id);
  }

  window.WABShell = {
    openAccountFull: openAccountFull,
    switchSingleAccount: switchSingleAccount,
    cycleSingleAccount: cycleSingleAccount,
    // V12.3 W1: last wab:screens-changed payload (active, busy, colors,
    // hasNew, screens). The dot row itself lives in render.js; this is the
    // under-the-hood read for any future consumer.
    screenInfo: function () { return screenState; }
  };

  function accountInSlot0() {
    var owner = null;
    assignments.forEach(function (sv, key) { if (sv === 0) owner = key; });
    return owner;
  }

  function renderAll() {
    renderCards();
    renderSlots();
    renderTabstrip();
    renderEmptyState();
    if (el.privacyAccount && !el.settings.hidden) refreshPrivacyAccountSelect();
    if (el.portalAccount && !el.settings.hidden) refreshPortalAccountSelect();
  }

  /* ---------- layout ---------- */

  function setLayout(mode, push) {
    if (MODES.indexOf(mode) === -1) return;
    layout = mode;
    document.body.setAttribute('data-layout', mode);
    Array.prototype.forEach.call(el.layoutSwitch.querySelectorAll('.mode-btn'), function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    renderTabstrip();
    renderSlots();
    renderCards();
    if (push !== false && wabOk()) {
      call(function () { return window.wab.app.setLayout(mode); }, 'Could not save the layout');
    }
    fireLayoutChange();
  }

  /* ---------- slot assignment ---------- */

  function onCardClick(accId) {
    closeCtxMenu();
    if (layout === 'tabs') {
      // Tabs mode: clicking a card always makes it the visible tab.
      selectAccount(accId);
      return;
    }
    if (assignments.has(accId)) {
      assignments.delete(accId);
    } else {
      var count = VISIBLE_SLOTS[layout] || 1;
      var used = [];
      assignments.forEach(function (s) { used.push(s); });
      var free = -1;
      for (var s = 0; s < count; s++) if (used.indexOf(s) === -1) { free = s; break; }
      if (free === -1) {
        assignments.forEach(function (sv, key) { if (sv === 0) assignments.delete(key); });
        free = 0;
      }
      assignments.set(accId, free);
    }
    afterAssignmentChange();
  }

  function selectAccount(accId) {
    if (!accountById(accId)) return;
    assignments.forEach(function (sv, key) { if (sv === 0) assignments.delete(key); });
    assignments.set(accId, 0);
    activeTab = accId;
    afterAssignmentChange();
    tabCbs.forEach(function (cb) {
      try { cb(accId); } catch (e) { /* subscriber error must not break the shell */ }
    });
  }

  // Keep slot 0 owned by the active tab when in tabs mode.
  function syncTabAssignment() {
    if (layout !== 'tabs' || !activeTab) return;
    assignments.forEach(function (sv, key) { if (sv === 0 && key !== activeTab) assignments.delete(key); });
    assignments.set(activeTab, 0);
  }

  function afterAssignmentChange() {
    syncTabAssignment();
    renderSlots();
    renderTabstrip();
    renderCards();
    fireLayoutChange();
  }

  /* ---------- WABSlots / WABTabs (contract globals) ---------- */

  function slotVisible(node) {
    return !node.hidden && node.getClientRects().length > 0;
  }

  window.WABSlots = {
    getRects: function () {
      var rects = [];
      slots.forEach(function (node) {
        if (!slotVisible(node)) return;
        var r = node.getBoundingClientRect();
        rects.push({
          slot: parseInt(node.dataset.slot, 10),
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height)
        });
      });
      return rects;
    },
    onLayoutChange: function (cb) {
      if (typeof cb === 'function') layoutCbs.push(cb);
    }
  };

  window.WABTabs = {
    onSelect: function (cb) {
      if (typeof cb === 'function') tabCbs.push(cb);
    },
    select: function (accountId) {
      if (layout !== 'tabs') return;
      selectAccount(accountId);
    }
  };

  var layoutRaf = null;

  function fireLayoutChange() {
    if (layoutRaf !== null) return;
    layoutRaf = window.requestAnimationFrame(function () {
      layoutRaf = null;
      layoutCbs.forEach(function (cb) {
        try { cb(); } catch (e) { /* subscriber error must not break the shell */ }
      });
    });
  }

  /* ---------- account actions ---------- */

  function relinkAccount(id) {
    call(function () { return window.wab.accounts.relink(id); }, 'Could not open the QR window');
    toast('QR window opened. If this account is still linked, chats appear in seconds. Otherwise scan the QR.');
  }

  function removeAccount(id) {
    call(function () { return window.wab.accounts.remove(id); }, 'Could not remove the account')
      .then(function (res) {
        if (!res) return;
        assignments.delete(id);
        unread.delete(id);
        if (activeTab === id) activeTab = null;
        accounts = accounts.filter(function (a) { return a.id !== id; });
        renderAll();
        fireLayoutChange();
        toast('Account removed');
      });
  }

  function applyStatus(accountId, status) {
    var acc = accountById(accountId);
    if (!acc) return;
    acc.status = status;
    if (status === 'logged-out') assignments.delete(accountId);
    renderAll();
    fireLayoutChange();
  }

  /* ---------- add account modal ---------- */

  var addColorPick = COLORS[0];
  var addPlatformPick = 'whatsapp';   // v14 U2: chooser pick in the add modal
  var addContextUserId = '';          // v14 U2: user the next account belongs to

  // V14 U3: selected platform, the owner the account is added for (empty on
  // the plain add paths, main then defaults to the first user), and the
  // one-in-flight guard that kills double adds (Enter could re-fire
  // createAccount while the disabled Create button meant nothing to it).
  // U2's addPlatformPick / addContextUserId stay as the injected chooser's
  // mirrors; openAddModal keeps both pairs in sync from one prefill.
  var addPlatform = 'whatsapp';
  var addUserId = '';
  var addBusy = false;

  /* ---------- E3: sender account avatars ---------- */

  // Mirror constant: store.js cleanAvatar (keep in sync). Chars, not bytes:
  // the data URL is ASCII, so length is the honest size of what we persist.
  var AVATAR_MAX_CHARS = 40960;

  // The photo picked in the add modal, saved right after the account exists.
  var addAvatarPick = '';
  // Who the next file-picker result belongs to: 'add' or an account id.
  // Survives rail re-renders mid-pick (only the id is held, never the node).
  var avatarInputTarget = null;
  var avatarInputWired = false;

  // First two letters of the account name (E3 brief law). Deliberately NOT
  // render.js's initialsOf (first+last word) — swap here if that is wanted.
  function accInitials(name) {
    var t = String(name || '').trim();
    return t ? t.slice(0, 2).toUpperCase() : '?';
  }

  // The shared hidden input (index.html EDIT 3). Stand-down law: build it at
  // body level if the markup is missing. Wired exactly once.
  function ensureAvatarInput() {
    if (el.avatarInput && avatarInputWired) return el.avatarInput;
    el.avatarInput = el.avatarInput || $('acc-avatar-input');
    if (!el.avatarInput) {
      el.avatarInput = document.createElement('input');
      el.avatarInput.type = 'file';
      el.avatarInput.id = 'acc-avatar-input';
      el.avatarInput.hidden = true;
      document.body.appendChild(el.avatarInput);
    }
    el.avatarInput.accept = 'image/*';
    if (!avatarInputWired) {
      el.avatarInput.addEventListener('change', onAvatarPicked);
      avatarInputWired = true;
    }
    return el.avatarInput;
  }

  function pickAvatarFor(target) {
    ensureAvatarInput();
    if (!el.avatarInput) return;
    avatarInputTarget = target;   // 'add' or the account id; overwritten on every pick
    el.avatarInput.click();
  }

  // File -> 128px cover-cropped JPEG data URL under the cap. Phone photos
  // are megabytes raw; the downscale is what makes the 40KB law livable.
  function resizeToAvatar(file, done) {
    if (!file) return;
    if (String(file.type || '').indexOf('image/') !== 0) {
      toast('That file is not an image');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var S = 128;
        var c = document.createElement('canvas');
        c.width = S;
        c.height = S;
        var ctx = c.getContext('2d');
        var w = img.width || 1;
        var h = img.height || 1;
        var side = Math.min(w, h);
        var sx = (w - side) / 2;
        var sy = (h - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, S, S);
        var url = c.toDataURL('image/jpeg', 0.85);
        if (url.length > AVATAR_MAX_CHARS) url = c.toDataURL('image/jpeg', 0.7);
        if (url.length > AVATAR_MAX_CHARS) {
          toast('Photo too large after resizing (max 40 KB), pick a smaller image');
          return;
        }
        done(url);
      };
      img.onerror = function () { toast('Could not read that image'); };
      img.src = String(reader.result || '');
    };
    reader.onerror = function () { toast('Could not read that file'); };
    reader.readAsDataURL(file);
  }

  function onAvatarPicked() {
    var input = el.avatarInput;
    if (!input) return;
    var file = input.files && input.files[0];
    var target = avatarInputTarget;
    input.value = '';   // same file stays re-pickable; the File object above is already held
    avatarInputTarget = null;
    if (!file || !target) return;
    resizeToAvatar(file, function (url) {
      if (target === 'add') {
        addAvatarPick = url;
        paintAddAvatarPreview();
        return;
      }
      saveAccountAvatar(target, url);
    });
  }

  // Saves through the existing accounts:update patch seam; the main-side
  // list push re-renders the rail, the local patch keeps it instant.
  function saveAccountAvatar(accId, url) {
    var acc = accountById(accId);
    call(function () { return window.wab.accounts.update(accId, { avatar: url }); }, 'Could not save the photo')
      .then(function (updated) {
        if (acc) acc.avatar = (updated && updated.id) ? updated.avatar : url;
        renderAll();
        toast('Photo saved');
      });
  }

  // The modal's preview circle: picked photo, else live initials of the
  // typed name on the picked color.
  function paintAddAvatarPreview() {
    if (!el.addAvatarPreview) return;
    el.addAvatarPreview.textContent = '';
    el.addAvatarPreview.style.backgroundImage = '';
    el.addAvatarPreview.style.background = '';
    if (addAvatarPick) {
      el.addAvatarPreview.classList.add('has-img');
      try { el.addAvatarPreview.style.backgroundImage = 'url("' + addAvatarPick + '")'; } catch (e) { /* cosmetic */ }
    } else {
      el.addAvatarPreview.classList.remove('has-img');
      el.addAvatarPreview.style.background = addColorPick || COLORS[0];
      el.addAvatarPreview.textContent = accInitials(el.addName && el.addName.value);
    }
  }

  function buildSwatches(container, selected, onPick, extra) {
    container.textContent = '';
    var list = COLORS.slice();
    if (extra && list.indexOf(extra) === -1) list.unshift(extra);   // V14 U3: platform prefill color
    list.forEach(function (c) {
      var s = document.createElement('button');
      s.type = 'button';
      s.className = 'swatch' + (c === selected ? ' selected' : '');
      s.style.background = c;
      s.setAttribute('aria-label', 'Color ' + c);
      s.addEventListener('click', function () {
        Array.prototype.forEach.call(container.children, function (x) { x.classList.remove('selected'); });
        s.classList.add('selected');
        onPick(c);
      });
      container.appendChild(s);
    });
  }

  // v14 U2: the modal ships Name + Color in index.html; the platform chooser
  // and the "For <user>" line are injected here once, standing down if the
  // modal ever ships its own #add-platform-row.
  // V14 U3 integration: index.html now ships a static platform selector
  // (#add-platform-sel), so the chooser injection stands down under this
  // same stand-down law; only the "For <user>" context line still injects.
  function ensureAddPlatformRow() {
    if (el.modalAdd.querySelector('#add-platform-row')) return;
    var shipsSel = !!(el.addPlatWa || el.modalAdd.querySelector('#add-platform-sel'));
    var nameField = el.addName ? el.addName.parentNode : null;
    if (!nameField || !nameField.parentNode) return;
    if (!shipsSel) {
      var field = document.createElement('div');
      field.className = 'field';
      field.id = 'add-platform-row';
      var lab = document.createElement('span');
      lab.className = 'field-label';
      lab.textContent = 'Platform';
      field.appendChild(lab);
      var row = document.createElement('div');
      row.className = 'plat-chooser';
      ['whatsapp', 'telegram'].forEach(function (p) {
        var b = buildPlatformBtn(p);
        b.classList.add('plat-choice');
        if (p === addPlatformPick) b.classList.add('is-picked');
        var t = document.createElement('span');
        t.className = 'plat-choice-name';
        t.textContent = platformName(p);
        b.appendChild(t);
        b.addEventListener('click', function () {
          setAddPlatform(p);
          paintChooserPicks();
        });
        row.appendChild(b);
      });
      field.appendChild(row);
      nameField.parentNode.insertBefore(field, nameField.nextSibling);
    }

    if (el.modalAdd.querySelector('#add-user-context')) return;
    var ctx = document.createElement('p');
    ctx.id = 'add-user-context';
    ctx.className = 'add-user-context';
    ctx.hidden = true;
    var title = el.modalAdd.querySelector('#add-title');
    if (title && title.parentNode) title.parentNode.insertBefore(ctx, title.nextSibling);
    else el.modalAdd.insertBefore(ctx, el.modalAdd.firstChild);
  }

  function paintChooserPicks() {
    var row = el.modalAdd.querySelector('#add-platform-row .plat-chooser');
    if (!row) return;
    Array.prototype.forEach.call(row.children, function (x) {
      x.classList.toggle('is-picked', x.dataset.platform === addPlatformPick);
    });
  }

  function addContextLine(userId) {
    var line = el.modalAdd.querySelector('#add-user-context');
    if (!line) return;
    var u = null;
    users.forEach(function (x) { if (x.id === userId) u = x; });
    if (u && u.name) {
      line.textContent = 'For ' + u.name;
      line.hidden = false;
    } else {
      line.textContent = '';
      line.hidden = true;
    }
  }

  // V14 U2+U3 merged: openAddModal(prefill) where prefill = { platform,
  // userId, name, color }, every field optional (the wab:add-account detail
  // passes through whole; U2 ctx senders pass { userId, platform }). Plain
  // callers (rail button, empty state, Settings) pass nothing and get the
  // first user + WhatsApp (U2 law; main falls back to the first user anyway).
  // U3's state (addPlatform / addUserId) and U2's chooser mirrors
  // (addPlatformPick / addContextUserId) stay in sync from this one prefill;
  // the static selector (index.html U3) and the injected chooser
  // (ensureAddPlatformRow, which stands down when the static one ships)
  // both reflect it.
  function openAddModal(prefill) {
    var pf = prefilled(prefill || {});
    addUserId = pf.userId || (users.length ? users[0].id : '');
    addContextUserId = addUserId;
    setAddPlatform(pf.platform);
    addColorPick = pf.color || COLORS[accounts.length % COLORS.length];
    el.addName.value = pf.name;
    var extra = (pf.color && COLORS.indexOf(pf.color) === -1) ? pf.color : null;
    buildSwatches(el.addSwatches, addColorPick, function (c) { addColorPick = c; paintAddAvatarPreview(); }, extra);
    ensureAddPlatformRow();
    paintChooserPicks();
    addContextLine(addContextUserId);
    addAvatarPick = '';   // E3: every open starts photoless; the preview shows initials
    paintAddAvatarPreview();
    el.modalAdd.hidden = false;
    el.addName.focus();
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(true); } catch (e) { /* optional */ }
  }

  // Normalizes a wab:add-account detail into the four prefill fields.
  function prefilled(d) {
    return {
      platform: (d.platform === 'telegram') ? 'telegram' : 'whatsapp',
      userId: (d.userId && String(d.userId)) || '',
      name: (typeof d.name === 'string') ? d.name : '',
      color: (/^#[0-9a-fA-F]{6}$/.test(String(d.color || ''))) ? d.color : null
    };
  }

  // V14 U3: the modal's platform selector. Highlights the picked logo and
  // swaps the scan hint to that platform's phone path. The QR window repeats
  // the same wording on its own (windows.js keys it off account.platform).
  // U2's addPlatformPick mirror rides along so the injected chooser, when
  // it is the one in play, never disagrees with the static selector.
  function setAddPlatform(p) {
    addPlatform = (p === 'telegram') ? 'telegram' : 'whatsapp';
    addPlatformPick = addPlatform;
    if (el.addPlatWa) {
      el.addPlatWa.classList.toggle('active', addPlatform === 'whatsapp');
      el.addPlatWa.setAttribute('aria-pressed', addPlatform === 'whatsapp' ? 'true' : 'false');
    }
    if (el.addPlatTg) {
      el.addPlatTg.classList.toggle('active', addPlatform === 'telegram');
      el.addPlatTg.setAttribute('aria-pressed', addPlatform === 'telegram' ? 'true' : 'false');
    }
    if (el.addPlatHint) {
      el.addPlatHint.textContent = addPlatform === 'telegram'
        ? 'The owner scans from their phone: Telegram, Settings, Devices, Link Desktop Device.'
        : 'The owner scans from their phone: WhatsApp, Settings, Linked devices, Link a device.';
    }
  }

  // V14 U3: duplicate guard, second layer after people.js. U2 only renders an
  // unconnected card when no account exists for the pair; legacy accounts
  // carry no userId and never match a real user id.
  function hasAccountFor(userId, platform) {
    if (!userId) return false;
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      if (a && String(a.userId || '') === String(userId) &&
          ((a.platform || 'whatsapp') === platform)) return true;
    }
    return false;
  }

  function closeAddModal() {
    el.modalAdd.hidden = true;
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(false); } catch (e) { /* optional */ }
  }

  function createAccount() {
    if (addBusy) return;   // V14 U3: Enter re-fires while the invoke is out
    var name = (el.addName.value || '').trim();
    if (!name) { el.addName.focus(); return; }
    addBusy = true;        // V14 U3: one add in flight = one QR window
    el.addCreate.disabled = true;
    // v14 U2: platform + owner ride along (preload widened in T3; main
    // whitelists the platform and falls back to the first user). U3: the
    // selector state feeds the call; U2's mirrors hold the same values.
    call(function () { return window.wab.accounts.add(name, addColorPick, addPlatform, addUserId || undefined); }, 'Could not add the account')
      .then(function (acc) {
        addBusy = false;
        el.addCreate.disabled = false;
        if (!acc || !acc.id) return;
        accounts.push(acc);
        // E3: the optional modal photo rides a follow-up update on the fresh
        // id (accounts:add's signature stays untouched; store.js gates the
        // size). The list push re-renders; the local patch is instant.
        if (addAvatarPick) {
          var avUrl = addAvatarPick;
          call(function () { return window.wab.accounts.update(acc.id, { avatar: avUrl }); }, 'Could not save the photo')
            .then(function (updated) {
              acc.avatar = (updated && updated.id) ? updated.avatar : avUrl;
              renderCards();
            });
        }
        addAvatarPick = '';
        // v14 U2/D4: the new account's section opens so its linking status
        // row (QR waiting) shows immediately under the user's logo; one
        // more click on the logo folds the detail away, leaving the logo.
        openSections.add(secKey(acc.userId || addUserId, acc.platform || addPlatform));
        closeAddModal();
        renderAll();
        fireLayoutChange();
        toast('Account created');
      });
  }

  /* ---------- context menu ---------- */

  function openCtxMenu(accId, x, y) {
    ctxAccountId = accId;
    var acc = accountById(accId);
    if (!acc) return;
    buildSwatches(el.ctxSwatches, acc.color, function (c) {
      call(function () { return window.wab.accounts.update(accId, { color: c }); }, 'Could not save the color')
        .then(function (updated) {
          if (updated && updated.id) {
            acc.color = updated.color;
          } else {
            acc.color = c;
          }
          renderAll();
        });
    });
    el.ctxMenu.hidden = false;
    var mw = el.ctxMenu.offsetWidth || 190;
    var mh = el.ctxMenu.offsetHeight || 160;
    var px = Math.min(x, window.innerWidth - mw - 8);
    var py = Math.min(y, window.innerHeight - mh - 8);
    el.ctxMenu.style.left = Math.max(8, px) + 'px';
    el.ctxMenu.style.top = Math.max(8, py) + 'px';
  }

  function closeCtxMenu() {
    if (!el.ctxMenu) return;
    el.ctxMenu.hidden = true;
    ctxAccountId = null;
  }

  function startRename(accId) {
    // D4: the rename target is the .pucard-acc detail row (buildCard is
    // gone); the .card-name span inside keeps its class, so the input
    // insertion logic below is untouched.
    var card = el.accountList.querySelector('.pucard-acc[data-id="' + accId + '"]');
    if (!card) return;
    var acc = accountById(accId);
    var nameEl = card.querySelector('.card-name');
    if (!nameEl || !acc) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-name-input';
    input.maxLength = 40;
    input.value = acc.name || '';
    nameEl.hidden = true;
    nameEl.parentNode.insertBefore(input, nameEl);
    input.focus();
    input.select();

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      var value = input.value.trim();
      input.remove();
      nameEl.hidden = false;
      if (!save || !value || value === acc.name) return;
      call(function () { return window.wab.accounts.update(accId, { name: value }); }, 'Could not save the name')
        .then(function (updated) {
          acc.name = (updated && updated.name) ? updated.name : value;
          renderAll();
        });
    }

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') commit(true);
      else if (ev.key === 'Escape') commit(false);
      ev.stopPropagation();
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  /* ---------- remove modal ---------- */

  function openRemoveModal(accId) {
    var acc = accountById(accId);
    if (!acc) return;
    removeTargetId = accId;
    el.removeTitle.textContent = 'Remove ' + (acc.name || 'account') + '?';
    el.modalRemove.hidden = false;
    el.removeConfirm.focus();
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(true); } catch (e) { /* optional */ }
  }

  function closeRemoveModal() {
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(false); } catch (e) { /* optional */ }
    el.modalRemove.hidden = true;
    removeTargetId = null;
  }

  /* ---------- settings ---------- */

  function openSettings() {
    el.settings.hidden = false;
    refreshPrivacyAccountSelect();
    refreshPortalAccountSelect();
    loadAiConfig();
    loadPrivacy();
    loadPortal();
    startPortalPolling();
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(true); } catch (e) { /* optional */ }
  }

  function closeSettings() {
    el.settings.hidden = true;
    stopPortalPolling();
    try { if (window.wab && window.wab.app.setOverlayVisible) window.wab.app.setOverlayVisible(false); } catch (e) { /* optional */ }
  }

  function loadAiConfig() {
    call(function () { return window.wab.ai.getConfig(); }, 'Could not load AI settings')
      .then(function (cfg) {
        if (!cfg) return;
        el.aiProvider.value = cfg.provider === 'anthropic' ? 'anthropic' : 'openai-compatible';
        el.aiBaseUrl.value = cfg.baseUrl || '';
        el.aiModel.value = cfg.model || '';
        el.aiKey.value = cfg.apiKey || '';
        el.aiMaxCtx.value = String(cfg.maxContextMessages || 40);
        updateBaseUrlPlaceholder();
      });
  }

  function updateBaseUrlPlaceholder() {
    el.aiBaseUrl.placeholder = BASEURL_PLACEHOLDER[el.aiProvider.value] || BASEURL_PLACEHOLDER['openai-compatible'];
  }

  function saveAiConfig() {
    var cfg = {
      provider: el.aiProvider.value === 'anthropic' ? 'anthropic' : 'openai-compatible',
      baseUrl: el.aiBaseUrl.value.trim(),
      apiKey: el.aiKey.value,
      model: el.aiModel.value.trim(),
      maxContextMessages: parseInt(el.aiMaxCtx.value, 10) || 40
    };
    el.aiSave.disabled = true;
    call(function () { return window.wab.ai.setConfig(cfg); }, 'Could not save AI settings')
      .then(function (saved) {
        el.aiSave.disabled = false;
        if (!saved) return;
        toast('AI settings saved');
      });
  }

  function testAi() {
    // Test uses the saved config, so save quietly first if the form changed.
    saveAiConfigQuiet(function () {
      el.aiTestResult.hidden = true;
      el.aiTest.disabled = true;
      el.aiTest.textContent = 'Testing';
      call(function () { return window.wab.ai.test(); }, 'Test failed')
        .then(function (res) {
          el.aiTest.disabled = false;
          el.aiTest.textContent = 'Test';
          el.aiTestResult.hidden = false;
          if (res && res.ok) {
            el.aiTestResult.className = 'test-result ok';
            el.aiTestResult.textContent = 'Works, model ' + (res.model || 'unknown');
          } else {
            el.aiTestResult.className = 'test-result fail';
            el.aiTestResult.textContent = errText(res, 'Test failed');
          }
        });
    });
  }

  function saveAiConfigQuiet(done) {
    var cfg = {
      provider: el.aiProvider.value === 'anthropic' ? 'anthropic' : 'openai-compatible',
      baseUrl: el.aiBaseUrl.value.trim(),
      apiKey: el.aiKey.value,
      model: el.aiModel.value.trim(),
      maxContextMessages: parseInt(el.aiMaxCtx.value, 10) || 40
    };
    call(function () { return window.wab.ai.setConfig(cfg); }, 'Could not save AI settings')
      .then(function () { if (done) done(); });
  }

  function privacyAccountId() {
    return el.privacyAccount.value || null;
  }

  function refreshPrivacyAccountSelect() {
    var prev = el.privacyAccount.value;
    el.privacyAccount.textContent = '';
    if (accounts.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No accounts yet';
      el.privacyAccount.appendChild(opt);
      el.privacySave.disabled = true;
      return;
    }
    accounts.forEach(function (acc) {
      var o = document.createElement('option');
      o.value = acc.id;
      o.textContent = acc.name || 'Account';
      el.privacyAccount.appendChild(o);
    });
    el.privacySave.disabled = false;
    if (prev && accountById(prev)) el.privacyAccount.value = prev;
  }

  var privacyLoadedFor = null;
  var privacyChatsCache = [];
  var privacyChatsLoaded = false;

  function loadPrivacy() {
    var accId = privacyAccountId();
    privacySelection = new Set();
    privacyOnlyPick = null;
    privacyChatsCache = [];
    privacyChatsLoaded = false;
    privacyLoadedFor = accId;

    if (!accId) {
      el.privacyChats.textContent = '';
      el.privacyMode.value = 'all';
      updatePrivacyHint();
      updatePrivacyHandover(null);
      return;
    }

    var note = document.createElement('div');
    note.className = 'chat-load-note';
    note.textContent = 'Loading chats';
    el.privacyChats.textContent = '';
    el.privacyChats.appendChild(note);

    call(function () { return window.wab.privacy.get(accId); }, 'Could not load privacy settings')
      .then(function (cfg) {
        if (privacyLoadedFor !== accId) return;
        if (cfg) {
          if (cfg.mode === 'allow' && cfg.allow && cfg.allow.length === 1) {
            el.privacyMode.value = 'only';
            privacyOnlyPick = cfg.allow[0];
          } else if (cfg.mode === 'deny') {
            el.privacyMode.value = 'deny';
            (cfg.deny || []).forEach(function (t) { privacySelection.add(t); });
          } else if (cfg.mode === 'allow') {
            el.privacyMode.value = 'allow';
            (cfg.allow || []).forEach(function (t) { privacySelection.add(t); });
          } else {
            el.privacyMode.value = 'all';
          }
        }
        updatePrivacyHint();
        // Config may land after the chat list; re-render so checks show.
        if (privacyChatsLoaded) renderPrivacyChats(privacyChatsCache);
      });

    call(function () { return window.wab.privacy.listChats(accId); }, 'Could not read the chat list')
      .then(function (chats) {
        if (privacyLoadedFor !== accId) return;
        privacyChatsCache = Array.isArray(chats) ? chats : [];
        privacyChatsLoaded = true;
        renderPrivacyChats(privacyChatsCache);
      });

    updatePrivacyHandover(accId);
  }

  // Consent-first handover: while the selected account HAS a live portal
  // invite, its owner owns consent through the portal link. The manual
  // mode/chats picker hides and the note says how to take it back (revoke
  // the invite in the Consent portal block below). Without an invite the
  // manual picker stays: operator-owned accounts keep local setup. st is
  // optional: callers that already hold a fresh portal status pass it, the
  // privacy-account path fetches its own.
  function updatePrivacyHandover(accId, st) {
    if (!el.privacyManualBlock || !el.privacyPortalNote) return;
    if (!accId) {
      el.privacyManualBlock.hidden = false;
      el.privacyPortalNote.hidden = true;
      el.privacyPortalNote.textContent = '';
      return;
    }
    var apply = function (status) {
      if (privacyAccountId() !== accId) return; // the select moved on; stale
      var inv = status && status.invites && status.invites[accId];
      el.privacyManualBlock.hidden = !!inv;
      el.privacyPortalNote.hidden = !inv;
      el.privacyPortalNote.textContent = inv
        ? 'Consent for this account is owned by its owner through the portal link. Revoke the invite to take manual setup back.'
        : '';
    };
    if (st) { apply(st); return; }
    if (!wabOk() || !window.wab.portal || typeof window.wab.portal.status !== 'function') return;
    call(function () { return window.wab.portal.status(); }, 'Could not load the consent portal')
      .then(function (fresh) { apply(fresh); });
  }

  // Mode switch keeps the loaded chat list, drops in-progress picks.
  function onPrivacyModeChange() {
    privacySelection = new Set();
    privacyOnlyPick = null;
    updatePrivacyHint();
    renderPrivacyChats(privacyChatsCache);
  }

  function renderPrivacyChats(chats) {
    el.privacyChats.textContent = '';
    var mode = el.privacyMode.value;

    if (mode === 'all') {
      var n = document.createElement('div');
      n.className = 'chat-load-note';
      n.textContent = 'All chats are visible. Pick another mode to choose chats.';
      el.privacyChats.appendChild(n);
      return;
    }

    if (chats.length === 0) {
      var e = document.createElement('div');
      e.className = 'chat-load-note';
      e.textContent = privacyChatsLoaded
        ? 'No chats found yet. Open this account once so its chat list loads.'
        : 'Loading chats';
      el.privacyChats.appendChild(e);
      return;
    }

    // Type-a-name filter: match on normalized title substring.
    var q = (el.privacyFilter && el.privacyFilter.value ? el.privacyFilter.value : '').toLowerCase().trim();
    var shown = q
      ? chats.filter(function (c) { return (c.title || '').toLowerCase().indexOf(q) !== -1; })
      : chats;
    if (shown.length === 0) {
      var nf = document.createElement('div');
      nf.className = 'chat-load-note';
      nf.textContent = 'Nothing matches that name.';
      el.privacyChats.appendChild(nf);
      return;
    }

    shown.forEach(function (chat) {
      var row = document.createElement('label');
      row.className = 'chat-row';

      var input = document.createElement('input');
      if (mode === 'only') {
        input.type = 'radio';
        input.name = 'wab-only-pick';
        input.checked = privacyOnlyPick === chat.title;
        input.addEventListener('change', function () {
          if (input.checked) privacyOnlyPick = chat.title;
        });
      } else {
        input.type = 'checkbox';
        input.checked = privacySelection.has(chat.title);
        input.addEventListener('change', function () {
          if (input.checked) privacySelection.add(chat.title);
          else privacySelection.delete(chat.title);
        });
      }
      row.appendChild(input);

      var label = document.createElement('span');
      label.textContent = chat.title;
      row.appendChild(label);

      if (chat.unread) {
        var u = document.createElement('span');
        u.className = 'chat-unread';
        u.textContent = String(chat.unread);
        row.appendChild(u);
      }

      el.privacyChats.appendChild(row);
    });
  }

  function updatePrivacyHint() {
    var hints = {
      all: 'All chats are visible.',
      allow: 'Checked chats stay visible. Everything else is hidden.',
      deny: 'Checked chats are blurred and cannot be opened.',
      only: 'Pick the one chat to show. Everything else is hidden.'
    };
    el.privacyHint.textContent = hints[el.privacyMode.value] || '';
  }

  function savePrivacy() {
    var accId = privacyAccountId();
    if (!accId) return;
    var mode = el.privacyMode.value;
    var config;

    if (mode === 'all') {
      config = { mode: 'all', allow: [], deny: [] };
    } else if (mode === 'deny') {
      config = { mode: 'deny', allow: [], deny: Array.from(privacySelection) };
    } else if (mode === 'only') {
      if (!privacyOnlyPick) {
        toast('Pick one chat first');
        return;
      }
      config = { mode: 'allow', allow: [privacyOnlyPick], deny: [] };
    } else {
      config = { mode: 'allow', allow: Array.from(privacySelection), deny: [] };
    }

    el.privacySave.disabled = true;
    call(function () { return window.wab.privacy.set(accId, config); }, 'Could not save privacy settings')
      .then(function (saved) {
        el.privacySave.disabled = false;
        if (!saved) return;
        toast('Privacy settings saved');
      });
  }

  /* ---------- consent portal ---------- */
  // One invite link per account. The partner opens it on their phone and
  // picks the contacts to share; revoking kills the link instantly.

  function portalAccountId() {
    return el.portalAccount ? (el.portalAccount.value || null) : null;
  }

  function refreshPortalAccountSelect() {
    if (!el.portalAccount) return;
    var prev = el.portalAccount.value;
    el.portalAccount.textContent = '';
    if (accounts.length === 0) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No accounts yet';
      el.portalAccount.appendChild(opt);
      if (el.portalGenerate) el.portalGenerate.disabled = true;
      return;
    }
    accounts.forEach(function (acc) {
      var o = document.createElement('option');
      o.value = acc.id;
      o.textContent = acc.name || 'Account';
      el.portalAccount.appendChild(o);
    });
    if (el.portalGenerate) el.portalGenerate.disabled = false;
    if (prev && accountById(prev)) el.portalAccount.value = prev;
  }

  var portalLoadedFor = null;

  function portalNoteText(text, fail) {
    if (!el.portalNote) return;
    el.portalNote.hidden = !text;
    el.portalNote.className = fail ? 'test-result fail' : 'privacy-hint';
    el.portalNote.textContent = text || '';
  }

  function renderPortalStatus(st, accId) {
    if (!st) return;
    if (!st.running) {
      portalNoteText('The consent portal server is not running. Restart the app and check the console.', true);
    } else {
      portalNoteText('', false);
    }
    var inv = st.invites && st.invites[accId];
    var urls = (inv && inv.urls) || {};
    var lan = Array.isArray(urls.lan) ? urls.lan : [];
    if (inv && lan.length) {
      el.portalLink.value = lan[0];
      el.portalLink.title = lan.length > 1
        ? 'Other possible links: ' + lan.slice(1).join(' ')
        : '';
      el.portalLinkBlock.hidden = false;
    } else {
      el.portalLink.value = '';
      el.portalLink.title = '';
      el.portalLinkBlock.hidden = true;
    }
    el.portalGenerate.hidden = !accId || !!inv;
    el.portalRevoke.hidden = !inv;
    renderPortalRemote(st);
    // Invite truth just changed (settings open, account switch, generate or
    // revoke): the Privacy block handover follows the same fresh status.
    updatePrivacyHandover(privacyAccountId(), st);
  }

  function loadPortal() {
    var accId = portalAccountId();
    portalLoadedFor = accId;
    portalNoteText('', false);
    el.portalLinkBlock.hidden = true;
    el.portalGenerate.hidden = !accId;
    el.portalRevoke.hidden = true;
    if (!wabOk() || !window.wab.portal || typeof window.wab.portal.status !== 'function') {
      portalNoteText('Portal tools did not load. Restart the app.', true);
      return;
    }
    call(function () { return window.wab.portal.status(); }, 'Could not load the consent portal')
      .then(function (st) {
        if (portalLoadedFor !== accId) return;
        renderPortalStatus(st, accId);
      });
  }

  /* ---------- remote access (public tunnel) ---------- */
  // One cloudflared quick tunnel for the whole desk. The Settings row starts
  // and stops it on demand; the public invite link is the tunnel URL plus
  // the account token. The status poll keeps the row honest while Settings
  // is open, so a tunnel that died mid-session stops advertising its link.

  var remoteBusy = false;
  var remoteRunning = false;
  var remoteUrl = null;
  var portalPollTimer = null;

  function paintRemoteRow() {
    if (!el.portalRemoteToggle) return;
    el.portalRemoteToggle.disabled = remoteBusy;
    el.portalRemoteToggle.textContent = remoteBusy
      ? 'Working...'
      : (remoteRunning ? 'Stop remote access' : 'Start remote access');
    if (el.portalRemoteStatus) {
      el.portalRemoteStatus.textContent = (remoteRunning && remoteUrl)
        ? 'Remote access is on: ' + remoteUrl
        : 'Remote access is off. Start it to get a public link that works outside your network.';
    }
  }

  function renderPortalRemote(st) {
    var rem = (st && st.remote) || {};
    remoteRunning = !!rem.running;
    remoteUrl = rem.url || null;
    paintRemoteRow();
    // The full public invite link shows only when BOTH the tunnel is live
    // AND an invite exists for the selected account.
    var accId = portalAccountId();
    var inv = st && st.invites && st.invites[accId];
    var urls = (inv && inv.urls) || {};
    var pub = (remoteRunning && remoteUrl && urls.public) ? urls.public : null;
    if (el.portalPublicLink) el.portalPublicLink.value = pub || '';
    if (el.portalPublicLinkBlock) el.portalPublicLinkBlock.hidden = !pub;
  }

  function startRemoteAccess() {
    if (remoteBusy) return;
    if (!wabOk() || !window.wab.portal || typeof window.wab.portal.remoteStart !== 'function') {
      portalNoteText('Remote access tools did not load. Restart the app.', true);
      return;
    }
    remoteBusy = true;
    paintRemoteRow();
    call(function () { return window.wab.portal.remoteStart(); }, 'Could not start remote access')
      .then(function (res) {
        remoteBusy = false;
        if (!res || !res.ok) {
          portalNoteText((res && res.error) || 'Could not start remote access.', true);
          paintRemoteRow();
          return;
        }
        toast('Remote access is live');
        loadPortal();
      });
  }

  function stopRemoteAccess() {
    if (remoteBusy) return;
    if (!wabOk() || !window.wab.portal || typeof window.wab.portal.remoteStop !== 'function') {
      portalNoteText('Remote access tools did not load. Restart the app.', true);
      return;
    }
    remoteBusy = true;
    paintRemoteRow();
    call(function () { return window.wab.portal.remoteStop(); }, 'Could not stop remote access')
      .then(function (res) {
        remoteBusy = false;
        if (!res || !res.ok) {
          portalNoteText((res && res.error) || 'Could not stop remote access.', true);
        } else {
          toast('Remote access stopped');
        }
        loadPortal();
      });
  }

  function startPortalPolling() {
    if (portalPollTimer) return;
    portalPollTimer = window.setInterval(function () {
      if (!el.settings || el.settings.hidden) return;
      if (!wabOk() || !window.wab.portal || typeof window.wab.portal.status !== 'function') return;
      window.wab.portal.status().then(function (st) {
        if (!st || !el.settings || el.settings.hidden) return;
        renderPortalRemote(st);
      }).catch(function () { /* transient poll miss; the next tick retries */ });
    }, 5000);
  }

  function stopPortalPolling() {
    if (!portalPollTimer) return;
    window.clearInterval(portalPollTimer);
    portalPollTimer = null;
  }

  function generatePortalInvite() {
    var accId = portalAccountId();
    if (!accId) return;
    el.portalGenerate.disabled = true;
    call(function () { return window.wab.portal.createInvite(accId); }, 'Could not create the link')
      .then(function (res) {
        el.portalGenerate.disabled = false;
        if (!res || !res.ok) {
          portalNoteText((res && res.error) || 'Could not create the link.', true);
          return;
        }
        toast('Portal link created. It is printed in the console too.');
        loadPortal();
      });
  }

  function revokePortalInvite() {
    var accId = portalAccountId();
    if (!accId) return;
    el.portalRevoke.disabled = true;
    call(function () { return window.wab.portal.revokeInvite(accId); }, 'Could not revoke the link')
      .then(function () {
        el.portalRevoke.disabled = false;
        toast('Portal link revoked');
        loadPortal();
      });
  }

  function copyPortalLinkFallback(text) {
    try {
      el.portalLink.focus();
      el.portalLink.select();
      document.execCommand('copy');
      toast('Invite link copied');
    } catch (e) {
      toast('Copy failed. Select the link and copy it by hand.');
    }
  }

  function copyPortalLink() {
    var text = el.portalLink ? el.portalLink.value : '';
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        toast('Invite link copied');
      }, function () {
        copyPortalLinkFallback(text);
      });
    } else {
      copyPortalLinkFallback(text);
    }
  }

  function copyPortalPublicFallback() {
    try {
      el.portalPublicLink.focus();
      el.portalPublicLink.select();
      document.execCommand('copy');
      toast('Public invite link copied');
    } catch (e) {
      toast('Copy failed. Select the link and copy it by hand.');
    }
  }

  function copyPortalPublicLink() {
    var text = el.portalPublicLink ? el.portalPublicLink.value : '';
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(function () {
        toast('Public invite link copied');
      }, function () {
        copyPortalPublicFallback();
      });
    } else {
      copyPortalPublicFallback();
    }
  }

  /* ---------- wiring ---------- */

  function wire() {
    // v14 U2: every entry point seeds the chooser (openAddModal defaults to
    // the first user when handed no context).
    if (el.addBtn) el.addBtn.addEventListener('click', function () { openAddModal(); });
    if (el.settingsAddAccount) el.settingsAddAccount.addEventListener('click', function () {
      closeSettings();
      openAddModal();
    });
    el.emptyAddBtn.addEventListener('click', function () { openAddModal(); });
    el.addCreate.addEventListener('click', createAccount);
    // V14 U3: platform selector buttons.
    if (el.addPlatWa) el.addPlatWa.addEventListener('click', function () { setAddPlatform('whatsapp'); });
    if (el.addPlatTg) el.addPlatTg.addEventListener('click', function () { setAddPlatform('telegram'); });
    // E3: the modal's photo door, initials that follow the typed name, and
    // the one shared hidden input (rail circles call pickAvatarFor directly).
    if (el.addAvatarBtn) el.addAvatarBtn.addEventListener('click', function () { pickAvatarFor('add'); });
    el.addName.addEventListener('input', function () {
      if (!addAvatarPick) paintAddAvatarPreview();
    });
    ensureAvatarInput();
    el.addName.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') createAccount();
    });
    el.modalAdd.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', closeAddModal);
    });
    el.modalAdd.addEventListener('click', function (ev) {
      if (ev.target === el.modalAdd) closeAddModal();
    });

    el.removeConfirm.addEventListener('click', function () {
      if (removeTargetId) removeAccount(removeTargetId);
      closeRemoveModal();
    });
    el.modalRemove.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', closeRemoveModal);
    });
    el.modalRemove.addEventListener('click', function (ev) {
      if (ev.target === el.modalRemove) closeRemoveModal();
    });

    el.ctxRename.addEventListener('click', function () {
      var id = ctxAccountId;
      closeCtxMenu();
      if (id) startRename(id);
    });
    el.ctxRemove.addEventListener('click', function () {
      var id = ctxAccountId;
      closeCtxMenu();
      if (id) openRemoveModal(id);
    });

    Array.prototype.forEach.call(el.layoutSwitch.querySelectorAll('.mode-btn'), function (b) {
      b.addEventListener('click', function () { setLayout(b.dataset.mode); });
    });

    el.aiBtn.addEventListener('click', toggleAi);
    el.settingsBtn.addEventListener('click', function () {
      if (el.settings.hidden) openSettings();
      else closeSettings();
    });
    el.settingsClose.addEventListener('click', closeSettings);

    el.aiProvider.addEventListener('change', updateBaseUrlPlaceholder);
    el.aiTest.addEventListener('click', testAi);
    el.aiSave.addEventListener('click', saveAiConfig);

    el.privacyAccount.addEventListener('change', loadPrivacy);
    el.privacyMode.addEventListener('change', onPrivacyModeChange);
    el.privacySave.addEventListener('click', savePrivacy);
    if (el.privacyFilter) {
      el.privacyFilter.addEventListener('input', function () {
        renderPrivacyChats(privacyChatsCache);
      });
    }

    // Consent portal block: switch account, generate, copy, revoke.
    if (el.portalAccount) el.portalAccount.addEventListener('change', loadPortal);
    if (el.portalGenerate) el.portalGenerate.addEventListener('click', generatePortalInvite);
    if (el.portalCopy) el.portalCopy.addEventListener('click', copyPortalLink);
    if (el.portalRevoke) el.portalRevoke.addEventListener('click', revokePortalInvite);
    // Remote access: one toggle button (start or stop) + the public link copy.
    if (el.portalRemoteToggle) el.portalRemoteToggle.addEventListener('click', function () {
      if (remoteBusy) return;
      if (remoteRunning) stopRemoteAccess();
      else startRemoteAccess();
    });
    if (el.portalPublicCopy) el.portalPublicCopy.addEventListener('click', copyPortalPublicLink);

    document.addEventListener('click', function (ev) {
      if (!el.ctxMenu.hidden && !el.ctxMenu.contains(ev.target)) closeCtxMenu();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (!el.ctxMenu.hidden) closeCtxMenu();
        else if (!el.modalAdd.hidden) closeAddModal();
        else if (!el.modalRemove.hidden) closeRemoveModal();
        else if (!el.settings.hidden) closeSettings();
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'i' || ev.key === 'I')) {
        ev.preventDefault();
        toggleAi();
      }
      // Ctrl+1..6: jump straight to a screen (single and tabs view). The
      // arrows cycle too (people.js relays its Ctrl+arrows through
      // WABShell.cycleSingleAccount in one-rect layouts). Grid and split
      // layouts keep their keys because every pane is already visible there.
      if ((ev.ctrlKey || ev.metaKey) && ev.key >= '1' && ev.key <= '6' && !ev.altKey) {
        var n = parseInt(ev.key, 10) - 1;
        if (screensApi()) {
          if (screenLayout()) {
            ev.preventDefault();
            switchScreenExternal(n);
          }
        } else {
          var linked = linkedAccounts();
          if (linked[n]) {
            ev.preventDefault();
            switchSingleAccount(linked[n].id);
          }
        }
      }
    });

    // Empty panes ask for an account; the renderer emits this when the user picks one.
    window.addEventListener('wab:assign-pane', function (ev) {
      var d = ev && ev.detail;
      if (!d || !d.accountId) return;
      var slot = parseInt(d.slot, 10);
      if (isNaN(slot)) return;
      assignments.forEach(function (sv, key) { if (sv === slot) assignments.delete(key); });
      assignments.set(d.accountId, slot);
      afterAssignmentChange();
    });

    window.addEventListener('wab:open-settings', function () { openSettings(); });

    // v14 U2+U3, closing the T5 seam: the pane picker's platform doors
    // (render.js connectPlatform), people.js's connectPlatform and the
    // rail's unconnected logos (shell.js requestAdd) all knock here. The
    // shell owns the add modal, so this single listener claims the event
    // synchronously (so render.js's next-tick Settings fallback and
    // requestAdd's self-open fallback both stand down), re-guards against
    // a platform that is already connected for that user, and opens the
    // modal pre-filled from the whole detail (platform, userId, name,
    // color; U2 senders pass userId + platform only and keep working).
    window.addEventListener('wab:add-account', function (ev) {
      var d = ev && ev.detail;
      if (!d) return;
      try { d.handled = true; } catch (eH) { /* frozen detail: still open below */ }
      var pf = prefilled(d);
      if (pf.userId && hasAccountFor(pf.userId, pf.platform)) {
        toast('That platform is already connected for this user');
        return;
      }
      openAddModal(d);
    });

    // The renderer owns screen occupancy and the dot row. The event contract
    // stays alive here (V12.3 W1): the payload is cached for WABShell.screenInfo
    // consumers; there is no bottom UI to repaint anymore.
    window.addEventListener('wab:screens-changed', function (ev) {
      screenState = (ev && ev.detail) || null;
    });

    window.addEventListener('resize', fireLayoutChange);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(fireLayoutChange).observe(el.slotArea);
    }
  }

  function toggleAi() {
    window.dispatchEvent(new CustomEvent('wab:toggle-ai'));
  }

  // v14 U2: the users behind the rail cards. An older preload without
  // wab.users degrades to one ungrouped 'Accounts' card so the rail stays
  // alive; the toast from call() stays loud either way.
  function loadUsers() {
    if (!wabOk() || !window.wab.users || typeof window.wab.users.list !== 'function') {
      users = [];
      return Promise.resolve();
    }
    return call(function () { return window.wab.users.list(); }, 'Could not load users')
      .then(function (list) {
        users = Array.isArray(list) ? list : [];
      });
  }

  /* ---------- boot ---------- */

  function boot() {
    grabElements();

    if (!wabOk()) {
      el.bootError.hidden = false;
      el.shell.hidden = true;
      return;
    }
    el.shell.hidden = false;

    wire();
    setLayout('single', false); // no push on boot; spine keeps its own default

    // v14 U2: users first, then accounts; the first renderCards groups
    // correctly instead of flashing a placeholder card.
    loadUsers().then(function () {
      call(function () { return window.wab.accounts.list(); }, 'Could not load accounts')
        .then(function (list) {
          accounts = Array.isArray(list) ? list : [];
          renderAll();
          fireLayoutChange();
        });
    });

    try {
      window.wab.accounts.onStatus(function (p) {
        if (p && p.accountId) applyStatus(p.accountId, p.status);
      });
      window.wab.app.onUnread(function (p) {
        if (!p || !p.accountId) return;
        unread.set(p.accountId, { allowed: p.allowed || 0, restricted: p.restricted || 0 });
        renderCards();
      });
      window.wab.app.onToast(function (p) {
        if (!p || !p.text) return;
        // Restricted toasts already carry the generic line. Shown verbatim.
        toast(p.text, p.kind || 'info');
      });
      window.wab.app.onLayout(function (m) {
        // Spine-driven layout changes run through the shell's own setter (no push back).
        if (MODES.indexOf(m) !== -1) setLayout(m, false);
      });
      window.wab.accounts.onListChanged(function () {
        // Accounts changed outside this UI (added via IPC, restored on boot, removed elsewhere).
        // v14 U2: users reload too, so a user added elsewhere appears in the rail.
        loadUsers().then(function () {
          call(function () { return window.wab.accounts.list(); }, 'Could not load accounts')
            .then(function (list) {
              if (!Array.isArray(list)) return;
              var ids = {};
              list.forEach(function (a) { ids[a.id] = true; });
              assignments.forEach(function (sv, key) { if (!ids[key]) assignments.delete(key); });
              accounts = list;
              renderAll();
              fireLayoutChange();
            });
        });
      });
    } catch (e) {
      toast('Live updates did not connect. Restart the app.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
