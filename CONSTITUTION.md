# Chat Bridge — Constitution

Ratified 2026-11-24 by the Owner (Bjovibes). This is the apex document: where anything else in this repo disagrees with it, this file wins. Amendments are Owner-only.

## Article I — What Chat Bridge is

One human runs many conversations from one desk. An operator answers WhatsApp and Telegram on behalf of partners, through the official web clients running invisibly underneath a single glass interface. The person whose account it is decides exactly what the desk may see, and can switch that off at any time from their own phone. Nothing is ever sent without the operator's click.

## Article II — The Laws

1. **Official sessions only.** No protocol libraries, no fake clients, no unofficial APIs. Ever.
2. **The human always sends.** No send path exists without the operator's click. The app has no code that presses send.
3. **The blindfold holds at the data layer.** Restricted chats never reach the renderer. Filtered before memory, not blurred on top of it.
4. **Fail loud.** No silent empty panes. If something cannot be read or sent, it says so.
5. **One identity per real human.** Aged accounts. Human pacing. The envelope holds.
6. **Consent is granular.** The account owner picks exactly which contacts the desk may see and chat with. Default is none.
7. **Consent is revocable at any moment.** From the owner's own phone, without asking anyone. Revocation outranks every other state: an in-flight draft to a revoked contact is dropped, not queued.
8. **The portal is the front door.** Consent is given in a portal the account owner opens themselves, not by handing over a phone at the operator's desk.

## Article III — What the laws mean in code

- Law 2 is a code constraint, not a policy: review must reject any change that adds a path capable of pressing send autonomously.
- Law 3 means filtering in the data spine before the renderer, and the send path must re-check the blindfold (known gap, scheduled fix; see the README honest-limits section).
- Law 1 means pull requests that add unofficial protocol libraries, automation frameworks, or bulk-messaging capability are rejected regardless of usefulness.
- Law 4 means no silent fallbacks: a failed read or send surfaces as an explicit error state, never as an empty pane or a swallowed exception.
- Law 7 means consent revocation semantics are designed before convenience features.

## Article IV — Amendment

Amendments are made by the Owner only. Laws may be added or tightened, never weakened or removed. An amendment that weakens or removes an existing law is void.

## Article V — Interpretation

When two readings of any law conflict, the more private reading wins. When in doubt about a person's data: do not touch it, do not copy it, do not show it.

—

*Owner: Bjovibes. Ratified 2026-11-24. Laws 1 to 5 carried from the 2026-11-20 founding PRD; laws 6 to 8 added with the consent portal direction.*
