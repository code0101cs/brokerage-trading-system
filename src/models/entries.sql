CREATE TABLE entries (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    transaction_id BIGINT NOT NULL REFERENCES transactions(id),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entries_user ON entries (user_id);
CREATE INDEX idx_entries_transaction ON entries (transaction_id);

CREATE FUNCTION block_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed, the table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_no_change
BEFORE UPDATE OR DELETE ON entries
FOR EACH ROW EXECUTE FUNCTION block_change();
