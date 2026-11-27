Chat Bridge v0.5.0-beta — consent-first defaults

The trust model is now the default, not a setting.

## What is new

- **New accounts link locked.** When a partner links their WhatsApp or Telegram, the desk immediately sees nothing. No contacts, no names, no history. The owner then opens their consent portal link and ticks exactly what to share. Default none, from the first second.
- **Relinking keeps consent.** A re-linked account keeps its allow-list; the owner's choices survive connection drops.
- **Locked looks locked.** A waiting account shows an explicit card: no contacts shared yet, send the consent invite. Never a suspicious empty list.
- **The manual picker steps aside.** While a portal invite owns an account, the operator's manual privacy picker hides and a note says who owns consent. Revoking the invite brings manual setup back.
- **Full spine coverage.** History, has-more, media, and every open path (including search-open and pre-open) now refuse restricted chats with a loud error. Typing indicators and the AI panel never name a restricted chat.

## The flow for a remote partner, end to end

1. On a call, the owner opens WhatsApp, Settings, Linked devices, Link a device, Link with phone number instead, and reads you the code. You type it. Linked, and locked.
2. You generate the consent invite and start Remote access, send the public link.
3. The owner opens it on their phone, ticks the contacts to share, saves. Your desk updates live.

## Install (Windows 10/11)

Download Chat-Bridge-Setup-0.5.0.exe below, double-click, SmartScreen > More info > Run anyway.

## Beta means beta

Send drill not yet verified 10/10 against live phones, inline media decrypt untested against a real photo, Telegram history read unverified live. One documented residual: the AI insert command writes into the open chat's composer; all open and send paths are guarded, but the composer of a stale-open restricted chat is not auto-cleared.

## The laws

Eight constitutional laws, unchanged. This release just makes two of them harder to break: consent is granular (default none, now enforced at link time) and the blindfold holds at the data layer (every path). Read CONSTITUTION.md.
