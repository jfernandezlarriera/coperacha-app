# coperacha-app

Public repo for the Coperacha app (group collections over WhatsApp + CoDi). Never commit
secrets, API keys, tokens, `.env` files, or user data. Put required names in `.env.example`
only.

Inherits the Coperacha area rules from `~/Work/Coperacha/AGENTS.md` (and `~/Work/AGENTS.md`).
User-facing copy is Mexican Spanish (tú). Code, comments, commits, and file names are in
English. Never name the hackathon (event or organizer) in the product, README, or comments; the only
mention is the generic prototype notice in `src/util/html.js` («creado en una hackatón»), approved by JI.

Do not deploy, and do not change AWS or production config, unless JI explicitly asked.

## Context

Node 20, plain JavaScript (ESM), zero npm dependencies. HTTP on `node:http`, tests on
`node:test`, JSON file store (`src/db/store.js`, schema in `src/db/schema.md`). Domain rules
live in `src/domain/`; WhatsApp (Arturito) and CoDi (Pey) are behind interfaces with mocks in
`src/integrations/`. Read [docs/ROADMAP.md](./docs/ROADMAP.md) and the latest
`docs/sessions/*-session-plan.md` for priorities.

## Gotchas

- Never use the words "inversión" or "rendimiento" in copy (a test checks `messages.js`).
- Who-paid-what is exposed only by `contributorList()` in `src/domain/colecta.js`; keep it
  that way in web, WhatsApp and logs.
- Logs never contain message text, names or phones: only chatId, type, messageId and ids.
- In production the store is mirrored to S3 (`DATABASE_S3_BUCKET`, see `src/db/open-store.js`)
  with a single writer: keep App Runner at one instance. Deploy details in `infra/README.md`.
- `Store` returns live references: take primitive snapshots before mutating when you need
  before/after comparisons (see `snapshot()` in `colecta.js`).
- Outbound WhatsApp always goes through `OutboundQueue` (6/min). Never call the Arturito
  client directly from domain code.
- No real Google, Pey or Arturito calls in tests; `NODE_ENV=test` silences the logger.

## Commands

- `npm test`: all tests (`node --test test/`).
- `npm start`: server on `PORT` (reads `.env`; needs `SESSION_SECRET`, and either Google
  credentials or `AUTH_DEV_LOGIN=true`).
- Deadline sweep runs every minute inside the server; `service.sweepDeadlines(now)` in tests.

## Change cycle

Read by `~/Work/workspace/bin/change`. Keep the key format.

- test: `npm test`
- deploy: `AWS_PROFILE=coperacha infra/deploy.sh`
- deploy_requires_approval: yes
