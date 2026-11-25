# Contributing to Chat Bridge

Thanks for wanting to help. The bar is simple: the laws always win.

## The laws are acceptance criteria

Before opening a PR, read `CONSTITUTION.md`. Concretely:

- Nothing that can press send autonomously. No schedulers, no auto-replies, no bots. Ever.
- No unofficial protocol libraries (whatsapp-web.js, Baileys, TDLib wrappers, and friends). Official web clients only.
- The blindfold lives at the data layer. Anything that moves restricted chats closer to the renderer is wrong.
- Fail loud: no silent fallbacks, no swallowed errors, no empty panes pretending to be empty chats.

PRs that violate a law will be closed with a pointer to this file, however useful the feature is.

## Setup

```
cd build
npm install
npm run smoke
```

Smoke boots the app in mock mode against `tools/mock-wa.html`. No phones, no accounts, no network. If smoke does not pass, fix that first.

## House rules

- Plain code: CommonJS in main/preload, classic scripts in the renderer. No frameworks, no build step, no TypeScript without an issue discussion first.
- Small PRs. One thing each.
- No real conversation data anywhere: no screenshots of real chats, no real names or phone numbers in code, fixtures, or issues.
- Say what you tested and what you could not. Untested is fine; silent is not.
- MIT. Contributions come under the repo license.

## The honest limitations list

`README.md` has one. If your PR changes a limitation, update the list in the same PR. That list is part of the product.
