const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addUser, addInstrument, depositCash, depositShares } = require("./helpers/ledger.js");
const { lockWallets } = require("../src/config/ledger.js");
const { feeSql } = require("../src/config/fees.js");
const { buyHold, availableCash, availableShares, resizeHold, releaseHold } = require("../src/config/holds.js");

const { state, dbTest } = useDb("holds");
const { call, signUp } = useServer();

let seeded = false;

// TCS reference price 500.00
const seed = async () => {
    if (!seeded) {
        seeded = true;
        await addInstrument(state.pool, "TCS", "500.00");
        // These tests use prices far from 500.00, so the 10% band and the 0.05 tick would get in the way
        await state.pool.query("UPDATE instruments SET band_pct = 900, tick_size = 0.01 WHERE symbol = 'TCS'");
    }
};

// A funded user, optionally with shares
const trader = async (name, cash, shares) => {
    await seed();

    const user = await signUp(name);

    if (cash) {
        await depositCash(state.pool, user.userId, cash);
    }

    if (shares) {
        await depositShares(state.pool, user.userId, "TCS", shares);
    }

    return user;
};

const order = (user, key, side, quantity, price = "500.00", extra) =>
    call("POST", "/orders", { token: user.token, key, body: { symbol: "TCS", side, orderType: "LIMIT", quantity, price, ...extra } });

const holdsOf = async (userId) => {
    const rows = await state.pool.query("SELECT order_id, cash_amount, share_quantity, status FROM holds WHERE user_id = $1 ORDER BY id", [userId]);

    return rows.rows;
};

dbTest("fee is 0.03% of value, rounded up to the next paisa, capped at 20.00", async () => {
    const table = [
        ["0.00", "0.00"],
        ["1.00", "0.01"],
        ["99.99", "0.03"],
        ["100.00", "0.03"],
        ["333.33", "0.10"],
        ["333.34", "0.11"],
        ["1000.00", "0.30"],
        ["1000.01", "0.31"],
        ["50000.00", "15.00"],
        ["66666.66", "20.00"],
        ["66666.67", "20.00"],
        ["2000000.00", "20.00"]
    ];

    for (const [value, fee] of table) {
        const row = await state.pool.query(`SELECT ${feeSql("$1::numeric")} AS fee`, [value]);

        assert.strictEqual(row.rows[0].fee, fee, `fee on ${value}`);
    }
});

dbTest("a buy holds quantity times price plus the fee estimate", async () => {
    assert.strictEqual(await buyHold(state.pool, 100, "500.00"), "50015.00");
    assert.strictEqual(await buyHold(state.pool, 3, "33.33"), "100.02");
    assert.strictEqual(await buyHold(state.pool, 1200, "500.00"), "600020.00");
    assert.strictEqual(await buyHold(state.pool, 1, "0.01"), "0.02");
});

dbTest("a buy order is ACCEPTED with its hold, and available balance drops by the hold", async () => {
    const user = await trader("alice", "1000000.00");
    const res = await order(user, "alice-1", "BUY", 100);

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(res.body, { message: "Order accepted", orderId: res.body.orderId });

    const o = await state.pool.query("SELECT status, filled_quantity, price, time_in_force FROM orders WHERE id = $1", [res.body.orderId]);

    assert.deepStrictEqual(o.rows[0], { status: "ACCEPTED", filled_quantity: 0, price: "500.00", time_in_force: "DAY" });
    assert.deepStrictEqual(await holdsOf(user.userId), [{ order_id: res.body.orderId, cash_amount: "50015.00", share_quantity: 0, status: "ACTIVE" }]);

    const funds = await call("GET", "/account/balance", { token: user.token });

    assert.deepStrictEqual(funds.body, { accountBalance: "1000000.00", availableBalance: "949985.00" });
});

