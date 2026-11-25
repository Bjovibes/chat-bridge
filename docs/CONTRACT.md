# Chat Bridge — build contract v1 (2026-11-20, rebranded 2026-11-24)

The law every module codes against. Read PRD.md first. If your module needs something not here, put it in your final report as a proposed contract change; do not invent silently.

## Stack law

- Electron app, `main: src/main/main.js`. CommonJS (`require/module.exports`) everywhere under `src/main`, `src/preload`, `src/shared`, `src/ai`.
- Renderer (`src/ui/**`) = plain HTML/CSS/JS **classic scripts** (no `import`/`export`, no frameworks, no bundler, no TypeScript). Everything loads over `file://`.
- Only dependency allowed: `electron`. Node 26 globals (fetch, AbortController) are available in main.
- All user-visible copy: plain language, **no em-dashes**, no emoji, English, sentence case.
- Every fallible path fails loud: return/throw `{ok:false, error:'human readable'}`. Never swallow.
- No code path anywhere presses WhatsApp's send button. Ever.

## File ownership (write ONLY your files)

| Owner | Files |
|---|---|
| spine (integrator) | `src/main/main.js`, `src/main/windows.js`, `src/main/sessions.js`, `src/main/ipc.js`, `src/main/store.js`, `src/preload/shell-preload.js`, `package.json`, `start-wa-bridge.cmd`, integration edits to `src/ui/index.html` |
| A · privacy + mock | `src/main/inject/privacy-inject.js`, `src/main/inject/context-scraper.js`, `src/shared/normalize.js`, `tools/mock-wa.html` |
| B · AI | `src/ai/providers.js`, `src/ai/commands.js`, `src/ui/ai-panel/fragment.html`, `src/ui/ai-panel/ai-panel.css`, `src/ui/ai-panel/ai-panel.js` |
| C · shell UI | `src/ui/index.html`, `src/ui/shell.css`, `src/ui/shell.js` |

## Data shapes (`src/shared/schema.js` will mirror this; until it exists, this file is the truth)

```js
Account       { id: 'wa_<8hex>', name, color, createdAt, partition: 'persist:' + id, status: 'linking'|'linked'|'logged-out' }
PrivacyConfig { accountId, mode: 'all'|'allow'|'deny', allow: [title], deny: [title], updatedAt }   // allow-list of exactly 1 = "only this contact"
AIConfig      { provider: 'openai-compatible'|'anthropic', baseUrl, apiKey, model, maxContextMessages }  // maxContextMessages default 40
AIUsage       { calls, lastCallAt }
LayoutMode    'single'|'split2'|'split3'|'grid5'|'tabs'
ChatRef       { title, unread }        // title = exact chat-list title text as shown by WhatsApp
UnreadSummary { allowed, restricted }  // counts only, restricted is NEVER named anywhere
AICommand     'draft-reply'|'summarize'|'reconnect'|'lookup'|'freeform'
```

## IPC channels (all `invoke`→`handle` unless marked push)

```
accounts:list                                  → Account[]
accounts:add      {name, color}                → Account          (spine opens QR window after)
accounts:update   {id, patch:{name?,color?}}   → Account
accounts:remove   {id}                         → {ok}
privacy:get       {accountId}                  → PrivacyConfig
privacy:set       {accountId, config}          → PrivacyConfig    (spine re-injects blindfold live)
privacy:listChats {accountId}                  → ChatRef[]        (setup picker; partner-supervised moment)
ai:config:get                                  → AIConfig
ai:config:set     {config}                     → AIConfig
ai:test                                        → {ok, model, error?}
ai:run            {accountId, command, instruction?} → {ok, text, error?}   (counts 1 usage call)
ai:insert         {accountId, text}            → {ok, error?}     (insert into compose, never send)
app:setLayout     {mode}                       → {ok}
push: accounts:onStatus   {accountId, status}
push: app:onUnread        {accountId, allowed, restricted}        (every 3 s)
push: app:onToast         {kind:'allowed'|'restricted'|'info', text}  (restricted text is ALWAYS the generic line)
```

