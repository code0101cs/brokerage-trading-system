const test = require("node:test");
const assert = require("node:assert");

const { initDb, tables } = require("../scripts/initDb.js");
const { STATES } = require("../src/config/orderStates.js");
const { useDb } = require("./helpers/db.js");

const { state, dbTest } = useDb("schema");

dbTest("initDb builds an empty database with every table", async () => {
    const rows = await state.pool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'`
    );

    assert.deepStrictEqual(rows.rows.map((r) => r.table_name).sort(), [...tables].sort());
    assert.strictEqual(tables.length, 14);
});

dbTest("initDb with reset can run twice", async () => {
    await initDb(state.pool, true);
});

dbTest("initDb without reset fails and leaves the tables alone", async () => {
    await assert.rejects(initDb(state.pool, false), /already exists/);

    const rows = await state.pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'");

    assert.strictEqual(Number(rows.rows[0].n), 14);
});

dbTest("every table has a BIGINT identity primary key named id", async () => {
    const rows = await state.pool.query(
        `SELECT table_name, data_type, is_identity, identity_generation
         FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'id'`
    );

    assert.strictEqual(rows.rows.length, 14);

    for (const row of rows.rows) {
        assert.strictEqual(row.data_type, "bigint", row.table_name);
        assert.strictEqual(row.is_identity, "YES", row.table_name);
        assert.strictEqual(row.identity_generation, "ALWAYS", row.table_name);
    }
});

dbTest("every idempotency column is unique", async () => {
    const rows = await state.pool.query(
        `SELECT t.relname AS table_name
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
         WHERE c.contype = 'u' AND a.attname = 'idempotency_key'`
    );

    assert.deepStrictEqual(rows.rows.map((r) => r.table_name).sort(), ["orders", "transactions"]);
});

dbTest("the indexes from the plan exist", async () => {
    const rows = await state.pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'");
    const defs = rows.rows.map((r) => r.indexdef);

    assert.ok(defs.some((d) => d.includes("ON public.orders") && d.includes("(symbol, status)")));
    assert.ok(defs.some((d) => d.includes("ON public.entries") && d.includes("(user_id)")));
});

dbTest("orders status check matches the state machine", async () => {
    const rows = await state.pool.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relname = 'orders' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%status%'`
    );

    assert.strictEqual(rows.rows.length, 1);

    const found = [...rows.rows[0].def.matchAll(/'([A-Z_]+)'::/g)].map((m) => m[1]);

    assert.deepStrictEqual(found.sort(), [...STATES].sort());
});

dbTest("constraints reject bad rows", async () => {
    await state.pool.query("INSERT INTO users (name, password_hash) VALUES ('u1', 'x')");
    await state.pool.query("INSERT INTO instruments (symbol, name, reference_price) VALUES ('TCS', 'Tata', 500.00)");

    const order = (qty, status, key, type = "LIMIT", price = 500) =>
        state.pool.query(
            `INSERT INTO orders
             (user_id, symbol, side, order_type, time_in_force, price, quantity, status, idempotency_key)
             VALUES (1, 'TCS', 'BUY', $4, 'DAY', $5, $1, $2, $3)`,
            [qty, status, key, type, price]
        );

    await order(10, "NEW", "k1");

    // Duplicate idempotency key
    await assert.rejects(order(10, "NEW", "k1"), (e) => e.code === "23505");

    // Quantity must be positive
    await assert.rejects(order(0, "NEW", "k2"), (e) => e.code === "23514");

    // Status must be a known state
    await assert.rejects(order(10, "BOGUS", "k3"), (e) => e.code === "23514");

    // A limit order needs a price
    await assert.rejects(order(10, "NEW", "k4", "LIMIT", null), (e) => e.code === "23514");

    // A market order does not
    await order(10, "NEW", "k5", "MARKET", null);

    // Unknown symbol is blocked by the foreign key
    await assert.rejects(
        state.pool.query(
            `INSERT INTO orders
             (user_id, symbol, side, order_type, time_in_force, price, quantity, status, idempotency_key)
             VALUES (1, 'NOPE', 'BUY', 'LIMIT', 'DAY', 1, 1, 'NEW', 'k6')`
        ),
        (e) => e.code === "23503"
    );

    // Filled cannot pass the quantity
    await assert.rejects(state.pool.query("UPDATE orders SET filled_quantity = 11 WHERE idempotency_key = 'k1'"), (e) => e.code === "23514");
});

dbTest("ledger and trade constraints", async () => {
    await state.pool.query("INSERT INTO transactions (idempotency_key, kind) VALUES ('t1', 'DEPOSIT')");

    // Duplicate transaction key
    await assert.rejects(state.pool.query("INSERT INTO transactions (idempotency_key, kind) VALUES ('t1', 'DEPOSIT')"), (e) => e.code === "23505");

    // Unknown kind
    await assert.rejects(state.pool.query("INSERT INTO transactions (idempotency_key, kind) VALUES ('t2', 'GIFT')"), (e) => e.code === "23514");

    // Entry amounts are positive and typed
    await assert.rejects(state.pool.query("INSERT INTO entries (user_id, transaction_id, amount, entry_type) VALUES (1, 1, 0, 'DEBIT')"), (e) => e.code === "23514");
    await assert.rejects(state.pool.query("INSERT INTO entries (user_id, transaction_id, amount, entry_type) VALUES (1, 1, 5, 'SIDEWAYS')"), (e) => e.code === "23514");

    // Share quantity is positive
    await assert.rejects(state.pool.query("INSERT INTO share_entries (user_id, transaction_id, symbol, quantity, entry_type) VALUES (1, 1, 'TCS', 0, 'CREDIT')"), (e) => e.code === "23514");

    // One hold per order
    await state.pool.query("INSERT INTO holds (user_id, order_id, cash_amount) VALUES (1, 1, 100)");
    await assert.rejects(state.pool.query("INSERT INTO holds (user_id, order_id, cash_amount) VALUES (1, 1, 100)"), (e) => e.code === "23505");

    // Event stream positions are unique per stream
    await state.pool.query("INSERT INTO events (stream, stream_seq, type, payload) VALUES ('TCS', 1, 'OrderAccepted', '{}')");
    await assert.rejects(state.pool.query("INSERT INTO events (stream, stream_seq, type, payload) VALUES ('TCS', 1, 'OrderAccepted', '{}')"), (e) => e.code === "23505");

    // Money has two decimals and no more
    await state.pool.query("INSERT INTO entries (user_id, transaction_id, amount, entry_type) VALUES (1, 1, 10.019, 'CREDIT')");

    const rows = await state.pool.query("SELECT amount FROM entries WHERE amount > 0");

    assert.strictEqual(rows.rows[0].amount, "10.02");
});
