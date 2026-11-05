CREATE TABLE instruments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    tick_size NUMERIC(12,2) NOT NULL DEFAULT 0.05 CHECK (tick_size > 0),
    lot_size BIGINT NOT NULL DEFAULT 1 CHECK (lot_size > 0),
    reference_price NUMERIC(12,2) NOT NULL CHECK (reference_price > 0),
    max_quantity BIGINT NOT NULL DEFAULT 10000 CHECK (max_quantity > 0),
    band_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00 CHECK (band_pct > 0),
    halted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
