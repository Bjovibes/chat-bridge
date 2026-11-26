// Chat Bridge consent portal server. Plain node http, zero dependencies.
// The partner (account owner) opens http://<this PC>:47120/<token> on their
// phone, sees their own contact list as names + toggles, and picks what the
// operator may see. Writes flow through the SAME privacy pipeline as the
// operator's Settings picker: store.setPrivacy + sessions.injectPrivacy.
// Never serves message content: the only chat data exposed is titles.
// Fail loud in the console ([portal] prefix), never crash the desk.

const http = require('http');
const os = require('os');
const store = require('../store');
const sessions = require('../sessions');
const tunnel = require('./remote-tunnel');   // read-only here: the tunnel itself is started on demand via ipc
const { PORTAL_HTML } = require('./portal-page');

const PORT = 47120;                 // documented constant: the consent portal port
const HOST = '0.0.0.0';             // reachable from the LAN so a phone can open it
const MAX_BODY = 256 * 1024;        // bigger POST bodies are refused, not read
const MAX_CHATS = 500;              // cap on the contact list served to the page
const MAX_TITLES = 500;             // cap on one allow-list write
const MAX_TITLE_LEN = 200;          // one title can never grow unbounded

let server = null;
let running = false;

// The same reader the operator's privacy picker uses (ipc.js
// privacy:listChats): the UNFILTERED chat list for the account, titles only.
const LIST_CHATS_SRC =
  '(function(){try{return window.__wabListChats?window.__wabListChats():[];}catch(e){return [];}})()';

/* ---------- helpers ---------- */

function send(res, status, type, body) {
  try {
    res.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(body);
  } catch (e) {
    console.error('[portal] response failed:', e && e.message);
    try { res.destroy(); } catch (e2) { /* already gone */ }
  }
}

function sendText(res, status, text) { send(res, status, 'text/plain; charset=utf-8', text); }

function sendJson(res, status, obj) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj)); }

function sendPage(res, status, html) {
  try {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"
    });
    res.end(html);
  } catch (e) {
    console.error('[portal] page response failed:', e && e.message);
    try { res.destroy(); } catch (e2) { /* already gone */ }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;   // keep draining so the socket stays answerable
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function parseJson(text) {
  if (!text || !text.trim()) return {};
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { return null; }
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
}

// A token is valid only if it exists AND its account still exists. A revoked
// or deleted account invite simply stops resolving: the link turns 404.
function accountForToken(token) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const invite = store.findInviteByToken(token);
  if (!invite) return null;
  return store.getAccount(invite.accountId) || null;
}

// Clean a partner-submitted allow list: strings only, capped, deduped.
// A title that does not match any real chat is inert (the blindfold matches
// by title), so nothing can be escalated through this shape.
function cleanTitles(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const clean = t.slice(0, MAX_TITLE_LEN);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_TITLES) break;
  }
  return out;
}

// The consent write: EXACTLY the path ipc.js privacy:set uses. Store first
// (the file is the authority), then the live re-inject so the operator's
// views update without a restart.
function applyAllow(accountId, titles) {
  store.setPrivacy(accountId, { mode: 'allow', allow: titles, deny: [] });
  let live = true;
  try {
    sessions.injectPrivacy(accountId);
  } catch (e) {
    live = false;
    console.error('[portal] live re-inject failed for account ' + accountId + ':', e && e.message);
  }
  return { ok: true, live, allowed: titles.length };
}

function ipv4Addresses() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces() || {};
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (addr && addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
      }
    }
  } catch (e) {
    console.error('[portal] could not read network interfaces:', e && e.message);
  }
  return out;
}

// Invite URLs for a token: every LAN URL, plus the public tunnel URL when
// the remote tunnel is running. public stays null while the tunnel is off,
// so nothing ever shows a public link that does not work.
function inviteUrls(token) {
  const t = tunnel.status();
  return {
    lan: ipv4Addresses().map((ip) => 'http://' + ip + ':' + PORT + '/' + token),
    public: (t.running && t.url) ? (t.url + '/' + token) : null
  };
}

// Boot + create-time affordance: print every phone-usable URL to the console.
function logLanUrls() {
  const ips = ipv4Addresses();
  const t = tunnel.status();
  for (const acc of store.listAccounts()) {
    const invite = store.getInvite(acc.id);
    if (!invite) continue;
    if (!ips.length) {
      console.error('[portal] no LAN IPv4 address found, cannot print a LAN link for ' + acc.name);
    } else {
      for (const ip of ips) {
        console.log('[portal] ' + acc.name + ' link: http://' + ip + ':' + PORT + '/' + invite.token);
      }
    }
    if (t.running && t.url) {
      console.log('[portal] ' + acc.name + ' public link: ' + t.url + '/' + invite.token);
    }
  }
}