## `window.wab` (exposed by spine's shell-preload; UI agents code against exactly this)

```js
window.wab = {
  accounts: { list(), add(name, color), update(id, patch), remove(id), onStatus(cb) },
  privacy:  { get(accountId), set(accountId, config), listChats(accountId) },
  ai:       { getConfig(), setConfig(config), test(), run(accountId, command, instruction?), insert(accountId, text) },
  app:      { setLayout(mode), onUnread(cb), onToast(cb) }
}
```

## A · inject scripts contract

Run in the WhatsApp page world via `webContents.executeJavaScript`. No require, no globals leaked beyond documented ones. Guard double-injection. try/catch everything: a missed selector is a no-op, never a throw.

`privacy-inject.js` — source string; main sets `window.__WAB_PRIVACY__ = config` (JSON) BEFORE each execution. Provides in page:
- `window.__wabGetUnread()` → `{allowed, restricted}` (counts only)
- `window.__wabListChats()` → `[{title, unread}]` (enumerates list; used by the supervised setup picker only)
- Blindfold: MutationObserver (debounced ~200 ms) over the chat list + open-chat header.
  - mode `allow`: any chat row whose normalized title is NOT in allow → `display:none` (hidden = does not exist visually).
  - mode `deny`: denied titles → blurred (`filter:blur(9px)`, `pointer-events:none`) on the row.
  - Click guard: capture-phase listener; a click targeting a restricted row (or a search-result row, or anything that would open a restricted chat) → `preventDefault()+stopPropagation()` + small in-page toast "Restricted by account owner".
  - If the currently open conversation's header matches a restricted title → blur the whole conversation pane.
- Title matching: `src/shared/normalize.js` (CommonJS module AND the same logic inlined in the inject source; keep them identical): lowercase, strip emoji/diacritics/punctuation, collapse whitespace, compare; phone-digit sequences compare digits-only. Fuzzy startsWith fallback. Imperfect is documented, never fatal.

`context-scraper.js` — source string providing in page:
- `window.__wabScrapeChat()` → `{ok, contactName, messages:[{fromMe, text, ts}], error?}` — last 40 messages of the OPEN chat, newest last. Resilient selectors with ≥2 fallbacks each; on miss `{ok:false, error:'could not read this chat (WhatsApp UI changed?)'}`.
- `window.__wabInsertText(text)` → `{ok, error?}` — find the compose `div[contenteditable="true"]`, focus it, `document.execCommand('insertText', false, text)`; fallback: synthetic beforeinput/input/paste events. Never touches any send button.

`tools/mock-wa.html` — phone-free test double of WhatsApp Web, runs from file://, zero network: chat list (≥12 fake chats, aria structure mimicking WA: `#pane-side [role="row"]`, titles, unread badges), open-conversation pane with header title + message bubbles, WORKING compose contenteditable that appends sent bubbles locally. Used by `--mock` smoke tests so privacy/scrape/insert verify without phones. Also expose the same `__wab*` contract naturally (it should NOT; the inject scripts must work ON it via executeJavaScript — mock must be naive WA-like, no built-in `__wab*`).

## B · AI contract

`providers.js` (CommonJS): `async callAI(config, {system, user}) → {ok, text, error}`.
- `openai-compatible`: POST `${baseUrl}/chat/completions`, Bearer key, `{model, temperature:0.7, messages:[{role:'system',content},{role:'user',content}]}`. Works for OpenAI, GLM/z.ai, Groq, OpenRouter, Ollama `/v1`.
- `anthropic`: POST `${baseUrl||'https://api.anthropic.com'}/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`, `system`, `max_tokens:1024`.
- 60 s AbortController timeout; errors carry HTTP status + body trimmed to 300 chars; the API key is never in any error, log, or return value.

