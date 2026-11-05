CREATE TABLE settlements (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trade_id BIGINT NOT NULL UNIQUE REFERENCES trades(id),
    trade_date DATE NOT NULL,
    settlement_date DATE NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SETTLED')),
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CHECK (settlement_date >= trade_date)
);

CREATE INDEX idx_settlements_due ON settlements (settlement_date, status);
