// Chat Bridge — local JSON store. One file, userData/wa-bridge.json. No cloud, ever.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const FILE = path.join(app.getPath('userData'), 'wa-bridge.json');

const DEFAULTS = () => ({
  accounts: [],            // Account[] per CONTRACT.md
  users: [],               // v14 T3: User[] {id, name}; 'Owner' auto-created on first load
  privacy: {},             // accountId -> PrivacyConfig
  ai: {                    // AIConfig
    provider: 'openai-compatible',
    baseUrl: '',
    apiKey: '',
    model: '',
    maxContextMessages: 40
  },
  prefs: { threadCrop: true },   // v2 Conversation Mode default: WhatsApp cropped to threads
  panePrefs: {},                 // v3: slot -> { zoom, minimized }
  sentLog: [],                   // v12.7: operator's own send history (metadata only)
  brain: { tone: '', notes: {} },// v12.7: the sidekick's persistent memory
  usage: { calls: 0, lastCallAt: null }
});

let state = DEFAULTS();
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = Object.assign(DEFAULTS(), raw);
      state.ai = Object.assign(DEFAULTS().ai, raw.ai || {});
      state.usage = Object.assign(DEFAULTS().usage, raw.usage || {});
    }
  } catch (e) {
    // Corrupt store: start fresh rather than die. Loud in console, app keeps working.
    console.error('[store] could not read store, starting fresh:', e.message);
    state = DEFAULTS();
  }
  migrateUsers();   // v14 T3: users + account owners/platforms; additive, idempotent
  return state;
}

// --- users + platform migration (v14 T3) ---
// the owner's ruling: the desk gains a users layer; every account belongs to a
// user and carries a platform ('whatsapp' | 'telegram'). ADDITIVE ONLY:
// existing accounts keep ids, partitions, privacy, status; they gain a
// userId (the first user) and platform ('whatsapp'). Idempotent: a second
// run changes nothing and saves nothing.
function makeUserId() {
  return 'u_' + Math.random().toString(16).slice(2, 10);
}

function migrateUsers() {
  let dirty = false;
  if (!Array.isArray(state.users)) { state.users = []; dirty = true; }
  if (!state.users.length) {
    state.users.push({ id: makeUserId(), name: 'Owner' });   // single-user default: everyone is the owner
    dirty = true;
  }
  const firstUserId = state.users[0].id;
  for (const a of state.accounts) {
    if (!a) continue;
    if (!a.userId || !state.users.some(u => u.id === a.userId)) { a.userId = firstUserId; dirty = true; }
    if (a.platform !== 'whatsapp' && a.platform !== 'telegram') { a.platform = 'whatsapp'; dirty = true; }
  }
  if (dirty) save();
}

function getUsers() { return state.users.slice(); }

function getUser(userId) {
  return state.users.find(u => u.id === String(userId || '')) || null;
}

function addUser(name) {
  const clean = String(name || '').trim().slice(0, 40) || 'User';
  const u = { id: makeUserId(), name: clean };
  state.users.push(u);
  save();
  return u;
}

function writeNow() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[store] save failed:', e.message);
  }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 400);
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeNow();
}

function get() { return state; }

// --- accounts ---
function listAccounts() { return state.accounts.slice(); }

// E3 sender avatars: a base64 data URL, small by law. The renderer resizes
// to a 128px square JPEG before sending; this gate is the backstop for any
// other writer (IPC patch, hand-edited store file): oversized or non-image
// values are dropped, never stored. Empty string clears the photo.
// Mirror constant: build\src\ui\shell.js AVATAR_MAX_CHARS (keep in sync).
const AVATAR_MAX_CHARS = 40960;
function cleanAvatar(v) {
  if (typeof v !== 'string' || !v) return '';
  if (v.length > AVATAR_MAX_CHARS) return '';
  if (!/^data:image\/[a-z0-9.+-]+;base64,/.test(v)) return '';
  return v;
}

function upsertAccount(account) {
  // v14 T3 write gate: whatever path writes an account (IPC, watchdog,
  // relink, smoke fixtures), the stored record always carries owner +
  // platform. Mutates in place, matching the old contract exactly.
  if (!Array.isArray(state.users) || !state.users.length) migrateUsers();
  if (!account.userId || !state.users.some(u => u.id === account.userId)) account.userId = state.users[0].id;
  if (account.platform !== 'whatsapp' && account.platform !== 'telegram') account.platform = 'whatsapp';
  account.avatar = cleanAvatar(account.avatar);   // E3: cap + data-URL gate
  const i = state.accounts.findIndex(a => a.id === account.id);
  if (i >= 0) state.accounts[i] = account; else state.accounts.push(account);
  save();
  return account;
}

function getAccount(id) { return state.accounts.find(a => a.id === id) || null; }

function removeAccount(id) {
  state.accounts = state.accounts.filter(a => a.id !== id);
  delete state.privacy[id];
  save();
}

