const test = require("node:test");
const assert = require("node:assert");

const { createBook, bestBid, bestAsk, snapshot } = require("../../src/engine/orderBook.js");
const { submitLimit } = require("../../src/engine/matching.js");
const { ex, mk, assertConsistent } = require("./helpers.js");

const trades = (events) => events.filter((e) => e.type === "TradeExecuted");

// Expected trade built from the example in docs/events.md
const trade = (seq, n, price, quantity, buy, sell, aggressor) =>
    ex("TradeExecuted", {
        seq,
        ts: seq * 1000,
        tradeId: `TCS-${seq}-${n}`,
        price,
        quantity,
        buyOrderId: buy[0],
        buyUserId: buy[1],
        sellOrderId: sell[0],
        sellUserId: sell[1],
        aggressor
    });

test("an exact cross trades the full quantity at the resting price", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(101, 7, "SELL", 50000, 100), 1, 1000);

    const events = submitLimit(book, mk(102, 8, "BUY", 50000, 100), 2, 2000);

    assert.deepStrictEqual(trades(events), [trade(2, 1, 50000, 100, [102, 8], [101, 7], "BUY")]);
    assert.strictEqual(bestBid(book), null);
    assert.strictEqual(bestAsk(book), null);
    assertConsistent(book);
});

test("an incoming buy above the ask gets price improvement", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(101, 7, "SELL", 50000, 100), 1, 1000);

    const events = submitLimit(book, mk(102, 8, "BUY", 51000, 40), 2, 2000);

    assert.deepStrictEqual(trades(events), [trade(2, 1, 50000, 40, [102, 8], [101, 7], "BUY")]);
    assert.deepStrictEqual(bestAsk(book), { price: 50000, quantity: 60 });
    assertConsistent(book);
});

test("an incoming sell below the bid trades at the resting bid", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(101, 7, "BUY", 50000, 100), 1, 1000);

    const events = submitLimit(book, mk(102, 8, "SELL", 49000, 30), 2, 2000);

    assert.deepStrictEqual(trades(events), [trade(2, 1, 50000, 30, [101, 7], [102, 8], "SELL")]);
    assert.deepStrictEqual(bestBid(book), { price: 50000, quantity: 70 });
    assertConsistent(book);
});

test("a big order walks several levels, best price first, and rests the remainder", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50200, 10), 1, 1000);
    submitLimit(book, mk(2, 7, "SELL", 50000, 10), 2, 2000);
    submitLimit(book, mk(3, 7, "SELL", 50100, 10), 3, 3000);

    const events = submitLimit(book, mk(4, 8, "BUY", 50150, 25), 4, 4000);

    assert.deepStrictEqual(trades(events), [
        trade(4, 1, 50000, 10, [4, 8], [2, 7], "BUY"),
        trade(4, 2, 50100, 10, [4, 8], [3, 7], "BUY")
    ]);

    // The last 5 rest at the buyer's own limit, the dearest ask is untouched
    assert.deepStrictEqual(bestBid(book), { price: 50150, quantity: 5 });
    assert.deepStrictEqual(bestAsk(book), { price: 50200, quantity: 10 });
    assertConsistent(book);
});

test("prices that do not cross do not match", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const events = submitLimit(book, mk(2, 8, "BUY", 49900, 10), 2, 2000);

    assert.strictEqual(trades(events).length, 0);
    assert.deepStrictEqual(bestBid(book), { price: 49900, quantity: 10 });
    assert.deepStrictEqual(bestAsk(book), { price: 50000, quantity: 10 });
    assertConsistent(book);
});

test("the oldest order at a level fills first", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 9, "SELL", 50000, 10), 2, 2000);

    const events = submitLimit(book, mk(3, 8, "BUY", 50000, 15), 3, 3000);

    assert.deepStrictEqual(trades(events), [
        trade(3, 1, 50000, 10, [3, 8], [1, 7], "BUY"),
        trade(3, 2, 50000, 5, [3, 8], [2, 9], "BUY")
    ]);

    // Order 2 is left with 5, order 1 is gone
    const rest = snapshot(book).asks[0].orders;

    assert.strictEqual(rest.length, 1);
    assert.strictEqual(rest[0].id, 2);
    assert.strictEqual(rest[0].filled, 5);
    assertConsistent(book);
});

test("an accepted order starts its events with OrderAccepted", () => {
    const book = createBook("TCS");

    const events = submitLimit(book, { id: 101, userId: 7, side: "SELL", timeInForce: "DAY", price: 50000, quantity: 100 }, 1, 1700000000000);

    assert.deepStrictEqual(events, [ex("OrderAccepted", { seq: 1, ts: 1700000000000 })]);
});

test("the caller's order object is not changed", () => {
    const book = createBook("TCS");
    const resting = mk(1, 7, "SELL", 50000, 10);
    const incoming = mk(2, 8, "BUY", 50000, 10);
    const before = JSON.stringify([resting, incoming]);

    submitLimit(book, resting, 1, 1000);
    submitLimit(book, incoming, 2, 2000);

    assert.strictEqual(JSON.stringify([resting, incoming]), before);
});

test("bad input and a repeated id are rejected and change nothing", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const hash = JSON.stringify(snapshot(book));
    const bad = [
        mk(2, 8, "BUY", 50000, 0),
        mk(3, 8, "BUY", 500.5, 10),
        mk(4, 8, "BUY", -5, 10),
        mk(5, 8, "SIDEWAYS", 50000, 10),
        mk(6, 8, "BUY", 50000, 1.5),
        mk(7, 8, "BUY", null, 10, { orderType: "LIMIT" }),
        mk(8, 8, "BUY", 50000, 10, { timeInForce: "GTC" })
    ];

    for (const o of bad) {
        const events = submitLimit(book, o, 2, 2000);

        assert.deepStrictEqual(events, [ex("OrderRejected", { seq: 2, ts: 2000, orderId: o.id, userId: 8, reason: "INVALID_ORDER" })]);
    }

    const dup = submitLimit(book, mk(1, 7, "SELL", 50000, 10), 3, 3000);

    assert.deepStrictEqual(dup, [ex("OrderRejected", { seq: 3, ts: 3000, orderId: 1, userId: 7, reason: "DUPLICATE_ORDER_ID" })]);
    assert.strictEqual(JSON.stringify(snapshot(book)), hash);
});
