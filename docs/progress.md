# Progress

## Phase 3: Accounts, ledger and positions (v0.3)

Exit gate: every transaction balances, and the audit query reports zero drift. Met.

| Task | What landed |
|---|---|
| 3.1 | ADR 0002 lists every ledger table, every transaction kind and the exact rows each writes. `users.is_system` and the seeded `deposits`, `exchange` and `fees` accounts. |
| 3.2 | `postEntries` in `src/config/ledger.js`. Triggers block UPDATE and DELETE on `entries` and `share_entries`. |
| 3.3 | `POST /auth/register`, `POST /auth/login`, `POST /account/deposit`, `GET /account/balance`, `authMiddleware.js`. |
| 3.4 | Holds (`src/config/holds.js`), the shared fee expression (`fees.js`), `moveOrder` (`orders.js`), `lockWallets`, and a first cut of `POST /orders`. |
| 3.5 | `buyFill` and `sellFill` in `src/config/positions.js`, SQL expressions only, a table of 15 hand-calculated sequences. |
| 3.6 | `GET /account/portfolio` with mark price, market value and unrealised P&L from one query, plus realised, unrealised, fees and net P&L. |
| 3.7 | `npm run audit` with 7 checks. A test settles 1,000 random trades from 20 users, eight at a time, and the audit stays green. Another corrupts rows by hand and every check fires. |

Notes:

- `POST /orders` exists now, in a minimal form, because 3.4's exit test needs it: limit orders only, available cash or shares checked under the wallet lock, order and hold written in one transaction, lifecycle NEW, PENDING_RISK, ACCEPTED logged in `order_events`. An order that does not fit answers 400 and leaves no row. Phase 4 grows this into the full risk checks, `rejectOrder` (which stores REJECTED), market orders and cancel.
- `initDb` now seeds the three system accounts, so a freshly built database is no longer completely empty. The schema test checks for exactly those three rows.
- BIGINT columns (ids, quantities, counts) now come back from `pg` as numbers, set once in `src/config/db.js`. NUMERIC stays a string, so money is never a float.
- The fee expression is wrapped in `ROUND(..., 2)`. It changes no value, but numeric division otherwise returns a long tail of zeros (`50015.0000000000000000`). The tests caught that.
- `avg_cost` keeps 4 decimals as the plan says, so each fill rounds it. The tests pin the rounding down to the paisa.
- The portfolio response has four keys beyond `{ portfolio: rows }`: `realizedPnl`, `unrealizedPnl`, `feesPaid`, `netPnl`. Rows include closed positions (quantity 0), so their realised P&L stays visible. Fees paid are the user's own FEE debits, which equal the credits the fees account received.
- Shares are handed out only by a test helper (a DEPOSIT with share legs, plus the position). There is no endpoint for it yet.
- The audit's `holds_within_balances` only compares holds that actually reserve cash (or shares) with cash (or shares), so a sell hold's zero cash never trips it.
- Each database test file now gets its own throwaway database, created and dropped by `test/helpers/db.js`, so files run side by side. Root-level `before` hooks run concurrently, not in order, so the HTTP helper starts the server on the first request.
- The full suite takes about 53 seconds, nearly all of it the 1,000-trade audit test and the concurrency tests.

## Phase 2: Matching engine core (v0.2)

Exit gate: 100k random commands replay with zero invariant violations, and the engine agrees with a naive reference implementation on every event. Met.

| Task | What landed |
|---|---|
| 2.1 | `orderBook.js`: price levels in a Map plus a sorted price array, FIFO doubly linked list per level, id index for O(1) cancel, `bestBid`, `bestAsk`, `depth`, `snapshot`. |
| 2.2 | `matching.js`: limit matching, price-time priority, trade at the resting price. |
| 2.3 | Market orders with an optional protection price, remainder cancelled with `NO_LIQUIDITY` or `PROTECTION_PRICE`. |
| 2.4 | Fill events for both sides, filled value tracked so the average price is derived, queue place kept on a partial fill. |
| 2.5 | `amend.js`: cancel and replace. Smaller size at the same price keeps priority, anything else loses it. |
| 2.6 | IOC, FOK (decided before any trade) and self-trade prevention. `expireAll` for the end of the session. |
| 2.7 | `engine.js`: `applyCommand` and `bookHash`. A test fails if `src/engine` touches a clock, randomness or I/O. |
| 2.8 | 101 tests in total. 100k random commands check I4, I5 and I6 after every command, and a naive reference book agrees on every event of 100k commands. |
| 2.9 | `scripts/benchEngine.js`, baseline in `docs/benchmarks.md`: about 2.3M commands/s on a shallow book, about 1.9M with 5,700 resting orders. |

Notes:

- The engine tests were checked by mutation: 15 deliberate bugs were planted in `src/engine` one at a time and every one made a test fail. The first run missed a replace-with-equal-size bug, because the generator almost never produced one, so the generator now aims replaces at an order's last known price and size.
- Engine events carry prices in whole paise, as ADR 0001 says. The exchange converts at the boundary in Phase 5.
- `applyCommand` takes `{ seq, ts, type, payload }`. The plan names `seq`, `type` and `payload` and says timestamps come from the command, so `ts` is a field of the command. Command types are `NEW_ORDER`, `CANCEL`, `REPLACE` and `EXPIRE`.
- `replace(book, id, newQuantity, newPrice)` takes `newQuantity` as the new total quantity of the order, fills included. A quantity at or below what already filled is refused with `CancelRejected` and reason `INVALID_ORDER`.
- Cancel reason `PROTECTION_PRICE` was added for a market order stopped by its protection price. `NO_LIQUIDITY` is kept for a book that ran dry.
- The seeded generator lives in `test/engine/generator.js` and is shared by the replay test, the random-stream test, the differential test and the benchmark.
- Idempotency by seq (task 6.5) is not in the engine yet. `applyCommand` only records `book.lastSeq`.

## Phase 1: Foundations and domain model (v0.1)

Exit gate: design doc, schema and invariants written down and merged. Met.

| Task | What landed |
|---|---|
| 1.1 | Express app, `server.js`, folder layout, health route with a test, CI workflow against a Postgres container. |
| 1.2 | `docker-compose.yml` with Postgres 16 and Redis 7 (healthchecks, named volumes), kafka profile off by default, `.env.example`, `src/config/db.js`, `npm run check` connects to both. |
| 1.3 | ADR 0001 (`docs/adr`), CI step that fails on `parseFloat` or `toFixed` under `src`. |
| 1.4 | `docs/events.md` with an example for every event, `src/config/events.js`, a test that checks the doc against the constants. |
| 1.5 | `src/config/orderStates.js` with `transition()`, a test over every state and event pair, `docs/order-lifecycle.md`. |
| 1.6 | `docs/invariants.md` mapping I1 to I8 to one check and one owning phase, with a test that enforces the mapping. |
| 1.7 | 14 model files in `src/models`, `scripts/initDb.js`, schema tests against a throwaway database, `docs/schema.md` with the ER diagram. |

Notes:

- Host Postgres port is 5433, because a local Postgres install already uses 5432. CI still uses 5432.
- `events.md` has two events the plan list did not name, `OrderReplaced` and `CancelRejected`, because task 2.5 needs them.
- Schema tests create `brokerage_test` next to the dev database and skip when Postgres is unreachable. CI sets `REQUIRE_DB=1`, so there a missing database fails the build.
- `node scripts/initDb.js --reset` drops the `public` schema. It is for development databases only.
