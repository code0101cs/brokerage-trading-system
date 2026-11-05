CREATE TABLE share_entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    transaction_id BIGINT NOT NULL REFERENCES transactions(id),
    symbol VARCHAR(20) NOT NULL REFERENCES instruments(symbol),
    quantity BIGINT NOT NULL CHECK (quantity > 0),
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_share_entries_user ON share_entries (user_id, symbol);
CREATE INDEX idx_share_entries_transaction ON share_entries (transaction_id);
