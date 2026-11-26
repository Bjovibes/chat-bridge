Chat Bridge v0.3.0-beta — the consent portal

The headline feature: the person whose WhatsApp or Telegram it is now decides, from their own phone, exactly what the operator can see.

## What is new

- **Consent portal.** The operator generates an invite link in Settings, Privacy, Consent portal, and sends it to the account owner. The owner opens it on their phone (works while both are on the same network and the desk is running): they see their own chat list as simple toggles, tick what they allow, Save, done. Changes apply live to the desk. A big "Turn it all off" button zeroes everything anytime. Default: everything off.
- **Blindfold guard, enforced.** Sends, message reads and AI context reads now refuse restricted chats loudly, before anything happens, fail-closed. The operator sees the refusal reason, not a silent failure.

## Install (Windows 10/11)

1. Download Chat-Bridge-Setup-0.3.0.exe below
2. Double-click. No admin needed, installs to your user folder
3. SmartScreen will warn ("Windows protected your PC") because the app is unsigned. Click More info, then Run anyway, if you trust it
4. Add account, scan the QR with your own phone, then immediately set the privacy mode, or send the invite link and let the owner pick

## Honest limits of this portal (MVP)

- Plain HTTP on the local network: no TLS, and it only works while the desk PC runs on the same network as the partner's phone. Reaching the internet needs a tunnel or relay you set up yourself (designed, not shipped)
- The invite link is the only credential. Send it over a channel you trust. If it leaks, Revoke and Generate kills it instantly
- No passcode yet, no rate limiting on token guessing (tokens are 128-bit random)
- The portal shows chat names and toggles only. It has no access to message content, by design and by construction

## Beta means beta

- The send reliability drill is not yet verified 10/10 against live phones
- Inline media decrypt chain applied but untested against a real photo
- The Telegram history read is applied but unverified live
- History, media and pre-open doors are not yet blindfold-guarded to the same standard as send and read (tracked in the PRD)

## The laws

Eight constitutional laws govern this app. Official sessions only. The human always sends. The blindfold holds at the data layer. Fail loud. One identity per real human. Consent is granular. Consent is revocable at any moment. The portal is the front door. Read CONSTITUTION.md.

## For coders

Clone, then in build/: npm install, npm run smoke (phone-free mock mode). PRs welcome: read CONTRIBUTING.md first, the laws are acceptance criteria.
