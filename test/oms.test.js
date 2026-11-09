const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, key } = require("./helpers/ledger.js");
const { moveOrder } = require("../src/config/orders.js");
const { STATES, TRIGGERS, TRANSITIONS } = require("../src/config/orderStates.js");

const { state, dbTest } = useDb("oms");
const { call, signUp } = useServer();

let user;

// An order straight in a given status, for tests that start the lifecycle midway
const orderIn = async (status) => {
    const row = await state.pool.query(
        `INSERT INTO orders
         (user_id, symbol, side, order_type, time_in_force, price, quantity, status, idempotency_key)
         VALUES ($1, 'TCS', 'BUY', 'LIMIT', 'DAY', 500.00, 10, $2, $3)
         RETURNING id`,
        [user.userId, status, key("oms")]
    );

    return row.rows[0].id;
};

const statusOf = async (id) => (await state.pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;
const logOf = async (id) => (await state.pool.query("SELECT event, from_status, to_status FROM order_events WHERE order_id = $1 ORDER BY id", [id])).rows;

dbTest("setup: an instrument and a funded user", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    user = await signUp("olga");

    await depositCash(state.pool, user.userId, "100000.00");
});

dbTest("an order placed through the API walks NEW, PENDING_RISK, ACCEPTED and logs each step", async () => {
    const res = await call("POST", "/orders", { token: user.token, key: key("oms"), body: { symbol: "TCS", side: "BUY", orderType: "LIMIT", quantity: 10, price: "500.00" } });

    assert.deepStrictEqual(await logOf(res.body.orderId), [
        { event: "SUBMIT", from_status: "NEW", to_status: "PENDING_RISK" },
        { event: "RISK_PASS", from_status: "PENDING_RISK", to_status: "ACCEPTED" }
    ]);
});

dbTest("moveOrder takes one step, updates the status and writes the event row", async () => {
    const id = await orderIn("ACCEPTED");

    assert.strictEqual(await moveOrder(state.pool, id, "ACCEPTED", "ACK", { by: "test" }), "WORKING");
    assert.strictEqual(await statusOf(id), "WORKING");

    const events = await state.pool.query("SELECT detail FROM order_events WHERE order_id = $1", [id]);

    assert.deepStrictEqual(events.rows, [{ detail: { by: "test" } }]);
});

dbTest("every illegal state and event pair throws and leaves the order and its log alone", async () => {
    let tried = 0;

    for (const from of STATES) {
        for (const event of TRIGGERS) {
            if (Object.hasOwn(TRANSITIONS[from], event)) {
                continue;
            }

            const id = await orderIn(from);

            await assert.rejects(moveOrder(state.pool, id, from, event), /Illegal transition/);

            assert.strictEqual(await statusOf(id), from);
            assert.deepStrictEqual(await logOf(id), []);

            tried++;
        }
    }

    // 10 states x 9 events = 90 pairs, minus the legal ones
    const legal = STATES.reduce((n, s) => n + Object.keys(TRANSITIONS[s]).length, 0);

    assert.strictEqual(tried, 90 - legal);
});

dbTest("a step from the wrong current status returns null and writes nothing", async () => {
    const id = await orderIn("WORKING");

    // The caller thinks it is ACCEPTED, but another request already moved it on
    assert.strictEqual(await moveOrder(state.pool, id, "ACCEPTED", "ACK"), null);
    assert.strictEqual(await statusOf(id), "WORKING");
    assert.deepStrictEqual(await logOf(id), []);
});

dbTest("20 requests move one order at once: one winner, 19 nulls, one event row", async () => {
    const id = await orderIn("ACCEPTED");

    // All twenty read ACCEPTED and ask for a different legal step
    const events = ["ACK", "CANCEL_REQUEST", "EXPIRE", "PARTIAL_FILL", "FILL"];
    const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => moveOrder(state.pool, id, "ACCEPTED", events[i % events.length]))
    );

    assert.strictEqual(results.filter((r) => r !== null).length, 1);
    assert.strictEqual(results.filter((r) => r === null).length, 19);

    const log = await logOf(id);

    assert.strictEqual(log.length, 1);
    assert.strictEqual(await statusOf(id), log[0].to_status);
});

dbTest("two requests with the same step: exactly one wins, whatever the order", async () => {
    for (let round = 0; round < 15; round++) {
        const id = await orderIn("ACCEPTED");
        const both = await Promise.all([
            moveOrder(state.pool, id, "ACCEPTED", "CANCEL_REQUEST"),
            moveOrder(state.pool, id, "ACCEPTED", "CANCEL_REQUEST")
        ]);

        assert.deepStrictEqual(both.filter((r) => r === null).length, 1);
        assert.strictEqual((await logOf(id)).length, 1);
    }
});

dbTest("the log of an order is a connected chain: each step starts where the last one ended", async () => {
    const id = await orderIn("NEW");
    const steps = ["SUBMIT", "RISK_PASS", "ACK", "PARTIAL_FILL", "PARTIAL_FILL", "CANCEL_REQUEST", "CANCELLED"];
    let at = "NEW";

    for (const event of steps) {
        at = await moveOrder(state.pool, id, at, event);
    }

    const log = await logOf(id);

    assert.strictEqual(log.length, steps.length);
    assert.strictEqual(log[0].from_status, "NEW");

    for (let i = 1; i < log.length; i++) {
        assert.strictEqual(log[i].from_status, log[i - 1].to_status);
    }

    assert.strictEqual(await statusOf(id), "CANCELLED");

    // A closed order goes nowhere
    await assert.rejects(moveOrder(state.pool, id, "CANCELLED", "FILL"), /Illegal transition/);
});

// Walk src and return every file path
const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

dbTest("no code changes an order's status except moveOrder", () => {
    const root = path.join(__dirname, "..", "src");
    const offenders = [];

    for (const file of walk(root)) {
        if (!file.endsWith(".js") || file.endsWith(path.join("config", "orders.js"))) {
            continue;
        }

        const code = fs.readFileSync(file, "utf8");

        // An UPDATE orders statement that sets the status
        for (const m of code.matchAll(/UPDATE orders[^`"]*?SET([^`"]*)/g)) {
            if (/\bstatus\s*=/.test(m[1])) {
                offenders.push(path.relative(root, file));
            }
        }

        if (/INSERT INTO orders[^`"]*\)[^`"]*VALUES[^`"]*'(?!NEW')[A-Z_]+'/.test(code)) {
            offenders.push(`${path.relative(root, file)} inserts an order past NEW`);
        }
    }

    assert.deepStrictEqual(offenders, []);
});
