const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, depositShares, key } = require("./helpers/ledger.js");
const { isMarketOpen } = require("../src/config/market.js");

const { state, dbTest } = useDb("risk");
const { call, signUp } = useServer();

let user;

const good = { symbol: "TCS", side: "BUY", orderType: "LIMIT", timeInForce: "DAY", quantity: 10, price: "500.00" };

const place = (body) => call("POST", "/orders", { token: user.token, key: key("r"), body });

dbTest("setup: instruments for every rule and a funded user", async () => {
    // TCS: tick 0.05, lot 1, max 10000, band 10%, reference 500.00
    await addInstrument(state.pool, "TCS", "500.00");

    // LOT trades in lots of 10, BIG has a high price so a few shares are a large value, HALT is halted
    await addInstrument(state.pool, "LOT", "500.00");
    await addInstrument(state.pool, "BIG", "5000.00");
    await addInstrument(state.pool, "HALT", "500.00");

    await state.pool.query("UPDATE instruments SET lot_size = 10 WHERE symbol = 'LOT'");
    await state.pool.query("UPDATE instruments SET halted = TRUE WHERE symbol = 'HALT'");

    user = await signUp("rita");

    await depositCash(state.pool, user.userId, "100000.00");
    await depositShares(state.pool, user.userId, "TCS", 100, "500.00");
});

const refused = [
    ["Instrument halted", { ...good, symbol: "HALT" }],
    ["Invalid lot size", { ...good, symbol: "LOT", quantity: 15 }],
    ["Invalid tick size", { ...good, price: "500.03" }],
    ["Quantity too large", { ...good, quantity: 10001 }],
    ["Order value too large", { ...good, symbol: "BIG", quantity: 3000, price: "5000.00" }],
    ["Price outside allowed band", { ...good, price: "550.05" }],
    ["Price outside allowed band", { ...good, price: "449.95" }],
    ["Price outside allowed band", { ...good, side: "SELL", price: "600.00" }],
    ["Insufficient balance", { ...good, quantity: 500, price: "500.00" }],
    ["Insufficient shares", { ...good, side: "SELL", quantity: 101 }]
];

for (const [reason, body] of refused) {
    dbTest(`${reason}: ${body.side} ${body.quantity} ${body.symbol} at ${body.price} is rejected`, async () => {
        const res = await place(body);

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error, reason);
        assert.ok(Number.isInteger(res.body.orderId));

        // Kept on record as REJECTED with its reason, a RISK_FAIL event, and nothing held
        const row = await state.pool.query("SELECT status, reject_reason FROM orders WHERE id = $1", [res.body.orderId]);

        assert.deepStrictEqual(row.rows, [{ status: "REJECTED", reject_reason: reason }]);

        const events = await state.pool.query("SELECT event, from_status, to_status, detail FROM order_events WHERE order_id = $1 ORDER BY id", [res.body.orderId]);

        assert.deepStrictEqual(
            events.rows.map((e) => [e.event, e.to_status]),
            [["SUBMIT", "PENDING_RISK"], ["RISK_FAIL", "REJECTED"]]
        );
        assert.deepStrictEqual(events.rows[1].detail, { reason });

        const holds = await state.pool.query("SELECT count(*) AS n FROM holds WHERE order_id = $1", [res.body.orderId]);

        assert.strictEqual(holds.rows[0].n, 0);
    });
}

dbTest("Market closed: the check runs first, before the instrument is even looked at", async () => {
    process.env.MARKET_HOURS = "never";

    try {
        const res = await place({ ...good, symbol: "HALT" });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error, "Market closed");

        const row = await state.pool.query("SELECT status, reject_reason FROM orders WHERE id = $1", [res.body.orderId]);

        assert.deepStrictEqual(row.rows, [{ status: "REJECTED", reject_reason: "Market closed" }]);
    } finally {
        process.env.MARKET_HOURS = "always";
    }
});

dbTest("when several checks fail the first one in the plan's order is the one reported", async () => {
    // Halted, bad lot, bad tick, too many, too big, off band, no balance: halted wins
    const res = await place({ symbol: "HALT", side: "BUY", orderType: "LIMIT", quantity: 10001, price: "1.03" });

    assert.strictEqual(res.body.error, "Instrument halted");

    // Past that, lot size comes before tick size, tick before quantity, quantity before value
    const lot = await place({ symbol: "LOT", side: "BUY", orderType: "LIMIT", quantity: 10005, price: "500.03" });
    const tick = await place({ ...good, quantity: 10001, price: "500.03" });
    const size = await place({ symbol: "BIG", side: "BUY", orderType: "LIMIT", quantity: 10001, price: "5000.00" });
    const value = await place({ symbol: "BIG", side: "BUY", orderType: "LIMIT", quantity: 3000, price: "6000.00" });

    assert.strictEqual(lot.body.error, "Invalid lot size");
    assert.strictEqual(tick.body.error, "Invalid tick size");
    assert.strictEqual(size.body.error, "Quantity too large");
    assert.strictEqual(value.body.error, "Order value too large");

    // Band comes before funds: out of band and unaffordable reports the band
    const band = await place({ ...good, quantity: 9000, price: "560.00" });

    assert.strictEqual(band.body.error, "Price outside allowed band");
});

