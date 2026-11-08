const test = require("node:test");
const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { addUser, addInstrument, balance, shareBalance, key, depositCash, depositShares } = require("./helpers/ledger.js");
const { postEntries, systemId } = require("../src/config/ledger.js");

const { state, dbTest } = useDb("ledger");

// Run work inside the caller's BEGIN and COMMIT, the way a handler does
const inTx = async (work) => {
    const client = await state.pool.connect();

    try {
        await client.query("BEGIN");

        const out = await work(client);

        await client.query("COMMIT");

        return out;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

const rowsOf = async (transId) => {
    const rows = await state.pool.query("SELECT user_id, amount, entry_type FROM entries WHERE transaction_id = $1 ORDER BY id", [transId]);

    return rows.rows;
};

dbTest("postEntries writes the transaction row and a DEBIT and a CREDIT row tied by its id", async () => {
    const deposits = await systemId(state.pool, "deposits");
    const alice = await addUser(state.pool, "alice");

    const transId = await inTx((client) =>
        postEntries(client, { idemp: "first-deposit", kind: "DEPOSIT", description: "start money", cash: [{ debit: deposits, credit: alice, amount: "1000000.00" }] })
    );

    const trans = await state.pool.query("SELECT idempotency_key, kind, description FROM transactions WHERE id = $1", [transId]);

    assert.deepStrictEqual(trans.rows, [{ idempotency_key: "first-deposit", kind: "DEPOSIT", description: "start money" }]);
    assert.deepStrictEqual(await rowsOf(transId), [
        { user_id: deposits, amount: "1000000.00", entry_type: "DEBIT" },
        { user_id: alice, amount: "1000000.00", entry_type: "CREDIT" }
    ]);
    assert.strictEqual(await balance(state.pool, alice), "1000000.00");
    assert.strictEqual(await balance(state.pool, deposits), "-1000000.00");
});

dbTest("a repeated idempotency key raises a unique violation and writes nothing", async () => {
    const deposits = await systemId(state.pool, "deposits");
    const bob = await addUser(state.pool, "bob");
    const post = (client) => postEntries(client, { idemp: "same-key", kind: "DEPOSIT", description: "x", cash: [{ debit: deposits, credit: bob, amount: "50.00" }] });

    await inTx(post);

    await assert.rejects(inTx(post), (e) => e.code === "23505");

    // The second attempt rolled back whole
    assert.strictEqual(await balance(state.pool, bob), "50.00");
});

dbTest("a rollback by the caller leaves no transaction and no entries behind", async () => {
    const deposits = await systemId(state.pool, "deposits");
    const carol = await addUser(state.pool, "carol");

    await assert.rejects(
        inTx(async (client) => {
            await postEntries(client, { idemp: "rolled-back", kind: "DEPOSIT", description: "x", cash: [{ debit: deposits, credit: carol, amount: "10.00" }] });
            throw new Error("something later failed");
        }),
        /something later failed/
    );

    const t = await state.pool.query("SELECT 1 FROM transactions WHERE idempotency_key = 'rolled-back'");

    assert.strictEqual(t.rows.length, 0);
    assert.strictEqual(await balance(state.pool, carol), "0");
});

dbTest("an UPDATE or DELETE on entries fails", async () => {
    const grace = await addUser(state.pool, "grace");

    await depositCash(state.pool, grace, "5.00");

    const rows = await state.pool.query("SELECT id FROM entries WHERE user_id = $1", [grace]);
    const id = rows.rows[0].id;

    await assert.rejects(state.pool.query("UPDATE entries SET amount = 1 WHERE id = $1", [id]), /UPDATE on entries is not allowed/);
    await assert.rejects(state.pool.query("DELETE FROM entries WHERE id = $1", [id]), /DELETE on entries is not allowed/);

    // Even a bulk statement that matches nothing special is blocked row by row
    await assert.rejects(state.pool.query("UPDATE entries SET created_at = created_at"), /not allowed/);
});

dbTest("share legs are written to share_entries and an UPDATE or DELETE there fails", async () => {
    const deposits = await systemId(state.pool, "deposits");
    const dave = await addUser(state.pool, "dave");

    await addInstrument(state.pool, "TCS", "500.00");

    const transId = await inTx((client) =>
        postEntries(client, { idemp: key("sh"), kind: "DEPOSIT", description: "shares", shares: [{ debit: deposits, credit: dave, symbol: "TCS", quantity: 100 }] })
    );

    const rows = await state.pool.query("SELECT user_id, symbol, quantity, entry_type FROM share_entries WHERE transaction_id = $1 ORDER BY id", [transId]);

    assert.deepStrictEqual(rows.rows, [
        { user_id: deposits, symbol: "TCS", quantity: 100, entry_type: "DEBIT" },
        { user_id: dave, symbol: "TCS", quantity: 100, entry_type: "CREDIT" }
    ]);
    assert.strictEqual(await shareBalance(state.pool, dave, "TCS"), "100");

    await assert.rejects(state.pool.query("UPDATE share_entries SET quantity = 1 WHERE transaction_id = $1", [transId]), /UPDATE on share_entries is not allowed/);
    await assert.rejects(state.pool.query("DELETE FROM share_entries WHERE transaction_id = $1", [transId]), /DELETE on share_entries is not allowed/);
});

dbTest("a trade through the exchange balances in cash and shares and leaves the exchange flat", async () => {
    const exchange = await systemId(state.pool, "exchange");
    const buyer = await addUser(state.pool, "buyer");
    const seller = await addUser(state.pool, "seller");

    await depositCash(state.pool, buyer, "100000.00");
    await depositShares(state.pool, seller, "TCS", 100);

    const transId = await inTx((client) =>
        postEntries(client, {
            idemp: "trade:1",
            kind: "TRADE",
            description: "TCS 60 at 500.00",
            cash: [
                { debit: buyer, credit: exchange, amount: "30000.00" },
                { debit: exchange, credit: seller, amount: "30000.00" }
            ],
            shares: [
                { debit: seller, credit: exchange, symbol: "TCS", quantity: 60 },
                { debit: exchange, credit: buyer, symbol: "TCS", quantity: 60 }
            ]
        })
    );

    assert.strictEqual(await balance(state.pool, buyer), "70000.00");
    assert.strictEqual(await balance(state.pool, seller), "30000.00");
    assert.strictEqual(await shareBalance(state.pool, buyer, "TCS"), "60");
    assert.strictEqual(await shareBalance(state.pool, seller, "TCS"), "40");

    // The clearing account nets to zero
    assert.strictEqual(await balance(state.pool, exchange), "0.00");
    assert.strictEqual(await shareBalance(state.pool, exchange, "TCS"), "0");

    const cash = await state.pool.query("SELECT count(*) AS n FROM entries WHERE transaction_id = $1", [transId]);
    const shares = await state.pool.query("SELECT count(*) AS n FROM share_entries WHERE transaction_id = $1", [transId]);

    assert.strictEqual(cash.rows[0].n, 4);
    assert.strictEqual(shares.rows[0].n, 4);
});

dbTest("debits equal credits for every transaction, in cash and in shares", async () => {
    const cash = await state.pool.query(
        `SELECT transaction_id
         FROM entries
         GROUP BY transaction_id
         HAVING SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END)
             <> SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)`
    );
    const shares = await state.pool.query(
        `SELECT transaction_id, symbol
         FROM share_entries
         GROUP BY transaction_id, symbol
         HAVING SUM(CASE WHEN entry_type = 'DEBIT' THEN quantity ELSE 0 END)
             <> SUM(CASE WHEN entry_type = 'CREDIT' THEN quantity ELSE 0 END)`
    );

    assert.strictEqual(cash.rows.length, 0);
    assert.strictEqual(shares.rows.length, 0);
});

dbTest("bad legs are refused before or by the database", async () => {
    const eve = await addUser(state.pool, "eve");
    const frank = await addUser(state.pool, "frank");

    // Same account on both sides, and nothing to post
    await assert.rejects(inTx((c) => postEntries(c, { idemp: key("bad"), kind: "TRADE", description: "x", cash: [{ debit: eve, credit: eve, amount: "1.00" }] })), /different accounts/);
    await assert.rejects(inTx((c) => postEntries(c, { idemp: key("bad"), kind: "TRADE", description: "x" })), /Nothing to post/);

    // Zero or negative amount, unknown kind
    await assert.rejects(inTx((c) => postEntries(c, { idemp: key("bad"), kind: "TRADE", description: "x", cash: [{ debit: eve, credit: frank, amount: "0.00" }] })), (e) => e.code === "23514");
    await assert.rejects(inTx((c) => postEntries(c, { idemp: key("bad"), kind: "GIFT", description: "x", cash: [{ debit: eve, credit: frank, amount: "1.00" }] })), (e) => e.code === "23514");

    // Unknown user is blocked by the foreign key
    await assert.rejects(inTx((c) => postEntries(c, { idemp: key("bad"), kind: "TRADE", description: "x", cash: [{ debit: eve, credit: 999999, amount: "1.00" }] })), (e) => e.code === "23503");

    assert.strictEqual(await balance(state.pool, eve), "0");
});