/* ---------- routes ---------- */

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);   // ['', token] style crumbs removed

  // Health: one plain line, for humans and for curl.
  if (parts.length === 0) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    return sendText(res, 200, 'Chat Bridge consent portal');
  }

  if (parts[0] === 'api') {
    const token = parts[1];
    const action = parts[2];
    const account = accountForToken(token);
    if (!account) {
      console.error('[portal] refused api request with unknown token (' + String(token || '').slice(0, 8) + '...)');
      return sendJson(res, 404, { ok: false, error: 'unknown or revoked link' });
    }

    if (action === 'chats' && parts.length === 3) {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
      let chats = [];
      try {
        const raw = await sessions.runInPage(account.id, LIST_CHATS_SRC);
        chats = Array.isArray(raw) ? raw : [];
      } catch (e) {
        console.error('[portal] chat list read failed for account ' + account.id + ':', e && e.message);
        return sendJson(res, 500, { ok: false, error: 'could not read the contact list, the desk may be offline' });
      }
      const privacy = store.getPrivacy(account.id);
      return sendJson(res, 200, {
        accountName: account.name || 'Account',
        allowed: Array.isArray(privacy.allow) ? privacy.allow.slice(0, MAX_TITLES) : [],
        chats: chats
          .filter((c) => c && typeof c.title === 'string' && c.title)
          .slice(0, MAX_CHATS)
          .map((c) => ({ title: c.title.slice(0, MAX_TITLE_LEN) }))
      });
    }

    if (action === 'allow' && parts.length === 3) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      const body = parseJson(await readBody(req));
      if (!body) return sendJson(res, 400, { ok: false, error: 'the request body must be JSON' });
      const titles = cleanTitles(body.titles);
      if (!titles) return sendJson(res, 400, { ok: false, error: 'titles must be a list of names' });
      console.log('[portal] partner saved allow list for account ' + account.id + ' (' + titles.length + ' chats)');
      return sendJson(res, 200, applyAllow(account.id, titles));
    }

    if (action === 'off' && parts.length === 3) {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
      console.log('[portal] partner turned everything off for account ' + account.id);
      return sendJson(res, 200, applyAllow(account.id, []));
    }

    console.error('[portal] unknown api path: ' + url.pathname);
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  // The page itself: GET /<token>.
  if (parts.length === 1) {
    if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
    const account = accountForToken(parts[0]);
    if (!account) {
      console.error('[portal] refused page request with unknown token (' + parts[0].slice(0, 8) + '...)');
      return sendPage(res, 404, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<body style="background:#12140b;color:#F4F5F2;font-family:sans-serif;padding:32px;max-width:480px;margin:0 auto">'
        + '<h1 style="font-size:20px">This link is not valid anymore</h1>'
        + '<p style="margin-top:10px;color:#C9CEC2">Ask the operator for a new link.</p></body>');
    }
    return sendPage(res, 200, PORTAL_HTML);
  }

  console.error('[portal] unknown path: ' + url.pathname);
  return sendText(res, 404, 'Not found');
}

function handle(req, res) {
  Promise.resolve()
    .then(() => route(req, res))
    .catch((e) => {
      console.error('[portal] request failed (' + req.method + ' ' + req.url + '):', e && e.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'portal error, try again' });
      else { try { res.destroy(); } catch (e2) { /* already gone */ } }
    });
}

/* ---------- lifecycle ---------- */

function start() {
  return new Promise((resolve) => {
    try {
      if (server) { resolve(true); return; }
      server = http.createServer(handle);
      server.on('error', (e) => {
        running = false;
        console.error('[portal] server error on port ' + PORT + ':', e && e.message);
        server = null;
        resolve(false);
      });
      server.listen(PORT, HOST, () => {
        running = true;
        console.log('[portal] consent portal listening on ' + HOST + ':' + PORT);
        logLanUrls();
        resolve(true);
      });
    } catch (e) {
      running = false;
      console.error('[portal] could not start:', e && e.message);
      resolve(false);
    }
  });
}

function status() {
  const invites = {};
  for (const acc of store.listAccounts()) {
    const invite = store.getInvite(acc.id);
    if (!invite) continue;
    invites[acc.id] = {
      token: invite.token,
      createdAt: invite.createdAt,
      urls: inviteUrls(invite.token)
    };
  }
  return { running, port: PORT, remote: tunnel.status(), invites };
}

module.exports = { start, status, inviteUrls, logLanUrls, PORT };
