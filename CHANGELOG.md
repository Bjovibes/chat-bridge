# Changelog

## v0.2.0-beta (2026-11-25)
- First packaged release: Windows NSIS installer (Chat-Bridge-Setup-0.2.0.exe) on the GitHub Releases page. App icon (bridge arch, three typing dots) wired through the installer and window.

## Unreleased (2026-11-24)
- Rebrand: **Chat Bridge** (public name; internally WA Bridge → OneBridge → Chat Bridge). Window title, rail wordmark, About, dialogs, launcher strings, comment headers.
- Repo hygiene: git init, .gitignore (shots/ never committed, node_modules, logs), MIT LICENSE, public README, this changelog.
- Electron pinned to 45.4.1 (was "latest").
- Logo: bridge arch with three typing dots (brand/).
- Product spec for the consent portal: docs/PRD-V2-CHAT-BRIDGE.md (laws 6 to 8).
- Audit finding documented: send path does not yet re-check the blindfold; fix scheduled with the portal work.

## V14.3 (2026-11-23)
- WhatsApp + Telegram dual-platform desk: engine rooms in hidden WebContentsViews, data spine on IndexedDB + window globals, clipboard-paste sends, endless history, drafts, typing indicators, media decrypt chain (unverified live), activity ledger, AI sidekick with brain, watchdog self-healing, layout auto-distribution, emoji bar, platform constellation cards, command bar.

## V12 series (2026-11-22)
- Staged ICM rebuild: one central bar, engine-room lid, platform renderer, rail solidification. Full history in v12/.

## v2.0 (2026-11-21)
- People rail, privacy modes in the desk, archive copy in archive/build-v2.0-2026-11-21/.

## v1.0 (2026-11-20)
- WhatsApp desk, privacy blinds, AI sidekick, consent line on every account add. Archive copy in archive/build-v1.0-2026-11-20/.
