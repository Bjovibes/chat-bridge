/* Chat Bridge onboarding.js, v14.6. Classic script, no modules, file:// safe.
   The first-run guide: a chronological four-step card people.js mounts in the
   empty people rail, walking the operator to the first LIVE conversation.
   Once all four steps are done, or the guide is skipped, it never renders
   again (the store's onboarded flag is the only remembered bit).

   Laws:
   - Step state is COMPUTED, never hoarded: every refresh asks the main
     process for { onboarded, profileNamed, accountLinked, consentGiven,
     personVisible } and the card derives done/current/pending from that
     answer plus the renderer's own loaded people list (the merge the
     engine cannot always reach).
   - Refresh rides the events that already refresh the desk: people load
     success (people.js notePeople), account list changes (people.js
     onListChanged), account status pushes (shell.js applyStatus) and
     portal status renders (shell.js renderPortalStatus). No timers of
     its own.
   - One action per step, nothing else competes: the skip control is a
     small muted link under the steps.
   - Everything guards: an older preload yields one loud toast, then the
     desk keeps its old empty state. Never throws, never alerts. */

(function () {
  'use strict';

  var state = {
    ready: false,          // first onboarding:state answer landed
    onboarded: false,      // never-repeat flag, main process truth
    profileNamed: false,
    accountLinked: false,
    consentGiven: false,
    personVisible: false,
    peopleSeen: false,     // renderer merge: the desk's own loaded people list
    operatorId: '',        // first user (the operator) for the rename step
    operatorName: '',
    completing: false,     // one setDone in flight
    warned: false          // one loud toast per session
  };

  /* ---------- guards and utils ---------- */

  function wabOk() {
    return typeof window.wab === 'object' && window.wab !== null;
  }

  function apiOk() {
    return wabOk() && window.wab.onboarding &&
      typeof window.wab.onboarding.state === 'function' &&
      typeof window.wab.onboarding.setDone === 'function';
  }

  function usersApiOk() {
    return wabOk() && window.wab.users &&
      typeof window.wab.users.list === 'function' &&
      typeof window.wab.users.update === 'function';
  }

  function errText(err, fallback) {
    var msg = err && (err.message || err.error);
    return (typeof msg === 'string' && msg) ? msg : (fallback || 'Something went wrong');
  }

  // Shell toast is not a global; bridge through the event the spine wires.
  function toastRaw(text) {
    try {
      window.dispatchEvent(new CustomEvent('wab:toast-raw', { detail: { text: String(text) } }));
    } catch (e) { /* degrade silently */ }
  }

  function warnOnce() {
    if (state.warned) return;
    state.warned = true;
    toastRaw('First-run guide needs the latest app version');
  }

  // people.js listens and re-renders the rail; the card is rebuilt from the
  // fresh cache on every render, so nothing else needs notifying.
  function emitUpdated() {
    try {
      window.dispatchEvent(new CustomEvent('wab:onboarding-updated'));
    } catch (e) { /* degrade silently */ }
  }

  /* ---------- state ---------- */

  function personLive() {
    return state.personVisible || state.peopleSeen;
  }

  function stepsDone() {
    return state.profileNamed && state.accountLinked && state.consentGiven && personLive();
  }

  // Never-repeat: flip the store flag once, then the emit clears the card.
  // Used by the auto-complete check and by the skip link alike.
  function finishForever() {
    if (state.completing) return;
    if (!apiOk()) { warnOnce(); return; }
    state.completing = true;
    window.wab.onboarding.setDone().then(function () {
      state.completing = false;
      state.onboarded = true;
      emitUpdated();
    }).catch(function (err) {
      state.completing = false;
      toastRaw(errText(err, 'Could not save the guide state'));
    });
  }

  function fetchState() {
    if (!apiOk()) { warnOnce(); return; }
    window.wab.onboarding.state().then(function (st) {
      if (!st) return;
      state.ready = true;
      state.onboarded = st.onboarded === true;
      state.profileNamed = !!st.profileNamed;
      state.accountLinked = !!st.accountLinked;
      state.consentGiven = !!st.consentGiven;
      state.personVisible = !!st.personVisible;
      if (!state.onboarded && stepsDone()) finishForever();
      emitUpdated();
    }).catch(function (err) {
      if (state.warned) return;   // one loud toast, quiet retries after it
      state.warned = true;
      toastRaw(errText(err, 'Could not load the first-run guide'));
    });
  }

  // people.js reports its own loaded list after every successful load: the
  // renderer-side half of personVisible, and the people-load refresh event.
  function notePeople(hasPeople) {
    state.peopleSeen = !!hasPeople;
    if (state.onboarded) return;
    fetchState();
  }

  // The operator is the first user (the one the store auto-creates).
  function loadOperator() {
    if (!wabOk() || !window.wab.users || typeof window.wab.users.list !== 'function') return;
    window.wab.users.list().then(function (list) {
      if (Array.isArray(list) && list.length) {
        state.operatorId = String(list[0].id || '');
        state.operatorName = list[0].name || '';
      }
    }).catch(function () { /* the rename step fails loudly on save instead */ });
  }

  /* ---------- card pieces ---------- */

  function helper(body, text) {
    var h = document.createElement('span');
    h.className = 'wob-helper';
    h.textContent = text;
    body.appendChild(h);
  }

  function actionRow(control) {
    var row = document.createElement('div');
    row.className = 'wob-action';
    row.appendChild(control);
    return row;
  }

  // Step 1: inline input + save, writing the operator user's name through
  // the users:update channel. No users rename UI exists elsewhere, so the
  // field lives here; Enter commits like Save.
  function buildProfileStep(body, st) {
    if (st.done) {
      helper(body, 'The desk addresses you as ' + (state.operatorName || 'your saved name') + '.');
      return;
    }
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'wob-input';
    input.maxLength = 40;
    input.placeholder = 'Your name';
    input.setAttribute('aria-label', 'Profile name');
    input.setAttribute('autocomplete', 'off');

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'wob-btn';
    save.textContent = 'Save';

    function commit() {
      var value = (input.value || '').trim();
      if (!value) {
        try { input.focus(); } catch (eF) { /* fine */ }
        return;
      }
      if (!usersApiOk()) {
        toastRaw('Rename needs the latest app version');
        return;
      }
      save.disabled = true;
      window.wab.users.update(state.operatorId || '', value).then(function (u) {
        save.disabled = false;
        if (!u || !u.id) {
          toastRaw('Could not save the name');
          return;
        }
        state.operatorName = u.name || value;
        try { input.blur(); } catch (eB) { /* fine */ }
        fetchState();   // step 1 flips done from the fresh state answer
      }).catch(function (err) {
        save.disabled = false;
        toastRaw(errText(err, 'Could not save the name'));
      });
    }

    save.addEventListener('click', commit);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    });

    var row = actionRow(input);
    row.appendChild(save);
    body.appendChild(row);
    helper(body, 'Names the operator profile the desk addresses you by.');
  }

  // Step 2 reuses the rail's connect door: WABPeople.connectPlatform knocks
  // on the shell's wab:add-account listener, the same handler the Add
  // account button and the unconnected platform logos use. No modal logic
  // is duplicated here.
  function buildConnectStep(body, st) {
    if (!st.done) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wob-btn';
      btn.textContent = 'Connect WhatsApp';
      btn.addEventListener('click', function () {
        var claimed = false;
        try {
          if (window.WABPeople && typeof window.WABPeople.connectPlatform === 'function') {
            claimed = window.WABPeople.connectPlatform('whatsapp', state.operatorId, state.operatorName);
          }
        } catch (eC) { claimed = false; }
        if (!claimed) toastRaw('Could not open the connect window. Use Add account in the rail.');
      });
      body.appendChild(actionRow(btn));
    }
    helper(body, 'On a call, the owner opens WhatsApp, Settings, Linked devices, Link a device, Link with phone number instead, and reads you the code.');
  }

  // Step 3 opens Settings through the shell's wab:open-settings door, then
  // lands on the Consent portal section: account picker, invite link and
  // the remote access block all sit there.
  function buildConsentStep(body, st) {
    if (!st.done) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wob-btn';
      btn.textContent = 'Open consent settings';
      btn.addEventListener('click', function () {
        try {
          window.dispatchEvent(new CustomEvent('wab:open-settings'));
        } catch (eO) {
          toastRaw('Could not open Settings');
          return;
        }
        try {
          var sel = document.getElementById('portal-account');
          var sec = sel && sel.closest ? sel.closest('section') : null;
          if (sec && typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start' });
        } catch (eS) { /* Settings opened; the scroll is a nicety */ }
      });
      body.appendChild(actionRow(btn));
    }
    helper(body, 'Generate the invite link and send it. Remote access makes it work from another country.');
  }

  // Step 4 is helper only: the owner's portal pick makes the person appear
  // in this same rail; clicking it opens the live conversation.
  function buildLiveStep(body) {
    helper(body, 'When the owner ticks a contact, it appears here. Click it and you are live.');
  }

  /* ---------- card ---------- */

  function card() {
    if (!apiOk()) { warnOnce(); return null; }
    if (state.onboarded || !state.ready) return null;

    var steps = [
      { label: 'Name your profile', done: state.profileNamed, build: buildProfileStep },
      { label: 'Connect a WhatsApp', done: state.accountLinked, build: buildConnectStep },
      { label: 'Let the owner pick chats', done: state.consentGiven, build: buildConsentStep },
      { label: 'Open the conversation', done: personLive(), build: buildLiveStep }
    ];
    var currentIdx = -1;
    for (var i = 0; i < steps.length; i++) {
      if (!steps[i].done) { currentIdx = i; break; }
    }

    var box = document.createElement('div');
    box.className = 'wob-card';

    var title = document.createElement('span');
    title.className = 'wob-title';
    title.textContent = 'Get your first conversation live';
    box.appendChild(title);

    var sub = document.createElement('span');
    sub.className = 'wob-sub';
    sub.textContent = 'Four steps in order. This guide leaves once the first chat is live.';
    box.appendChild(sub);

    var listEl = document.createElement('div');
    listEl.className = 'wob-steps';
    box.appendChild(listEl);

    steps.forEach(function (st, idx) {
      var row = document.createElement('div');
      row.className = 'wob-step' + (st.done ? ' is-done' : (idx === currentIdx ? ' is-current' : ' is-pending'));
      var mark = document.createElement('span');
      mark.className = 'wob-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = st.done ? '✓' : String(idx + 1);
      row.appendChild(mark);
      var stepBody = document.createElement('div');
      stepBody.className = 'wob-step-body';
      var label = document.createElement('span');
      label.className = 'wob-step-label';
      label.textContent = st.label;
      stepBody.appendChild(label);
      try { st.build(stepBody, st); } catch (eB) { /* one broken step never kills the card */ }
      row.appendChild(stepBody);
      listEl.appendChild(row);
    });

    // Skip: a muted link, never a button competing with the steps.
    var skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'wob-skip';
    skip.textContent = 'Skip this guide';
    skip.addEventListener('click', function () { finishForever(); });
    box.appendChild(skip);

    return box;
  }

  /* ---------- public surface ---------- */

  window.WABOnboarding = {
    card: function () {
      try { return card(); } catch (e) { return null; }
    },
    refresh: function () {
      try { fetchState(); } catch (e) { /* degrade quietly */ }
    },
    notePeople: function (hasPeople) {
      try { notePeople(hasPeople); } catch (e) { /* degrade quietly */ }
    }
  };

  /* Auto-boot like the other UI modules; the card itself renders only when
     people.js asks for it inside the empty rail. */
  function boot() {
    loadOperator();
    fetchState();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
