const test = require("node:test");
const assert = require("node:assert");

const { createBook, bestBid, bestAsk, snapshot } = require("../../src/engine/orderBook.js");
const { submitLimit } = require("../../src/engine/matching.js");
const { cancel, replace } = require("../../src/engine/amend.js");
const { ex, mk, assertConsistent, createTracker } = require("./helpers.js");

const state = (book) => JSON.stringify(snapshot(book));

const trades = (events) => events.filter((e) => e.type === "TradeExecuted");

test("cancel removes the order and reports the unfilled quantity", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(102, 8, "BUY", 50000, 100), 1, 1000);

    const events = cancel(book, 102, 2, 2000);

    assert.deepStrictEqual(events, [ex("OrderCancelled", { seq: 2, ts: 2000, orderId: 102, userId: 8, cancelledQuantity: 100, filledQuantity: 0, reason: "USER_REQUEST" })]);
    assert.strictEqual(bestBid(book), null);
    assertConsistent(book);
});

test("a cancelled order keeps the fills it already had", () => {
    const book = createBook("TCS");
    const tracker = createTracker();

    tracker.apply(submitLimit(book, mk(102, 8, "BUY", 50000, 100), 1, 1000));
    tracker.apply(submitLimit(book, mk(103, 7, "SELL", 50000, 80), 2, 2000));

    const events = cancel(book, 102, 3, 3000);

    assert.deepStrictEqual(events, [ex("OrderCancelled", { seq: 3, ts: 3000, orderId: 102, userId: 8, cancelledQuantity: 20, filledQuantity: 80, reason: "USER_REQUEST" })]);

    tracker.apply(events);
    tracker.check(book);
});

test("cancelling an unknown id is CANCEL_REJECTED and the book does not change", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const before = state(book);
    const events = cancel(book, 999, 2, 2000);

    assert.deepStrictEqual(events, [ex("CancelRejected", { seq: 2, ts: 2000, orderId: 999, reason: "ORDER_NOT_FOUND" })]);
    assert.strictEqual(state(book), before);
});

test("cancelling an already filled or already cancelled id is CANCEL_REJECTED", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 8, "BUY", 50000, 10), 2, 2000);
    submitLimit(book, mk(3, 8, "BUY", 49000, 10), 3, 3000);
    cancel(book, 3, 4, 4000);

    const before = state(book);

    for (const id of [1, 2, 3]) {
        const events = cancel(book, id, 5, 5000);

        assert.deepStrictEqual(events.map((e) => [e.type, e.reason]), [["CancelRejected", "ORDER_NOT_FOUND"]]);
    }

    assert.strictEqual(state(book), before);
});

test("a smaller size at the same price keeps its place in the queue", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 9, "SELL", 50000, 10), 2, 2000);

    const events = replace(book, 1, 6, 50000, 3, 3000);

    assert.deepStrictEqual(events, [ex("OrderReplaced", { seq: 3, ts: 3000, orderId: 1, userId: 7, oldQuantity: 10, newQuantity: 6, price: 50000 })]);
    assert.deepStrictEqual(bestAsk(book), { price: 50000, quantity: 16 });
    assertConsistent(book);

    // Order 1 is still first in line
    const hit = submitLimit(book, mk(3, 8, "BUY", 50000, 8), 4, 4000);

    assert.deepStrictEqual(trades(hit).map((t) => [t.sellOrderId, t.quantity]), [[1, 6], [2, 2]]);
});

test("a price change loses priority", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 9, "SELL", 50000, 10), 2, 2000);

    const away = replace(book, 1, 10, 50100, 3, 3000);

    assert.deepStrictEqual(away.map((e) => e.type), ["OrderCancelled", "OrderAccepted"]);
    assert.strictEqual(away[0].reason, "REPLACED");
    assert.strictEqual(away[1].price, 50100);

    replace(book, 1, 10, 50000, 4, 4000);

    // Order 1 is back at 50000 but behind order 2
    assert.deepStrictEqual(snapshot(book).asks[0].orders.map((o) => o.id), [2, 1]);

    const hit = submitLimit(book, mk(3, 8, "BUY", 50000, 5), 5, 5000);

    assert.deepStrictEqual(trades(hit).map((t) => t.sellOrderId), [2]);
    assertConsistent(book);
});

test("a size increase loses priority", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 9, "SELL", 50000, 10), 2, 2000);

    const events = replace(book, 1, 20, 50000, 3, 3000);

    assert.deepStrictEqual(events.map((e) => e.type), ["OrderCancelled", "OrderAccepted"]);
    assert.deepStrictEqual(snapshot(book).asks[0].orders.map((o) => [o.id, o.quantity]), [[2, 10], [1, 20]]);
    assertConsistent(book);
});

test("a replace to a crossing price trades straight away", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 8, "BUY", 49900, 10), 2, 2000);

    const events = replace(book, 2, 10, 50000, 3, 3000);

    assert.deepStrictEqual(events.map((e) => e.type), [
        "OrderCancelled",
        "OrderAccepted",
        "TradeExecuted",
        "OrderFilled",
        "OrderFilled"
    ]);
    assert.strictEqual(trades(events)[0].price, 50000);
    assert.strictEqual(book.orders.size, 0);
});

test("replacing a partly filled order keeps its fills", () => {
    const book = createBook("TCS");
    const tracker = createTracker();

    tracker.apply(submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000));
    tracker.apply(submitLimit(book, mk(2, 8, "BUY", 50000, 4), 2, 2000));

    const events = replace(book, 1, 12, 50100, 3, 3000);

    assert.deepStrictEqual(events[0], ex("OrderCancelled", { seq: 3, ts: 3000, orderId: 1, userId: 7, cancelledQuantity: 6, filledQuantity: 4, reason: "REPLACED" }));

    tracker.apply(events);
    tracker.check(book);

    // 12 in total, 4 already filled, 8 left in the book
    const o = book.orders.get(1).order;

    assert.strictEqual(o.quantity - o.filled, 8);
    assertConsistent(book);
});

test("a replace for an unknown id or with bad numbers is CANCEL_REJECTED and changes nothing", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 8, "BUY", 50000, 4), 2, 2000);

    const before = state(book);

    assert.deepStrictEqual(replace(book, 999, 5, 50000, 3, 3000).map((e) => e.reason), ["ORDER_NOT_FOUND"]);

    // Order 1 has 4 filled, so 4 or fewer in total makes no sense
    for (const [q, p] of [[4, 50000], [3, 50000], [0, 50000], [8, 0], [8, -1], [8, 500.5], [8.5, 50000]]) {
        assert.deepStrictEqual(replace(book, 1, q, p, 3, 3000).map((e) => e.reason), ["INVALID_ORDER"], `${q} at ${p}`);
    }

    assert.strictEqual(state(book), before);
});
