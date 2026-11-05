# Invariants

Eight rules that must stay true in every phase. Each one has exactly one named check and one owning phase, the phase where that check is written. Later phases keep running it.

| ID | Rule | Kind | Check name | Where it lives | Owning phase |
|---|---|---|---|---|---|
| I1 | No account cash balance is ever negative | SQL audit | `cash_never_negative` | scripts/audit.js | Phase 3 (task 3.7) |
| I2 | No security position is ever negative (no short selling in v1) | SQL audit | `positions_never_negative` | scripts/audit.js | Phase 3 (task 3.7) |
| I3 | Every ledger transaction has debits equal to credits | SQL audit | `debits_equal_credits` | scripts/audit.js | Phase 3 (task 3.7) |
| I4 | After every command, the order book is not crossed | random-stream test | `book_never_crossed` | test/engine/randomStream.test.js | Phase 2 (task 2.8) |
| I5 | For each order, filled + remaining + cancelled quantity equals original quantity | random-stream test | `order_quantity_conserved` | test/engine/randomStream.test.js | Phase 2 (task 2.8) |
| I6 | Each trade has equal buy and sell quantity, and its price respects both orders' limits | random-stream test | `trade_respects_limits` | test/engine/randomStream.test.js | Phase 2 (task 2.8) |
| I7 | Held cash and held shares equal the unfilled reservations of open orders | SQL audit | `holds_match_open_orders` | scripts/audit.js | Phase 5 (task 5.4) |
| I8 | Replaying the event log from empty reproduces the same book, ledger and positions | replay test | `replay_reproduces_state` | scripts/crashTest.js | Phase 6 (task 6.6) |

## How each check works

### I1: `cash_never_negative`

For every user, `SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END)` over `entries` is at least 0. System users are exempt: `deposits` is the source of paper money and ends up negative by design. Fails with the offending user ids.

### I2: `positions_never_negative`

For every user and symbol, `SUM(CASE ...)` over `share_entries` is at least 0, and `positions.quantity` is at least 0. The `exchange` clearing user is exempt on the same grounds as above.

### I3: `debits_equal_credits`

Grouped by `transaction_id`, the sum of DEBIT amounts equals the sum of CREDIT amounts in `entries`, and the same for quantities in `share_entries`. Any transaction with no rows on one side fails too.

### I4: `book_never_crossed`

After every command in the seeded random stream, `bestBid(book) < bestAsk(book)` whenever both sides are non-empty.

### I5: `order_quantity_conserved`

The random-stream test tracks every order it sends. After every command, each order satisfies `filled + remaining + cancelled = original`, where `remaining` is zero once the order is finished.

### I6: `trade_respects_limits`

For each TradeExecuted in the stream, buy quantity equals sell quantity (one `quantity` field read back against both orders' fill events). The trade price is at or below the buyer's limit and at or above the seller's limit. Market orders are exempt from the limit side of the check.

### I7: `holds_match_open_orders`

For each user, `SUM(holds.cash_amount)` over ACTIVE holds equals the unfilled reservation of their open buy orders, and active share holds equal the unfilled quantity of their open sell orders. It becomes checkable in Phase 5, when fills start reducing holds. Phases 3 and 4 only assert that active holds never exceed balances.

### I8: `replay_reproduces_state`

Run a session, record the book hash, balances and positions, rebuild everything from the empty event log and compare. Phase 2 already proves the engine half (`bookHash` is identical on replay, task 2.7). Phase 6 owns the full check because it includes the ledger and positions.

## Reporting

`scripts/audit.js` is extended over the phases and in task 8.5 prints one PASS or FAIL line per invariant. The three test-based checks are listed there as test results rather than SQL.
