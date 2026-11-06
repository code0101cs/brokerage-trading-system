const test = require("node:test");
const assert = require("node:assert");

const { createBook, snapshot, avgPrice } = require("../../src/engine/orderBook.js");
const { submitLimit, submitMarket } = require("../../src/engine/matching.js");
const { ex, mk, assertConsistent, createTracker } = require("./helpers.js");

test("a partial fill emits the trade, then a fill event for each side", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(101, 7, "SELL", 50000, 100), 1, 1000);

    const events = submitLimit(book, mk(102, 8, "BUY", 50000, 60), 3, 1700000000200);

    // The doc examples are exactly this scenario
    assert.deepStrictEqual(events.slice(1), [
        ex("TradeExecuted", {}),
        ex("OrderPartiallyFilled", {}),
        ex("OrderFilled", {})
    ]);
});

test("a fill that finishes the order is OrderFilled with nothing remaining", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const events = submitLimit(book, mk(2, 8, "BUY", 50000, 10), 2, 2000);
    const fills = events.filter((e) => e.type === "OrderFilled");

    assert.deepStrictEqual(fills.map((e) => e.orderId), [1, 2]);

    for (const f of fills) {
        assert.strictEqual(f.remainingQuantity, 0);
        assert.strictEqual(f.filledQuantity, 10);
        assert.strictEqual(f.filledValue, 500000);
    }
});

test("filled value and average price follow every fill", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 7, "SELL", 50100, 20), 2, 2000);

    // 10 at 50000, then 20 at 50100, then 5 rest at 50150
    const events = submitLimit(book, mk(3, 8, "BUY", 50150, 35), 3, 3000);
    const mine = events.filter((e) => e.orderId === 3 && e.fillQuantity);

    assert.deepStrictEqual(mine.map((e) => e.filledValue), [500000, 500000 + 20 * 50100]);
    assert.deepStrictEqual(mine.map((e) => e.remainingQuantity), [25, 5]);

    const resting = book.orders.get(3).order;

    assert.strictEqual(resting.filled, 30);
    assert.strictEqual(resting.value, 500000 + 1002000);
    assert.strictEqual(avgPrice(resting), (500000 + 1002000) / 30);
});

test("an order with no fills has no average price", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    assert.strictEqual(avgPrice(book.orders.get(1).order), null);
});

test("a partly filled resting order keeps its place in the queue", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 9, "SELL", 50000, 10), 2, 2000);

    // Takes 4 of order 1, which is still first in line
    submitLimit(book, mk(3, 8, "BUY", 50000, 4), 3, 3000);

    assert.deepStrictEqual(snapshot(book).asks[0].orders.map((o) => [o.id, o.filled]), [[1, 4], [2, 0]]);

    const events = submitLimit(book, mk(4, 8, "BUY", 50000, 8), 4, 4000);
    const trades = events.filter((e) => e.type === "TradeExecuted");

    // Order 1 gives its last 6 before order 2 is touched
    assert.deepStrictEqual(trades.map((t) => [t.sellOrderId, t.quantity]), [[1, 6], [2, 2]]);
    assertConsistent(book);
});

test("I5 holds after every command in a mix of small and large fills", () => {
    const book = createBook("TCS");
    const tracker = createTracker();
    let id = 0;
    let seq = 0;

    const send = (fn, o) => {
        seq++;
        tracker.apply(fn(book, o, seq, seq * 1000));
        tracker.check(book);
        assertConsistent(book);
    };

    // Deep resting liquidity in odd sizes
    for (let i = 0; i < 20; i++) {
        send(submitLimit, mk(++id, 1, "SELL", 50000 + i * 10, 7 + i * 3));
        send(submitLimit, mk(++id, 2, "BUY", 49990 - i * 10, 5 + i * 4));
    }

    // Small takes, then big sweeps, limit and market
    for (const qty of [1, 2, 3, 40, 1, 150, 5, 300, 1, 1, 90]) {
        send(submitLimit, mk(++id, 3, "BUY", 50300, qty));
        send(submitMarket, mk(++id, 4, "SELL", null, qty));
        send(submitLimit, mk(++id, 5, "SELL", 49700, qty));
        send(submitMarket, mk(++id, 6, "BUY", null, qty));
    }

    assert.ok(tracker.orders.size > 50);
});
