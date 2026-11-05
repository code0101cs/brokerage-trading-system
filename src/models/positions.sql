CREATE TABLE positions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    symbol VARCHAR(20) NOT NULL REFERENCES instruments(symbol),
    quantity BIGINT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    avg_cost NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
    realized_pnl NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, symbol)
);
