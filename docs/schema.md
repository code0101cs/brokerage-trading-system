# Database schema v1

One `.sql` file per table in `src/models`. `node scripts/initDb.js` builds an empty database in dependency order inside one transaction, so a failure leaves nothing half built. `node scripts/initDb.js --reset` drops the `public` schema first, and it is meant for development databases only.

## ER diagram

```mermaid
erDiagram
    users ||--o| wallets : has
    users ||--o{ orders : places
    users ||--o{ entries : "cash ledger"
    users ||--o{ share_entries : "share ledger"
    users ||--o{ holds : reserves
    users ||--o{ positions : owns

    instruments ||--o{ orders : "traded in"
    instruments ||--o{ trades : "traded in"
    instruments ||--o{ share_entries : "shares of"
    instruments ||--o{ positions : "position in"

    orders ||--o{ order_events : "lifecycle log"
    orders ||--o| holds : "one hold each"
    orders ||--o{ trades : "buy side"
    orders ||--o{ trades : "sell side"

    trades ||--o| settlements : "settles"

    transactions ||--|{ entries : "debit and credit rows"
    transactions ||--o{ share_entries : "share legs"

    users {
        bigint id PK
        varchar name UK
        varchar password_hash
        boolean is_system
    }
    wallets {
        bigint id PK
        bigint user_id FK
    }
    instruments {
        bigint id PK
        varchar symbol UK
        numeric tick_size
        bigint lot_size
        numeric reference_price
        bigint max_quantity
        numeric band_pct
        boolean halted
    }
    orders {
        bigint id PK
        bigint user_id FK
        varchar symbol FK
        varchar side
        varchar order_type
        varchar time_in_force
        numeric price
        bigint quantity
        bigint filled_quantity
        varchar status
        varchar reject_reason
        varchar idempotency_key UK
    }
    order_events {
        bigint id PK
        bigint order_id FK
        varchar event
        varchar from_status
        varchar to_status
        jsonb detail
    }
    trades {
        bigint id PK
        varchar trade_id UK
        varchar symbol FK
        numeric price
        bigint quantity
        bigint buy_order_id FK
        bigint sell_order_id FK
    }
    transactions {
        bigint id PK
        varchar idempotency_key UK
        varchar kind
        varchar description
    }
    entries {
        bigint id PK
        bigint user_id FK
        bigint transaction_id FK
        numeric amount
        varchar entry_type
    }
    share_entries {
        bigint id PK
        bigint user_id FK
        bigint transaction_id FK
        varchar symbol FK
        bigint quantity
        varchar entry_type
    }
    holds {
        bigint id PK
        bigint user_id FK
        bigint order_id FK
        numeric cash_amount
        bigint share_quantity
        varchar status
    }
    positions {
        bigint id PK
        bigint user_id FK
        varchar symbol FK
        bigint quantity
        numeric avg_cost
        numeric realized_pnl
    }
    settlements {
        bigint id PK
        bigint trade_id FK
        date trade_date
        date settlement_date
        varchar status
        timestamptz settled_at
    }
    events {
        bigint id PK
        varchar stream
        bigint stream_seq
        varchar type
        jsonb payload
    }
    outbox {
        bigint id PK
        varchar type
        jsonb payload
        timestamptz published_at
    }
```

`events` and `outbox` have no foreign keys on purpose. `events` is the append-only command log keyed by stream (the symbol), and `outbox` is a queue of messages to publish. Both must stay writable on their own.

## Tables

| Table | Job | Phase that fills it |
|---|---|---|
| users | Traders, bots and the system accounts (`deposits`, `exchange`, `fees`). | 3 |
| wallets | One row per user that can hold cash. | 3 |
| instruments | The tradable symbols with tick size, lot size, reference price and limits. | 7 (seed), read from 4 |
| orders | Every order and its current status. | 4 |
| order_events | One row per status change, the order's lifecycle log. | 4 |
| trades | One row per match, `trade_id` unique so a repeat is detected. | 5 |
| transactions | Header of each ledger posting: DEPOSIT, TRADE or FEE. | 3 |
| entries | Cash legs, a DEBIT and a CREDIT per transaction. Balances are derived with `SUM(CASE ...)`. | 3 |
| share_entries | The same for shares. | 3 |
| holds | One reservation per order. Available cash is balance minus active holds. | 3 and 4 |
| positions | Quantity, average cost and realised P&L per user and symbol. | 3 and 5 |
| settlements | One row per trade, PENDING until the settlement date. | 5 |
| events | Append-only command log, a global id plus a per-symbol sequence. | 6 |
| outbox | Messages written with each state change and published later. | 6 |

## Rules every table follows

- `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
- Foreign keys are inline and the types match on both sides.
- Fixed sets use `CHECK (col IN (...))`, quantities use `CHECK (quantity > 0)`, and money is `NUMERIC(12,2)` (ADR 0001).
- Every idempotency column has a unique key: `orders.idempotency_key`, `transactions.idempotency_key`, `trades.trade_id` and `events (stream, stream_seq)`. `settlements.trade_id` and `holds.order_id` are unique so a repeat cannot create a second row.
- Indexes: `orders (symbol, status)`, `entries (user_id)`, plus the lookups the later phases hit (see the model files).

## Added later

The triggers that block UPDATE and DELETE on `entries` and `share_entries` come with task 3.2, and the ones on `events` with task 6.1. `book_snapshots` (6.3) and `candles` (7.4) are new tables in those phases.
