// Chat Bridge — IPC wiring per docs/CONTRACT.md. All channels invoke/handle,
// plus three pushed events. AI calls go through src/ai/providers.js.
const { ipcMain } = require('electron');
const store = require('./store');
const sessions = require('./sessions');
const portal = require('./portal/portal-server');
const tunnel = require('./portal/remote-tunnel');
const { callAI, DEFAULT_MODELS } = require('../ai/providers');
const { buildPrompt } = require('../ai/commands');
const { normalizeTitle } = require('../shared/normalize');

let push = () => {};   // set by main.js: (channel, payload) -> webContents.send

function setPush(fn) { push = fn; }

// Mock-mode read for the consent auto-lock. The app entry derives the mock
// flag from process.argv and hands it to the sessions module; argv is that
// same source, readable here without any new export.
function appInMockMode() {
  return process.argv.slice(2).includes('--mock');
}

// Consent-first default: a REAL account starts locked the moment it is added
// or relinked (mode 'allow', empty allow list), so the desk shows nothing
// until the account's owner picks contacts through the consent portal. An
// existing privacy config is never overwritten: a relink keeps the owner's
// consent decisions. Mock runs are exempt so phone-free smoke stays on its
// fixture expectations. The session's own load-time privacy inject picks
// this config up; no extra inject call is needed here.
function lockAccountOnLink(accountId) {
  if (!accountId) return;
  if (appInMockMode()) return;
  if (store.hasPrivacy(accountId)) return;
  store.setPrivacy(accountId, { mode: 'allow', allow: [], deny: [] });
}

function scrapeSrc() {
  return `(function(){try{return window.__wabScrapeChat?window.__wabScrapeChat():{ok:false,error:'chat reader not ready yet'};}catch(e){return {ok:false,error:'chat reader failed'};}})()`;
}
function listChatsSrc() {
  return `(function(){try{return window.__wabListChats?window.__wabListChats():[];}catch(e){return [];}})()`;
}
function insertSrc(textJson) {
  return `(function(){try{return window.__wabInsertText?window.__wabInsertText(${textJson}):{ok:false,error:'chat bridge not ready yet'};}catch(e){return {ok:false,error:'chat bridge failed'};}})()`;
}