// --- privacy ---
function getPrivacy(accountId) {
  return state.privacy[accountId] ||
    { accountId, mode: 'all', allow: [], deny: [], updatedAt: null };
}

function setPrivacy(accountId, config) {
  const clean = {
    accountId,
    mode: ['all', 'allow', 'deny'].includes(config.mode) ? config.mode : 'all',
    allow: Array.isArray(config.allow) ? config.allow.map(String) : [],
    deny: Array.isArray(config.deny) ? config.deny.map(String) : [],
    updatedAt: new Date().toISOString()
  };
  state.privacy[accountId] = clean;
  save();
  return clean;
}

// --- prefs (v2) ---
function getPrefs() {
  return Object.assign({ threadCrop: true }, state.prefs || {});
}

function setPrefs(patch) {
  state.prefs = Object.assign({ threadCrop: true }, state.prefs || {}, patch || {});
  save();
  return Object.assign({}, state.prefs);
}

// --- pane prefs (v3) ---
function getPanePrefs() {
  const out = {};
  for (const s of Object.keys(state.panePrefs || {})) out[s] = Object.assign({ zoom: 1, minimized: false }, state.panePrefs[s]);
  return out;
}

function setPanePrefs(slot, prefs) {
  const key = String(slot);
  const cur = Object.assign({ zoom: 1, minimized: false }, (state.panePrefs || {})[key] || {});
  const next = {
    zoom: Math.min(2.4, Math.max(0.8, Number(prefs && prefs.zoom) || cur.zoom)),
    minimized: !!(prefs && 'minimized' in prefs ? prefs.minimized : cur.minimized),
    // S3 seam: the rail fold persists under slot -1; keep any boolean flags given.
    folded: !!(prefs && 'folded' in prefs ? prefs.folded : cur.folded)
  };
  state.panePrefs = state.panePrefs || {};
  state.panePrefs[key] = next;
  save();
  return next;
}

// --- sent log (v12.7): the operator's own activity. Metadata only: the blindfold
// governs what the operator cannot see; his OWN sends are his record. Cap 2000.
function logSend(entry) {
  state.sentLog.push({
    t: entry.t || Date.now(),
    accountId: String(entry.accountId || ''),
    accountName: String(entry.accountName || ''),
    chatId: String(entry.chatId || ''),
    title: String(entry.title || ''),
    ok: entry.ok !== false
  });
  if (state.sentLog.length > 2000) state.sentLog.splice(0, state.sentLog.length - 2000);
  save();
}
function sentStats() {
  const log = state.sentLog;
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const out = { total: 0, today: 0, week: 0, byAccount: {}, byChat: {}, last: null, failed: 0 };
  for (const e of log) {
    if (!out.last || e.t > out.last) out.last = e.t;
    if (e.ok === false) { out.failed += 1; continue; }   // stats count deliveries, not attempts
    out.total += 1;
    if (now - e.t < day) out.today += 1;
    if (now - e.t < 7 * day) out.week += 1;
    const ak = e.accountName || e.accountId;
    out.byAccount[ak] = (out.byAccount[ak] || 0) + 1;
    if (e.title) {
      const ck = ak + ' · ' + e.title;
      out.byChat[ck] = (out.byChat[ck] || 0) + 1;
    }
  }
  out.byChatTop = Object.keys(out.byChat).map(function (k) { return { chat: k, n: out.byChat[k] }; })
    .sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
  return out;
}

// --- brain (v12.7): the sidekick's persistent memory ---
function getBrain() { return JSON.parse(JSON.stringify(state.brain || { tone: '', notes: {} })); }
function setBrain(patch) {
  const p = patch || {};
  state.brain = {
    tone: String(p.tone != null ? p.tone : (state.brain && state.brain.tone) || '').slice(0, 2000),
    notes: (p.notes && typeof p.notes === 'object') ? p.notes : ((state.brain && state.brain.notes) || {})
  };
  const keys = Object.keys(state.brain.notes);
  if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(function (k) { delete state.brain.notes[k]; });
  save();
  return getBrain();
}

// --- ai ---
function getAIConfig() { return Object.assign({}, state.ai); }

function setAIConfig(patch) {
  const p = patch || {};
  state.ai = {
    provider: p.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
    baseUrl: String(p.baseUrl || '').trim(),
    apiKey: String(p.apiKey || '').trim(),
    model: String(p.model || '').trim(),
    maxContextMessages: Math.min(200, Math.max(4, parseInt(p.maxContextMessages, 10) || 40))
  };
  save();
  return Object.assign({}, state.ai);
}

function bumpUsage() {
  state.usage.calls += 1;
  state.usage.lastCallAt = new Date().toISOString();
  save();
}

module.exports = {
  load, save, flush, get,
  listAccounts, getAccount, upsertAccount, removeAccount,
  getUsers, getUser, addUser,
  getPrivacy, setPrivacy,
  getPrefs, setPrefs, getPanePrefs, setPanePrefs,
  logSend, sentStats, getBrain, setBrain,
  getAIConfig, setAIConfig, bumpUsage
};
