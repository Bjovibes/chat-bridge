<p align="left"><img src="brand/chat-bridge-logo-light.svg" width="260" alt="Chat Bridge"></p>

**One human runs many conversations from one desk.**

Chat Bridge is a desktop desk for an operator who answers WhatsApp and Telegram on behalf of partners. The official web clients run underneath as invisible engine rooms. The desk renders every conversation itself, with an AI sidekick that drafts and summarizes on command. Nothing is ever sent without the operator's click, and the person whose account it is decides exactly what the desk may see.

Built by one person and their agents, in the open, from day one. Development build: V14.3.

Development happens in a private vault that holds the full history and research notes; only scrubbed, public-safe material is published here.

## The laws

These are design laws, not settings. The code is shaped around them.

1. **Official sessions only.** No protocol libraries, no fake clients, no unofficial APIs. Ever.
2. **The human always sends.** No send path exists without the operator's click. The app has no code that presses send.
3. **The blindfold holds at the data layer.** Restricted chats are filtered out before they reach the interface, not blurred on top of memory.
4. **Fail loud.** No silent empty panes. If something cannot be read or sent, it says so.
5. **One identity per real human.** Aged accounts, human pacing.
6. **Consent is granular.** The account owner picks exactly which contacts the desk may see. Default is none.
7. **Consent is revocable at any moment.** From the owner's own phone. Nothing on this PC can stop that, and nothing here should.
8. **Consent moves to a portal.** In development: the owner opens a link on their phone and toggles contact-level access themselves. See the PRD.

## Download (no coding needed)

Grab the installer from [Releases](https://github.com/Bjovibes/chat-bridge/releases): download `Chat-Bridge-Setup-0.2.0.exe`, double-click, done. Windows 10/11, installs to your user folder, no admin needed.

The app is unsigned, so Windows SmartScreen will say "Windows protected your PC". Click **More info** → **Run anyway** if you trust it. A signing certificate is future work.

## Run it from source

Windows first, macOS later. In `build/`:

```
npm install        (once)
start-wa-bridge.cmd
```

Everything stays on this PC. No cloud, no sync, no account of ours.

## First run, per partner account

1. Click Add account. Read the consent line out loud or send it to them: **only link an account whose owner explicitly authorized you.**
2. Name it, pick a color. A QR window opens.
3. The partner scans it on their own phone: WhatsApp, Settings, Linked devices, Link a device (Telegram: Settings, Devices, Link Desktop Device).
4. Open Settings, Privacy, pick the account, set the view mode. Recommended: Only this contact. Their other chats then do not exist on this desk: hidden from the list, blocked at the data layer, never fed to the AI, and notifications only ever say "new message in a restricted chat".
5. The partner can unlink anytime from their own phone. That is their kill switch today, and it outranks everything here.

## The AI sidekick

Right-click inside a chat, Ask AI (or Ctrl+I). Draft reply, Summarize, Reconnect, What we know, or freeform. Results appear in a panel; Insert drops the text into the compose box. **The app has no code path that presses send.**

Bring your own key: Settings, AI provider. OpenAI-compatible endpoints (OpenAI, GLM, Groq, OpenRouter, local Ollama) or Anthropic. The key is stored locally in the app data folder and sent only to the endpoint you configure.

## Honest limits, read these

- **The blindfold is a filter, not cryptography.** Restricted chats are excluded at the data layer on the operator's machine. Someone with developer tools and bad intent on that machine could work around it. It is built for trust and against accidental glances. If you need hard guarantees, do not link the account.
- **Ban risk is never zero.** The app loads official WhatsApp Web and Telegram Web exactly like a browser does, with genuine human input and zero automation. That is the lowest risk that exists. The platforms can still log devices out or restrict accounts at their own discretion. Running an account on behalf of another person sits in a gray zone of platform intent; know that before you link anything.
- **Known gap, being fixed:** the send path does not yet re-check the blindfold (the people list does). Found in the 2026-11-24 audit, fix scheduled with the consent portal work.
- **The AI can be wrong.** Drafts are drafts. Read before you send. Lookup has no live web access in this version.
- **Platform UI changes can break the reading layer.** The data spine reads platform internals. When they change, the app fails loudly instead of guessing. Fixes usually follow within days.
- **Unproven paths, listed rather than hidden:** the send reliability drill is not yet 10/10 verified live, inline media decrypt is untested against a real photo, and the Telegram history read is applied but unverified.
- **Windows only, one machine.** No sync, no team mode. The AI key sits in a plain local JSON file.
- **Electron fingerprints.** The engine rooms are Chromium views and can be fingerprinted as such. We do not disguise this beyond normal browser behavior.

## What it never does

- Never sends messages by itself
- Never automates, schedules, or bulk-messages anything
- Never reads restricted chats or sends them to the AI
- Never syncs or uploads your data anywhere

## The repo

| Path | What it is |
|---|---|
| `build/` | The app. Plain Electron, no frameworks, no build step. ~23,700 lines. |
| `build/src/main/` | Main process: sessions spine, engine rooms, blindfold, IPC, store. |
| `build/src/ui/` | Renderer: the glass desk. Classic scripts, zero dependencies. |
| `build/tools/` | Mock WhatsApp page + fixtures. Full smoke test without a phone: `npm run smoke`. |
| `brand/` | The logo. Bridge arch, three typing dots. |
| `docs/PRD-V2-CHAT-BRIDGE.md` | The product spec, including the consent portal (next flagship). |
| `docs/CONTRACT.md` | The module and IPC contract. |
| `CONSTITUTION.md` | The apex: the eight laws, amendment rules. |
| `AGENTS.md`, `CONTRIBUTING.md` | How agents and humans work on this repo. |

## License

MIT. See `LICENSE`.
