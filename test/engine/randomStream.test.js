const test = require("node:test");
const assert = require("node:assert");

const { createBook, bestBid, bestAsk } = require("../../src/engine/orderBook.js");
const { applyCommand } = require("../../src/engine/engine.js");
const { generate } = require("./generator.js");
const { assertConsistent, createTracker } = require("./helpers.js");

// I6: one trade has equal buy and sell quantity and respects both limits
const tradeRespectsLimits = (trade, fills, tracker, tradeIds) => {
    assert.ok(!tradeIds.has(trade.tradeId), `trade id ${trade.tradeId} repeated`);
    tradeIds.add(trade.tradeId);

    assert.ok(Number.isInteger(trade.quantity) && trade.quantity > 0, "trade quantity is a positive whole number");
    assert.ok(Number.isInteger(trade.price) && trade.price > 0, "trade price is a positive whole number");
    assert.notStrictEqual(trade.buyUserId, trade.sellUserId, "no self trade");

    // Both sides were filled by exactly the trade quantity
    const mine = fills.filter((f) => f.tradeId === trade.tradeId);

    assert.strictEqual(mine.length, 2, "two fill events per trade");
    assert.deepStrictEqual(mine.map((f) => f.orderId).sort(), [trade.buyOrderId, trade.sellOrderId].sort());

    for (const f of mine) {
        assert.strictEqual(f.fillQuantity, trade.quantity, "buy and sell quantity are equal");
        assert.strictEqual(f.fillPrice, trade.price);
    }

    const buy = tracker.orders.get(trade.buyOrderId);
    const sell = tracker.orders.get(trade.sellOrderId);

    assert.strictEqual(buy.side, "BUY");
    assert.strictEqual(sell.side, "SELL");

    // A market order has no limit, a limit order is never traded through
    if (buy.price !== null) {
        assert.ok(trade.price <= buy.price, `buyer paid ${trade.price}, limit ${buy.price}`);
    }

    if (sell.price !== null) {
        assert.ok(trade.price >= sell.price, `seller got ${trade.price}, limit ${sell.price}`);
    }

    // The trade is at the price of the order that was resting
    const resting = trade.aggressor === "BUY" ? sell : buy;

    assert.strictEqual(trade.price, resting.price, "trade at the resting price");
};

const run = (seed, count) => {
    const book = createBook("TCS");
    const tracker = createTracker();
    const tradeIds = new Set();
    let trades = 0;

    for (const command of generate(seed, count)) {
        const events = applyCommand(book, command);
        const where = `seed ${seed}, seq ${command.seq}`;

        try {
            // Throws on a bad fill sum or an illegal state move
            tracker.apply(events);

            // I5 for every order the command touched
            const touched = new Set();

            for (const e of events) {
                touched.add(e.orderId);
                touched.add(e.buyOrderId);
                touched.add(e.sellOrderId);
            }

            tracker.check(book, touched);

            // I4: not crossed
            const bid = bestBid(book);
            const ask = bestAsk(book);

            if (bid && ask) {
                assert.ok(bid.price < ask.price, `crossed book ${bid.price} / ${ask.price}`);
            }

            // I6 for every trade
            const fills = events.filter((e) => e.type === "OrderPartiallyFilled" || e.type === "OrderFilled");

            for (const e of events.filter((x) => x.type === "TradeExecuted")) {
                tradeRespectsLimits(e, fills, tracker, tradeIds);
                trades++;
            }

            // The whole structure now and then, it is too slow every time
            if (command.seq % 1000 === 0) {
                assertConsistent(book);
                tracker.check(book);
            }
        } catch (error) {
            error.message = `${where}: ${error.message}`;
            throw error;
        }
    }

    assertConsistent(book);
    tracker.check(book);

    return { trades, orders: tracker.orders.size };
};

test("book_never_crossed, order_quantity_conserved and trade_respects_limits hold for 100k random commands", () => {
    const result = run(1, 100000);

    // The run must have actually traded a lot, or it proves little
    assert.ok(result.trades > 10000, `only ${result.trades} trades`);
    assert.ok(result.orders > 40000, `only ${result.orders} orders`);
});

test("the same checks hold for more seeds", () => {
    for (const seed of [2, 3, 4, 5, 6, 7]) {
        run(seed, 25000);
    }
});

test("the same checks hold with only two users, so self-trade prevention fires constantly", () => {
    const book = createBook("TCS");
    const tracker = createTracker();
    let prevented = 0;

    for (const command of generate(77, 30000, 2)) {
        const events = applyCommand(book, command);

        tracker.apply(events);
        tracker.check(book, new Set(events.map((e) => e.orderId)));

        prevented += events.filter((e) => e.reason === "SELF_TRADE_PREVENTED").length;

        for (const e of events.filter((x) => x.type === "TradeExecuted")) {
            assert.notStrictEqual(e.buyUserId, e.sellUserId);
        }
    }

    assertConsistent(book);
    assert.ok(prevented > 100, `self-trade prevention fired only ${prevented} times`);
});
