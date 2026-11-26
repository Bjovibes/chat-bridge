# Chat Bridge — PRD v2.0 (2026-11-24)

Source: the owner's direction, 2026-11-24. This file is the authority for the Chat Bridge era.
PRD v1 (2026-11-20, the WA Bridge single-platform draft) stays in the repo root as history.

Naming history, so nobody is confused later: **WA Bridge** (working title, v1) → **OneBridge** (internal product name, V12 to V14) → **Chat Bridge (CB)** (public name, set by the owner, 2026-11-24). Same product, same repo, same laws. The folder stays `wa-bridge` on this machine; the repo and public face are `chat-bridge`.

---

## 1. What Chat Bridge is

One human runs many conversations from one desk.

An operator (one real person, for example a founder running conversations for several partners) works WhatsApp and Telegram side by side in a single glass interface. The official web clients run invisibly underneath as engine rooms. The desk renders every conversation itself, with AI drafts and summaries on command. Nothing is ever sent without the operator's click.

And the whole thing is consent-governed: the person whose account it is decides exactly what the desk is allowed to see, and can switch that off at any time, from their own phone.

**One line for strangers:** Chat Bridge turns official WhatsApp and Telegram web sessions into one operator desk, with per-contact consent given by the account owner and a kill switch they always hold.

## 2. Who it is for

- **The operator** — one real human who answers on behalf of partners. Aged accounts, human pacing, one identity per real human.
- **The partner** — the account owner. They keep their phone, their number, their account. They grant access to chosen contacts only, and they can revoke it anytime.

## 3. Product laws (the constitution)

1. **Official sessions only.** No protocol libraries, no fake clients, no unofficial APIs. Ever.
2. **The human always sends.** No send path exists without the operator's click. Drafts are proposals.
3. **The blindfold holds at the data layer.** Restricted chats never reach the renderer. Not blurred on screen while sitting in memory. Filtered before memory.
4. **Fail loud.** No silent empty panes. If something cannot be read or sent, it says so.
5. **One identity per real human.** Aged accounts. Human pacing. The envelope holds.
6. **Consent is granular.** *(new, 2026-11-24)* The partner picks exactly which contacts the desk may see and chat with. Default is none.
7. **Consent is revocable at any moment.** *(new, 2026-11-24)* From the partner's own phone, without asking anyone. Revocation takes effect at the data layer, immediately.
8. **The portal is the front door.** *(new, 2026-11-24)* Consent is given in a portal the partner opens themselves, not by handing over a phone or scanning a QR at the operator's desk.

Laws 6 to 8 exist because the alternative is trust and manual filtering. Today, linking a partner account means they scan a QR at the operator's machine, and privacy relies on the blindfold config the operator sets up. That is not good enough for what this product claims. The consent portal is the fix.

## 4. What exists today (V14.3, 2026-11-23)

Working:
- Engine rooms: official WhatsApp Web and Telegram Web in hidden WebContentsViews
- Data spine: reads IndexedDB and window globals, no DOM scraping
- Blindfold: restricted people filtered at the spine, before the renderer
- Opens and sends driven by real OS-level input (real clicks, real clipboard paste)
- Endless history scroll, drafts, typing indicators, emoji bar
- Media decrypt chain (applied, unverified against a live photo)
- Activity ledger, watchdog self-healing, layout auto-distribution
- AI sidekick: draft reply, summarize, reconnect, lookup, translate; brain memory
- Platform constellation cards, command bar, one central compose bar

Not yet proven (honest list):
- Send reliability drill: clipboard paste works in testing but is not yet proven 10/10 in a live drill
- Telegram message history read: fix applied, unverified live
- Telegram names: 171 of 500 contacts show without names (users who never set one)
- Media inline display: never tested against a real photo

## 5. The Consent Portal (v2 flagship)

### The problem it solves

Today the consent flow is: partner comes to the operator (or a QR gets photographed and sent), links the account, and then trusts the operator's blindfold configuration. Three failures:

1. Consent is all-or-nothing at link time. The partner cannot hand over "just this one contact" in a way the system enforces for them.
2. Revocation means asking the operator to unlink, or trusting a config change.
3. Nothing is self-service from the partner's own phone.

### The flow

1. The operator creates an invite in the desk. The desk generates a one-time invite link.
2. The operator sends the link to the partner (WhatsApp, email, whatever).
3. The partner opens it **on their phone**. The portal is a web page, phone-first. Not an app.
4. The partner makes a profile (name, passcode) or logs in if returning.
5. The portal shows their contact list, read from their linked session. The partner toggles exactly which contacts Chat Bridge may see and chat with. Default: everything off.
6. The partner saves. The desk picks up the change immediately, at the data layer. Newly allowed contacts appear; removed ones vanish mid-session, including from memory.
7. Anytime, from the same link or a saved bookmark, the partner can change the selection or hit **turn it all off**. One tap. Everything goes dark for the operator, immediately.

The flagship sentence from PRD v1 carries over and gets stronger: partner picks "only this contact", the operator sees exactly one thread, and now the partner did the picking themselves, from their pocket.

### Design principles

- **Phone-first.** The portal is designed for a 6-inch screen. The desk is for the 27-inch screen.
- **Default none.** A new partner sees every toggle off. Granting is an explicit act.
- **Revocation beats everything.** Turn-it-off wins over any state, any session, any draft in flight. A draft being written to a revoked contact is dropped, not queued.
- **The portal never shows message content.** It shows contact names and toggles. It is a consent surface, not a reading surface.
- **No third-party cloud.** The portal talks to the operator's machine. Design question: relay or tunnel, see open questions.

