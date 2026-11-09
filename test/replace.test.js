const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, depositShares, key, fillOrder } = require("./helpers/ledger.js");
const { availableCash, availableShares } = require("../src/config/holds.js");
const gateway = require("../src/config/gateway.js");
const { runAudit } = require("../scripts/audit.js");

const { state, dbTest } = useDb("replace");
const { call, signUp } = useServer();

let rae;
let rob;

const limit = (who, side, quantity, price = "500.00") =>
    call("POST", "/orders", { token: who.token, key: key("p"), body: { symbol: "TCS", side, orderType: "LIMIT", quantity, price } });

const replace = (who, id, body) => call("PATCH", `/orders/${id}`, { token: who.token, body });

const orderRow = async (id) => (await state.pool.query("SELECT status, quantity, price, filled_quantity FROM orders WHERE id = $1", [id])).rows[0];
const holdRow = async (id) => (await state.pool.query("SELECT cash_amount, share_quantity, status FROM holds WHERE order_id = $1", [id])).rows[0];

dbTest("setup: TCS and two funded traders", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    rae = await signUp("rae");
    rob = await signUp("rob");

    await depositCash(state.pool, rae.userId, "2000000.00");
    await depositShares(state.pool, rae.userId, "TCS", 300, "500.00");
    await depositCash(state.pool, rob.userId, "100000.00");
    await depositShares(state.pool, rob.userId, "TCS", 300, "500.00");
});

dbTest("a new quantity changes the order and resizes the hold in the same step", async () => {
    const placed = await limit(rae, "BUY", 100);
    const id = placed.body.orderId;

    // 100 x 500.00 + 15.00
    assert.strictEqual((await holdRow(id)).cash_amount, "50015.00");

    const res = await replace(rae, id, { quantity: 60 });

    assert.deepStrictEqual(res, { status: 200, body: { message: "Order replaced", orderId: id } });
    assert.strictEqual((await orderRow(id)).quantity, 60);
    assert.strictEqual((await holdRow(id)).cash_amount, "30009.00");

    await replace(rae, id, { quantity: 120 });

    // 120 x 500.00 + 18.00
    assert.strictEqual((await holdRow(id)).cash_amount, "60018.00");
});

dbTest("a new price changes the hold, and both together work too", async () => {
    const placed = await limit(rae, "BUY", 10);
    const id = placed.body.orderId;

    await replace(rae, id, { price: "520.00" });

    // 10 x 520.00 = 5200.00 + 1.56
    assert.deepStrictEqual(await orderRow(id), { status: "ACCEPTED", quantity: 10, price: "520.00", filled_quantity: 0 });
    assert.strictEqual((await holdRow(id)).cash_amount, "5201.56");

    await replace(rae, id, { price: "480.00", quantity: 20 });

    // 20 x 480.00 = 9600.00 + 2.88
    assert.strictEqual((await orderRow(id)).price, "480.00");
    assert.strictEqual((await holdRow(id)).cash_amount, "9602.88");
});

dbTest("the order's own hold counts as available, so a replace can use all the cash", async () => {
    const buyer = await signUp("rhea");

    // 10000.00 cash: 19 at 500.00 holds 9500.00 + 2.85, 20 at 499.00 needs 9980.00 + 3.00
    await depositCash(state.pool, buyer.userId, "10000.00");

    const placed = await limit(buyer, "BUY", 19);
    const up = await replace(buyer, placed.body.orderId, { quantity: 20, price: "499.00" });

    assert.strictEqual(up.status, 200);
    assert.strictEqual((await holdRow(placed.body.orderId)).cash_amount, "9983.00");
    assert.strictEqual(await availableCash(state.pool, buyer.userId), "17.00");
});

dbTest("a replace the balance cannot cover is Insufficient balance and changes nothing", async () => {
    const buyer = await signUp("rudy");

    await depositCash(state.pool, buyer.userId, "10000.00");

    const placed = await limit(buyer, "BUY", 10);
    const id = placed.body.orderId;
    const res = await replace(buyer, id, { quantity: 21 });

    assert.deepStrictEqual(res, { status: 400, body: { error: "Insufficient balance" } });
    assert.deepStrictEqual(await orderRow(id), { status: "ACCEPTED", quantity: 10, price: "500.00", filled_quantity: 0 });
    assert.strictEqual((await holdRow(id)).cash_amount, "5001.50");
});

