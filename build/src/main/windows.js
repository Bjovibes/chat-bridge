// Chat Bridge v3 — windows: the shell (BaseWindow-style view tree) + QR link windows.
// Topology per research (notes\WAWEB-SEND-HIDDEN-RESEARCH-2026-11-21.md):
// engines at FULL bounds UNDER the UI view; UI re-added on top whenever an engine
// joins. backgroundThrottling:false everywhere, set at creation, never toggled.
const { BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const sessions = require('./sessions');

function createShell() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: '#12140b',
    show: false,
    title: 'Chat Bridge',
    webPreferences: { backgroundThrottling: false }
  });
  win.removeMenu();

  // The UI view: everything the operator sees. Engines join UNDER it, full size.
  const uiView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  uiView.setBackgroundColor('#12140b');
  win.contentView.addChildView(uiView);

  const fit = () => {
    const [w, h] = win.getContentSize();
    uiView.setBounds({ x: 0, y: 0, width: w, height: h });
    sessions.fitEngines(w, h);
  };
  win.on('resize', fit);

  uiView.webContents.on('did-finish-load', () => {
    try { if (!win.isMaximized()) win.maximize(); } catch (eM) { /* fine */ }
    if (!win.isVisible()) win.show();
    fit();
  });
  // Safety: never leave the window hidden if the UI view is slow to load.
  setTimeout(() => { try { if (!win.isDestroyed() && !win.isVisible()) win.show(); } catch (e) { /* closing */ } }, 6000);

  uiView.webContents.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));

  sessions.setShellWindow(win);
  sessions.setUiView(uiView);
  win.uiView = uiView;   // the spine and diagnostics talk to the UI view, never the window's own contents
  return win;
}

// The QR window hosts an engine DURING linking via its own view tree.
// v14 T3 (seam): the title and phone instructions carry the platform.
function createQrWindow(account) {
  const platformName = (account && account.platform === 'telegram') ? 'Telegram' : 'WhatsApp';
  const qr = new BrowserWindow({
    width: 540,
    height: 800,
    minWidth: 500,
    minHeight: 660,
    show: false,
    backgroundColor: '#12140b',
    title: 'Link ' + account.name + ' : scan the ' + platformName + ' QR',
    webPreferences: { backgroundThrottling: false }
  });
  qr.removeMenu();
  qr.once('ready-to-show', () => {
    qr.show();
    qr.focus();
    qr.setAlwaysOnTop(true, 'screen-saver');
  });
  qr.loadURL('data:text/html,' + encodeURIComponent([
    '<!doctype html><html><head><meta charset="utf-8"><title>Link ' + account.name + '</title>',
    '<style>',
    'body{margin:0;font-family:Inter,Segoe UI,system-ui,sans-serif;height:100vh;',
    'background:radial-gradient(900px 600px at 70% -10%, rgba(201,184,74,0.22), transparent 60%),',
    'radial-gradient(800px 600px at -10% 110%, rgba(90,84,32,0.45), transparent 55%),',
    'linear-gradient(160deg,#171b0c,#0c0e08);',
    'display:flex;align-items:center;justify-content:center;color:#fff}',
    '.card{max-width:360px;padding:28px 30px;border-radius:26px;text-align:center;',
    'background:rgba(46,46,30,0.4);backdrop-filter:blur(30px) saturate(1.5);',
    'border:1px solid rgba(255,255,255,0.28);',
    'box-shadow:0 18px 50px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.22)}',
    'h1{font-size:19px;margin:0 0 6px;font-weight:600}',
    'p{font-size:13.5px;line-height:1.55;color:rgba(255,255,255,0.62);margin:0 0 4px}',
    '.note{font-size:12px;color:rgba(255,255,255,0.42);margin-top:14px}',
    '</style></head><body>',
    '<div class="card">',
    '<h1>Linking ' + account.name + '</h1>',
    '<p>' + platformName + ' is opening. The partner scans the QR code on their phone:</p>',
    '<p>' + platformName + ((account && account.platform === 'telegram')
      ? ', Settings, Devices, Link Desktop Device.'
      : ', Settings, Linked devices, Link a device.') + '</p>',
    // Phone-code path for remote partners (WhatsApp only): they cannot scan
    // this QR from another country, so they read out a code instead.
    ((account && account.platform === 'telegram')
      ? ''
      : '<p class="note">Remote partner: on their phone, WhatsApp, Settings, Linked devices, Link a device, Link with phone number instead. They read you the code, you type it here.</p>'),
    '<p class="note">Only link an account whose owner explicitly authorized you. They can unlink anytime from their phone.</p>',
    '</div></body></html>'
  ].join('')));
  return qr;
}

module.exports = { createShell, createQrWindow };
