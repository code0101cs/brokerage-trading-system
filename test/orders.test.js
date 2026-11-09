const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, key } = require("./helpers/ledger.js");

const { state, dbTest } = useDb("orders");
const { call, signUp } = useServer();

let user;
let other;

const good = { symbol: "TCS", side: "BUY", orderType: "LIMIT", timeInForce: "DAY", quantity: 10, price: "500.00" };

const place = (body, who = user, idemp = key("o")) => call("POST", "/orders", { token: who.token, key: idemp, body });

dbTest("setup: an instrument and two funded users", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    user = await signUp("ola");
    other = await signUp("omar");

    await depositCash(state.pool, user.userId, "100000.00");
    await depositCash(state.pool, other.userId, "100000.00");
});

dbTest("a valid order answers 201 with its id and the order is stored", async () => {
    const res = await place(good);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.message, "Order accepted");
    assert.ok(Number.isInteger(res.body.orderId));

    const row = await state.pool.query("SELECT status, user_id FROM orders WHERE id = $1", [res.body.orderId]);

    assert.strictEqual(row.rows[0].status, "ACCEPTED");
    assert.strictEqual(row.rows[0].user_id, user.userId);
});

const bad = [
    ["symbol missing", { ...good, symbol: undefined }, "Symbol is required"],
    ["symbol not a string", { ...good, symbol: 7 }, "Symbol is required"],
    ["side wrong", { ...good, side: "HOLD" }, "Side must be BUY or SELL"],
    ["side lowercase", { ...good, side: "buy" }, "Side must be BUY or SELL"],
    ["order type missing", { ...good, orderType: undefined }, "Order type must be LIMIT"],
    ["order type unknown", { ...good, orderType: "STOP" }, "Order type must be LIMIT"],
    ["time in force unknown", { ...good, timeInForce: "GTC" }, "Time in force must be DAY, IOC or FOK"],
    ["quantity missing", { ...good, quantity: undefined }, "Quantity must be a positive whole number"],
    ["quantity zero", { ...good, quantity: 0 }, "Quantity must be a positive whole number"],
    ["quantity negative", { ...good, quantity: -5 }, "Quantity must be a positive whole number"],
    ["quantity fractional", { ...good, quantity: 1.5 }, "Quantity must be a positive whole number"],
    ["quantity a string", { ...good, quantity: "10" }, "Quantity must be a positive whole number"],
    ["price missing on a limit order", { ...good, price: undefined }, "Price must be positive with at most two decimals"],
    ["price zero", { ...good, price: "0" }, "Price must be positive with at most two decimals"],
    ["price negative", { ...good, price: "-5.00" }, "Price must be positive with at most two decimals"],
    ["price with three decimals", { ...good, price: "500.123" }, "Price must be positive with at most two decimals"],
    ["price not a number", { ...good, price: "abc" }, "Price must be positive with at most two decimals"],
    ["price an array", { ...good, price: [5] }, "Price must be positive with at most two decimals"],
    ["symbol that is not listed", { ...good, symbol: "NOPE" }, "Unknown symbol"]
];

for (const [name, body, error] of bad) {
    dbTest(`bad payload, ${name}: 400 with an error and no order row`, async () => {
        const before = await state.pool.query("SELECT count(*) AS n FROM orders WHERE user_id = $1", [user.userId]);
        const res = await place(body);

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.body, { error });

        const after = await state.pool.query("SELECT count(*) AS n FROM orders WHERE user_id = $1", [user.userId]);

        assert.strictEqual(after.rows[0].n, before.rows[0].n);
    });
}

dbTest("a missing or oversized idempotency key is a 400, a missing token a 401", async () => {
    const none = await call("POST", "/orders", { token: user.token, body: good });
    const long = await call("POST", "/orders", { token: user.token, key: "k".repeat(51), body: good });
    const anon = await call("POST", "/orders", { key: key("o"), body: good });

    assert.deepStrictEqual(none, { status: 400, body: { error: "No idempotency key" } });
    assert.deepStrictEqual(long, { status: 400, body: { error: "Idempotency key too long" } });
    assert.strictEqual(anon.status, 401);
});

dbTest("a body that is not an object is a 400", async () => {
    const res = await call("POST", "/orders", { token: user.token, key: key("o") });

    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
});

dbTest("the same idempotency key twice: 201 then 409, and one order", async () => {
    const idemp = key("twice");
    const first = await place(good, user, idemp);
    const second = await place(good, user, idemp);

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 409);
    assert.deepStrictEqual(second.body, { error: "Order with same idempotency key exists" });

    const rows = await state.pool.query("SELECT count(*) AS n FROM orders WHERE idempotency_key = $1", [idemp]);

    assert.strictEqual(rows.rows[0].n, 1);
});

dbTest("two requests with one key fired together: one 201, one 409", async () => {
    const idemp = key("race");
    const all = await Promise.all([place(good, user, idemp), place(good, user, idemp)]);
    const codes = all.map((r) => r.status).sort();

    assert.deepStrictEqual(codes, [201, 409]);
});

dbTest("GET /orders/:id returns the order and its lifecycle events in order", async () => {
    const placed = await place(good);
    const res = await call("GET", `/orders/${placed.body.orderId}`, { token: user.token });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.order.id, placed.body.orderId);
    assert.strictEqual(res.body.order.status, "ACCEPTED");
    assert.strictEqual(res.body.order.symbol, "TCS");
    assert.strictEqual(res.body.order.price, "500.00");
    assert.strictEqual(res.body.order.filled_quantity, 0);

    assert.deepStrictEqual(
        res.body.events.map((e) => [e.event, e.from_status, e.to_status]),
        [
            ["SUBMIT", "NEW", "PENDING_RISK"],
            ["RISK_PASS", "PENDING_RISK", "ACCEPTED"]
        ]
    );
});

dbTest("GET /orders/:id answers 404 for a missing order and for someone else's order", async () => {
    const placed = await place(good);

    const missing = await call("GET", "/orders/99999999", { token: user.token });
    const foreign = await call("GET", `/orders/${placed.body.orderId}`, { token: other.token });

    assert.deepStrictEqual(missing, { status: 404, body: { error: "Order not found" } });
    assert.deepStrictEqual(foreign, { status: 404, body: { error: "Order not found" } });
});

dbTest("GET /orders/:id answers 400 for an id that is not a number and 401 without a token", async () => {
    const text = await call("GET", "/orders/abc", { token: user.token });
    const sql = await call("GET", "/orders/1%20OR%201=1", { token: user.token });
    const anon = await call("GET", "/orders/1");

    assert.strictEqual(text.status, 400);
    assert.strictEqual(sql.status, 400);
    assert.strictEqual(anon.status, 401);
});
