const test = require("node:test");
const assert = require("node:assert");

const { createBook, bestAsk, bestBid, snapshot } = require("../../src/engine/orderBook.js");
const { submitLimit, submitMarket } = require("../../src/engine/matching.js");
const { expireAll } = require("../../src/engine/amend.js");
const { ex, mk, assertConsistent, createTracker } = require("./helpers.js");

const only = (events, type) => events.filter((e) => e.type === type);

const state = (book) => JSON.stringify(snapshot(book));

const cancelled = (seq, orderId, userId, cancelledQuantity, filledQuantity, reason) =>
    ex("OrderCancelled", { seq, ts: seq * 1000, orderId, userId, cancelledQuantity, filledQuantity, reason });

const seedAsks = (book) => {
    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 9, "SELL", 50100, 10), 2, 2000);
};

test("IOC fills what it can and cancels the rest", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const events = submitLimit(book, mk(2, 8, "BUY", 50000, 25, { timeInForce: "IOC" }), 2, 2000);

    assert.strictEqual(only(events, "TradeExecuted").length, 1);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(2, 2, 8, 15, 10, "IOC_REMAINDER")]);
    assert.strictEqual(bestBid(book), null);
    assertConsistent(book);
});

test("IOC that cannot trade at all is cancelled whole and never rests", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const events = submitLimit(book, mk(3, 8, "BUY", 49000, 5, { timeInForce: "IOC" }), 3, 3000);

    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(3, 3, 8, 5, 0, "IOC_REMAINDER")]);
    assert.strictEqual(bestBid(book), null);
});

test("IOC that fills completely has no cancel", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const events = submitLimit(book, mk(3, 8, "BUY", 50000, 10, { timeInForce: "IOC" }), 3, 3000);

    assert.strictEqual(only(events, "OrderCancelled").length, 0);
    assert.strictEqual(only(events, "OrderFilled").length, 2);
});

test("FOK with just enough liquidity fills completely", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const events = submitLimit(book, mk(3, 8, "BUY", 50100, 20, { timeInForce: "FOK" }), 3, 3000);

    assert.deepStrictEqual(only(events, "TradeExecuted").map((t) => [t.price, t.quantity]), [[50000, 10], [50100, 10]]);
    assert.strictEqual(only(events, "OrderCancelled").length, 0);
    assert.strictEqual(book.orders.size, 0);
});

test("FOK just short of liquidity does nothing: no trade, cancelled whole", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const before = state(book);
    const events = submitLimit(book, mk(3, 8, "BUY", 50100, 21, { timeInForce: "FOK" }), 3, 3000);

    // Decided before any trade is emitted
    assert.strictEqual(only(events, "TradeExecuted").length, 0);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(3, 3, 8, 21, 0, "FOK_NOT_FILLABLE")]);
    assert.strictEqual(state(book), before);
});

test("FOK only counts liquidity inside its limit price", () => {
    const book = createBook("TCS");

    seedAsks(book);

    // 20 exist, but half of it is above the limit
    const events = submitLimit(book, mk(3, 8, "BUY", 50000, 20, { timeInForce: "FOK" }), 3, 3000);

    assert.strictEqual(only(events, "TradeExecuted").length, 0);
    assert.strictEqual(only(events, "OrderCancelled")[0].reason, "FOK_NOT_FILLABLE");
    assert.deepStrictEqual(bestAsk(book), { price: 50000, quantity: 10 });
});

test("a FOK market order respects its protection price", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const short = submitMarket(book, mk(3, 8, "BUY", null, 20, { timeInForce: "FOK", protectionPrice: 50000 }), 3, 3000);

    assert.strictEqual(only(short, "TradeExecuted").length, 0);
    assert.strictEqual(only(short, "OrderCancelled")[0].reason, "FOK_NOT_FILLABLE");

    const enough = submitMarket(book, mk(4, 8, "BUY", null, 20, { timeInForce: "FOK", protectionPrice: 50100 }), 4, 4000);

    assert.strictEqual(only(enough, "TradeExecuted").length, 2);
    assert.strictEqual(book.orders.size, 0);
});