`commands.js` (CommonJS): `COMMANDS` array `[{id, label, placeholder}]` for all five + `buildPrompt(command, {contactName, messages, instruction}) → {system, user} | null`.
- `lookup` prompt law: answer ONLY from provided context + model knowledge, say plainly when something is not known, no live web access, no invented facts.
- `draft-reply`: drafts in the account owner's voice, references the last messages, appends operator tone instruction if given.
- All prompts: concise, no meta-talk, output is paste-ready text (no "here is your draft" preamble).

`ai-panel` — floating panel (bottom-right, ~420 px wide, draggable optional): `WABAiPanel = { init(), open({accountId?, command?}), close(), setContext({accountId, chatName}) }` global; classic script; styles in its own css; renders into `#ai-panel-root` (fragment.html root div id). Contents: header (chat/account context line + close), command chips (5), freeform textarea + Run, result box with word count + **Copy** + **Insert into chat** (→ `wab.ai.insert`), usage counter (session calls), error box. Empty AIConfig → friendly "add your key in Settings" state with a button that fires `window.dispatchEvent(new CustomEvent('wab:open-settings'))`. Visual: AI Partners tokens (Paper `#F6F8FB`, Ink `#0F172A`, Tile blue `#426CA8` accent, hairlines `#D9E1EC`, radius 12, Inter). No gradients, no emoji, no em-dashes.

## C · shell UI contract

`index.html` loads `shell.css`, `shell.js`, and (integration markers, spine fills them) `<!-- @INTEGRATE: ai-panel fragment + css + js -->` and `<!-- @INTEGRATE: settings markup -->` — C ships its OWN settings panel inline (C owns settings).

- Left rail (240 px): logo line "Chat Bridge", account cards (color dot, name, status dot linking/'linked'/logged-out, unread badge, right-click → rename/color/remove with confirm; "logged-out" state shows "re-link" button that calls `accounts:add`-equivalent… simply `wab.accounts.update` no-op + toast "scan the QR window that opened" and spine handles reopen), "+ Add account" button → consent modal (bold line: "Only link accounts whose owner explicitly authorized you. They can unlink anytime from their phone.") → name + color picker → `wab.accounts.add` → status dot 'linking' (QR window opens via spine).
- Toolbar: layout switcher (5 modes), "AI sidekick" toggle (Ctrl+I), "Settings" toggle.
- View area: `.slot` divs `data-slot="0".."4"` inside `#slot-area`. C exposes `window.WABSlots = { getRects(): [{slot, x, y, w, h}] /* CSS px, relative to window content area */ , onLayoutChange(cb) }` (ResizeObserver + layout switches fire cb). Spine positions Electron BrowserViews over these rects. Layouts: single(1 big), split2, split3, grid5 (rail collapses to icons at ≤1280 px width optional), tabs (one slot + tab strip built from account chips, C manages which account selected via `window.WABTabs = {select(accountId)}` callback registry `WABTabs.onSelect(cb)`).
- Settings panel (slide-over right): AI provider form (provider select openai-compatible/anthropic, baseUrl, model, api key password field, maxContextMessages number, Test button showing result inline), Privacy editor (account select → mode select → checklist of chats from `privacy.listChats` with checkboxes for allow/deny + "only this contact" quick pick), About block (version, "drafts never send themselves", local-data note). Saves via `wab.ai.setConfig` / `wab.privacy.set`.
- Toasts: bottom-left stack, renders `app.onToast` events; restricted toast always shows the generic line unchanged.
- Visual: same AI Partners tokens as B. States for everything: empty (no accounts), no-key (AI), linking, logged-out. No invented WhatsApp branding, no WhatsApp logo.

## Smoke test law (spine implements, everyone respects)

`npm run smoke` = `electron . --smoke --mock`: loads `tools/mock-wa.html` as every session's page, auto-creates 3 accounts (Linking Lane names), sets account 1 to allow-list of 1, captures window PNGs to `build/shots/`, exits 0. Agents: code so this can pass (deterministic ids not required; no external network in ANY renderer except WhatsApp itself in real mode and the AI provider on explicit Test/Run).

