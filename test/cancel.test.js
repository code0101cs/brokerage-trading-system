const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, depositShares, balance, key, fillOrder } = require("./helpers/ledger.js");
const { availableCash, availableShares } = require("../src/config/holds.js");
const gateway = require("../src/config/gateway.js");
const { runAudit } = require("../scripts/audit.js");

const { state, dbTest } = useDb("cancel");
const { call, signUp } = useServer();

let alice;
let bob;
let carol;

const limit = (who, side, quantity, price = "500.00") =>
    call("POST", "/orders", { token: who.token, key: key("c"), body: { symbol: "TCS", side, orderType: "LIMIT", quantity, price } });

const cancel = (who, id) => call("DELETE", `/orders/${id}`, { token: who.token });

const orderRow = async (id) => (await state.pool.query("SELECT status, filled_quantity FROM orders WHERE id = $1", [id])).rows[0];
const holdRow = async (id) => (await state.pool.query("SELECT cash_amount, share_quantity, status FROM holds WHERE order_id = $1", [id])).rows[0];
const logOf = async (id) => (await state.pool.query("SELECT event, to_status FROM order_events WHERE order_id = $1 ORDER BY id", [id])).rows.map((e) => `${e.event}:${e.to_status}`);

dbTest("setup: TCS and three funded traders with shares", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    alice = await signUp("alice");
    bob = await signUp("bob");
    carol = await signUp("carol");

    for (const u of [alice, bob, carol]) {
        await depositCash(state.pool, u.userId, "200000.00");
        await depositShares(state.pool, u.userId, "TCS", 500, "500.00");
    }
});

dbTest("cancel before any fill: 200, PENDING_CANCEL then CANCELLED, hold released", async () => {
    const before = await availableCash(state.pool, alice.userId);
    const placed = await limit(alice, "BUY", 100);

    assert.notStrictEqual(await availableCash(state.pool, alice.userId), before);

    const res = await cancel(alice, placed.body.orderId);

    assert.deepStrictEqual(res, { status: 200, body: { message: "Order cancelled", orderId: placed.body.orderId } });
    assert.strictEqual((await orderRow(placed.body.orderId)).status, "CANCELLED");
    assert.strictEqual((await holdRow(placed.body.orderId)).status, "RELEASED");
    assert.strictEqual(await availableCash(state.pool, alice.userId), before);

    assert.deepStrictEqual(await logOf(placed.body.orderId), [
        "SUBMIT:PENDING_RISK",
        "RISK_PASS:ACCEPTED",
        "CANCEL_REQUEST:PENDING_CANCEL",
        "CANCELLED:CANCELLED"
    ]);
});

dbTest("cancelling a sell gives its shares back", async () => {
    const before = await availableShares(state.pool, alice.userId, "TCS");
    const placed = await limit(alice, "SELL", 200);

    assert.strictEqual(await availableShares(state.pool, alice.userId, "TCS"), before - 200);

    await cancel(alice, placed.body.orderId);

    assert.strictEqual(await availableShares(state.pool, alice.userId, "TCS"), before);
});

dbTest("cancel answers 404 for a missing order and for another user's order, and 400 for a bad id", async () => {
    const placed = await limit(alice, "BUY", 10);

    assert.deepStrictEqual(await cancel(alice, 99999999), { status: 404, body: { error: "Order not found" } });
    assert.deepStrictEqual(await cancel(bob, placed.body.orderId), { status: 404, body: { error: "Order not found" } });
    assert.strictEqual((await cancel(alice, "abc")).status, 400);
    assert.strictEqual((await call("DELETE", `/orders/${placed.body.orderId}`)).status, 401);

    // Bob's attempt changed nothing
    assert.strictEqual((await orderRow(placed.body.orderId)).status, "ACCEPTED");
    assert.strictEqual((await holdRow(placed.body.orderId)).status, "ACTIVE");
});

dbTest("cancel after the fill, the race lost: 409 Order already filled, nothing changes", async () => {
    const placed = await limit(alice, "BUY", 50);

    // The exchange filled it completely before the cancel request arrived
    await fillOrder(state.pool, placed.body.orderId, bob.userId, 50, "500.00");

    const res = await cancel(alice, placed.body.orderId);

    assert.deepStrictEqual(res, { status: 409, body: { error: "Order already filled" } });
    assert.strictEqual((await orderRow(placed.body.orderId)).status, "FILLED");
    assert.strictEqual((await holdRow(placed.body.orderId)).status, "RELEASED");
    assert.ok(!(await logOf(placed.body.orderId)).some((e) => e.startsWith("CANCEL")));
});

