# Progress

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