## Change protocol

Contract changes are proposed in the agent's final report and applied by the integrator only. Never edit another owner's file.

---

# V2 — Conversation Mode (2026-11-21). Supersedes nothing above; adds to it.

Law: cold start to typing in two clicks. WhatsApp becomes the invisible engine; the desk shows people.

## New IPC

```
chats:listPeople   {}                        → [{title, unread, accountId, accountName, accountColor}]  // privacy-filtered merge, linked accounts only
chats:searchAll    {query}                   → top 20 of the same shape, normalized substring match
chats:open         {accountId, title}        → {ok, error?}   // openChat automation + attach view to ACTIVE pane + focus compose
app:setActivePane  {slot}                    → {ok}
app:getPrefs                                 → {threadCrop: boolean}   // default true once v2 ships
app:setPrefs       {threadCrop}              → {ok}
push: panes:onState   {slot, accountId, accountName, accountColor, title, open}   // fired on every pane person change
```

Privacy law applies to the people data: the SPINE filters every chat list through the account's allow/deny config (normalize-matched) before it returns anything. Denied or non-allowed titles never leave the main process.

## `window.wab` additions (preload, integrator-owned)

```js
wab.chats = { listPeople(), searchAll(query), open(accountId, title) }
wab.app  += { setActivePane(slot), getPrefs(), setPrefs(prefs), onPaneState(cb) }
```

## A2 · inject contract

`open-chat-inject.js` — source string installed per page (installer pattern like the others). Provides `window.__wabOpenChat(titleJson)` returning a **Promise** of `{ok, error?}`:
1. Temporarily lift the declutter curtain: `window.__wabSetDeclutter(false)` (search box reappears; wrap in try, the function may not exist on old injections).
2. Find the search box: fallback chain `#side header div[data-tab="3"]`, `#side header div[contenteditable="true"]`, `#side div[contenteditable="true"]`, `#side header input[type="text"]`.
3. Focus it, select all + delete existing content, then `document.execCommand('insertText', false, title)`.
4. Wait (poll ≤ 500 ms steps) up to 4 s for result rows: `[data-testid="overlay"] [role="button"]`, `.matched-name` ancestors, fallback: rows inside any overlay/panel that appeared near the search box containing a title-like span.
5. Click the first row whose normalized title matches the target (normalize semantics from privacy-inject: exact, then startsWith).
6. Wait up to 4 s for the conversation header title to match the target (normalized), same header selectors as context-scraper.
7. `window.__wabSetDeclutter(true)` again, always (finally-style), resolve `{ok:true}` or `{ok:false, error:'search did not find <title>'}`.
8. NEVER locates or presses any send button. Opening chats is all this does.

`declutter-inject.js` extension (same file, still idempotent): add `window.__wabSetThreadCrop(on)` + CSS guarded by `html.wab-threadcrop`: hide the whole left column `#side` and let the conversation column take the full width (fallback chains for the flex parent: `#app .two`, `#main`, the main flex container; use `flex: 1 1 100%` / width 100% where needed). Nav-strip hiding stays as-is.

`tools/mock-wa.html`: add a working search input at the top of the list pane with the hooks the real chain looks for first: `#side header div[data-tab="3"]` as a `contenteditable="true"` div. Typing filters the visible chat rows (normalized substring). Clicking a row opens that chat as today. Everything else unchanged, still zero network, still no `__wab*` globals of its own.

## B2 · people UI contract

Files (write ONLY these): `src/ui/fragment-people.html`, `src/ui/people.js`, `src/ui/people.css`.

`fragment-people.html` = single root `<div id="wab-people-root">` containing: `#people-rail` block (section title "People", a live filter input `#people-filter`, scroll container `#people-list`) and `#search-palette` overlay (hidden; input `#palette-input`, results `#palette-results`). No script/link tags. The integrator pastes the fragment and inserts `<div id="people-rail"></div>` into the shell rail above the accounts list.

