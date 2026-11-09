const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, depositShares, balance, key } = require("./helpers/ledger.js");
const { availableCash, availableShares } = require("../src/config/holds.js");
const { runAudit } = require("../scripts/audit.js");

const { state, dbTest } = useDb("concurrency");
const { call, signUp } = useServer();

const place = (who, body) => call("POST", "/orders", { token: who.token, key: key("x"), body: { symbol: "TCS", orderType: "LIMIT", price: "500.00", ...body } });

const tally = (all) => {
    const out = {};

    for (const r of all) {
        const k = r.status === 201 ? "201" : `${r.status} ${r.body.error}`;

        out[k] = (out[k] || 0) + 1;
    }

    return out;
};

dbTest("setup: TCS", async () => {
    await addInstrument(state.pool, "TCS", "500.00");
});

dbTest("50 simultaneous buys, each costing a third of the balance: exactly 3 get 201, 47 get Insufficient balance", async () => {
    const user = await signUp("cora");

    // One order is 100 x 500.00 = 50000.00 plus a 15.00 fee, so three orders are exactly 150045.00
    await depositCash(state.pool, user.userId, "150045.00");

    const all = await Promise.all(Array.from({ length: 50 }, () => place(user, { side: "BUY", quantity: 100 })));

    assert.deepStrictEqual(tally(all), { 201: 3, "400 Insufficient balance": 47 });

    // Three accepted orders with a hold each, 47 rejected with none, nothing spent yet
    const orders = await state.pool.query("SELECT status, count(*) AS n FROM orders WHERE user_id = $1 GROUP BY status ORDER BY status", [user.userId]);

    assert.deepStrictEqual(orders.rows, [{ status: "ACCEPTED", n: 3 }, { status: "REJECTED", n: 47 }]);

    const holds = await state.pool.query("SELECT count(*) AS n, SUM(cash_amount) AS total FROM holds WHERE user_id = $1 AND status = 'ACTIVE'", [user.userId]);

    assert.deepStrictEqual(holds.rows[0], { n: 3, total: "150045.00" });
    assert.strictEqual(await availableCash(state.pool, user.userId), "0.00");
    assert.strictEqual(await balance(state.pool, user.userId), "150045.00");

    const rejected = await state.pool.query("SELECT DISTINCT reject_reason FROM orders WHERE user_id = $1 AND status = 'REJECTED'", [user.userId]);

    assert.deepStrictEqual(rejected.rows, [{ reject_reason: "Insufficient balance" }]);

    const results = await runAudit(state.pool);

    for (const r of results) {
        assert.ok(r.ok, `${r.name} failed: ${JSON.stringify(r.rows.slice(0, 3))}`);
    }
});

dbTest("50 simultaneous sells, each a third of the shares: exactly 3 get 201, 47 get Insufficient shares", async () => {
    const user = await signUp("sean");

    await depositShares(state.pool, user.userId, "TCS", 300, "500.00");

    const all = await Promise.all(Array.from({ length: 50 }, () => place(user, { side: "SELL", quantity: 100 })));

    assert.deepStrictEqual(tally(all), { 201: 3, "400 Insufficient shares": 47 });
    assert.strictEqual(await availableShares(state.pool, user.userId, "TCS"), 0);

    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("buys and sells of one user at the same time do not use up each other's limits", async () => {
    const user = await signUp("beth");

    await depositCash(state.pool, user.userId, "150045.00");
    await depositShares(state.pool, user.userId, "TCS", 300, "500.00");

    const all = await Promise.all(
        Array.from({ length: 50 }, (_, i) => place(user, { side: i % 2 === 0 ? "BUY" : "SELL", quantity: 100 }))
    );

    const buys = all.filter((_, i) => i % 2 === 0);
    const sells = all.filter((_, i) => i % 2 === 1);

    assert.deepStrictEqual(tally(buys), { 201: 3, "400 Insufficient balance": 22 });
    assert.deepStrictEqual(tally(sells), { 201: 3, "400 Insufficient shares": 22 });
    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("many users ordering at once each get exactly their own limit", async () => {
    const users = [];

    for (let i = 0; i < 10; i++) {
        const u = await signUp(`multi-${i}`);

        // Room for 2 orders of 50015.00, not 3
        await depositCash(state.pool, u.userId, "100030.00");
        users.push(u);
    }

    const calls = [];

    for (let round = 0; round < 5; round++) {
        for (const u of users) {
            calls.push(place(u, { side: "BUY", quantity: 100 }));
        }
    }

    const all = await Promise.all(calls);

    assert.deepStrictEqual(tally(all), { 201: 20, "400 Insufficient balance": 30 });

    for (const u of users) {
        const accepted = await state.pool.query("SELECT count(*) AS n FROM orders WHERE user_id = $1 AND status = 'ACCEPTED'", [u.userId]);

        assert.strictEqual(accepted.rows[0].n, 2);
    }

    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("50 market buys at once are held to the collar value too", async () => {
    const user = await signUp("marco");

    // A market buy of 100 reserves 100 x 525.00 + 15.75 = 52515.75, so three fit in 157547.25
    await depositCash(state.pool, user.userId, "157547.25");

    const all = await Promise.all(
        Array.from({ length: 50 }, () => call("POST", "/orders", { token: user.token, key: key("x"), body: { symbol: "TCS", side: "BUY", orderType: "MARKET", quantity: 100 } }))
    );

    assert.deepStrictEqual(tally(all), { 201: 3, "400 Insufficient balance": 47 });
    assert.strictEqual(await availableCash(state.pool, user.userId), "0.00");
    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});