dbTest("the order walks NEW, PENDING_RISK, ACCEPTED and each step is logged", async () => {
    const user = await trader("bobby", "100000.00");
    const res = await order(user, "bobby-1", "BUY", 10);
    const events = await state.pool.query("SELECT event, from_status, to_status FROM order_events WHERE order_id = $1 ORDER BY id", [res.body.orderId]);

    assert.deepStrictEqual(events.rows, [
        { event: "SUBMIT", from_status: "NEW", to_status: "PENDING_RISK" },
        { event: "RISK_PASS", from_status: "PENDING_RISK", to_status: "ACCEPTED" }
    ]);
});

dbTest("a sell holds its shares and available shares drop by them", async () => {
    const user = await trader("carol", null, 100);
    const res = await order(user, "carol-1", "SELL", 40);

    assert.strictEqual(res.status, 201);
    assert.deepStrictEqual(await holdsOf(user.userId), [{ order_id: res.body.orderId, cash_amount: "0.00", share_quantity: 40, status: "ACTIVE" }]);
    assert.strictEqual(await availableShares(state.pool, user.userId, "TCS"), 60);

    // The held shares cannot back a second order
    const more = await order(user, "carol-2", "SELL", 61);

    assert.strictEqual(more.status, 400);
    assert.strictEqual(more.body.error, "Insufficient shares");

    const ok = await order(user, "carol-3", "SELL", 60);

    assert.strictEqual(ok.status, 201);
    assert.strictEqual(await availableShares(state.pool, user.userId, "TCS"), 0);
});

dbTest("an order that does not fit is refused with 400, stored as REJECTED, and holds nothing", async () => {
    const user = await trader("dave", "1000.00");

    // 3 at 500.00 costs 1500.45
    const res = await order(user, "dave-1", "BUY", 3);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "Insufficient balance");

    const row = await state.pool.query("SELECT status, reject_reason FROM orders WHERE id = $1", [res.body.orderId]);

    assert.deepStrictEqual(row.rows, [{ status: "REJECTED", reject_reason: "Insufficient balance" }]);
    assert.deepStrictEqual(await holdsOf(user.userId), []);

    // Exactly the available amount is fine: 1 at 999.00 plus fee 0.30 is 999.30
    const fits = await order(user, "dave-2", "BUY", 1, "999.00");

    assert.strictEqual(fits.status, 201);
    assert.strictEqual(await availableCash(state.pool, user.userId), "0.70");

    // 0.70 left. A price of 0.70 needs 0.71 with its fee, one paisa too much
    const over = await order(user, "dave-3", "BUY", 1, "0.70");

    assert.strictEqual(over.status, 400);

    // 0.69 plus a 0.01 fee is exactly 0.70
    const exact = await order(user, "dave-4", "BUY", 1, "0.69");

    assert.strictEqual(exact.status, 201);
    assert.strictEqual(await availableCash(state.pool, user.userId), "0.00");

    const gone = await order(user, "dave-5", "BUY", 1, "0.01");

    assert.strictEqual(gone.status, 400);
});

dbTest("selling shares you do not hold is refused", async () => {
    const user = await trader("erin", "100000.00");
    const res = await order(user, "erin-1", "SELL", 1);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "Insufficient shares");
});

dbTest("two orders that fit the balance separately but not together give one 201 and one 400", async () => {
    const user = await trader("frank", "1000000.00");

    // Each costs 600020.00
    const all = await Promise.all([order(user, "frank-1", "BUY", 1200), order(user, "frank-2", "BUY", 1200)]);
    const codes = all.map((r) => r.status).sort();

    assert.deepStrictEqual(codes, [201, 400]);
    assert.strictEqual(all.find((r) => r.status === 400).body.error, "Insufficient balance");

    const active = await holdsOf(user.userId);

    assert.strictEqual(active.length, 1);
    assert.strictEqual(await availableCash(state.pool, user.userId), "399980.00");
});

