CREATE TABLE orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    symbol VARCHAR(20) NOT NULL REFERENCES instruments(symbol),
    side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type VARCHAR(10) NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT')),
    time_in_force VARCHAR(3) NOT NULL CHECK (time_in_force IN ('DAY', 'IOC', 'FOK')),
    price NUMERIC(12,2) CHECK (price > 0),
    protection_price NUMERIC(12,2) CHECK (protection_price > 0),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    filled_quantity BIGINT NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0 AND filled_quantity <= quantity),
    status VARCHAR(20) NOT NULL CHECK (status IN ('NEW', 'PENDING_RISK', 'REJECTED', 'ACCEPTED', 'WORKING', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELLED', 'EXPIRED')),
    reject_reason VARCHAR(100),
    idempotency_key VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CHECK (order_type = 'MARKET' OR price IS NOT NULL)
);

CREATE INDEX idx_orders_symbol_status ON orders (symbol, status);
