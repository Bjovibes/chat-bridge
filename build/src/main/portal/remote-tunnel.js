// Chat Bridge remote tunnel for the consent portal. Wraps the local
// build/tools/cloudflared.exe (a Cloudflare quick tunnel: free, no account)
// so a partner outside the local network can open an invite link: it prints
// one public https URL and forwards it to the portal port. One tunnel at a
// time, started strictly on demand from Settings, never at boot. Fail loud
// in the console ([tunnel] prefix), never crash the desk.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TARGET_URL = 'http://localhost:47120';   // the consent portal port (portal-server PORT)
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com(?![\w.-])/i;
const START_TIMEOUT_MS = 30000;                // no URL within 30s = loud failure
const TAIL_LINES = 40;                         // output lines kept for error tails

const exePath = path.join(__dirname, '..', '..', '..', 'tools', 'cloudflared.exe');

let proc = null;          // the live child process, null when idle
let startPromise = null;  // the in-flight (or resolved) start: one tunnel at a time
let running = false;      // true only once the public URL has been seen
let url = null;           // the public https URL cloudflared printed
let manualStop = false;   // a stop was asked, so the next exit is not a failure
let quitHooked = false;   // the will-quit hook registers exactly once

function log(msg) { console.log('[tunnel] ' + msg); }
function fail(msg) { console.error('[tunnel] ' + msg); }

// A rolling tail of cloudflared output so every failure shows what it said.
function newTail() {
  const lines = [];
  return {
    push: (line) => {
      const clean = String(line).trim();
      if (!clean) return;
      lines.push(clean);
      if (lines.length > TAIL_LINES) lines.shift();
    },
    text: () => lines.join('\n')
  };
}

// Kill the process tree. On Windows taskkill /T reaches children a plain
// kill leaves behind; elsewhere proc.kill is enough.
function killProc(p, why) {
  if (!p) return;
  const pid = p.pid;
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', (e) => {
          fail('taskkill failed (' + why + '): ' + (e && e.message));
          try { p.kill(); } catch (e2) { /* already gone */ }
        });
      return;
    } catch (e) { /* fall through to a plain kill */ }
  }
  try { p.kill(); } catch (e) { fail('kill failed (' + why + '): ' + (e && e.message)); }
}

function reset() {
  proc = null;
  startPromise = null;
  running = false;
  url = null;
}

// Only the CURRENT child may reset the shared state: a stop followed by a
// quick restart must not let the old exit event wipe the new tunnel.
function resetIfCurrent(child) {
  if (proc === child) reset();
}

// Auto-stop on app quit. The electron require is lazy so this module stays
// loadable outside the app (node --check, plain node); the hook is asked
// for only when a tunnel actually starts.
function wireQuitHook() {
  if (quitHooked) return;
  quitHooked = true;
  try {
    const { app } = require('electron');
    if (app && typeof app.on === 'function') {
      app.on('will-quit', () => {
        try {
          if (proc) {
            log('app is quitting, stopping the tunnel');
            killProc(proc, 'app quit');
          }
        } catch (e) { /* best effort at shutdown */ }
      });
    }
  } catch (e) { /* not inside electron: nothing to hook */ }
}

function start() {
  // One tunnel at a time: a running or in-flight start answers itself.
  if (startPromise) return startPromise;
  if (!fs.existsSync(exePath)) {
    const err = new Error('cloudflared.exe not found in build/tools, see the README');
    fail(err.message);
    return Promise.reject(err);
  }
  manualStop = false;
  wireQuitHook();
  startPromise = new Promise((resolve, reject) => {
    const tail = newTail();
    let settled = false;
    let timer = null;
    log('starting a cloudflared quick tunnel to ' + TARGET_URL);
    let child = null;
    try {
      child = spawn(exePath, ['tunnel', '--url', TARGET_URL, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true
      });
      proc = child;
    } catch (e) {
      reset();
      fail('could not spawn cloudflared: ' + (e && e.message));
      reject(e);
      return;
    }

    // Belt and braces: cloudflared usually prints the URL box on stderr, but
    // BOTH streams are watched, line by line.
    const onLine = (line) => {
      tail.push(line);
      const m = URL_RE.exec(line);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        running = true;
        url = m[0];
        log('public URL: ' + url);
        resolve({ url });
      }
    };

    // No public URL in time: kill it and fail loud with the output tail.
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProc(child, 'start timeout');
      resetIfCurrent(child);
      const msg = 'no public URL appeared within ' + Math.round(START_TIMEOUT_MS / 1000) +
        's, cloudflared output tail:\n' + tail.text();
      fail(msg);
      reject(new Error(msg));
    }, START_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { chunk.split(/\r?\n/).forEach(onLine); });
    child.stderr.on('data', (chunk) => { chunk.split(/\r?\n/).forEach(onLine); });

    child.on('error', (e) => {
      if (settled) {
        resetIfCurrent(child);
        fail('tunnel died mid-session: ' + (e && e.message) +
          '. The public link is dead. Restart remote access from Settings if you still need it.');
        return;
      }
      settled = true;
      clearTimeout(timer);
      resetIfCurrent(child);
      fail('cloudflared failed to launch: ' + (e && e.message));
      reject(e);
    });

    child.on('exit', (code, signal) => {
      const byUs = manualStop;
      manualStop = false;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resetIfCurrent(child);
        const msg = byUs
          ? 'the tunnel start was cancelled before the public URL appeared'
          : 'cloudflared exited before printing a public URL (code ' + code + '), output tail:\n' + tail.text();
        fail(msg);
        reject(new Error(msg));
        return;
      }
      resetIfCurrent(child);
      if (byUs) log('tunnel stopped (exit code ' + code + ')');
      else fail('tunnel died mid-session (code ' + code + ', signal ' + signal +
        '). The public link is dead. Restart remote access from Settings if you still need it.');
    });
  });
  return startPromise;
}

function stop() {
  const p = proc;
  if (!p) {
    log('stop: no tunnel is running');
    return { ok: true };
  }
  manualStop = true;
  reset();
  log('stopping the tunnel');
  killProc(p, 'stop');
  return { ok: true };
}

// running is true only between the URL appearing and the process leaving,
// so a dead tunnel never keeps advertising a public link.
function status() {
  return { running: running, url: running ? url : null };
}

module.exports = { start, stop, status };
