# Changelog

## v0.6.0-beta (2026-11-27)
- **First-run guide.** A fresh desk shows "Get your first conversation live": name your profile, connect a WhatsApp, let the owner pick chats, open the conversation. Each step has its own action, flips to done as you actually do it, and the card disappears forever once your first conversation is live (or when you skip it). It never repeats.

## v0.5.0-beta (2026-11-27)
- **New accounts link locked.** The desk sees nothing until the account owner picks contacts through the consent portal. Default none, by law and now by code. Relinking never overwrites consent.
- **Locked looks locked.** A waiting account shows an explicit "No contacts shared yet" card with the next step, in the rail and in panes.
- **Picker handover.** While a portal invite owns an account, the operator's manual privacy picker hides itself. Revoke the invite to take manual setup back.
- **Full spine blindfold coverage.** History, has-more, media, and every open path now refuse restricted chats loudly. Typing indicators and AI context never name restricted chats.

## v0.4.0-beta (2026-11-26)
- **Remote access**: partners in another country can now open the consent portal. Settings > Consent portal > Remote access starts a free Cloudflare quick tunnel and shows the public invite link. Works while the desk runs; the URL changes on restart. Requires cloudflared.exe in build/tools (see README).
- **Remote linking made plain**: the link window is bigger and prints the WhatsApp phone-code path (Linked devices > Link a device > Link with phone number instead). The partner reads the code on a call; the operator types it. No QR scanning across distance.

## v0.3.0-beta (2026-11-26)
- **Consent portal MVP**: the account owner opens an invite link on their phone and picks exactly which contacts the operator may see. Save writes through the live privacy pipeline; "Turn it all off" zeroes it anytime. Settings > Privacy > Consent portal: Generate / Copy / Revoke. Plain HTTP on the LAN; the link is the credential.
- **Blindfold guard enforced**: sends, message reads and AI context reads now refuse restricted chats loudly, fail-closed on unresolvable titles. The renderer surfaces the refusal reason.

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
