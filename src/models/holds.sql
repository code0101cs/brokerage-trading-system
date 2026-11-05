CREATE TABLE holds (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id),
    cash_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
    share_quantity BIGINT NOT NULL DEFAULT 0 CHECK (share_quantity >= 0),
    status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_holds_user_status ON holds (user_id, status);
