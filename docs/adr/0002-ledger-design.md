# ADR 0002: Ledger design

Status: accepted

## Context

Phase 3 adds money and shares. The same rules that worked for the wallet and ledger project apply: every movement is a pair of rows, nothing is ever edited, and balances are worked out from the rows instead of being stored. Shares get a twin of the cash tables, and open orders reserve money or shares so the same funds cannot back two orders.

## Decision

### Tables

| Table | Role in the ledger |
|---|---|
| users | Traders, bots and the three system accounts. `is_system` is TRUE for the system accounts. |
| wallets | One row per trading user. It exists to be locked: every balance check and write for a user starts with `SELECT ... FOR UPDATE` on that row. |
| transactions | One header row per posting: `idempotency_key` (unique), `kind`, `description`. |
| entries | Cash legs, `NUMERIC(12,2)`. One DEBIT row and one CREDIT row per transfer, tied by `transaction_id`. |
| share_entries | Share legs, `BIGINT` quantity and a `symbol`. Same shape as entries. |
| holds | One reservation per order: `cash_amount`, `share_quantity`, `status` ACTIVE or RELEASED. |
| positions | Quantity, `avg_cost` and `realized_pnl` per user and symbol. A cache of the share ledger plus the cost basis, cross-checked by the audit. |

`instruments`, `orders` and `trades` are read by the ledger code (the symbol list, the order a hold belongs to, the latest trade price) but do not hold balances.

### System accounts

Three ordinary rows in `users` with `is_system = TRUE` and an unusable password hash, created when the schema is built:

| Name | Purpose | Expected balance |
|---|---|---|
| deposits | Source of paper money and paper shares. | Negative, equal to everything handed out. |
| exchange | Clearing. Every trade passes through it. | Zero after every completed trade. |
| fees | Collects brokerage fees. | Only grows. |

Because the names exist as rows, registering one of them fails with 409 like any other taken name. System accounts are never locked and never checked for funds, so they are exempt from invariants I1 and I2.

### Balances are derived

```
cash balance(user)         = SUM(CREDIT amount) - SUM(DEBIT amount)           over entries
share balance(user, sym)   = SUM(CREDIT quantity) - SUM(DEBIT quantity)       over share_entries
held cash(user)            = SUM(cash_amount)    of ACTIVE holds
held shares(user, sym)     = SUM(share_quantity) of ACTIVE holds whose order is in sym
available cash             = cash balance - held cash
available shares           = share balance - held shares
```

Nothing stores a balance. `positions.quantity` is a cache of the share balance, and the audit checks that they agree.

### Transaction kinds and the exact rows each one writes

A "transfer" below is one DEBIT row on the paying account and one CREDIT row on the receiving account, with the same amount.

**DEPOSIT** (cash). Idempotency key: the `idempotency-key` header of the request.

| Table | Rows |
|---|---|
| entries | DEBIT `deposits`, CREDIT the user, amount. |

**DEPOSIT** (shares). Gives a user paper shares, used by tests and the demo. Same kind, share legs instead of cash legs.

| Table | Rows |
|---|---|
| share_entries | DEBIT `deposits`, CREDIT the user, symbol, quantity. |

**TRADE**. One per trade, idempotency key `trade:<trades.id>`. Cash and shares both go through `exchange`, so the clearing account is visibly flat afterwards.

| Table | Rows |
|---|---|
| entries | DEBIT buyer, CREDIT `exchange`, trade value. DEBIT `exchange`, CREDIT seller, trade value. |
| share_entries | DEBIT seller, CREDIT `exchange`, symbol, quantity. DEBIT `exchange`, CREDIT buyer, symbol, quantity. |

Trade value is `quantity * price` and is calculated in SQL.

**FEE**. One per side of a trade, idempotency key `fee:<trades.id>:<user id>`.

| Table | Rows |
|---|---|
| entries | DEBIT the user, CREDIT `fees`, fee amount. |

The fee is `LEAST(CEIL(value * 0.0003 * 100) / 100, 20.00)`: 0.03% of the trade value, rounded up to the next paisa, capped at 20.00. The hold estimate uses the same expression (`src/config/fees.js`).

### Holds

- A buy order holds `quantity * price + fee(quantity * price)`, calculated in SQL. A sell order holds its share quantity.
- The hold is always the reservation for the unfilled part: after a fill the amounts are recomputed from the order's remaining quantity, so held cash and held shares equal the unfilled reservations of open orders (invariant I7).
- A hold is set to RELEASED when the order has nothing left open: filled, cancelled, expired or rejected.
- Wallet rows are locked with `SELECT ... FOR UPDATE` in ascending `user_id` order, so two requests that touch the same pair of users cannot deadlock.

### Rules the database enforces

- `transactions.idempotency_key` is unique, so a repeated posting raises a unique violation (23505) and the caller answers 409.
- Triggers on `entries` and `share_entries` block UPDATE and DELETE. A mistake is fixed by posting a reversing transaction, never by editing a row.
- Every amount has `CHECK (amount > 0)` and the entry type is DEBIT or CREDIT.

### Rules the audit enforces (task 3.7)

Debits equal credits for every transaction in cash and in shares, no non-system balance is negative, each position equals its share ledger, active holds never exceed balances, and the exchange account is flat.

## Consequences

- Any number in the system can be explained by listing rows. History is complete because nothing is edited.
- A balance query reads every entry for a user. That is fine at this scale. If it ever is not, add a cached balance that the audit checks, rather than replacing the derivation.
- Two ledger rows per transfer and four per trade is more writing than a single "from, to" row. In exchange the clearing account makes a broken trade show up as a non-zero `exchange` balance.
