# Progress

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
