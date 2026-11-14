# Data schema (JSON store, schemaVersion 1)

One file at `DATABASE_PATH` with six collections. All ids are UUIDs, all timestamps are UTC
ISO strings, all amounts are integer centavos (MXN). Nothing secret is stored: no OAuth
tokens, no Pey credentials. The organizer's CLABE is stored because Pey needs it as the
beneficiary of every charge.

| Collection | Fields |
|---|---|
| `organizers` | `id`, `googleSub`, `email`, `name`, `createdAt` |
| `colectas` | `id`, `code` (share link), `organizerId`, `organizerName`, `organizerPhone`, `clabe`, `giftIdea`, `goalCents`, `deadline`, `splitMode` (`equal` \| `free`), `status` (`open` \| `goal_reached` \| `confirmed` \| `failed` \| `cancelled`), `finalGift`, `winningProposalId`, `votingClosedAt`, `confirmedAt`, `failedAt`, `cancelledAt`, `milestonesNotified` (array of percentages), `reminderSentAt`, `createdAt`, `updatedAt` |
| `participants` | `id`, `colectaId`, `name`, `phone` (digits), `chatId`, `mode` (`fixed` \| `equal` \| `majority_cap`), `fixedCents`, `capCents` (private), `finalCents` (set at confirmation), `joinedAt` |
| `proposals` | `id`, `colectaId`, `title`, `proposedBy` (`p:<participantId>` \| `o:<organizerId>`), `createdAt` |
| `votes` | `id`, `colectaId`, `voter` (same key format as `proposedBy`), `proposalId`, `updatedAt` |
| `charges` | `id`, `colectaId`, `participantId`, `peyChargeId`, `reference`, `amountCents`, `status` (`pending` \| `paid` \| `failed` \| `expired`), `paymentUrl`, `createdAt`, `updatedAt` |

Migrations are forward-only functions in `src/db/store.js` keyed by `schemaVersion`. Moving
to SQLite means re-implementing the `Store` methods (`insert`, `get`, `find`, `findOne`,
`all`, `update`, `remove`) over tables with the same columns.
