const test = require("node:test");
const assert = require("node:assert");

const { createBook, bestBid, bestAsk } = require("../../src/engine/orderBook.js");
const { submitLimit, submitMarket } = require("../../src/engine/matching.js");
const { ex, mk, assertConsistent } = require("./helpers.js");

const only = (events, type) => events.filter((e) => e.type === type);

// A market order as the engine takes it
const market = (id, userId, side, quantity, extra) => mk(id, userId, side, null, quantity, extra);

// Expected cancel built from the example in docs/events.md
const cancelled = (seq, orderId, userId, cancelledQuantity, filledQuantity, reason) =>
    ex("OrderCancelled", { seq, ts: seq * 1000, orderId, userId, cancelledQuantity, filledQuantity, reason });

const seedAsks = (book) => {
    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 7, "SELL", 50100, 10), 2, 2000);
    submitLimit(book, mk(3, 7, "SELL", 50300, 10), 3, 3000);
};

test("a market buy that the book can fill takes liquidity from the best price outward", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const events = submitMarket(book, market(10, 8, "BUY", 15), 4, 4000);
    const trades = only(events, "TradeExecuted");

    assert.deepStrictEqual(trades.map((t) => [t.price, t.quantity, t.sellOrderId]), [
        [50000, 10, 1],
        [50100, 5, 2]
    ]);
    assert.strictEqual(only(events, "OrderCancelled").length, 0);
    assert.deepStrictEqual(bestAsk(book), { price: 50100, quantity: 5 });
    assert.strictEqual(bestBid(book), null);
    assertConsistent(book);
});

test("a market sell works the bids from the top down", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "BUY", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 7, "BUY", 49900, 10), 2, 2000);

    const events = submitMarket(book, market(10, 8, "SELL", 12), 3, 3000);

    assert.deepStrictEqual(only(events, "TradeExecuted").map((t) => [t.price, t.quantity, t.buyOrderId]), [
        [50000, 10, 1],
        [49900, 2, 2]
    ]);
    assert.deepStrictEqual(bestBid(book), { price: 49900, quantity: 8 });
    assertConsistent(book);
});

test("a market order that fills only partly cancels the rest with NO_LIQUIDITY", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "SELL", 50000, 10), 1, 1000);

    const events = submitMarket(book, market(10, 8, "BUY", 25), 2, 2000);

    assert.strictEqual(only(events, "TradeExecuted").length, 1);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(2, 10, 8, 15, 10, "NO_LIQUIDITY")]);

    // It never rests
    assert.strictEqual(bestBid(book), null);
    assert.strictEqual(book.orders.has(10), false);
    assertConsistent(book);
});

test("a market order against an empty book is accepted, then cancelled whole", () => {
    const book = createBook("TCS");

    const events = submitMarket(book, market(10, 8, "BUY", 10), 1, 1000);

    assert.deepStrictEqual(events, [
        ex("OrderAccepted", { seq: 1, ts: 1000, orderId: 10, userId: 8, side: "BUY", orderType: "MARKET", price: null, quantity: 10 }),
        cancelled(1, 10, 8, 10, 0, "NO_LIQUIDITY")
    ]);
    assert.strictEqual(book.orders.size, 0);
});

test("a protection price stops a market buy walking past it", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const events = submitMarket(book, market(10, 8, "BUY", 30, { protectionPrice: 50100 }), 4, 4000);

    assert.deepStrictEqual(only(events, "TradeExecuted").map((t) => [t.price, t.quantity]), [
        [50000, 10],
        [50100, 10]
    ]);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(4, 10, 8, 10, 20, "PROTECTION_PRICE")]);

    // The ask beyond the protection price is untouched
    assert.deepStrictEqual(bestAsk(book), { price: 50300, quantity: 10 });
    assertConsistent(book);
});

test("a protection price stops a market sell too", () => {
    const book = createBook("TCS");

    submitLimit(book, mk(1, 7, "BUY", 50000, 10), 1, 1000);
    submitLimit(book, mk(2, 7, "BUY", 49000, 10), 2, 2000);

    const events = submitMarket(book, market(10, 8, "SELL", 20, { protectionPrice: 49500 }), 3, 3000);

    assert.strictEqual(only(events, "TradeExecuted").length, 1);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(3, 10, 8, 10, 10, "PROTECTION_PRICE")]);
    assert.deepStrictEqual(bestBid(book), { price: 49000, quantity: 10 });
});

test("a protection price inside the best ask means no trade at all", () => {
    const book = createBook("TCS");

    seedAsks(book);

    const events = submitMarket(book, market(10, 8, "BUY", 5, { protectionPrice: 49000 }), 4, 4000);

    assert.strictEqual(only(events, "TradeExecuted").length, 0);
    assert.deepStrictEqual(only(events, "OrderCancelled"), [cancelled(4, 10, 8, 5, 0, "PROTECTION_PRICE")]);
    assert.deepStrictEqual(bestAsk(book), { price: 50000, quantity: 10 });
});

test("a bad protection price is rejected", () => {
    const book = createBook("TCS");

    for (const p of [0, -5, 500.5]) {
        const events = submitMarket(book, market(10, 8, "BUY", 5, { protectionPrice: p }), 1, 1000);

        assert.deepStrictEqual(events, [ex("OrderRejected", { seq: 1, ts: 1000, orderId: 10, userId: 8, reason: "INVALID_ORDER" })]);
    }
});
