Chat Bridge v0.4.0-beta — remote partners

Two things changed, both for the case where the account owner is in another country.

## Linking without a QR scan

WhatsApp supports linking by phone code. On the owner's phone: WhatsApp, Settings, Linked devices, Link a device, "Link with phone number instead". Their phone shows a code; they read it to the operator on a call; the operator types it into the app's link window (which now prints these instructions on its card and is bigger so the form fits). Telegram owners just read the code the app sends them. No cameras, no distance.

## The consent portal, reachable from anywhere

Settings > Consent portal > Remote access > Start spins up a free Cloudflare quick tunnel and shows a public https invite link. The owner opens it on their phone from anywhere, sees their chat list as toggles, picks what to share (or hits Turn it all off), and the desk updates live.

One-time setup: download cloudflared.exe from the official Cloudflare GitHub releases into build/tools. It is not bundled with the app.

Honest limits: the public link only works while the desk is running, and the URL changes on every restart, so send a fresh link each session. A stable named tunnel is future work. The invite token remains the only credential; revoke rotates it instantly.

## Everything from before still holds

The eight laws, the blindfold enforced on send, read and AI paths, the human always sends, official sessions only. Install steps are unchanged: download the exe below, double-click, SmartScreen > More info > Run anyway.

## Beta means beta

Send drill not yet verified 10/10 against live phones, inline media decrypt untested against a real photo, Telegram history read unverified live, history/media/pre-open doors not yet blindfold-guarded (tracked in the PRD).
