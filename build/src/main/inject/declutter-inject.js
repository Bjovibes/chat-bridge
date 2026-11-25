// Chat Bridge — declutter + thread-crop injection, hardened 2026-11-21 with
// researched selectors (notes\WAWEB-DOM-RESEARCH-2026-11-21.md, all 2026 sources).
// Strips WhatsApp's own chrome so the desk shows conversations only: no nav rail
// (Chats/Status/Channels/Communities icons), no WhatsApp search/filters, and in
// thread-crop mode no chat list at all. Runs in the page world via
// webContents.executeJavaScript. Idempotent. Never throws into the host page.
//
// Key research findings baked in:
// - The nav is NOT a <nav> element; its buttons carry data-navbar-item="true"
//   (locale-independent). Hiding via :has() containers.
// - The chat column is [data-testid="drawer-left"] / #side; #side alone dies on
//   tab switches, so it is always paired with the structural rule.
// - WhatsApp rebuilds wrapper nodes and drops styling: a body MutationObserver
//   (rAF-batched) PLUS a 1500ms interval reasserts everything (WWST pattern).
// - No chat open (no footer / no conversation-panel-messages): #main hides
//   entirely and the warm desk background shows through. Zero selector risk.
(function () {
  var W = window, D = document;
  var STYLE_ID = 'wab-declutter-style';
  var CROP_STYLE_ID = 'wab-threadcrop-style';

  function addStyle(id, css) {
    try {
      if (D.getElementById(id)) return;
      var st = D.createElement('style');
      st.id = id;
      st.textContent = css;
      (D.head || D.documentElement).appendChild(st);
    } catch (e) { /* never throw */ }
  }

  function installDeclutter() {
    addStyle(STYLE_ID, [
      // Nav rail: the 2026 layout hides it via its marker buttons' container.
      'html.wab-declutter div:has(> button[data-navbar-item="true"]) { display: none !important; }',
      'html.wab-declutter header[data-tab] { display: none !important; }',
      // Legacy shapes (harmless misses; the mock still uses some of these).
      'html.wab-declutter nav { display: none !important; }',
      'html.wab-declutter [data-testid="menu-tabs-dialogs"] { display: none !important; }',
      // WhatsApp search + filter block (2026-07 verified testids).
      'html.wab-declutter [data-testid="chat-list-search-container"] { display: none !important; }',
      'html.wab-declutter [data-testid="chatlist-header"] { display: none !important; }',
      'html.wab-declutter [aria-label="chat-list-filters"] { display: none !important; }',
      'html.wab-declutter #side > div:has(button#all-filter) { display: none !important; }',
      // Legacy + mock shapes for the search area.
      'html.wab-declutter #side > header { display: none !important; }',
      'html.wab-declutter #side [data-testid="chat-list-search"] { display: none !important; }',
      'html.wab-declutter #side [data-testid="chat-filter-panel"] { display: none !important; }'
    ].join('\n'));
  }

  function installCrop() {
    addStyle(CROP_STYLE_ID, [
      // The chat column dies by testid first, id second (id is volatile across
      // tab switches), structurally third (sibling-of-#main pattern).
      'html.wab-threadcrop [data-testid="drawer-left"] { display: none !important; }',
      'html.wab-threadcrop #side { display: none !important; }',
      'html.wab-threadcrop div:has(> div#main) > div:not(:has(div#main)):not(div#main) { display: none !important; }',
      'html.wab-threadcrop div[role="complementary"] { display: none !important; }',
      // Conversation column takes the full width.
      'html.wab-threadcrop #main { flex: 1 1 100% !important; width: 100% !important; min-width: 0 !important; max-width: none !important; }',
      'html.wab-threadcrop #app .two { flex: 1 1 100% !important; min-width: 0 !important; }',
      'html.wab-threadcrop #app > div { flex: 1 1 100% !important; min-width: 0 !important; }',
      // No chat open: hide the whole conversation pane, show the desk's warm dark.
      'html.wab-threadcrop.wab-nochat #main { display: none !important; }',
      // WhatsApp's welcome/intro junk (census-verified testid, 2026-11-21).
      'html.wab-threadcrop [data-testid="intro-panel"] { display: none !important; }',
      'html.wab-threadcrop body { background: #191b10 !important; }'
    ].join('\n'));
  }

  function classes(on, cls) {
    try {
      if (on) D.documentElement.classList.add(cls);
      else D.documentElement.classList.remove(cls);
    } catch (e) { /* never throw */ }
  }

  W.__wabSetDeclutter = function (on) {
    try { W.__wabDeclutter = !!on; installDeclutter(); classes(!!on, 'wab-declutter'); } catch (e) {}
  };
  W.__wabSetThreadCrop = function (on) {
    try { W.__wabThreadCrop = !!on; installCrop(); classes(!!on, 'wab-threadcrop'); } catch (e) {}
  };

  function hasOpenChat() {
    try {
      if (D.querySelector('[data-testid="intro-panel"]')) return false;   // welcome card = nothing open
      return !!(D.querySelector('#main footer') || D.querySelector('footer') ||
        D.querySelector('[data-testid="conversation-panel-messages"]') ||
        D.querySelector('[data-testid^="conv-msg-"]'));
    } catch (e) { return true; }  // assume open on doubt: never hide a live thread
  }

  var rafPending = false;
  function reassert() {
    try {
      installDeclutter();
      installCrop();
      // Crop flag drives the no-chat dimming only when the crop is on.
      if (D.documentElement.classList.contains('wab-threadcrop')) {
        classes(!hasOpenChat(), 'wab-nochat');
      } else {
        classes(false, 'wab-nochat');
      }
    } catch (e) { /* never throw */ }
  }
  function scheduleReassert() {
    if (rafPending) return;
    rafPending = true;
    W.requestAnimationFrame(function () { rafPending = false; reassert(); });
  }

  // Upgrade path: a page that already ran an older build of this file gets the
  // new surfaces without double-installing the observers.
  if (W.__wabDeclutterInstalled) {
    try { installCrop(); } catch (eOld) {}
    return;
  }
  W.__wabDeclutterInstalled = true;

  installDeclutter();
  installCrop();
  classes(true, 'wab-declutter');   // declutter is on by default; crop waits for its setter

  try {
    var mo = new MutationObserver(scheduleReassert);
    mo.observe(D.body || D.documentElement, { childList: true, subtree: true });
  } catch (e) { /* older page */ }
  try { W.setInterval(reassert, 1500); } catch (e2) { /* never throw */ }
})();
