# AGENTS.md — for any agent (or human) working on Chat Bridge

Read this before touching anything. It is short on purpose.

**What this is:** an Electron desk where one operator runs partners' WhatsApp and Telegram through the official web clients, with consent blindfolds and an AI sidekick. Apex rules: `CONSTITUTION.md`. Product direction: `docs/PRD-V2-CHAT-BRIDGE.md`. Module contract: `docs/CONTRACT.md`. Friendly intro: `README.md`.

## Hard rules

1. **Do not launch the app unless the Owner asks.** It is a live operator tool holding real, linked sessions. For verification use mock mode, which needs no phone: `npm run smoke` in `build/`.
2. **Never commit screenshots of real conversations.** `build/shots/` is where the app writes capture output; it is gitignored and must stay that way. No chat screenshots in issues or PRs either.
3. **The laws are acceptance criteria.** No send path without a human click. No unofficial protocols. Blindfold at the data layer. A change that breaks a law is wrong even if it works.
4. **`package.json` name stays `wa-bridge`.** The app's data folder (store, linked session partitions) is keyed to it; renaming orphans every linked account on every installed machine. The public name lives in `productName` and UI strings.
5. **No secrets in code.** API keys are entered at runtime in Settings and stored in the local app data folder, never in the repo.
6. **Report honestly.** Say what is untested as untested. Fail loud applies to agents too.

## Map

- `build/src/main/sessions.js` — the spine: engine rooms (hidden WebContentsViews), data reads, blindfold filter (enforced on list, send, read and AI paths), real-click opens, clipboard-paste sends
- `build/src/main/portal/` — the consent portal: phone-first page + HTTP server (port 47120) where partners toggle contact-level consent
- `build/src/main/engine/` — injected into the platform pages: `engine-inject.js` (WhatsApp bridge), `telegram-inject.js` (Telegram bridge)
- `build/src/main/inject/` — DOM-layer guards (privacy curtain, open-chat, scraper, declutter)
- `build/src/main/{main,windows,ipc,store}.js` — entry, window tree, IPC channels, JSON store
- `build/src/ui/` — the desk renderer: shell, people rail, render panes, AI panel, activity, debug
- `build/src/shared/normalize.js` — title normalization and the matching law
- `build/tools/` — mock WhatsApp page + fixtures (smoke mode runs phone-free)

## Instruments

- `npm run smoke` — boots the app in mock mode against `tools/mock-wa.html`, writes screenshots to `build/shots/` (local only)
- `--selftest` — the app's own verdict on its engine seams
- `--sendreport` — send-path autopsy output
- Mock fixtures: `build/tools/fixtures.json`

## Before you claim done

Smoke passes, your diff contains no screenshots/shots paths, no secrets, no real names or numbers, and no law violations. If you could not test something live, say so.
