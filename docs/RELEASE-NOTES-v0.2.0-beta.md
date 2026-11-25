Chat Bridge v0.2.0-beta — the first packaged release

One human runs many conversations from one desk. Chat Bridge is a desktop desk where an operator answers WhatsApp and Telegram through the official web clients, with consent blindfolds, an AI sidekick that drafts but never sends, and a kill switch that lives on the account owner's phone.

## Install (Windows 10/11)

1. Download Chat-Bridge-Setup-0.2.0.exe below
2. Double-click. No admin needed, installs to your user folder
3. SmartScreen will warn ("Windows protected your PC") because the app is unsigned. Click More info, then Run anyway, if you trust it
4. Click Add account, scan the QR with your own phone, and set the privacy mode before anyone starts working

## What works

- Official WhatsApp Web and Telegram Web side by side, invisible under one glass desk
- Consent blindfolds: restricted chats never reach the interface, the AI never sees them
- AI sidekick: draft reply, summarize, reconnect, what-we-know (bring your own API key, Settings, AI provider)
- Endless history, drafts, typing indicators, emoji, watchdog self-healing
- The app has no code path that presses send. You press send. Always.

## Beta means beta

- The send reliability drill is not yet verified 10/10 against live phones
- Inline media (photos in chat) has an applied but untested decrypt chain
- The Telegram history read is applied but unverified live
- The send path does not yet re-check the blindfold (the people list does; guard is scheduled)

## The laws

Eight constitutional laws govern this app: official sessions only, the human always sends, the blindfold holds at the data layer, fail loud, one identity per real human, consent is granular, consent is revocable at any moment from the owner's phone, and consent moves to a portal (specified, being built). Read CONSTITUTION.md.

## For coders

Clone, then in build/: npm install, npm run smoke (phone-free mock mode). PRs welcome: read CONTRIBUTING.md first — the laws are acceptance criteria.