dbTest("a valid order passes every check, and the edges of each rule are allowed", async () => {
    const edges = [
        good,
        { ...good, price: "550.00" },
        { ...good, price: "450.00" },
        { ...good, price: "500.05" },
        { ...good, quantity: 1 },
        { ...good, symbol: "LOT", quantity: 10 },
        { ...good, side: "SELL", quantity: 100, price: "500.00" }
    ];

    for (const body of edges) {
        const res = await place(body);

        assert.strictEqual(res.status, 201, `${JSON.stringify(body)} gave ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.body.message, "Order accepted");
    }

    const accepted = await state.pool.query("SELECT count(*) AS n FROM orders WHERE user_id = $1 AND status = 'ACCEPTED'", [user.userId]);
    const holds = await state.pool.query("SELECT count(*) AS n FROM holds WHERE user_id = $1 AND status = 'ACTIVE'", [user.userId]);

    assert.strictEqual(accepted.rows[0].n, edges.length);
    assert.strictEqual(holds.rows[0].n, edges.length);
});

dbTest("the value limit is 10000000.00 exactly", async () => {
    // BIG at 5000.00: 2000 shares is exactly 10,000,000.00, 2001 is over
    const exact = await place({ symbol: "BIG", side: "BUY", orderType: "LIMIT", quantity: 2000, price: "5000.00" });
    const over = await place({ symbol: "BIG", side: "BUY", orderType: "LIMIT", quantity: 2001, price: "5000.00" });

    // The exact one passes the value check and then stops at the balance
    assert.strictEqual(exact.body.error, "Insufficient balance");
    assert.strictEqual(over.body.error, "Order value too large");
});

dbTest("a rejected order keeps its idempotency key, so a retry is a 409", async () => {
    const idemp = key("retry");
    const body = { ...good, price: "500.03" };

    const first = await call("POST", "/orders", { token: user.token, key: idemp, body });
    const second = await call("POST", "/orders", { token: user.token, key: idemp, body });

    assert.strictEqual(first.status, 400);
    assert.strictEqual(second.status, 409);
});

dbTest("GET /orders/:id shows a rejected order with its reason", async () => {
    const res = await place({ ...good, price: "500.03" });
    const got = await call("GET", `/orders/${res.body.orderId}`, { token: user.token });

    assert.strictEqual(got.body.order.status, "REJECTED");
    assert.strictEqual(got.body.order.reject_reason, "Invalid tick size");
});

const at = (iso) => new Date(iso);

dbTest("trading hours: weekdays 09:15 to 15:30 India time", () => {
    delete process.env.MARKET_HOURS;

    try {
        // 2026-11-09 is a Monday. India time is UTC + 5:30, so 09:15 IST is 03:45 UTC
        assert.strictEqual(isMarketOpen(at("2026-11-09T03:44:00Z")), false);
        assert.strictEqual(isMarketOpen(at("2026-11-09T03:45:00Z")), true);
        assert.strictEqual(isMarketOpen(at("2026-11-09T09:59:00Z")), true);
        assert.strictEqual(isMarketOpen(at("2026-11-09T10:00:00Z")), false);
        assert.strictEqual(isMarketOpen(at("2026-11-13T06:00:00Z")), true);

        // Saturday and Sunday
        assert.strictEqual(isMarketOpen(at("2026-11-14T06:00:00Z")), false);
        assert.strictEqual(isMarketOpen(at("2026-11-15T06:00:00Z")), false);

        // 21:00 UTC on Sunday is already Monday 02:30 in India, still closed
        assert.strictEqual(isMarketOpen(at("2026-11-15T21:00:00Z")), false);
    } finally {
        process.env.MARKET_HOURS = "always";
    }
});

dbTest("MARKET_HOURS=always and never override the clock", () => {
    process.env.MARKET_HOURS = "never";
    assert.strictEqual(isMarketOpen(at("2026-11-09T06:00:00Z")), false);

    process.env.MARKET_HOURS = "always";
    assert.strictEqual(isMarketOpen(at("2026-11-14T06:00:00Z")), true);
});
