/* Chat Bridge - AI sidekick panel. Classic script, no modules, runs over file://.
   Exposes exactly: window.WABAiPanel = { init, open, close, setContext }.
   Talks to the app only through window.wab (see CONTRACT.md "window.wab"):
   wab.ai (getConfig, test, run, insert) and wab.brain (get, set).
   v12.7 G2: a real setup card with a connection test, a status line at the
   top (model + green dot, tested on open, cached 60 s), a Brain drawer
   (persistent tone + per-contact notes saved through wab.brain), and a
   "reading this conversation live" badge when a chat context is known.
   The fragment in index.html is untouched: every new element is built here.
   No em-dashes, no emoji, no alert() anywhere. */

(function () {
  'use strict';

  var COMMAND_IDS = ['draft-reply', 'summarize', 'reconnect', 'lookup', 'freeform'];
  var TOAST_MS = 1800;
  var BRAIN_SAVE_DEBOUNCE_MS = 800;
  var TEST_CACHE_MS = 60000;
  var BRAIN_MAX_CHARS = 2000;

  var els = {};
  var state = {
    inited: false,
    running: false,
    hasKey: false,
    accountId: null,
    chatId: null,
    chatName: null,
    accountName: null,
    ctxLocked: false,      // an explicit setContext() call owns the context
    usage: 0,
    lastText: '',
    toastTimer: null,
    config: null,          // last AIConfig seen from wab.ai.getConfig()
    test: { at: 0, running: false, ok: null, model: '', error: '' },
    brain: { tone: '', notes: {} },
    brainDirty: false,
    brainTimer: null,
    brainSaveTimer: null,
    drawerOpen: false
  };

  function $(id) {
    return document.getElementById(id);
  }

  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (typeof text === 'string') el.textContent = text;
    return el;
  }

  function errMsg(err, fallback) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof err === 'string' && err) return err;
    return fallback;
  }

  function clipText(text, max) {
    var s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max - 1) + '...' : s;
  }

  function wabAi() {
    return window.wab && window.wab.ai ? window.wab.ai : null;
  }

  function wabBrainOk() {
    return !!(window.wab && window.wab.brain &&
      typeof window.wab.brain.get === 'function' &&
      typeof window.wab.brain.set === 'function');
  }

  /* ---------- tiny view helpers ---------- */

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function hideError() {
    els.error.textContent = '';
    els.error.hidden = true;
  }

  function showHint(message) {
    els.hint.textContent = message;
    els.hint.hidden = false;
  }

  function hideHint() {
    els.hint.textContent = '';
    els.hint.hidden = true;
  }

  function showToast(message) {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    els.toast.textContent = message;
    els.toast.hidden = false;
    state.toastTimer = setTimeout(function () {
      els.toast.hidden = true;
      state.toastTimer = null;
    }, TOAST_MS);
  }

  function hideToast() {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    els.toast.hidden = true;
    els.toast.textContent = '';
  }

  function setBusy(busy) {
    state.running = busy;
    var buttons = els.chipsWrap.querySelectorAll('.ai-panel-chip');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
    els.run.disabled = busy;
    els.copy.disabled = busy;
    els.insert.disabled = busy;
    els.working.hidden = !busy;
  }

  function setActiveChip(commandId) {
    var buttons = els.chipsWrap.querySelectorAll('.ai-panel-chip');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-command') === commandId) {
        buttons[i].classList.add('is-active');
      } else {
        buttons[i].classList.remove('is-active');
      }
    }
  }

  function applyKeyState(hasKey) {
    state.hasKey = hasKey;
    els.nokey.hidden = hasKey;
    els.main.hidden = !hasKey;
    if (!hasKey) {
      hideWorkingAndResult();
      state.test = { at: 0, running: false, ok: null, model: '', error: '' };
    }
  }

  function hideWorkingAndResult() {
    els.working.hidden = true;
    els.result.hidden = true;
  }

  function renderContextLine() {
    var chat = state.chatName || 'this chat';
    var account = state.accountName || 'this account';
    // V13 D8: say where insert lands, only when the renderer route exists.
    var retargeted = false;
    try {
      retargeted = !!(window.WABRender &&
        typeof window.WABRender.insertIntoBar === 'function');
    } catch (e) { /* renderer absent: the honest old line stays */ }
    var line = 'for ' + chat + ' · ' + account +
      (retargeted ? ' (inserts into your compose bar)' : '');
    els.context.textContent = line;
    els.context.title = line;
    if (els.live) {
      els.live.hidden = !(state.accountId && state.chatName);
    }
    renderBrainFields();
  }

  function updateUsage() {
    els.usage.textContent =
      String(state.usage) + (state.usage === 1 ? ' call this session' : ' calls this session');
  }

  function countWords(text) {
    var parts = String(text).trim().split(/\s+/);
    var n = 0;
    for (var i = 0; i < parts.length; i++) if (parts[i]) n++;
    return n;
  }

  function renderResult(text) {
    state.lastText = text;
    els.text.textContent = text;
    els.wordcount.textContent = String(countWords(text)) + ' words';
    els.result.hidden = false;
  }

  /* ---------- key state + connection status line ---------- */

  function modelLabel() {
    var cfg = state.config;
    if (cfg && cfg.model) return cfg.model;
    if (cfg && cfg.provider === 'anthropic') return 'claude-sonnet-4-5';
    if (cfg) return 'gpt-4o-mini';
    return 'model not set';
  }

  function refreshKeyState() {
    return new Promise(function (resolve) {
      var ai = wabAi();
      if (ai && typeof ai.getConfig === 'function') {
        var pending;
        try {
          pending = ai.getConfig();
        } catch (err) {
          state.config = null;
          applyKeyState(false);
          resolve(false);
          return;
        }
        Promise.resolve(pending).then(
          function (cfg) {
            state.config = cfg && typeof cfg === 'object' ? cfg : null;
            var hasKey = !!(cfg && typeof cfg.apiKey === 'string' && cfg.apiKey);
            applyKeyState(hasKey);
            if (hasKey) maybeTestConnection(false);
            resolve(hasKey);
          },
          function () {
            state.config = null;
            applyKeyState(false);
            resolve(false);
          }
        );
        return;
      }
      state.config = null;
      applyKeyState(false);
      resolve(false);
    });
  }

  function runTest() {
    var ai = wabAi();
    if (!ai || typeof ai.test !== 'function') {
      return Promise.resolve({
        ok: false,
        model: modelLabel(),
        error: 'The sidekick cannot reach the app bridge (window.wab is missing).'
      });
    }
    var pending;
    try {
      pending = ai.test();
    } catch (err) {
      return Promise.resolve({ ok: false, model: modelLabel(), error: errMsg(err, 'The connection test failed.') });
    }
    return Promise.resolve(pending).then(
      function (res) {
        var r = res && typeof res === 'object' ? res : {};
        return {
          ok: r.ok === true,
          model: r.model || modelLabel(),
          error: typeof r.error === 'string' ? r.error : ''
        };
      },
      function (err) {
        return { ok: false, model: modelLabel(), error: errMsg(err, 'The connection test failed.') };
      }
    );
  }

  function rememberTest(res) {
    state.test = {
      at: Date.now(),
      running: false,
      ok: res.ok === true,
      model: res.model || modelLabel(),
      error: res.error || ''
    };
  }

  function renderStatusLine() {
    if (!els.statusLabel) return;
    var model = state.test.model || modelLabel();
    var dot = 'ai-panel-dot';
    if (state.test.running) {
      els.statusDot.className = dot + ' is-wait';
      els.statusLabel.textContent = 'checking ' + model + '...';
      els.statusRow.title = 'Testing the AI connection.';
    } else if (state.test.ok === true) {
      els.statusDot.className = dot + ' is-ok';
      els.statusLabel.textContent = model;
      els.statusRow.title = 'Connected. Click to test the AI connection again.';
    } else if (state.test.at > 0) {
      els.statusDot.className = dot + ' is-bad';
      els.statusLabel.textContent = clipText(state.test.error || 'connection failed', 60);
      els.statusRow.title = (state.test.error || 'The connection test failed.') + ' Click to test again.';
    } else {
      els.statusDot.className = dot + ' is-wait';
      els.statusLabel.textContent = model;
      els.statusRow.title = 'Click to test the AI connection.';
    }
  }

  function maybeTestConnection(force) {
    if (!state.hasKey) return;
    if (state.test.running) return;
    var fresh = state.test.at > 0 && Date.now() - state.test.at < TEST_CACHE_MS;
    if (!force && fresh) {
      renderStatusLine();
      return;
    }
    state.test.running = true;
    renderStatusLine();
    runTest().then(function (res) {
      rememberTest(res);
      renderStatusLine();
    });
  }

  /* ---------- setup card (no-key state) ---------- */

  function setSetupTestResult(kind, message) {
    if (!els.setupTestResult) return;
    els.setupTestResult.className = 'ai-panel-nokey-test-result' + (kind ? ' is-' + kind : '');
    els.setupTestResult.textContent = message;
    els.setupTestResult.hidden = !message;
    if (message) {
      els.setupTestResult.title = message;
    } else {
      els.setupTestResult.removeAttribute('title');
    }
  }

  function onSetupTest() {
    if (els.setupTest.disabled) return;
    els.setupTest.disabled = true;
    setSetupTestResult('testing', 'testing the connection...');
    runTest().then(function (res) {
      els.setupTest.disabled = false;
      rememberTest(res);
      if (res.ok === true) {
        setSetupTestResult('ok', 'Connection OK · ' + (res.model || modelLabel()));
        refreshKeyState();
      } else {
        setSetupTestResult('bad', res.error || 'The connection test failed.');
      }
    });
  }

  /* ---------- brain ---------- */

  function normalizeBrain(b) {
    var src = b && typeof b === 'object' ? b : {};
    var notesIn = src.notes && typeof src.notes === 'object' ? src.notes : {};
    var out = { tone: typeof src.tone === 'string' ? src.tone : '', notes: {} };
    for (var k in notesIn) {
      if (Object.prototype.hasOwnProperty.call(notesIn, k)) {
        out.notes[k] = String(notesIn[k] == null ? '' : notesIn[k]);
      }
    }
    return out;
  }

  function noteKey() {
    return state.chatName ? String(state.chatName).trim() : '';
  }

  function loadBrain() {
    if (!wabBrainOk()) return;
    // never clobber local edits that are still waiting for their debounced save
    if (state.brainTimer || state.brainDirty) return;
    try {
      Promise.resolve(window.wab.brain.get()).then(
        function (brain) {
          if (state.brainTimer || state.brainDirty) return;
          state.brain = normalizeBrain(brain);
          renderBrainFields();
        },
        function () { /* brain unreadable: keep the local copy */ }
      );
    } catch (err) { /* bridge broken: the panel still works */ }
  }

  function renderBrainFields() {
    if (!els.toneTa) return;
    if (els.toneTa.value !== state.brain.tone) els.toneTa.value = state.brain.tone;
    var key = noteKey();
    if (key) {
      els.noteSection.hidden = false;
      els.noperson.hidden = true;
      var label = 'What to remember about ' + state.chatName;
      if (els.noteLabel.textContent !== label) els.noteLabel.textContent = label;
      var val = Object.prototype.hasOwnProperty.call(state.brain.notes, key)
        ? state.brain.notes[key]
        : '';
      if (els.noteTa.value !== val) els.noteTa.value = val;
    } else {
      els.noteSection.hidden = true;
      els.noperson.hidden = false;
    }
  }

  function setBrainSaveState(kind, message) {
    if (state.brainSaveTimer) {
      clearTimeout(state.brainSaveTimer);
      state.brainSaveTimer = null;
    }
    if (!els.brainSave) return;
    if (kind === 'saving') {
      els.brainSave.textContent = 'saving...';
      els.brainSave.className = 'ai-panel-brain-save is-saving';
      els.brainSave.hidden = false;
      els.brainSave.removeAttribute('title');
    } else if (kind === 'saved') {
      els.brainSave.textContent = 'saved';
      els.brainSave.className = 'ai-panel-brain-save is-saved';
      els.brainSave.hidden = false;
      els.brainSave.removeAttribute('title');
      state.brainSaveTimer = setTimeout(function () {
        els.brainSave.hidden = true;
        state.brainSaveTimer = null;
      }, 1500);
    } else if (kind === 'failed') {
      els.brainSave.textContent = 'save failed';
      els.brainSave.className = 'ai-panel-brain-save is-failed';
      els.brainSave.hidden = false;
      els.brainSave.title = message || 'could not save the brain';
    } else {
      els.brainSave.hidden = true;
      els.brainSave.className = 'ai-panel-brain-save';
    }
  }

  function scheduleBrainSave() {
    state.brainDirty = true;
    if (state.brainTimer) clearTimeout(state.brainTimer);
    state.brainTimer = setTimeout(brainFlushSave, BRAIN_SAVE_DEBOUNCE_MS);
  }

  function brainFlushSave() {
    if (state.brainTimer) {
      clearTimeout(state.brainTimer);
      state.brainTimer = null;
    }
    if (!state.brainDirty) return;
    if (!wabBrainOk()) {
      setBrainSaveState('failed', 'the app bridge is missing');
      return;
    }
    state.brainDirty = false;
    var snapshot = { tone: state.brain.tone, notes: {} };
    for (var k in state.brain.notes) {
      if (Object.prototype.hasOwnProperty.call(state.brain.notes, k)) {
        snapshot.notes[k] = state.brain.notes[k];
      }
    }
    setBrainSaveState('saving');
    var pending;
    try {
      pending = window.wab.brain.set(snapshot);
    } catch (err) {
      state.brainDirty = true;
      setBrainSaveState('failed', errMsg(err, 'could not save the brain'));
      return;
    }
    Promise.resolve(pending).then(
      function () {
        if (!state.brainDirty) setBrainSaveState('saved');
      },
      function (err) {
        state.brainDirty = true;
        setBrainSaveState('failed', errMsg(err, 'could not save the brain'));
      }
    );
  }

  function openDrawer() {
    state.drawerOpen = true;
    els.brainBtn.classList.add('is-active');
    els.brainBtn.setAttribute('aria-expanded', 'true');
    els.drawer.hidden = false;
    loadBrain();
    renderBrainFields();
  }

  function closeDrawer() {
    state.drawerOpen = false;
    els.brainBtn.classList.remove('is-active');
    els.brainBtn.setAttribute('aria-expanded', 'false');
    els.drawer.hidden = true;
    if (state.brainTimer || state.brainDirty) brainFlushSave();
  }

  function toggleDrawer() {
    if (state.drawerOpen) closeDrawer();
    else openDrawer();
  }

  /* ---------- run a command ---------- */

  function runCommand(commandId) {
    if (state.running) return;

    if (COMMAND_IDS.indexOf(commandId) === -1) {
      showError('Unknown command: ' + commandId);
      return;
    }
    if (!state.hasKey) {
      showError('Add your AI key in Settings to use the sidekick.');
      return;
    }
    if (!state.accountId) {
      showError('No chat is selected. Open a chat first, then use the sidekick.');
      return;
    }

    var instruction = els.instruction.value.trim();

    if (commandId === 'freeform' && !instruction) {
      showHint('Type an instruction first, then run Freeform.');
      els.instruction.focus();
      return;
    }

    var ai = wabAi();
    if (!ai || typeof ai.run !== 'function') {
      showError('The sidekick cannot reach the app bridge (window.wab is missing).');
      return;
    }

    hideError();
    hideHint();
    els.result.hidden = true;
    setActiveChip(commandId);
    setBusy(true);

    var accountId = state.accountId;
    var pending;
    try {
      pending = ai.run(
        accountId,
        commandId,
        instruction ? instruction : undefined,
        state.chatId ? state.chatId : undefined
      );
    } catch (err) {
      setBusy(false);
      showError(errMsg(err, 'The AI call failed.'));
      return;
    }

    Promise.resolve(pending).then(
      function (res) {
        setBusy(false);
        if (!res || res.ok !== true) {
          showError((res && res.error) ? res.error : 'The AI call failed.');
          return;
        }
        var text = typeof res.text === 'string' ? res.text.trim() : '';
        if (!text) {
          showError('The AI returned no text.');
          return;
        }
        state.usage += 1;
        updateUsage();
        renderResult(text);
      },
      function (err) {
        setBusy(false);
        showError(errMsg(err, 'The AI call failed.'));
      }
    );
  }

  /* ---------- copy and insert ---------- */

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function copyResult() {
    if (!state.lastText || state.running) return;
    copyText(state.lastText).then(function (ok) {
      if (ok) {
        showToast('copied');
      } else {
        showHint('Copy failed. Select the text in the result box and copy manually.');
      }
    });
  }

  function insertResult() {
    if (!state.lastText || state.running) return;
    // V13 D8: insert lands in the CENTRAL COMPOSE BAR when the renderer
    // offers it. The old engine-composer path stays as a fallback for desks
    // without the renderer only. Without a panel context, any routed
    // conversation accepts the insert.
    var R = window.WABRender;
    if (R && typeof R.insertIntoBar === 'function') {
      var landed = false;
      try { landed = R.insertIntoBar(state.accountId, state.lastText); }
      catch (err) { landed = false; }
      if (landed === true) {
        showToast('Inserted into your compose bar.');
        return;
      }
      showError('Open the conversation this reply belongs to, then insert again.');
      return;
    }
    if (!state.accountId) {
      showError('No chat is selected.');
      return;
    }
    var ai = wabAi();
    if (!ai || typeof ai.insert !== 'function') {
      showError('The sidekick cannot reach the app bridge (window.wab is missing).');
      return;
    }
    var pending;
    try {
      pending = ai.insert(state.accountId, state.lastText);
    } catch (err) {
      showError(errMsg(err, 'Could not insert into the chat.'));
      return;
    }
    Promise.resolve(pending).then(
      function (res) {
        if (res && res.ok === true) {
          showToast('inserted');
        } else {
          showError((res && res.error) ? res.error : 'Could not insert into the chat.');
        }
      },
      function (err) {
        showError(errMsg(err, 'Could not insert into the chat.'));
      }
    );
  }

  /* ---------- fragment evolution (index.html stays untouched) ---------- */

  function buildSetupCard() {
    var text = els.nokey.querySelector('.ai-panel-nokey-text');
    if (text) {
      text.textContent =
        'The sidekick needs a brain: paste an API key (OpenAI-compatible, ' +
        'Anthropic, GLM) in Settings, or check the key is set.';
    }

    var actions = createEl('div', 'ai-panel-nokey-actions');
    els.setupTest = createEl('button', 'ai-panel-btn ai-panel-btn-quiet');
    els.setupTest.type = 'button';
    els.setupTest.id = 'ai-panel-test';
    els.setupTest.textContent = 'Test connection';
    els.setupTest.title = 'Check whether the AI key works';

    els.setupTestResult = createEl('div', 'ai-panel-nokey-test-result');
    els.setupTestResult.id = 'ai-panel-nokey-test-result';
    els.setupTestResult.hidden = true;

    // the existing Open settings button moves into the shared actions row
    actions.appendChild(els.openSettings);
    actions.appendChild(els.setupTest);
    els.nokey.appendChild(actions);
    els.nokey.appendChild(els.setupTestResult);
  }

  function buildStatusLine() {
    els.statusRow = createEl('button', 'ai-panel-status');
    els.statusRow.type = 'button';
    els.statusRow.id = 'ai-panel-status';
    els.statusDot = createEl('span', 'ai-panel-dot is-wait');
    els.statusLabel = createEl('span', 'ai-panel-status-label', modelLabel());
    els.statusRow.appendChild(els.statusDot);
    els.statusRow.appendChild(els.statusLabel);
    els.main.insertBefore(els.statusRow, els.main.firstChild);
  }

  function buildLiveBadge() {
    els.live = createEl('span', 'ai-panel-live');
    els.live.id = 'ai-panel-live';
    els.live.appendChild(createEl('span', 'ai-panel-live-dot'));
    els.live.appendChild(createEl('span', 'ai-panel-live-text', 'reading this conversation live'));
    els.live.hidden = true;
    els.context.parentNode.appendChild(els.live);
  }

  function buildBrainButton() {
    els.brainBtn = createEl('button', 'ai-panel-brain-btn');
    els.brainBtn.type = 'button';
    els.brainBtn.id = 'ai-panel-brain';
    els.brainBtn.textContent = 'Brain';
    els.brainBtn.title = 'Tone and per-contact notes that ride along with every draft';
    els.brainBtn.setAttribute('aria-expanded', 'false');
    els.brainBtn.setAttribute('aria-controls', 'ai-panel-drawer');
    els.closeBtn.parentNode.insertBefore(els.brainBtn, els.closeBtn);
  }

  function buildBrainDrawer() {
    var card = els.root.querySelector('.ai-panel-card');
    var body = els.main.parentNode;

    els.drawer = createEl('div', 'ai-panel-drawer');
    els.drawer.id = 'ai-panel-drawer';
    els.drawer.setAttribute('role', 'region');
    els.drawer.setAttribute('aria-label', 'Sidekick brain');
    els.drawer.hidden = true;

    var toneSec = createEl('div', 'ai-panel-drawer-section');
    toneSec.appendChild(createEl('div', 'ai-panel-field-label', 'Tone'));
    toneSec.appendChild(createEl('div', 'ai-panel-field-hint', 'How the sidekick should sound when drafting'));
    els.toneTa = createEl('textarea', 'ai-panel-brain-tone');
    els.toneTa.id = 'ai-panel-tone';
    els.toneTa.rows = 3;
    els.toneTa.maxLength = BRAIN_MAX_CHARS;
    els.toneTa.placeholder = 'e.g. Short and direct. Warm but never salesy. Match the contact’s language.';
    toneSec.appendChild(els.toneTa);

    els.noteSection = createEl('div', 'ai-panel-drawer-section');
    els.noteLabel = createEl('div', 'ai-panel-field-label', 'What to remember');
    els.noteTa = createEl('textarea', 'ai-panel-brain-note');
    els.noteTa.id = 'ai-panel-note';
    els.noteTa.rows = 3;
    els.noteTa.maxLength = BRAIN_MAX_CHARS;
    els.noteTa.placeholder = 'e.g. Runs a dental clinic, prefers Dutch, invoice sent in October.';
    els.noteSection.appendChild(els.noteLabel);
    els.noteSection.appendChild(els.noteTa);

    els.noperson = createEl('p', 'ai-panel-drawer-noperson',
      'Open a chat and a note for that person appears here.');

    var foot = createEl('div', 'ai-panel-drawer-foot');
    foot.appendChild(createEl('span', 'ai-panel-drawer-note',
      'The brain persists on this PC. It rides along with every draft.'));
    els.brainSave = createEl('span', 'ai-panel-brain-save');
    els.brainSave.id = 'ai-panel-brain-save';
    els.brainSave.hidden = true;
    foot.appendChild(els.brainSave);

    els.drawer.appendChild(toneSec);
    els.drawer.appendChild(els.noteSection);
    els.drawer.appendChild(els.noperson);
    els.drawer.appendChild(foot);
    card.insertBefore(els.drawer, body);
  }

  /* ---------- pane follow (until an explicit setContext takes over) ---------- */

  function wirePaneFollow() {
    try {
      if (window.wab && window.wab.app && typeof window.wab.app.onPaneState === 'function') {
        window.wab.app.onPaneState(function (p) {
          if (state.ctxLocked || !p || typeof p !== 'object' || p.isActive !== true) return;
          if (p.open) {
            state.accountId = p.accountId || null;
            state.chatName = p.title || null;
            state.accountName = p.accountName || null;
            state.chatId = null;
          } else {
            state.accountId = null;
            state.chatName = null;
            state.accountName = null;
            state.chatId = null;
          }
          renderContextLine();
        });
      }
    } catch (err) { /* live-follow is a bonus, never fatal */ }
  }

  /* ---------- public API ---------- */

  function init() {
    if (state.inited) return;
    var root = $('ai-panel-root');
    if (!root) {
      if (window.console && window.console.error) {
        window.console.error('WABAiPanel: #ai-panel-root not found, fragment not injected.');
      }
      return;
    }
    state.inited = true;

    els.root = root;
    els.context = $('ai-panel-context');
    els.closeBtn = $('ai-panel-close');
    els.nokey = $('ai-panel-nokey');
    els.openSettings = $('ai-panel-open-settings');
    els.main = $('ai-panel-main');
    els.chipsWrap = $('ai-panel-chips');
    els.instruction = $('ai-panel-instruction');
    els.run = $('ai-panel-run');
    els.hint = $('ai-panel-hint');
    els.working = $('ai-panel-working');
    els.error = $('ai-panel-error');
    els.result = $('ai-panel-result');
    els.wordcount = $('ai-panel-wordcount');
    els.copy = $('ai-panel-copy');
    els.insert = $('ai-panel-insert');
    els.text = $('ai-panel-text');
    els.usage = $('ai-panel-usage');
    els.toast = $('ai-panel-toast');

    // v12.7 G2: build every new surface before wiring events
    buildSetupCard();
    buildStatusLine();
    buildLiveBadge();
    buildBrainButton();
    buildBrainDrawer();

    els.closeBtn.addEventListener('click', function () { close(); });

    els.chipsWrap.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.ai-panel-chip') : null;
      if (!btn || btn.disabled) return;
      runCommand(btn.getAttribute('data-command'));
    });

    els.run.addEventListener('click', function () { runCommand('freeform'); });

    els.instruction.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'Enter' || ev.keyCode === 13)) {
        ev.preventDefault();
        runCommand('freeform');
      }
    });

    els.openSettings.addEventListener('click', function () {
      window.dispatchEvent(new CustomEvent('wab:open-settings'));
    });

    els.setupTest.addEventListener('click', onSetupTest);
    els.statusRow.addEventListener('click', function () { maybeTestConnection(true); });
    els.brainBtn.addEventListener('click', toggleDrawer);

    els.toneTa.addEventListener('input', function () {
      state.brain.tone = els.toneTa.value;
      scheduleBrainSave();
    });

    els.noteTa.addEventListener('input', function () {
      var key = noteKey();
      if (!key) return;
      state.brain.notes[key] = els.noteTa.value;
      scheduleBrainSave();
    });

    els.copy.addEventListener('click', copyResult);
    els.insert.addEventListener('click', insertResult);

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || els.root.hidden) return;
      if (state.drawerOpen) {
        closeDrawer();
        return;
      }
      close();
    });

    wirePaneFollow();

    state.usage = 0;
    updateUsage();
    renderContextLine();
    loadBrain();
    els.root.hidden = true;
  }

  function open(opts) {
    if (!state.inited) init();
    if (!state.inited) return;
    opts = opts || {};
    if (opts.accountId) state.accountId = opts.accountId;
    renderContextLine();
    hideToast();
    els.root.hidden = false;

    var command = opts.command || null;
    refreshKeyState().then(function (hasKey) {
      if (els.root.hidden) return;
      if (!hasKey) return;
      if (command === 'freeform') {
        els.instruction.focus();
      } else if (command && COMMAND_IDS.indexOf(command) !== -1) {
        runCommand(command);
      } else if (command) {
        showError('Unknown command: ' + command);
      }
    });
  }

  function close() {
    if (!state.inited) return;
    if (state.brainTimer || state.brainDirty) brainFlushSave();
    els.root.hidden = true;
    hideToast();
  }

  function setContext(ctx) {
    if (!state.inited) init();
    if (!state.inited) return;
    ctx = ctx || {};
    state.ctxLocked = true;
    if (typeof ctx.accountId !== 'undefined') state.accountId = ctx.accountId || null;
    if (typeof ctx.chatName !== 'undefined') state.chatName = ctx.chatName || null;
    if (typeof ctx.accountName !== 'undefined') state.accountName = ctx.accountName || null;
    if (typeof ctx.chatId !== 'undefined') state.chatId = ctx.chatId || null;
    renderContextLine();
  }

  window.WABAiPanel = {
    init: init,
    open: open,
    close: close,
    setContext: setContext
  };
})();