test("a self cross cancels the incoming order with SELF_TRADE_PREVENTED", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const before = state(book);
    const events = submitLimit(book, mk(2, 7, "BUY", 50000, 5), 2, 2000);

    assert.strictEqual(only(events, "TradeExecuted").length, 0);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(2, 2, 7, 5, 0, "SELF_TRADE_PREVENTED")]);

    // The resting order is untouched and the incoming one did not rest
    assert.strictEqual(state(book), before);
});

test("self-trade prevention keeps the fills made before the own order was reached", () => {
    const book = createBook("TCS");
    const tracker = createTracker();

    tracker.apply(submitLimit(book, mk(1, 8, "SELL", 50000, 10), 1, 1000));
    tracker.apply(submitLimit(book, mk(2, 7, "SELL", 50100, 10), 2, 2000));

    const events = submitLimit(book, mk(3, 7, "BUY", 50100, 20), 3, 3000);

    assert.deepStrictEqual(only(events, "TradeExecuted").map((t) => [t.sellOrderId, t.quantity]), [[1, 10]]);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(3, 3, 7, 10, 10, "SELF_TRADE_PREVENTED")]);
    assert.deepStrictEqual(bestAsk(book), { price: 50100, quantity: 10 });

    tracker.apply(events);
    tracker.check(book);
    assertConsistent(book);
});

test("a market order is also stopped by a self cross", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const events = submitMarket(book, mk(2, 7, "BUY", null, 5), 2, 2000);

    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(2, 2, 7, 5, 0, "SELF_TRADE_PREVENTED")]);
    assert.strictEqual(book.orders.size, 1);
});

test("FOK that would hit its own order is cancelled before any trade", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 8, "SELL", 50000, 5), 1, 1000);
    submitLimit(book, mk(2, 7, "SELL", 50100, 10), 2, 2000);

    const before = state(book);
    const events = submitLimit(book, mk(3, 7, "BUY", 50100, 10, { timeInForce: "FOK" }), 3, 3000);

    assert.strictEqual(only(events, "TradeExecuted").length, 0);
    assert.strictEqual(only(events, "OrderCancelled")[0].reason, "SELF_TRADE_PREVENTED");
    assert.strictEqual(state(book), before);
});

test("FOK that is satisfied before its own order is reached still fills", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 8, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 7, "SELL", 50100, 10), 2, 2000);

    const events = submitLimit(book, mk(3, 7, "BUY", 50100, 10, { timeInForce: "FOK" }), 3, 3000);

    assert.strictEqual(only(events, "TradeExecuted").length, 1);
    assert.strictEqual(only(events, "OrderCancelled").length, 0);
    assert.deepStrictEqual(bestAsk(book), { price: 50100, quantity: 10 });
});

test("end of session expires every resting order and keeps their fills", () => {
    const book = createBook("TCS");
    const tracker = createTracker();

    tracker.apply(submitLimit(book, mk(103, 9, "BUY", 49000, 50), 1, 1000));
    tracker.apply(submitLimit(book, mk(1, 7, "SELL", 50000, 10), 2, 2000));
    tracker.apply(submitLimit(book, mk(2, 8, "BUY", 50000, 4), 3, 3000));

    const events = expireAll(book, 4, 4000);

    assert.deepStrictEqual(events, [
        ex("OrderExpired", { seq: 4, ts: 4000, orderId: 103, userId: 9, expiredQuantity: 50, filledQuantity: 0 }),
        ex("OrderExpired", { seq: 4, ts: 4000, orderId: 1, userId: 7, expiredQuantity: 6, filledQuantity: 4 })
    ]);
    assert.strictEqual(book.orders.size, 0);

    tracker.apply(events);
    tracker.check(book);
    assertConsistent(book);
});
