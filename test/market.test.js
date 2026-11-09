const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, depositShares, balance, key } = require("./helpers/ledger.js");
const { createBook } = require("../src/engine/orderBook.js");
const { applyCommand } = require("../src/engine/engine.js");
const { postEntries, systemId, lockWallets } = require("../src/config/ledger.js");
const { resizeHold, releaseHold } = require("../src/config/holds.js");
const { moveOrder } = require("../src/config/orders.js");
const { buyFill, sellFill } = require("../src/config/positions.js");
const { feeSql } = require("../src/config/fees.js");
const { runAudit } = require("../scripts/audit.js");

const { state, dbTest } = useDb("market");
const { call, signUp } = useServer();

const rupees = (paise) => `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;

const market = (user, body) =>
    call("POST", "/orders", { token: user.token, key: key("m"), body: { symbol: "TCS", orderType: "MARKET", ...body } });

const orderRow = async (id) => (await state.pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const holdRow = async (id) => (await state.pool.query("SELECT cash_amount, share_quantity, status FROM holds WHERE order_id = $1", [id])).rows[0];

let buyer;
let sellers = [];

dbTest("setup: TCS at 500.00, a funded buyer and two sellers", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    buyer = await signUp("mia");
    sellers.push(await signUp("sam"), await signUp("sue"));

    await depositCash(state.pool, buyer.userId, "100000.00");

    for (const s of sellers) {
        await depositShares(state.pool, s.userId, "TCS", 100, "500.00");
    }
});

dbTest("a market buy reserves quantity x (reference price + 5%) plus the fee, and keeps the collar", async () => {
    const res = await market(buyer, { side: "BUY", quantity: 100 });

    assert.strictEqual(res.status, 201);

    const order = await orderRow(res.body.orderId);

    // 500.00 x 1.05 = 525.00, 100 x 525.00 = 52500.00, fee 15.75
    assert.strictEqual(order.price, null);
    assert.strictEqual(order.protection_price, "525.00");
    assert.strictEqual(order.order_type, "MARKET");
    assert.strictEqual(order.status, "ACCEPTED");
    assert.deepStrictEqual(await holdRow(res.body.orderId), { cash_amount: "52515.75", share_quantity: 0, status: "ACTIVE" });
});

dbTest("the collar follows the last trade price, rounded to the paisa", async () => {
    // A trade at 333.33, so the collar is 333.33 x 1.05 = 349.9965, rounded to 350.00
    const a = sellers[0];
    const b = sellers[1];

    await state.pool.query(
        `INSERT INTO orders (user_id, symbol, side, order_type, time_in_force, price, quantity, filled_quantity, status, idempotency_key)
         VALUES ($1, 'TCS', 'SELL', 'LIMIT', 'DAY', 333.33, 1, 1, 'FILLED', 'hist-s'), ($2, 'TCS', 'BUY', 'LIMIT', 'DAY', 333.33, 1, 1, 'FILLED', 'hist-b')`,
        [a.userId, b.userId]
    );

    const ids = await state.pool.query("SELECT id, side FROM orders WHERE idempotency_key IN ('hist-s', 'hist-b')");
    const sell = ids.rows.find((r) => r.side === "SELL").id;
    const buy = ids.rows.find((r) => r.side === "BUY").id;

    await state.pool.query("INSERT INTO trades (trade_id, symbol, price, quantity, buy_order_id, sell_order_id) VALUES ('hist-t', 'TCS', 333.33, 1, $1, $2)", [buy, sell]);

    const res = await market(buyer, { side: "BUY", quantity: 10 });

    assert.strictEqual(res.status, 201);
    assert.strictEqual((await orderRow(res.body.orderId)).protection_price, "350.00");

    // 10 x 350.00 = 3500.00, fee 1.05
    assert.strictEqual((await holdRow(res.body.orderId)).cash_amount, "3501.05");

    await state.pool.query("DELETE FROM trades WHERE trade_id = 'hist-t'");
});

dbTest("a market sell holds its shares and has no collar", async () => {
    const res = await market(sellers[0], { side: "SELL", quantity: 30 });

    assert.strictEqual(res.status, 201);
    assert.strictEqual((await orderRow(res.body.orderId)).protection_price, null);
    assert.deepStrictEqual(await holdRow(res.body.orderId), { cash_amount: "0.00", share_quantity: 30, status: "ACTIVE" });
});

dbTest("a market order that brings a price is a 400", async () => {
    const res = await market(buyer, { side: "BUY", quantity: 1, price: "500.00" });

    assert.deepStrictEqual(res, { status: 400, body: { error: "Market orders take no price" } });

    const zero = await market(buyer, { side: "BUY", quantity: 1, price: 0 });

    assert.strictEqual(zero.status, 400);
});

dbTest("a market buy the collar value cannot cover is Insufficient balance, a huge one is too large", async () => {
    // 200 x 525.00 + fee is more than what is left unheld
    const poor = await market(buyer, { side: "BUY", quantity: 200 });

    assert.strictEqual(poor.status, 400);
    assert.strictEqual(poor.body.error, "Insufficient balance");

    // BIG at 5000.00 has a collar of 5250.00, so 2000 shares is 10500000.00
    await addInstrument(state.pool, "BIG", "5000.00");

    const big = await market(buyer, { symbol: "BIG", side: "BUY", quantity: 2000 });

    assert.strictEqual(big.body.error, "Order value too large");
});

dbTest("market orders skip the tick and band checks, but not lot size", async () => {
    await state.pool.query("UPDATE instruments SET lot_size = 5 WHERE symbol = 'TCS'");

    const bad = await market(buyer, { side: "BUY", quantity: 7 });

    assert.strictEqual(bad.body.error, "Invalid lot size");

    const ok = await market(buyer, { side: "BUY", quantity: 5 });

    assert.strictEqual(ok.status, 201);

    await state.pool.query("UPDATE instruments SET lot_size = 1 WHERE symbol = 'TCS'");
});

// Settle what the engine matched: the cash and share legs through the exchange, the buyer's fee
// and both positions, the way the fill handler will in Phase 5
const settle = async (event, n) => {
    const client = await state.pool.connect();

    try {
        await client.query("BEGIN");
        await lockWallets(client, [event.buyUserId, event.sellUserId]);

        const price = rupees(event.price);
        const value = (await client.query("SELECT $1::bigint * $2::numeric AS v", [event.quantity, price])).rows[0].v;
        const fee = (await client.query(`SELECT ${feeSql("$1::numeric")} AS fee`, [value])).rows[0].fee;
        const exchange = await systemId(client, "exchange");
        const fees = await systemId(client, "fees");

        await postEntries(client, {
            idemp: `mt:${n}`,
            kind: "TRADE",
            description: "market test trade",
            cash: [
                { debit: event.buyUserId, credit: exchange, amount: value },
                { debit: exchange, credit: event.sellUserId, amount: value }
            ],
            shares: [
                { debit: event.sellUserId, credit: exchange, symbol: "TCS", quantity: event.quantity },
                { debit: exchange, credit: event.buyUserId, symbol: "TCS", quantity: event.quantity }
            ]
        });

        await postEntries(client, { idemp: `mf:${n}`, kind: "FEE", description: "buy fee", cash: [{ debit: event.buyUserId, credit: fees, amount: fee }] });
        await buyFill(client, event.buyUserId, "TCS", event.quantity, price);
        await sellFill(client, event.sellUserId, "TCS", event.quantity, price);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

dbTest("a market buy that would cost more than its hold fills only up to the collar, the rest is cancelled", async () => {
    // The two earlier tests left orders and holds, start this one from a clean slate
    await state.pool.query("UPDATE holds SET status = 'RELEASED'");
    await state.pool.query("UPDATE orders SET status = 'CANCELLED' WHERE status = 'ACCEPTED'");

    const before = await balance(state.pool, buyer.userId);
    const res = await market(buyer, { side: "BUY", quantity: 100 });

    assert.strictEqual(res.status, 201);

    const order = await orderRow(res.body.orderId);
    const hold = (await holdRow(res.body.orderId)).cash_amount;

    assert.strictEqual(order.protection_price, "525.00");
    assert.strictEqual(hold, "52515.75");

    // The book: 40 at 510.00, 40 at 524.00, then prices past the collar of 525.00
    const book = createBook("TCS");
    let seq = 0;

    const send = (type, payload) => applyCommand(book, { seq: ++seq, ts: seq * 1000, type, payload });
    const ask = (id, userId, price, quantity) =>
        send("NEW_ORDER", { id, userId, side: "SELL", orderType: "LIMIT", timeInForce: "DAY", price, quantity });

    ask(9001, sellers[0].userId, 51000, 40);
    ask(9002, sellers[1].userId, 52400, 40);
    ask(9003, sellers[0].userId, 52600, 40);
    ask(9004, sellers[1].userId, 60000, 100);

    // The collar goes to the engine in paise as the protection price
    const events = send("NEW_ORDER", {
        id: order.id,
        userId: buyer.userId,
        side: "BUY",
        orderType: "MARKET",
        timeInForce: "DAY",
        quantity: order.quantity,
        protectionPrice: 52500
    });

    const trades = events.filter((e) => e.type === "TradeExecuted");
    const cancel = events.find((e) => e.type === "OrderCancelled");

    assert.deepStrictEqual(trades.map((t) => [t.price, t.quantity]), [[51000, 40], [52400, 40]]);
    assert.strictEqual(cancel.reason, "PROTECTION_PRICE");
    assert.strictEqual(cancel.cancelledQuantity, 20);
    assert.strictEqual(cancel.filledQuantity, 80);

    // Fill handling: settle each trade, grow the order, shrink the hold to what is still unfilled
    for (const [i, t] of trades.entries()) {
        await settle(t, i);
        await state.pool.query("UPDATE orders SET filled_quantity = filled_quantity + $1 WHERE id = $2", [t.quantity, order.id]);
        await moveOrder(state.pool, order.id, i === 0 ? "ACCEPTED" : "PARTIALLY_FILLED", "PARTIAL_FILL");
        await resizeHold(state.pool, order.id);
    }

    // 20 unfilled at the 525.00 collar: 10500.00 plus its fee of 3.15
    assert.deepStrictEqual(await holdRow(order.id), { cash_amount: "10503.15", share_quantity: 0, status: "ACTIVE" });

    // The engine cancelled the rest: the order closes and the whole hold is released
    await moveOrder(state.pool, order.id, "PARTIALLY_FILLED", "CANCELLED");
    await releaseHold(state.pool, order.id);

    assert.strictEqual((await holdRow(order.id)).status, "RELEASED");

    // Paid 40 x 510.00 + 40 x 524.00 = 41360.00 plus a fee on each fill, well under the hold
    const after = await balance(state.pool, buyer.userId);
    const spent = await state.pool.query("SELECT $1::numeric - $2::numeric AS spent", [before, after]);

    assert.ok(Number(spent.rows[0].spent) < Number(hold), `spent ${spent.rows[0].spent}, held ${hold}`);
    assert.ok(Number(after) >= 0);
    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});

dbTest("even when the book sells exactly at the collar the cost fits the hold to the paisa", async () => {
    await state.pool.query("UPDATE holds SET status = 'RELEASED'");

    const res = await market(buyer, { side: "BUY", quantity: 100 });
    const hold = (await holdRow(res.body.orderId)).cash_amount;

    const worst = await state.pool.query(
        `SELECT 100 * 525.00 + ${feeSql("100 * 525.00")} AS most`
    );

    assert.strictEqual(hold, worst.rows[0].most);
});