dbTest("twelve parallel buys that each cost 150020.00 let exactly six through", async () => {
    const user = await trader("gina", "1000000.00");
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => order(user, `gina-${i}`, "BUY", 300)));

    assert.strictEqual(all.filter((r) => r.status === 201).length, 6);
    assert.strictEqual(all.filter((r) => r.status === 400).length, 6);

    // I7 in spirit: what is held is exactly six orders worth
    const held = await state.pool.query("SELECT SUM(cash_amount) AS held FROM holds WHERE user_id = $1 AND status = 'ACTIVE'", [user.userId]);

    assert.strictEqual(held.rows[0].held, "900120.00");
    assert.ok(Number(await availableCash(state.pool, user.userId)) >= 0);
});

dbTest("parallel sells cannot hold more shares than the user owns", async () => {
    const two = await trader("hank", null, 100);
    const pair = await Promise.all([order(two, "hank-1", "SELL", 60), order(two, "hank-2", "SELL", 60)]);

    assert.deepStrictEqual(pair.map((r) => r.status).sort(), [201, 400]);
    assert.strictEqual(await availableShares(state.pool, two.userId, "TCS"), 40);

    const many = await trader("ivan", null, 100);
    const all = await Promise.all(Array.from({ length: 15 }, (_, i) => order(many, `ivan-${i}`, "SELL", 10)));

    assert.strictEqual(all.filter((r) => r.status === 201).length, 10);
    assert.strictEqual(all.filter((r) => r.status === 400).length, 5);
    assert.strictEqual(await availableShares(state.pool, many.userId, "TCS"), 0);
});

dbTest("a repeated idempotency key returns 409 and creates one order and one hold", async () => {
    const user = await trader("judy", "1000000.00");

    const first = await order(user, "judy-same", "BUY", 10);
    const second = await order(user, "judy-same", "BUY", 10);

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 409);
    assert.strictEqual((await holdsOf(user.userId)).length, 1);

    const racers = await trader("kate", "1000000.00");
    const all = await Promise.all(Array.from({ length: 10 }, () => order(racers, "kate-same", "BUY", 10)));

    assert.deepStrictEqual(all.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    assert.strictEqual((await holdsOf(racers.userId)).length, 1);

    const orders = await state.pool.query("SELECT count(*) AS n FROM orders WHERE user_id = $1", [racers.userId]);

    assert.strictEqual(orders.rows[0].n, 1);
});

dbTest("bad order input is refused with 400 and a missing token with 401", async () => {
    const user = await trader("liam", "1000000.00");
    let n = 0;

    const bad = [
        { symbol: "NOPE" },
        { symbol: "" },
        { symbol: 5 },
        { side: "HOLD" },
        { side: "buy" },
        { orderType: "MARKET" },
        { orderType: "STOP" },
        { timeInForce: "GTC" },
        { quantity: 0 },
        { quantity: -1 },
        { quantity: 1.5 },
        { quantity: "5" },
        { quantity: null },
        { price: "0" },
        { price: -5 },
        { price: "1.234" },
        { price: "abc" },
        { price: null },
        { price: [500] },
        { price: "12345678901" }
    ];

    for (const change of bad) {
        const body = { symbol: "TCS", side: "BUY", orderType: "LIMIT", quantity: 1, price: "500.00", ...change };
        const res = await call("POST", "/orders", { token: user.token, key: `liam-${++n}`, body });

        assert.strictEqual(res.status, 400, JSON.stringify(change));
        assert.ok(res.body.error);
    }

    const noKey = await call("POST", "/orders", { token: user.token, body: { symbol: "TCS", side: "BUY", orderType: "LIMIT", quantity: 1, price: "500.00" } });

    assert.strictEqual(noKey.status, 400);
    assert.deepStrictEqual(noKey.body, { error: "No idempotency key" });

    const noAuth = await call("POST", "/orders", { key: "x", body: {} });

    assert.strictEqual(noAuth.status, 401);

    const rows = await state.pool.query("SELECT count(*) AS n FROM orders WHERE user_id = $1", [user.userId]);

    assert.strictEqual(rows.rows[0].n, 0);
});