dbTest("a sell grows and shrinks its share hold, and cannot go past the shares owned", async () => {
    const seller = await signUp("rosa");

    await depositShares(state.pool, seller.userId, "TCS", 100, "500.00");

    const placed = await limit(seller, "SELL", 40);
    const id = placed.body.orderId;

    await replace(seller, id, { quantity: 100 });

    assert.strictEqual((await holdRow(id)).share_quantity, 100);
    assert.strictEqual(await availableShares(state.pool, seller.userId, "TCS"), 0);

    const over = await replace(seller, id, { quantity: 101 });

    assert.deepStrictEqual(over, { status: 400, body: { error: "Insufficient shares" } });

    await replace(seller, id, { quantity: 30 });

    assert.strictEqual((await holdRow(id)).share_quantity, 30);
    assert.strictEqual(await availableShares(state.pool, seller.userId, "TCS"), 70);
});

dbTest("the risk checks apply to the new values, with the same messages", async () => {
    const placed = await limit(rae, "BUY", 10);
    const id = placed.body.orderId;

    const cases = [
        [{ price: "500.03" }, "Invalid tick size"],
        [{ price: "560.00" }, "Price outside allowed band"],
        [{ quantity: 10001 }, "Quantity too large"]
    ];

    for (const [body, error] of cases) {
        const res = await replace(rae, id, body);

        assert.deepStrictEqual(res, { status: 400, body: { error } });
    }

    // Still the order it was
    assert.deepStrictEqual(await orderRow(id), { status: "ACCEPTED", quantity: 10, price: "500.00", filled_quantity: 0 });
    assert.strictEqual((await holdRow(id)).cash_amount, "5001.50");
});

dbTest("bad bodies are a 400", async () => {
    const placed = await limit(rae, "BUY", 10);
    const id = placed.body.orderId;

    const cases = [
        [undefined, "Nothing to change"],
        [{}, "Nothing to change"],
        [{ quantity: 0 }, "Quantity must be a positive whole number"],
        [{ quantity: 2.5 }, "Quantity must be a positive whole number"],
        [{ quantity: "5" }, "Quantity must be a positive whole number"],
        [{ price: "abc" }, "Price must be positive with at most two decimals"],
        [{ price: "-1" }, "Price must be positive with at most two decimals"],
        [{ price: "500.123" }, "Price must be positive with at most two decimals"]
    ];

    for (const [body, error] of cases) {
        assert.deepStrictEqual(await replace(rae, id, body), { status: 400, body: { error } });
    }

    assert.strictEqual((await replace(rae, "abc", { quantity: 5 })).status, 400);
});

dbTest("404 for a missing or foreign order, 401 without a token", async () => {
    const placed = await limit(rae, "BUY", 10);

    assert.deepStrictEqual(await replace(rae, 99999999, { quantity: 5 }), { status: 404, body: { error: "Order not found" } });
    assert.deepStrictEqual(await replace(rob, placed.body.orderId, { quantity: 5 }), { status: 404, body: { error: "Order not found" } });
    assert.strictEqual((await call("PATCH", `/orders/${placed.body.orderId}`, { body: { quantity: 5 } })).status, 401);
    assert.strictEqual((await orderRow(placed.body.orderId)).quantity, 10);
});

dbTest("a partly filled order: the new quantity must pass what already filled, and funds count the unfilled part", async () => {
    const placed = await limit(rae, "BUY", 100);
    const id = placed.body.orderId;

    await fillOrder(state.pool, id, rob.userId, 40, "500.00");

    assert.strictEqual((await holdRow(id)).cash_amount, "30009.00");

    // At or below the 40 already filled is refused
    assert.deepStrictEqual(await replace(rae, id, { quantity: 40 }), { status: 400, body: { error: "Quantity must be above the filled quantity" } });
    assert.deepStrictEqual(await replace(rae, id, { quantity: 10 }), { status: 400, body: { error: "Quantity must be above the filled quantity" } });

    // 50 in total means 10 still open: 5000.00 + 1.50
    assert.strictEqual((await replace(rae, id, { quantity: 50 })).status, 200);
    assert.deepStrictEqual(await holdRow(id), { cash_amount: "5001.50", share_quantity: 0, status: "ACTIVE" });
    assert.strictEqual((await orderRow(id)).status, "PARTIALLY_FILLED");

    // A new price applies to the unfilled 10 only
    assert.strictEqual((await replace(rae, id, { price: "510.00" })).status, 200);
    assert.strictEqual((await holdRow(id)).cash_amount, "5101.53");
});

