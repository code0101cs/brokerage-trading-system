const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { addUser, addInstrument, depositCash, depositShares, key } = require("./helpers/ledger.js");
const { postEntries, systemId } = require("../src/config/ledger.js");
const { buyFill, sellFill } = require("../src/config/positions.js");
const { placeHold } = require("../src/config/holds.js");
const { runAudit, checks } = require("../scripts/audit.js");

const { state, dbTest } = useDb("auditcorrupt");

let a;
let b;
let c;

// Run some damage inside a transaction, audit it, and roll everything back.
// The append-only triggers are switched off inside the transaction too, and that is undone with it.
const damage = async (work) => {
    const client = await state.pool.connect();

    try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE entries DISABLE TRIGGER entries_no_change");
        await client.query("ALTER TABLE share_entries DISABLE TRIGGER share_entries_no_change");

        await work(client);

        const results = await runAudit(client);

        return results.filter((r) => !r.ok).map((r) => r.name).sort();
    } finally {
        await client.query("ROLLBACK");
        client.release();
    }
};

const insertOrder = async (client, userId, side, quantity) => {
    const row = await client.query(
        `INSERT INTO orders
         (user_id, symbol, side, order_type, time_in_force, price, quantity, status, idempotency_key)
         VALUES ($1, 'TCS', $2, 'LIMIT', 'DAY', 500.00, $3, 'ACCEPTED', $4)
         RETURNING id`,
        [userId, side, quantity, key("ord")]
    );

    return row.rows[0].id;
};

// A healthy little world: deposits, one trade through the exchange with fees, and two open orders
dbTest("a healthy ledger passes every check, system accounts and released holds included", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    a = await addUser(state.pool, "audit-a");
    b = await addUser(state.pool, "audit-b");
    c = await addUser(state.pool, "audit-c");

    await depositCash(state.pool, a, "100000.00");
    await depositCash(state.pool, b, "100000.00");
    await depositShares(state.pool, b, "TCS", 100, "500.00");
    await depositShares(state.pool, c, "TCS", 50, "500.00");

    const exchange = await systemId(state.pool, "exchange");
    const fees = await systemId(state.pool, "fees");

    // a buys 10 from b at 500.00, each pays a 1.50 fee
    await postEntries(state.pool, {
        idemp: "t-1",
        kind: "TRADE",
        description: "TCS 10 at 500.00",
        cash: [{ debit: a, credit: exchange, amount: "5000.00" }, { debit: exchange, credit: b, amount: "5000.00" }],
        shares: [{ debit: b, credit: exchange, symbol: "TCS", quantity: 10 }, { debit: exchange, credit: a, symbol: "TCS", quantity: 10 }]
    });
    await postEntries(state.pool, { idemp: "f-1a", kind: "FEE", description: "fee", cash: [{ debit: a, credit: fees, amount: "1.50" }] });
    await postEntries(state.pool, { idemp: "f-1b", kind: "FEE", description: "fee", cash: [{ debit: b, credit: fees, amount: "1.50" }] });
    await buyFill(state.pool, a, "TCS", 10, "500.00");
    await sellFill(state.pool, b, "TCS", 10, "500.00");

    // Open orders that fit: a buys 20, c sells 30
    const buy = await insertOrder(state.pool, a, "BUY", 20);
    const sell = await insertOrder(state.pool, c, "SELL", 30);

    await placeHold(state.pool, a, buy, "10003.00", 0);
    await placeHold(state.pool, c, sell, "0.00", 30);

    // A released hold with a silly amount does not count
    const done = await insertOrder(state.pool, a, "BUY", 1);

    await placeHold(state.pool, a, done, "999999999.00", 0);
    await state.pool.query("UPDATE holds SET status = 'RELEASED' WHERE order_id = $1", [done]);

    const results = await runAudit(state.pool);

    assert.strictEqual(results.length, checks.length);
    assert.deepStrictEqual(results.filter((r) => !r.ok), []);
});

dbTest("a debit with no matching credit is caught as debits not equal to credits", async () => {
    const failed = await damage((cl) =>
        cl.query("INSERT INTO entries (user_id, transaction_id, amount, entry_type) VALUES ($1, 1, 5.00, 'DEBIT')", [a])
    );

    assert.ok(failed.includes("debits_equal_credits"), failed.join());
});

dbTest("a credit amount edited by hand is caught", async () => {
    const failed = await damage((cl) =>
        cl.query("UPDATE entries SET amount = amount + 1 WHERE id = (SELECT min(id) FROM entries WHERE entry_type = 'CREDIT')")
    );

    assert.ok(failed.includes("debits_equal_credits"), failed.join());
});