`people.js` classic script, exposes exactly:
```js
window.WABPeople = { init(), refresh(), openInActivePane(person), openPalette(), closePalette(), setActivePane(slot), refreshPanes() }
```
- People list: `wab.chats.listPeople()` on init, then debounced (1 s) refresh on every `wab.app.onUnread`, `wab.accounts.onStatus`, `wab.accounts.onListChanged`. Row: account color dot, person title, unread badge. Click → `wab.chats.open({accountId, title})`. Row highlights when it is the active pane's person (`wab.app.onPaneState`).
- Local filter input filters the rendered list live (normalized substring).
- Palette: Ctrl+K opens (Esc closes, button too), input debounced 200 ms → `wab.chats.searchAll(query)`, results rows show person + account name badge, ArrowUp/Down move a cursor, Enter or click → `wab.chats.open` + close palette. Empty query shows the 12 most recent people (listPeople order kept).
- Reply-as chips: one chip per visible slot, absolutely positioned at the slot's top-left + 8 px inset, positioned via `window.WABSlots.getRects()` and repositioned on `WABSlots.onLayoutChange`. Chip shows the account color dot + person title + account name (from `panes:onState`), or "Empty pane" when the pane has no person. Clicking a chip calls `wab.app.setActivePane(slot)`. Active pane's chip gets a brighter border.
- Keyboard: Ctrl+K palette; Ctrl+ArrowLeft/Right cycles `setActivePane` through visible slots. Do not swallow other keys.
- No-key / no-account / loading states for everything. All calls wrapped, errors toast via the shell's toast (dispatch `new CustomEvent('wab:toast-raw', {detail:{text}})` if the shell toast fn is not reachable; degrade silently, never alert()).
- `people.css`: dark glass to match glass.css tokens (warm ambient assumptions not needed; use rgba(46,46,30,.4) surfaces, rgba(255,255,255,.22) hairlines, #fff text, #426CA8-class accent replaced by WHITE accents as in glass.css pills, radius 12/999, blur 30px). No emoji, no em-dashes, light-on-dark only.

## Spine (integrator, not agents)

Pane state map, prefs store, preload additions, openChat orchestration (install source + call + focus compose after open), people filtering via shared/normalize.js, smoke additions (people rail renders, palette opens, listPeople respects the blindfold), integration markers in index.html, live verification.

---

# V3 — ENGINE ROOMS (2026-11-21 night). Replaces the v2 interaction layer wholesale; v1 laws carry.

Spec: docs\V3-PLAN.md + docs\FLOW-V3-ENGINE-ROOMS.html. Research bibles: notes\WAWEB-IDB-RESEARCH-2026-11-21.md (data), notes\WAWEB-SEND-HIDDEN-RESEARCH-2026-11-21.md (send + engine liveness; its RECOMMENDED PATTERN section is normative code).

## Topology (spine-owned)

BaseWindow + WebContentsView tree: `uiView` (everything visible; our renderer) re-added on top; one `engineView` per account UNDER it at full-window bounds, attached-but-covered, `backgroundThrottling:false` at creation, per-account `persist:` partition. Engines never visible; UI paints opaque. No insets, no overlay dance.

## D · engine inject (write ONLY `src/main/engine/engine-inject.js`)

Source string (IIFE, idempotent, try/catch everything, no Node globals) defining:

```js
window.__wabEng = {
  ready(): Promise<bool>,                          // IDB reachable + module runtime probed
  listChats(): Promise<[{chatId, title, unread, t, archived}]>,     // IDB model-storage -> chat (+ contact name join); ID normalization inline (id._serialized | id.$1 | string)
  getContact(chatId): Promise<{name, phone}|null>,  // IDB contact store
  getMessages(chatId, limit): Promise<[{id, fromMe, text, ts, kind}]>,  // module runtime for bodies (research file technique); IDB metadata fallback; kind: text|system|media-placeholder
  openChat(chatId): Promise<{ok, error}>,           // module runtime openChatBottom pattern first, DOM search fallback (v2 file), verify by chatId
  send(text): Promise<{ok, error}>,                 // ONLY after openChat confirmed; exact RECOMMENDED PATTERN sequence from the send research file (selection-replace insert, exact-match verify, fresh node, aria-first wds-ic-send-filled, click)
  health(): Promise<{idb:bool, modules:bool, lastError:string|null}>
}
```

Rules: all IDB access read-only, short transactions, versionless open, never triggers upgrade (Ferdium pattern, research file). Module-runtime access guarded (webpackChunk scan per R1 file §3; absence degrades getMessages/openChat to {ok:false,error:'module runtime unavailable'} + health reports it). No plaintext contact names or message text in ANY error or log string. Never throws; every promise resolves.

## E · renderer (write ONLY `src/ui/render/fragment-render.html`, `src/ui/render/render.js`, `src/ui/render/render.css`)

Owns the conversation experience. Loaded after people.js (which keeps the People rail; E upgrades rows to initial-avatars and wires clicks to openConversation).

```js
window.WABRender = {
  init(),
  openConversation({accountId, chatId, title, accountName, accountColor}),  // into the active pane
  setPaneZoom(slot, delta),      // 0.8x..2.4x font scale, Ctrl+wheel on pane + +/- buttons, persisted via wab.app.setPanePrefs
  toggleMaximize(slot),          // pane fills the slot area (people rail collapses to icons), restore on toggle
  toggleMinimize(slot),          // pane collapses to its reply-as chip row; click chip restores
  renderMessages(slot, msgs),    // engine messages in, bubbles out; auto-scroll to newest only if already near bottom
  setState(slot, {state:'loading'|'empty'|'error'|'live', message?})
}
```

Panes are OUR divs inside `#slot-area` (one `.rpane` per slot; engine BrowserViews are gone from the slot area). Compose box per pane; Enter sends ONLY via `wab.eng.send` (Shift+Enter newline). Message polling: active pane every 2s via `wab.eng.messages`, people every 3s via `wab.eng.people`. Style: The Glass Desk tokens exactly (people.css/glass.css families; warm dark, white pills, radius 8/12/22/26/999, blur 30). No emoji, no em-dashes, English, sentence case. Zoom = CSS font-size scale on `.rpane` root with all sizes in rem.

## v3 IPC (spine)

```
eng:people {}                        -> [{title, unread, accountId, accountName, accountColor, chatId}]   // engine listChats x blindfold filter, spine-side
eng:messages {accountId, chatId, limit} -> [{id, fromMe, text, ts, kind}]
eng:send {accountId, chatId, text}   -> {ok, error}          // spine: openChat -> send; ONLY from operator Send click
eng:health {}                        -> {accountId -> {idb, modules, lastError}}
app:setPanePrefs {slot, prefs}       -> {ok}   // {zoom, minimized} persisted
app:getPanePrefs                     -> {slot -> prefs}
```

`window.wab` additions: `wab.eng = { people(), messages(accountId, chatId, limit), send(accountId, chatId, text), health() }`, `wab.app.setPanePrefs/getPanePrefs`.

Mock mode (--mock): engines serve FIXTURES from `tools/fixtures.json` (canned people + messages + echo-send with 800ms delay) so the renderer is fully testable phone-free; spine swaps engine calls for fixtures, agents D and E code against the same shapes.

## Ownership

| Owner | Files |
|---|---|
| D | `src/main/engine/engine-inject.js`, `tools/fixtures.json` |
| E | `src/ui/render/fragment-render.html`, `src/ui/render/render.js`, `src/ui/render/render.css` |
| spine | BaseWindow/WebContentsView migration, engine lifecycle, v3 IPC + preload, send orchestration, blindfold in data path, smoke v3, integration |