dbTest("filled, cancelled and cancel-pending orders cannot be replaced", async () => {
    const filled = await limit(rae, "BUY", 10);

    await fillOrder(state.pool, filled.body.orderId, rob.userId, 10, "500.00");

    assert.deepStrictEqual(await replace(rae, filled.body.orderId, { quantity: 20 }), { status: 409, body: { error: "Order already filled" } });

    const cancelled = await limit(rae, "BUY", 10);

    await call("DELETE", `/orders/${cancelled.body.orderId}`, { token: rae.token });

    assert.deepStrictEqual(await replace(rae, cancelled.body.orderId, { quantity: 20 }), { status: 409, body: { error: "Order can no longer be changed" } });

    const pending = await limit(rae, "BUY", 10);
    const original = gateway.cancel;

    gateway.cancel = async () => false;

    try {
        await call("DELETE", `/orders/${pending.body.orderId}`, { token: rae.token });
    } finally {
        gateway.cancel = original;
    }

    assert.deepStrictEqual(await replace(rae, pending.body.orderId, { quantity: 20 }), { status: 409, body: { error: "Order can no longer be changed" } });
});

dbTest("a market order cannot be replaced", async () => {
    const placed = await call("POST", "/orders", { token: rae.token, key: key("p"), body: { symbol: "TCS", side: "BUY", orderType: "MARKET", quantity: 10 } });
    const res = await replace(rae, placed.body.orderId, { quantity: 5 });

    assert.deepStrictEqual(res, { status: 400, body: { error: "Only limit orders can be changed" } });
});

dbTest("the exchange is told the new total quantity and price, and a refusal rolls everything back", async () => {
    const placed = await limit(rae, "BUY", 10);
    const id = placed.body.orderId;
    const original = gateway.replace;
    const calls = [];

    gateway.replace = async (order, quantity, price) => {
        calls.push([order.id, quantity, price]);

        return true;
    };

    try {
        await replace(rae, id, { quantity: 15, price: "505.00" });

        // The exchange says the order is no longer resting: the fill won
        gateway.replace = async () => false;

        const res = await replace(rae, id, { quantity: 99 });

        assert.deepStrictEqual(res, { status: 409, body: { error: "Order already filled" } });
    } finally {
        gateway.replace = original;
    }

    assert.deepStrictEqual(calls, [[id, 15, "505.00"]]);

    // The refused replace left the order and the hold as the first replace made them
    assert.deepStrictEqual(await orderRow(id), { status: "ACCEPTED", quantity: 15, price: "505.00", filled_quantity: 0 });
    assert.strictEqual((await holdRow(id)).cash_amount, "7577.28");
});

dbTest("a replace that throws is a 500 and changes nothing", async () => {
    const placed = await limit(rae, "BUY", 10);
    const id = placed.body.orderId;
    const original = gateway.replace;

    gateway.replace = async () => {
        throw new Error("exchange down");
    };

    const log = console.error;

    console.error = () => {};

    try {
        const res = await replace(rae, id, { quantity: 30 });

        assert.deepStrictEqual(res, { status: 500, body: { error: "Internal server error" } });
    } finally {
        gateway.replace = original;
        console.error = log;
    }

    assert.strictEqual((await orderRow(id)).quantity, 10);
    assert.strictEqual((await holdRow(id)).cash_amount, "5001.50");
});

dbTest("twenty replaces and a cancel at once leave the hold matching the order", async () => {
    const buyer = await signUp("rhys");

    await depositCash(state.pool, buyer.userId, "300000.00");

    const placed = await limit(buyer, "BUY", 100);
    const id = placed.body.orderId;

    const all = await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => replace(buyer, id, { quantity: 100 + i * 5 })),
        call("DELETE", `/orders/${id}`, { token: buyer.token })
    ]);

    assert.ok(all.every((r) => [200, 409].includes(r.status)), JSON.stringify(all.map((r) => r.status)));

    const order = await orderRow(id);
    const hold = await holdRow(id);

    if (order.status === "CANCELLED") {
        assert.strictEqual(hold.status, "RELEASED");
    } else {
        // Every replace that won was applied whole: the hold is exactly what the order needs
        const want = await state.pool.query(
            "SELECT $1::numeric * $2::numeric + ROUND(LEAST(CEIL($1::numeric * $2::numeric * 0.0003 * 100) / 100, 20.00), 2) AS hold",
            [order.quantity, order.price]
        );

        assert.strictEqual(hold.cash_amount, want.rows[0].hold);
    }

    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("the audit is green after all of it", async () => {
    const results = await runAudit(state.pool);

    for (const r of results) {
        assert.ok(r.ok, `${r.name} failed: ${JSON.stringify(r.rows.slice(0, 3))}`);
    }
});