dbTest("a partial fill shrinks the hold to what is still unfilled, a full fill releases it", async () => {
    const user = await trader("mona", "1000000.00");
    const res = await order(user, "mona-1", "BUY", 100);
    const id = res.body.orderId;

    // 40 of 100 filled: 60 left, 30000.00 plus 9.00 fee
    await state.pool.query("UPDATE orders SET filled_quantity = 40 WHERE id = $1", [id]);
    await resizeHold(state.pool, id);

    assert.deepStrictEqual(await holdsOf(user.userId), [{ order_id: id, cash_amount: "30009.00", share_quantity: 0, status: "ACTIVE" }]);
    assert.strictEqual(await availableCash(state.pool, user.userId), "969991.00");

    // Fully filled: nothing left to hold
    await state.pool.query("UPDATE orders SET filled_quantity = 100 WHERE id = $1", [id]);
    await resizeHold(state.pool, id);

    assert.deepStrictEqual(await holdsOf(user.userId), [{ order_id: id, cash_amount: "0.00", share_quantity: 0, status: "RELEASED" }]);
    assert.strictEqual(await availableCash(state.pool, user.userId), "1000000.00");
});

dbTest("a sell hold shrinks with fills too", async () => {
    const user = await trader("nick", null, 100);
    const res = await order(user, "nick-1", "SELL", 100);

    await state.pool.query("UPDATE orders SET filled_quantity = 30 WHERE id = $1", [res.body.orderId]);
    await resizeHold(state.pool, res.body.orderId);

    assert.strictEqual((await holdsOf(user.userId))[0].share_quantity, 70);

    // The share balance is still 100 here (no trade was booked), minus the 70 still held
    assert.strictEqual(await availableShares(state.pool, user.userId, "TCS"), 30);
});

dbTest("releasing a hold sets it to RELEASED and frees the cash", async () => {
    const user = await trader("olga", "1000000.00");
    const res = await order(user, "olga-1", "BUY", 100);

    await releaseHold(state.pool, res.body.orderId);

    assert.strictEqual((await holdsOf(user.userId))[0].status, "RELEASED");
    assert.strictEqual(await availableCash(state.pool, user.userId), "1000000.00");

    // Releasing twice changes nothing
    await releaseHold(state.pool, res.body.orderId);

    assert.strictEqual((await holdsOf(user.userId))[0].status, "RELEASED");
});

// Two transactions that lock the same two wallets and then hold them for a moment
const lockBoth = async (first, second, wait) => {
    const client = await state.pool.connect();

    try {
        await client.query("BEGIN");
        await first(client);
        await client.query(`SELECT pg_sleep(${wait})`);
        await second(client);
        await client.query("COMMIT");

        return "ok";
    } catch (error) {
        await client.query("ROLLBACK");

        return error.code;
    } finally {
        client.release();
    }
};

dbTest("locking wallets in opposite orders still never deadlocks, because ids are sorted", async () => {
    const a = await addUser(state.pool, "lock-a");
    const b = await addUser(state.pool, "lock-b");

    const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
            lockBoth((c) => lockWallets(c, i % 2 === 0 ? [a, b] : [b, a]), (c) => lockWallets(c, i % 2 === 0 ? [b, a] : [a, b]), 0.02)
        )
    );

    assert.deepStrictEqual(results, Array(20).fill("ok"));
});

dbTest("control: taking the same two locks one by one in opposite orders does deadlock", async () => {
    const a = await addUser(state.pool, "ctl-a");
    const b = await addUser(state.pool, "ctl-b");

    const one = (id) => (c) => c.query("SELECT id FROM wallets WHERE user_id = $1 FOR UPDATE", [id]);

    const results = await Promise.all([lockBoth(one(a), one(b), 0.2), lockBoth(one(b), one(a), 0.2)]);

    // Postgres kills one of them with 40P01, which is what sorted locking prevents
    assert.ok(results.includes("40P01"), `expected a deadlock, got ${results}`);
});