dbTest("a credit row deleted by hand is caught", async () => {
    const failed = await damage((cl) =>
        cl.query("DELETE FROM entries WHERE id = (SELECT min(id) FROM entries WHERE entry_type = 'CREDIT')")
    );

    assert.ok(failed.includes("debits_equal_credits"), failed.join());
});

dbTest("a share credit with no debit is caught, and so is the position that no longer matches", async () => {
    const failed = await damage((cl) =>
        cl.query("INSERT INTO share_entries (user_id, transaction_id, symbol, quantity, entry_type) VALUES ($1, 1, 'TCS', 5, 'CREDIT')", [c])
    );

    assert.deepStrictEqual(failed, ["debits_equal_credits", "positions_match_share_entries"]);
});

dbTest("a position edited by hand no longer matches the share ledger", async () => {
    const failed = await damage((cl) => cl.query("UPDATE positions SET quantity = quantity + 1 WHERE user_id = $1", [b]));

    assert.deepStrictEqual(failed, ["positions_match_share_entries"]);
});

dbTest("a position row that the ledger knows nothing about is caught", async () => {
    const failed = await damage(async (cl) => {
        const ghost = await cl.query("INSERT INTO users (name, password_hash) VALUES ('ghost', 'x') RETURNING id");

        await cl.query("INSERT INTO positions (user_id, symbol, quantity, avg_cost) VALUES ($1, 'TCS', 7, 500)", [ghost.rows[0].id]);
    });

    assert.deepStrictEqual(failed, ["positions_match_share_entries"]);
});

dbTest("a balanced transaction that overdraws a user is caught as negative cash only", async () => {
    const fees = await systemId(state.pool, "fees");

    const failed = await damage((cl) =>
        postEntries(cl, { idemp: key("over"), kind: "FEE", description: "x", cash: [{ debit: c, credit: fees, amount: "10000000.00" }] })
    );

    assert.deepStrictEqual(failed, ["cash_never_negative"]);
});

dbTest("a balanced transaction that takes more shares than a user has is caught", async () => {
    const deposits = await systemId(state.pool, "deposits");

    const failed = await damage((cl) =>
        postEntries(cl, { idemp: key("short"), kind: "TRADE", description: "x", shares: [{ debit: c, credit: deposits, symbol: "TCS", quantity: 1000 }] })
    );

    assert.ok(failed.includes("positions_never_negative"), failed.join());
});

dbTest("an active cash hold above the balance is caught", async () => {
    const failed = await damage(async (cl) => {
        const id = await insertOrder(cl, b, "BUY", 1);

        await placeHold(cl, b, id, "999999999.00", 0);
    });

    assert.deepStrictEqual(failed, ["holds_within_balances"]);
});

dbTest("an active share hold above the shares owned is caught", async () => {
    const failed = await damage(async (cl) => {
        const id = await insertOrder(cl, c, "SELL", 1);

        await placeHold(cl, c, id, "0.00", 10000);
    });

    assert.deepStrictEqual(failed, ["holds_within_balances"]);
});

dbTest("cash left sitting in the exchange account is caught", async () => {
    const exchange = await systemId(state.pool, "exchange");

    const failed = await damage((cl) =>
        postEntries(cl, { idemp: key("stuck"), kind: "TRADE", description: "x", cash: [{ debit: a, credit: exchange, amount: "1.00" }] })
    );

    assert.deepStrictEqual(failed, ["exchange_is_flat"]);
});

dbTest("shares left sitting in the exchange account are caught", async () => {
    const exchange = await systemId(state.pool, "exchange");

    const failed = await damage((cl) =>
        postEntries(cl, { idemp: key("stuck"), kind: "TRADE", description: "x", shares: [{ debit: c, credit: exchange, symbol: "TCS", quantity: 1 }] })
    );

    assert.ok(failed.includes("exchange_is_flat"), failed.join());
});

dbTest("a transaction header with no rows is caught", async () => {
    const failed = await damage((cl) =>
        cl.query("INSERT INTO transactions (idempotency_key, kind) VALUES ('empty', 'TRADE')")
    );

    assert.deepStrictEqual(failed, ["every_transaction_has_entries"]);
});

dbTest("after all that damage was rolled back the ledger is healthy again", async () => {
    const results = await runAudit(state.pool);

    assert.deepStrictEqual(results.filter((r) => !r.ok), []);
});
