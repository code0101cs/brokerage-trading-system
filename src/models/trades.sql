CREATE TABLE trades (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trade_id VARCHAR(60) NOT NULL UNIQUE,
    symbol VARCHAR(20) NOT NULL REFERENCES instruments(symbol),
    price NUMERIC(12,2) NOT NULL CHECK (price > 0),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    buy_order_id BIGINT NOT NULL REFERENCES orders(id),
    sell_order_id BIGINT NOT NULL REFERENCES orders(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CHECK (buy_order_id <> sell_order_id)
);

CREATE INDEX idx_trades_symbol ON trades (symbol, id);