### Security notes

- Invite links: single-use, rotating, expiring. A leaked old link is dead.
- Partner auth: passcode set at first profile creation. Unlinking the session kills the profile.
- The portal inherits law 3: it cannot show what the blindfold excludes, by construction.
- Abuse case considered: operator forwards the invite to someone else. Mitigation: the portal binds to the session that completes linking, and the contact list it shows is the list of that session only.

### What the code says today (audit, 2026-11-24)

The current privacy implementation, which the portal builds on and fixes:

- Store shape: `PrivacyConfig { accountId, mode: 'all'|'allow'|'deny', allow: [titles], deny: [titles], updatedAt }` in `%APPDATA%\wa-bridge\wa-bridge.json`. The desk's Settings UI offers four modes (`all`, allow-list, deny-list, only-this-contact; "only" is stored as an allow-list of one).
- Enforcement today: the people spine filters restricted chats before the renderer (law 3 holds on the list path), and a DOM-level curtain guards the raw engine view.
- Three gaps the portal must close:
  1. **The send path skips the blindfold check.** `engSend` and `engMessages` trust the renderer; only the list path filters. The comment at the "blindfold door" says one thing, the code does another. Fix scheduled before the portal ships.
  2. **Consent is keyed by display title, not stable chat ID.** Titles drift; the engine already has stable IDs. The portal's toggles must bind to IDs.
  3. **The privacy write path has no authentication surface.** `privacy:set` is operator-invokable by design today. The portal needs its own authenticated write path so the partner's choices cannot be overridden silently from the desk side.

### What is deliberately NOT in v2

- No message content in the portal, ever
- No partner-side replying (the partner chats in their normal WhatsApp app)
- No analytics for the operator about the partner's choices beyond "allowed: 3 contacts"
- No mobile app for the desk itself

## 6. Known issues and honest limitations

Written for public consumption, because this repo is meant to be a public thing we made:

1. **Platform terms of service.** WhatsApp and Telegram both officially support multiple device sessions linked to one account, and Chat Bridge only uses official web clients with genuine human input. But running an account on behalf of another person sits in a gray zone of platform intent. Ban risk is low, not zero. Anyone using this should know that.
2. **Fragile spine.** The data spine reads platform internals (IndexedDB schemas, window globals). When WhatsApp or Telegram ship UI changes, the spine can break. Failures surface loudly, but they mean downtime until patched.
3. **Unproven paths.** The send drill, live media decrypt, and Telegram history read are applied but not yet verified live. This is real software with real unknowns, listed rather than hidden.
4. **Single operator machine.** One Windows machine, one desk. No cloud, no sync, no team mode.
5. **The blindfold is a filter, not cryptography.** Restricted chats are excluded at the data layer on the operator's machine. That is a strong boundary, but the machine itself must be trusted. The consent portal (v2) moves the trust decision to the partner; it does not encrypt anything.
6. **Blindfold door coverage: send, read and AI paths guarded since V14.4** (2026-11-26); the history, media and pre-open doors are not yet held to the same standard and are the next guard work. Listed here rather than hidden.
6. **Windows only, for now.** Packaging for macOS is future work.
7. **Electron fingerprints.** The engine rooms are Chromium views and can be fingerprinted as such by the platforms. We do not disguise this beyond normal browser behavior.

## 7. Roadmap

| # | Deliverable | Status |
|---|---|---|
| 0 | This PRD, laws 6 to 8, portal flow map | 2026-11-24 |
| 1 | Send reliability drill, live media, Telegram history verification | pending operator hands |
| 2 | Consent portal MVP: invite link, phone page, contact toggles, live apply | **MVP built 2026-11-26 (V14.4)**: phone-first page served by the app on the LAN, tokens one-per-account, kill switch live. Not yet: passcode, TLS, internet tunnel, chatId-keyed consent |
| 3 | Revocation semantics: mid-session cutoff, draft drop, ledger entry | not started |
| 4 | macOS packaging | not started |
| 5 | More platforms (the architecture allows more engine rooms) | exploratory |

## 8. Open questions

1. **Relay or tunnel for the portal?** The partner's phone must reach the operator's machine. Candidates: a tiny relay service we host (what data transits it?), a WebRTC-style direct link, or a tunnel (Cloudflare-class). Decision pending a short research pass. Constraint: no third party may see contact names or content in transit.
2. **How does the portal read the partner's contact list before the session is linked?** Likely: link happens first (phone scans QR shown by the portal itself), then the contact list flows from the linked session. Exact sequence to be designed with the desk's spine.
3. **Do invite links need a server at all,** or can the desk sign a token that the portal verifies offline? Preference for the latter if the UX holds.
4. **Contact-level or chat-level consent?** A contact may have several chats (person, group, work). v1 thinking: contact-level, groups listed separately with their own toggles.
5. **Audit trail:** should the desk keep a tamper-evident log of consent changes, visible to the partner in the portal? Probably yes; cost unknown.

---

*PRD v2 written 2026-11-24 from the owner's direction. Laws 1 to 5 unchanged since 2026-11-20; laws 6 to 8 added with the consent portal. Amend only with the owner's ruling.*
