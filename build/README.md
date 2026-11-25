# Chat Bridge (the app)

A desktop desk for running partners' WhatsApp and Telegram accounts side by side, with consent blindfolds and an AI sidekick that drafts replies. You press send. Always.

## Run it

Double-click `start-wa-bridge.cmd` in this folder (first time: `npm install` in this folder, once).

- Windows first. macOS packaging later.
- Everything stays on this PC. No cloud, no sync, no account of ours.

## First run, per partner account

1. Click Add account. Read the consent line out loud or send it to them: **only link an account whose owner explicitly authorized you.**
2. Name it, pick a color. A QR window opens.
3. The partner scans it on their own phone: WhatsApp, Settings, Linked devices, Link a device (Telegram: Settings, Devices, Link Desktop Device).
4. While they are there, open Settings, Privacy, pick the account, and set the view mode. Recommended: Only this contact. Their private chats then do not exist on this desk: hidden in the list, cannot be opened, never fed to the AI, and notifications only ever say "new message in a restricted chat".
5. The partner can unlink anytime from their own phone. Nothing on this PC can stop that, and nothing here should.

## The AI sidekick

Right-click inside a chat, Ask AI. Or Ctrl+I. Commands:

- Draft reply (uses the last messages, your tone instructions welcome)
- Summarize
- Reconnect (a warm reconnection message)
- What we know (from the conversation and general knowledge only; it says plainly when it does not know something)
- Freeform (type any instruction)

Results appear in the panel. Insert drops the text into the compose box. **The app has no code path that presses send.** That is a design law, not a setting.

Setup: Settings, AI provider. Paste your own API key (OpenAI-compatible endpoint, which covers OpenAI, GLM, Groq, OpenRouter, local Ollama, or Anthropic). The key is stored locally in this app's data folder and sent only to the endpoint you configure.

## Honest limits, read these

- **The blindfold is a filter, not cryptography.** Restricted chats are excluded at the data layer. Someone with developer tools and bad intent on this machine could work around it. It is built for trust and against accidental glances. If you need hard guarantees, do not link the account.
- **Ban risk is never zero.** This app loads the official WhatsApp Web and Telegram Web exactly like a browser does, with zero automation and zero unofficial protocol libraries, which is the lowest risk that exists. The platforms can still log devices out or restrict accounts at their own discretion.
- **The AI can be wrong.** Drafts are drafts. Read before you send. Lookup does not have live web access in this version.
- **Platform UI changes can break the reading layer.** When that happens the app fails loudly ("could not read this chat") instead of guessing. Fix usually follows within days.
- **Known gap:** the send path does not yet re-check the blindfold (the people list does). Being fixed with the consent portal work.

## What it never does

- Never sends messages by itself
- Never automates, schedules, or bulk-messages anything
- Never reads restricted chats or sends them to the AI
- Never syncs or uploads your data anywhere

## For the technically curious

Electron, one isolated session partition per account, privacy layer injected per page load and enforced on the people spine, single JSON config in the app data folder. Smoke test without phones: `npm run smoke` (loads `tools/mock-wa.html`, writes screenshots to `shots/` which stay local and are never committed). Product spec: `..\docs\PRD-V2-CHAT-BRIDGE.md`. Module contract: `..\docs\CONTRACT.md`.