function registerAll() {
  // ---------- accounts ----------
  ipcMain.handle('accounts:list', () => store.listAccounts());

  ipcMain.handle('accounts:add', (_e, { name, color, platform, userId }) => {
    const clean = String(name || '').trim().slice(0, 40) || 'Account';
    const plat = platform === 'telegram' ? 'telegram' : 'whatsapp';   // v14 T3: whitelist, WhatsApp default
    const id = sessions.makeId(plat);   // ids carry their platform (wa_ / tg_)
    const owner = (userId && store.getUser(userId)) || store.getUsers()[0];   // v14 T3: default owner = first user (the owner)
    const account = {
      id,
      userId: owner ? owner.id : '',
      platform: plat,
      name: clean,
      color: /^#[0-9a-fA-F]{6}$/.test(String(color)) ? color : '#426CA8',
      createdAt: new Date().toISOString(),
      partition: sessions.partitionFor({ id, platform: plat }),   // v14 T3: persist:wa-<tail> / persist:tg-<tail>
      status: 'linking'
    };
    store.upsertAccount(account);
    lockAccountOnLink(id);   // consent-first: nothing is visible until the owner picks
    const { createQrWindow } = require('./windows');
    const qr = createQrWindow(account);
    const rec = sessions.createSession(account, qr);
    // The QR window hosts the view until the partner scans; view then moves to the shell.
    qr.on('ready-to-show', () => {
      try { qr.contentView.addChildView(rec.view); rec.view.setBounds({ x: 0, y: 0, width: 520, height: 740 }); } catch (e) { /* window race */ }
    });
    qr.on('close', () => {
      // Closing a window destroys its views. Detach first so the session survives
      // an operator closing this window mid-link (it will attach when it links).
      try { qr.contentView.removeChildView(rec.view); } catch (e) { /* already detached */ }
    });
    push('accounts:onStatus', { accountId: id, status: 'linking' });
    push('accounts:list-changed', {});
    return account;
  });

  ipcMain.handle('accounts:update', (_e, { id, patch }) => {
    const acc = store.getAccount(id);
    if (!acc) return null;
    const updated = Object.assign({}, acc, patch || {});
    if (!/^#[0-9a-fA-F]{6}$/.test(String(updated.color))) updated.color = '#426CA8';
    updated.name = String(updated.name || acc.name).trim().slice(0, 40) || acc.name;
    store.upsertAccount(updated);
    push('accounts:list-changed', {});
    return updated;
  });

  ipcMain.handle('accounts:remove', (_e, { id }) => {
    sessions.removeSession(id);
    store.removeAccount(id);
    push('accounts:list-changed', {});
    sessions.relayout();
    return { ok: true };
  });

  // Re-link: open a QR window on the account's EXISTING partition. If the stored
  // session is still valid, chats appear immediately (no scan needed); if WhatsApp
  // dropped it, the QR shows and the partner scans again. Nothing is ever consumed.
  ipcMain.handle('accounts:relink', (_e, { id }) => {
    const acc = store.getAccount(id);
    if (!acc) return { ok: false };
    sessions.removeSession(id);   // drops the old/dead view; partition data untouched
    const linking = Object.assign({}, acc, { status: 'linking' });
    store.upsertAccount(linking);
    lockAccountOnLink(id);   // locks ONLY accounts that never had a privacy config
    const { createQrWindow } = require('./windows');
    const qr = createQrWindow(linking);
    const rec = sessions.createSession(linking, qr);
    qr.on('ready-to-show', () => {
      try { qr.contentView.addChildView(rec.view); rec.view.setBounds({ x: 0, y: 0, width: 520, height: 740 }); } catch (e) { /* window race */ }
    });
    qr.on('close', () => {
      try { qr.contentView.removeChildView(rec.view); } catch (e) { /* already detached */ }
    });
    push('accounts:onStatus', { accountId: id, status: 'linking' });
    push('accounts:list-changed', {});
    return { ok: true };
  });

  // ---------- users (v14 T3) ----------
  ipcMain.handle('users:list', () => store.getUsers());

  ipcMain.handle('users:add', (_e, { name }) => store.addUser(name));

  // ---------- privacy ----------
  ipcMain.handle('privacy:get', (_e, { accountId }) => store.getPrivacy(accountId));

  ipcMain.handle('privacy:set', (_e, { accountId, config }) => {
    const clean = store.setPrivacy(accountId, config || {});
    sessions.injectPrivacy(accountId);   // live re-apply, no restart
    return clean;
  });

  ipcMain.handle('privacy:listChats', async (_e, { accountId }) => {
    const res = await sessions.runInPage(accountId, listChatsSrc);
    return Array.isArray(res) ? res : [];
  });

  // ---------- consent portal ----------
  // The partner's phone page. portal-server owns the HTTP side; these
  // channels only manage invite links (status, create, revoke).
  ipcMain.handle('portal:status', () => portal.status());

  ipcMain.handle('portal:createInvite', (_e, { accountId }) => {
    const acc = store.getAccount(accountId);
    if (!acc) return { ok: false, error: 'account not found' };
    const invite = store.createInvite(accountId);   // replaces any old link
    portal.logLanUrls();                            // print the fresh link(s) to the console
    return { ok: true, invite, urls: portal.inviteUrls(invite.token) };
  });

  ipcMain.handle('portal:revokeInvite', (_e, { accountId }) => {
    store.revokeInvite(accountId);                  // the link dies instantly (404)
    return portal.status();
  });

  // Remote access: the cloudflared quick tunnel that puts the portal on a
  // public https URL for partners outside the LAN. Started strictly on
  // demand from Settings, never at boot; one tunnel for the whole desk.
  ipcMain.handle('portal:remoteStart', async () => {
    try {
      const res = await tunnel.start();
      return { ok: true, url: res.url };
    } catch (e) {
      const msg = (e && e.message) ? e.message : 'the remote tunnel could not start';
      console.error('[portal] remote tunnel failed to start: ' + msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('portal:remoteStop', () => {
    try {
      tunnel.stop();
      return { ok: true };
    } catch (e) {
      const msg = (e && e.message) ? e.message : 'the remote tunnel could not stop';
      console.error('[portal] remote tunnel failed to stop: ' + msg);
      return { ok: false, error: msg };
    }
  });

  // ---------- ai ----------
  ipcMain.handle('ai:config:get', () => {
    const cfg = store.getAIConfig();
    return Object.assign({}, cfg, { model: cfg.model || DEFAULT_MODELS[cfg.provider] || '' });
  });

  ipcMain.handle('ai:config:set', (_e, { config }) => store.setAIConfig(config));

  ipcMain.handle('ai:test', async () => {
    const cfg = store.getAIConfig();
    if (!cfg.apiKey) return { ok: false, model: cfg.model, error: 'no API key set, paste one in Settings' };
    const res = await callAI(cfg, { system: 'You are a connection test. Reply with exactly: OK', user: 'test' });
    return { ok: res.ok, model: cfg.model, error: res.error };
  });

  ipcMain.handle('ai:run', async (_e, { accountId, command, instruction, chatId }) => {
    const cfg = store.getAIConfig();
    if (!cfg.apiKey) return { ok: false, error: 'no API key set, open Settings' };

    // v12.7: the sidekick reads the LIVE desk, not a stale DOM scrape. Prefer the
    // given chatId, else resolve by the account's people list, else old scrape.
    let contactName = 'this contact';
    let messages = [];
    let got = false;
    try {
      if (accountId) {
        let cid = chatId;
        let title = '';
        const people = await sessions.engPeople();
        const hit = people.find(p => p.accountId === accountId && (cid ? p.chatId === cid : false)) ||
                    (instruction ? null : null);
        if (!cid) {
          // fall back: the ACTIVE pane's person for this account
          const st = sessions.paneStateInfo ? sessions.paneStateInfo() : null;
          const active = st && st.find(p => p.accountId === accountId && p.chatId);
          if (active) { cid = active.chatId; title = active.title || ''; }
        } else if (hit) { title = hit.title || ''; }
        if (!title) { const h2 = people.find(p => p.accountId === accountId && p.chatId === cid); if (h2) title = h2.title || ''; }
        if (cid) {
          const msgs = await sessions.engMessages(accountId, cid, cfg.maxContextMessages || 40);
          if (Array.isArray(msgs) && msgs.length) {
            messages = msgs.slice(-(cfg.maxContextMessages || 40));
            contactName = title || 'this contact';
            got = true;
          } else if (msgs && msgs.ok === false && msgs.error) {
            // Refused read (blindfold or explicit failure): never fall through
            // to a live DOM scrape of whatever chat happens to be open.
            return { ok: false, error: msgs.error };
          }
        }
      }
    } catch (eCtx) { /* fall through to scrape */ }
    if (!got) {
      const scrape = await sessions.runInPage(accountId, scrapeSrc());
      if (scrape && scrape.ok) {
        const cap2 = Math.max(4, cfg.maxContextMessages || 40);
        messages = (scrape.messages || []).slice(-cap2);
        contactName = scrape.contactName || contactName;
      } else if (!messages.length) {
        return { ok: false, error: (scrape && scrape.error) || 'could not read this chat' };
      }
    }

    // The brain: persistent tone + per-contact notes ride along with the instruction.
    const brain = store.getBrain();
    const note = contactName !== 'this contact' ? (brain.notes && brain.notes[contactName]) : '';
    const instrParts = [];
    if (brain.tone) instrParts.push('Tone: ' + brain.tone);
    if (note) instrParts.push('What to remember about ' + contactName + ': ' + note);
    if (instruction) instrParts.push(String(instruction).slice(0, 2000));
    const finalInstruction = instrParts.join('\n');

    const prompt = buildPrompt(command, {
      contactName,
      messages,
      instruction: finalInstruction || undefined
    });
    if (!prompt) return { ok: false, error: 'unknown command: ' + command };

    const res = await callAI(cfg, prompt);
    if (res.ok) store.bumpUsage();
    return res;
  });

  ipcMain.handle('ai:insert', async (_e, { accountId, text }) => {
    const clean = String(text == null ? '' : text);
    if (!clean.trim()) return { ok: false, error: 'nothing to insert' };
    return sessions.runInPage(accountId, insertSrc(JSON.stringify(clean)));
  });

  // ---------- app ----------
  ipcMain.handle('app:setLayout', (_e, { mode }) => {
    sessions.setLayout(mode);
    return { ok: true };
  });

  // ---------- v2 Conversation Mode ----------
  // v3 shim: the v2 people rail reads through here; serve it from the ENGINE
  // (authoritative, blindfolded) so the rail lives natively and E's takeover stays dormant.
  ipcMain.handle('chats:listPeople', async () => sessions.engPeople());

  ipcMain.handle('chats:searchAll', async (_e, { query }) => {
    const q = normalizeTitle(String(query || ''));
    if (!q) return [];
    const people = await sessions.collectPeople();
    return people
      .filter(p => normalizeTitle(p.title).indexOf(q) !== -1)
      .slice(0, 20);
  });

  ipcMain.handle('chats:open', (_e, { accountId, title }) => sessions.openChat(accountId, title));

  ipcMain.handle('app:setActivePane', (_e, { slot }) => {
    sessions.setActivePane(slot);
    return { ok: true };
  });

  ipcMain.handle('app:getPrefs', () => store.getPrefs());

  ipcMain.handle('app:setPrefs', (_e, { threadCrop }) => {
    const prefs = store.setPrefs({ threadCrop: !!threadCrop });
    // Apply or lift the crop live on every session.
    for (const acc of store.listAccounts()) {
      const rec = sessions.getSession(acc.id);
      if (!rec || !rec.view || rec.view.webContents.isDestroyed()) continue;
      rec.view.webContents.executeJavaScript(
        `(function(){try{if(window.__wabSetThreadCrop){window.__wabSetThreadCrop(${prefs.threadCrop});}}catch(e){}return true;})()`, false
      ).catch(() => {});
    }
    return prefs;
  });

  // Overlays (settings, palette, modals) live in the shell's renderer, which sits
  // UNDER Electron views. When one opens, the desk lifts the views away.
  ipcMain.handle('app:setOverlayVisible', (_e, { on }) => {
    sessions.setOverlayVisible(!!on);
    return { ok: true };
  });

  // ---------- v3 Engine Rooms ----------
  ipcMain.handle('eng:people', async () => sessions.engPeople());

  ipcMain.handle('eng:messages', (_e, { accountId, chatId, limit }) =>
    sessions.engMessages(accountId, chatId, limit));

  ipcMain.handle('eng:send', (_e, { accountId, chatId, text, title }) =>
    sessions.engSend(accountId, chatId, text, title));   // fires ONLY from the operator's Send click

  // v12.4 speed: pre-open the conversation when it is VIEWED so Send is instant.
  ipcMain.handle('eng:preopen', (_e, { accountId, chatId }) =>
    sessions.engPreOpen(accountId, chatId));

  // v13: endless history (scroll up = load older, WhatsApp-phone law).
  ipcMain.handle('eng:history', (_e, { accountId, chatId, pages }) =>
    sessions.engHistory(accountId, chatId, pages));
  ipcMain.handle('eng:hasmore', (_e, { accountId, chatId }) =>
    sessions.engHasMoreHistory(accountId, chatId));

  // v12.7 media: fetch a message's media as a data URL (images, stickers, gifs).
  ipcMain.handle('eng:media', async (_e, { accountId, chatId, msgId }) => {
    // Blindfold door: media for a restricted chat is refused before the engine call.
    if (await sessions.chatRestricted(accountId, chatId, '')) {
      return { ok: false, error: 'blindfold: this chat is restricted by the account owner' };
    }
    return sessions.engCall(accountId,
      `(function(){try{return window.__wabEng.getMedia?window.__wabEng.getMedia(${JSON.stringify(String(chatId))},${JSON.stringify(String(msgId))}):{ok:false,error:'media not supported yet'};}catch(e){return {ok:false,error:'media call failed'};}})()`);
  });

  ipcMain.handle('eng:health', async () => sessions.engHealth());

  ipcMain.handle('app:getPanePrefs', () => store.getPanePrefs());

  ipcMain.handle('app:setPanePrefs', (_e, { slot, prefs }) => store.setPanePrefs(slot, prefs));

  // v12: the always-on debugger feed (step names + counts only).
  ipcMain.handle('debug:dump', () => sessions.debugDump());

  // v12.7: the operator's activity ledger + the sidekick's brain.
  ipcMain.handle('sent:stats', () => store.sentStats());
  ipcMain.handle('brain:get', () => store.getBrain());
  ipcMain.handle('brain:set', (_e, { brain }) => store.setBrain(brain));

  // S4 seam: bridge renderer pane-reply events into the debug ring.
  ipcMain.handle('debug:push', (_e, { kind, accountId, text }) => {
    sessions.debugEvent(String(kind || 'info').slice(0, 40), accountId, text);
    return { ok: true };
  });

  // v3 (E's proposal, adopted): the renderer reports the pane's person; the spine
  // becomes the authority for pane state and pushes panes:onState to everyone.
  ipcMain.handle('app:setPanePerson', (_e, { slot, accountId, chatId, title }) => {
    if (typeof slot !== 'number') return { ok: false };
    sessions.setPanePerson(slot, accountId, chatId, title);
    return { ok: true };
  });
}

module.exports = { registerAll, setPush };