dbTest("cancel after the fill, when the fill lands between the request and the exchange's answer", async () => {
    const placed = await limit(alice, "BUY", 20);
    const id = placed.body.orderId;
    const original = gateway.cancel;

    // The exchange answers that the order is gone from the book because it filled just now
    gateway.cancel = async () => false;

    try {
        const res = await cancel(alice, id);

        assert.deepStrictEqual(res, { status: 409, body: { error: "Order already filled" } });
    } finally {
        gateway.cancel = original;
    }

    // The cancel request is on record and the order waits in PENDING_CANCEL for the fill
    assert.strictEqual((await orderRow(id)).status, "PENDING_CANCEL");
    assert.strictEqual((await holdRow(id)).status, "ACTIVE");

    // The fill arrives: PENDING_CANCEL becomes FILLED and the hold is released
    await fillOrder(state.pool, id, bob.userId, 20, "500.00");

    assert.strictEqual((await orderRow(id)).status, "FILLED");
    assert.strictEqual((await holdRow(id)).status, "RELEASED");
    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("a second cancel while PENDING_CANCEL is a 409, and a cancel of a closed order too", async () => {
    const placed = await limit(carol, "BUY", 10);
    const id = placed.body.orderId;
    const original = gateway.cancel;

    gateway.cancel = async () => false;

    try {
        await cancel(carol, id);
    } finally {
        gateway.cancel = original;
    }

    assert.deepStrictEqual(await cancel(carol, id), { status: 409, body: { error: "Cancel already requested" } });

    const done = await limit(carol, "BUY", 10);

    await cancel(carol, done.body.orderId);

    assert.deepStrictEqual(await cancel(carol, done.body.orderId), { status: 409, body: { error: "Order already closed" } });

    // A rejected order is closed too
    const rejected = await limit(carol, "BUY", 10, "500.03");

    assert.strictEqual(rejected.status, 400);
    assert.deepStrictEqual(await cancel(carol, rejected.body.orderId), { status: 409, body: { error: "Order already closed" } });
});

dbTest("a partly filled buy: the hold covers only the unfilled part, and cancel releases that part", async () => {
    const start = await balance(state.pool, bob.userId);
    const placed = await limit(bob, "BUY", 100);
    const id = placed.body.orderId;

    // 100 at 500.00 holds 50000.00 plus a 15.00 fee
    assert.strictEqual((await holdRow(id)).cash_amount, "50015.00");

    // 40 fill at 500.00: 20000.00 leaves the account, plus a fee of 6.00
    await fillOrder(state.pool, id, carol.userId, 40, "500.00");

    assert.strictEqual((await orderRow(id)).status, "PARTIALLY_FILLED");
    assert.strictEqual((await orderRow(id)).filled_quantity, 40);

    // The 60 left hold 30000.00 plus 9.00
    assert.deepStrictEqual(await holdRow(id), { cash_amount: "30009.00", share_quantity: 0, status: "ACTIVE" });

    const res = await cancel(bob, id);

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await orderRow(id)).status, "CANCELLED");
    assert.strictEqual((await orderRow(id)).filled_quantity, 40);
    assert.strictEqual((await holdRow(id)).status, "RELEASED");

    // Only what was filled is gone: 20000.00 and its fee. The unfilled 60 are free again.
    const spent = await state.pool.query("SELECT $1::numeric - $2::numeric AS spent", [start, await balance(state.pool, bob.userId)]);

    assert.strictEqual(spent.rows[0].spent, "20006.00");
    assert.strictEqual(await availableCash(state.pool, bob.userId), await balance(state.pool, bob.userId));
});

dbTest("a partly filled sell releases only the unfilled shares", async () => {
    const placed = await limit(carol, "SELL", 100);
    const id = placed.body.orderId;
    const start = await availableShares(state.pool, carol.userId, "TCS");

    await fillOrder(state.pool, id, alice.userId, 40, "500.00");

    // 40 shares left the account and the hold shrank to the 60 still for sale
    assert.deepStrictEqual(await holdRow(id), { cash_amount: "0.00", share_quantity: 60, status: "ACTIVE" });
    assert.strictEqual(await availableShares(state.pool, carol.userId, "TCS"), start);

    await cancel(carol, id);

    assert.strictEqual((await holdRow(id)).status, "RELEASED");
    assert.strictEqual(await availableShares(state.pool, carol.userId, "TCS"), start + 60);
});

dbTest("ten cancels of one order at the same time: one 200, nine 409, one release", async () => {
    const placed = await limit(alice, "BUY", 10);
    const id = placed.body.orderId;

    const all = await Promise.all(Array.from({ length: 10 }, () => cancel(alice, id)));

    assert.strictEqual(all.filter((r) => r.status === 200).length, 1);
    assert.strictEqual(all.filter((r) => r.status === 409).length, 9);

    const log = await logOf(id);

    assert.strictEqual(log.filter((e) => e.startsWith("CANCEL_REQUEST")).length, 1);
    assert.strictEqual(log.filter((e) => e.startsWith("CANCELLED")).length, 1);
    assert.strictEqual((await holdRow(id)).status, "RELEASED");
});

dbTest("a cancel and a fill at the same moment leave a consistent order, whichever wins", async () => {
    for (let round = 0; round < 8; round++) {
        const placed = await limit(alice, "BUY", 10);
        const id = placed.body.orderId;

        const [res] = await Promise.all([cancel(alice, id), fillOrder(state.pool, id, bob.userId, 10, "500.00").catch(() => null)]);
        const order = await orderRow(id);
        const hold = await holdRow(id);

        // Whatever happened the hold is gone and the order is closed, filled or cancelled
        assert.ok(["FILLED", "CANCELLED", "PENDING_CANCEL"].includes(order.status), order.status);
        assert.ok([200, 409].includes(res.status));

        if (order.status === "CANCELLED") {
            assert.strictEqual(order.filled_quantity, 0);
            assert.strictEqual(hold.status, "RELEASED");
        }
    }

    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("the audit is green after all of it", async () => {
    const results = await runAudit(state.pool);

    for (const r of results) {
        assert.ok(r.ok, `${r.name} failed: ${JSON.stringify(r.rows.slice(0, 3))}`);
    }
});
