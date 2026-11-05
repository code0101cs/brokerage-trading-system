CREATE TABLE events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stream VARCHAR(20) NOT NULL,
    stream_seq BIGINT NOT NULL CHECK (stream_seq > 0),
    type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (stream, stream_seq)
);
