# ADR 0001: Number and identity conventions

Status: accepted

## Context

This is a trading system. A rounding slip of one paisa breaks the ledger audit, and a float in the wrong place breaks replay (invariant I8). The rules below are fixed once so no later phase has to argue about them.

## Decision

| Thing | Rule |
|---|---|
| Money in the database | `NUMERIC(12,2)`. Never `REAL`, `DOUBLE PRECISION` or `FLOAT`. |
| Average cost | `NUMERIC(12,4)` (only the positions table, see Phase 3). |
| Quantities | Whole shares in `BIGINT`. A quantity is never fractional. |
| Ids | `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`. |
| Timestamps | `TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`. |
| Prices inside the matching engine | Whole paise (integers). 500.00 rupees is 50000 paise. |
| Fees and P&L | Calculated in SQL, never in JavaScript. |

### The one boundary

Rupees become paise in exactly one place: `src/exchange/exchange.js`.

1. The price arrives as a string or number with at most two decimals. Anything with more decimals is rejected before it reaches the engine.
2. The exchange turns it into integer paise and hands that to the engine.
3. Trades come back from the engine in paise and the exchange turns them back into rupees before anything is written to the database.

The engine never sees a rupee value and the database never sees a paise value.

### No float helpers under `src`

`parseFloat` and `toFixed` are banned under `src`. They hide rounding. The CI job greps for them and fails the build if either appears.

Where application code must compare an amount, it uses `Number(value)` for a plain comparison and nothing more. Any arithmetic on money happens in SQL.

## Consequences

- Money maths is done by Postgres `NUMERIC`, so it is exact.
- The engine does integer maths only, so replay is byte-identical on any machine.
- One conversion point means one place to test and one place to get wrong.
- The grep is blunt. If a legitimate use ever appears, change this ADR first, then the check.
