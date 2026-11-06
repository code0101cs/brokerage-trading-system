const test = require("node:test");
const assert = require("node:assert");

const {
    createBook,
    addOrder,
    removeOrder,
    bestBid,
    bestAsk,
    depth,
    snapshot
} = require("../../src/engine/orderBook.js");
const { mk, assertConsistent } = require("./helpers.js");

test("empty book has no best prices and an empty snapshot", () => {
    const book = createBook("TCS");

    assert.strictEqual(bestBid(book), null);
    assert.strictEqual(bestAsk(book), null);
    assert.deepStrictEqual(depth(book, 5), { bids: [], asks: [] });
    assert.deepStrictEqual(snapshot(book), { symbol: "TCS", lastSeq: 0, bids: [], asks: [] });
    assertConsistent(book);
});

test("best bid is the highest buy and best ask the lowest sell", () => {
    const book = createBook("TCS");

    addOrder(book, mk(1, 1, "BUY", 9900, 10));
    addOrder(book, mk(2, 1, "BUY", 10000, 20));
    addOrder(book, mk(3, 1, "BUY", 9800, 5));
    addOrder(book, mk(4, 2, "SELL", 10200, 7));
    addOrder(book, mk(5, 2, "SELL", 10100, 3));

    assert.deepStrictEqual(bestBid(book), { price: 10000, quantity: 20 });
    assert.deepStrictEqual(bestAsk(book), { price: 10100, quantity: 3 });
    assertConsistent(book);
});

test("a level totals every order resting at its price", () => {
    const book = createBook("TCS");

    addOrder(book, mk(1, 1, "BUY", 10000, 10));
    addOrder(book, mk(2, 2, "BUY", 10000, 15));
    addOrder(book, mk(3, 3, "BUY", 10000, 5));

    assert.deepStrictEqual(bestBid(book), { price: 10000, quantity: 30 });
    assert.deepStrictEqual(depth(book, 1).bids, [{ price: 10000, quantity: 30, orders: 3 }]);
});

test("depth lists the best n levels first on each side", () => {
    const book = createBook("TCS");

    for (let i = 0; i < 6; i++) {
        addOrder(book, mk(10 + i, 1, "BUY", 9000 + i * 10, 1 + i));
        addOrder(book, mk(20 + i, 2, "SELL", 10000 + i * 10, 1 + i));
    }

    const d = depth(book, 3);

    assert.deepStrictEqual(d.bids.map((l) => l.price), [9050, 9040, 9030]);
    assert.deepStrictEqual(d.asks.map((l) => l.price), [10000, 10010, 10020]);
    assert.strictEqual(depth(book, 100).bids.length, 6);
});

test("snapshot keeps queue order inside a level and lists best price first", () => {
    const book = createBook("TCS");

    addOrder(book, mk(1, 1, "SELL", 10100, 10));
    addOrder(book, mk(2, 2, "SELL", 10100, 10));
    addOrder(book, mk(3, 3, "SELL", 10000, 10));
    addOrder(book, mk(4, 1, "BUY", 9900, 10));
    addOrder(book, mk(5, 2, "BUY", 9950, 10));

    const snap = snapshot(book);

    assert.deepStrictEqual(snap.asks.map((l) => l.price), [10000, 10100]);
    assert.deepStrictEqual(snap.asks[1].orders.map((o) => o.id), [1, 2]);
    assert.deepStrictEqual(snap.bids.map((l) => l.price), [9950, 9900]);
});

test("removing an order updates the level and drops an empty level", () => {
    const book = createBook("TCS");

    addOrder(book, mk(1, 1, "BUY", 10000, 10));
    addOrder(book, mk(2, 2, "BUY", 10000, 15));

    const gone = removeOrder(book, 1);

    assert.strictEqual(gone.id, 1);
    assert.deepStrictEqual(bestBid(book), { price: 10000, quantity: 15 });
    assertConsistent(book);

    removeOrder(book, 2);

    assert.strictEqual(bestBid(book), null);
    assert.strictEqual(book.bids.levels.size, 0);
    assertConsistent(book);
});

test("removing an unknown id changes nothing", () => {
    const book = createBook("TCS");

    addOrder(book, mk(1, 1, "BUY", 10000, 10));

    assert.strictEqual(removeOrder(book, 999), null);
    assert.strictEqual(book.orders.size, 1);
    assertConsistent(book);
});

test("removing the head, middle and tail of a level keeps the links right", () => {
    const book = createBook("TCS");

    for (let id = 1; id <= 5; id++) {
        addOrder(book, mk(id, id, "SELL", 10000, id));
    }

    removeOrder(book, 3);
    assertConsistent(book);
    removeOrder(book, 1);
    assertConsistent(book);
    removeOrder(book, 5);
    assertConsistent(book);

    const ids = snapshot(book).asks[0].orders.map((o) => o.id);

    assert.deepStrictEqual(ids, [2, 4]);
    assert.strictEqual(bestAsk(book).quantity, 6);
});

test("adding and removing 10k orders keeps every level total correct", () => {
    const book = createBook("TCS");
    let seed = 12345;

    // Small seeded generator, the engine tests never touch Math.random
    const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed;
    };

    const live = [];

    for (let id = 1; id <= 10000; id++) {
        const side = next() % 2 === 0 ? "BUY" : "SELL";
        const price = side === "BUY" ? 9000 + (next() % 50) : 10000 + (next() % 50);

        addOrder(book, mk(id, 1 + (next() % 20), side, price, 1 + (next() % 100)));
        live.push(id);
    }

    assertConsistent(book);
    assert.strictEqual(book.orders.size, 10000);

    // Remove in a shuffled order, checking along the way
    while (live.length > 0) {
        const i = next() % live.length;
        const id = live[i];

        live[i] = live[live.length - 1];
        live.pop();

        removeOrder(book, id);

        if (live.length % 1000 === 0) {
            assertConsistent(book);
        }
    }

    assert.strictEqual(book.orders.size, 0);
    assert.strictEqual(book.bids.levels.size, 0);
    assert.strictEqual(book.asks.levels.size, 0);
    assertConsistent(book);
});

test("cancel time stays flat as the book grows", () => {
    // Average time of 2000 cancels in a book that holds n orders on 100 price levels
    const timeCancels = (n) => {
        const book = createBook("TCS");

        for (let id = 1; id <= n; id++) {
            addOrder(book, mk(id, 1, "BUY", 5000 + (id % 100), 1));
        }

        const start = process.hrtime.bigint();

        for (let id = 1; id <= 2000; id++) {
            removeOrder(book, id * 3);
        }

        return Number(process.hrtime.bigint() - start) / 2000;
    };

    // Warm up, then compare a small and a big book
    timeCancels(10000);

    const small = timeCancels(10000);
    const big = timeCancels(200000);

    // A linear scan would be about 20 times slower here, allow noise up to 6 times
    assert.ok(big < small * 6, `cancel got slower: ${small}ns at 10k, ${big}ns at 200k`);
});
