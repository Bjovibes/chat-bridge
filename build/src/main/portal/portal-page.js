// Chat Bridge consent portal page. One HTML string, no external assets, no
// frameworks, system fonts. Served at GET /<token> by portal-server.js.
// The page shows contact names and toggles ONLY: no message content ever
// reaches it because the API behind it serves titles alone.
// Public-safe by law: no names, numbers, paths, or anything personal here.

const PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>Chat Bridge consent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    background: #12140b;
    color: #F4F5F2;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.45;
    min-height: 100vh;
  }
  .wrap { max-width: 480px; margin: 0 auto; padding: 24px 16px 96px 16px; }
  .mark { font-size: 20px; font-weight: 700; letter-spacing: 0.2px; }
  .mark .dot { color: #2DD4BF; }
  .tag { margin-top: 6px; font-size: 15px; color: #C9CEC2; }
  .acc { margin-top: 10px; font-size: 13px; color: #8B937D; }
  .explain {
    margin-top: 18px; padding: 14px; font-size: 14px; color: #C9CEC2;
    background: #1A1E10; border: 1px solid #2A2F1F; border-radius: 10px;
  }
  .explain strong { color: #F4F5F2; font-weight: 600; }
  .error {
    margin-top: 14px; padding: 12px 14px; font-size: 14px; color: #F4B4B8;
    background: #2A1416; border: 1px solid #5B262A; border-radius: 10px;
  }
  .list { margin-top: 14px; border: 1px solid #2A2F1F; border-radius: 10px; overflow: hidden; }
  .note { padding: 18px 14px; font-size: 14px; color: #8B937D; }
  .row {
    display: flex; align-items: center; gap: 12px;
    min-height: 56px; padding: 8px 14px; cursor: pointer;
    border-bottom: 1px solid #23281A; background: #171A0F;
  }
  .row:last-child { border-bottom: none; }
  .row .name { flex: 1; font-size: 16px; color: #9AA192; word-break: break-word; }
  .row.on .name { color: #F4F5F2; }
  .sw { position: relative; width: 52px; height: 32px; flex: none; }
  .sw input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; margin: 0; cursor: pointer; }
  .track { position: absolute; inset: 0; background: #2A2F1F; border-radius: 999px; transition: background 0.15s ease; pointer-events: none; }
  .track::after {
    content: ""; position: absolute; top: 4px; left: 4px; width: 24px; height: 24px;
    border-radius: 50%; background: #8B937D; transition: transform 0.15s ease, background 0.15s ease;
  }
  .sw input:checked + .track { background: #1E4B45; }
  .sw input:checked + .track::after { transform: translateX(20px); background: #2DD4BF; }
  .sw input:focus-visible + .track { outline: 2px solid #2DD4BF; outline-offset: 2px; }
  .bar {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
    display: flex; flex-direction: column; gap: 8px;
    max-width: 480px; margin: 0 auto; padding: 12px 16px 16px 16px;
    background: linear-gradient(to top, #12140b 70%, rgba(18, 20, 11, 0));
  }
  .save, .off {
    width: 100%; min-height: 52px; font-size: 16px; font-weight: 600;
    border-radius: 10px; cursor: pointer; font-family: inherit;
  }
  .save { background: #2DD4BF; color: #0B2B26; border: none; }
  .save:disabled { background: #1E4B45; color: #6FA79F; cursor: default; }
  .off { background: transparent; color: #F4B4B8; border: 1px solid #5B262A; }
  .off:disabled { color: #7A5254; cursor: default; }
  .law { margin-top: 14px; font-size: 12px; color: #6E7563; }
  .done { max-width: 480px; margin: 0 auto; padding: 48px 20px; text-align: left; }
  .done h1 { font-size: 20px; margin-bottom: 10px; }
  .done p { font-size: 15px; color: #C9CEC2; margin-bottom: 8px; }
  .done .law { margin-top: 18px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div id="wrap" class="wrap">
  <header>
    <div class="mark">Chat Bridge<span class="dot">.</span></div>
    <p class="tag">You decide what the operator can see.</p>
    <p id="account-name" class="acc" hidden></p>
  </header>

  <p class="explain">
    Everything starts <strong>switched off</strong>. Turn on only the contacts
    the operator may see and chat with, then press Save. You can come back to
    this page anytime, or turn it all off with one button.
  </p>

  <div id="error" class="error" hidden></div>
  <div id="list" class="list"><div class="note">Loading your contacts</div></div>
  <p class="law">This page shows contact names and toggles only. No messages are ever shown here.</p>
</div>

<div id="bar" class="bar" hidden>
  <button id="save" class="save" type="button">Save</button>
  <button id="off" class="off" type="button">Turn it all off</button>
</div>

<div id="done" class="done" hidden>
  <h1 id="done-title"></h1>
  <p id="done-text"></p>
  <p>You can close this page now. Nothing else is needed.</p>
  <p class="law">Reopen the same link anytime to change what is shared.</p>
</div>

<script>
(function () {
  'use strict';
  var token = (location.pathname.replace(/^\\/+/, '').split('/')[0]) || '';
  var elError = document.getElementById('error');
  var elList = document.getElementById('list');
  var elBar = document.getElementById('bar');
  var elWrap = document.getElementById('wrap');
  var elDone = document.getElementById('done');
  var elDoneTitle = document.getElementById('done-title');
  var elDoneText = document.getElementById('done-text');
  var elAccount = document.getElementById('account-name');
  var btnSave = document.getElementById('save');
  var btnOff = document.getElementById('off');

  function fail(msg) {
    elError.hidden = false;
    elError.textContent = msg;
  }
  function clearFail() {
    elError.hidden = true;
    elError.textContent = '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function showDone(title, text) {
    elDoneTitle.textContent = title;
    elDoneText.textContent = text;
    elWrap.hidden = true;
    elBar.hidden = true;
    elDone.hidden = false;
    window.scrollTo(0, 0);
  }
  function busy(on) {
    btnSave.disabled = on;
    btnOff.disabled = on;
  }
  function post(path, body) {
    busy(true);
    clearFail();
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      busy(false);
      if (!r.ok) throw new Error('The portal could not save (error ' + r.status + '). Nothing was changed on the phone side, try again.');
      return r.json();
    }).then(function (data) {
      if (!data || data.ok !== true) throw new Error((data && data.error) || 'The portal could not save. Try again.');
      return data;
    }, function (e) {
      busy(false);
      throw e;
    });
  }

  fetch('/api/' + encodeURIComponent(token) + '/chats', { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('This link is not valid anymore (error ' + r.status + '). Ask the operator for a new one.');
      return r.json();
    })
    .then(function (data) {
      render(data || {});
    })
    .catch(function (e) {
      elList.innerHTML = '';
      fail('Could not load your contacts: ' + (e && e.message ? e.message : 'network error') + '. Check the connection and reload.');
    });

  function render(data) {
    if (data.accountName) {
      elAccount.hidden = false;
      elAccount.textContent = 'For the account: ' + data.accountName;
    }
    var chats = data.chats || [];
    var allowed = {};
    (data.allowed || []).forEach(function (t) { allowed[t] = true; });
    if (!chats.length) {
      elList.innerHTML = '<div class="note">No contacts found yet. Ask the operator to open this account once, then reload this page.</div>';
      elBar.hidden = true;
      return;
    }
    var html = '';
    chats.forEach(function (c) {
      var t = String(c && c.title != null ? c.title : '');
      if (!t) return;
      html += '<label class="row' + (allowed[t] ? ' on' : '') + '">'
        + '<span class="name">' + esc(t) + '</span>'
        + '<span class="sw"><input type="checkbox" data-title="' + esc(t) + '"' + (allowed[t] ? ' checked' : '') + '>'
        + '<span class="track"></span></span></label>';
    });
    elList.innerHTML = html || '<div class="note">No contacts found yet.</div>';
    elList.addEventListener('change', function (ev) {
      var row = ev.target && ev.target.parentNode && ev.target.parentNode.parentNode;
      if (row && row.classList) row.classList.toggle('on', !!ev.target.checked);
    });
    elBar.hidden = false;
  }

  btnSave.addEventListener('click', function () {
    var picked = [];
    elList.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
      if (box.checked) picked.push(box.getAttribute('data-title'));
    });
    post('/api/' + encodeURIComponent(token) + '/allow', { titles: picked })
      .then(function () {
        showDone(
          'Saved',
          picked.length
            ? 'The operator can now see and chat with ' + picked.length + (picked.length === 1 ? ' contact' : ' contacts') + ' you picked. Everything else stays hidden.'
            : 'Saved with nothing switched on. The operator cannot see any of your chats.'
        );
      })
      .catch(function (e) { fail(e && e.message ? e.message : 'Save failed.'); });
  });

  btnOff.addEventListener('click', function () {
    if (!window.confirm('Turn everything off? The operator will not be able to see or chat with any of your contacts.')) return;
    post('/api/' + encodeURIComponent(token) + '/off', {})
      .then(function () {
        showDone('Everything is off', 'The operator cannot see any of your chats. Nothing is shared right now.');
      })
      .catch(function (e) { fail(e && e.message ? e.message : 'Turning off failed.'); });
  });
})();
</script>

</body>
</html>
`;

module.exports = { PORTAL_HTML };
