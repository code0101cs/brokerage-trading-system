const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const doc = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "events.md"), "utf8");

const examples = {};

// The json examples in docs/events.md are the source for expected events
for (const m of doc.matchAll(/```json\n([\s\S]*?)```/g)) {
    const ev = JSON.parse(m[1]);

    examples[ev.type] = ev;
}

// An expected event: the doc example with a few fields changed
const ex = (type, overrides) => ({ ...examples[type], ...overrides });

// A new order the way the engine takes it
const mk = (id, userId, side, price, quantity, extra) => ({
    id,
    userId,
    side,
    orderType: price === null ? "MARKET" : "LIMIT",
    timeInForce: "DAY",
    price,
    quantity,
    filled: 0,
    value: 0,
    ...extra
});

const types = (events) => events.map((e) => e.type);

// Walk the book internals and check every rule it must keep
const assertConsistent = (book) => {
    let count = 0;

    for (const name of ["bids", "asks"]) {
        const side = book[name];

        assert.strictEqual(side.prices.length, side.levels.size, `${name} price list and map agree`);

        for (let i = 0; i < side.prices.length; i++) {
            if (i > 0) {
                assert.ok(side.prices[i - 1] < side.prices[i], `${name} prices are strictly ascending`);
            }

            const level = side.levels.get(side.prices[i]);

            assert.ok(level, `${name} level exists`);
            assert.strictEqual(level.price, side.prices[i]);
            assert.ok(level.count > 0, "no empty levels");

            let total = 0;
            let n = 0;
            let prev = null;

            for (let node = level.head; node; node = node.next) {
                assert.strictEqual(node.prev, prev, "prev link");
                assert.strictEqual(node.level, level, "node knows its level");
                assert.strictEqual(node.order.price, level.price);
                assert.strictEqual(book.orders.get(node.order.id), node, "index points at the node");
                assert.ok(node.order.quantity - node.order.filled > 0, "no empty resting order");

                total += node.order.quantity - node.order.filled;
                prev = node;
                n++;
            }

            assert.strictEqual(level.tail, prev, "tail link");
            assert.strictEqual(n, level.count, "level count");
            assert.strictEqual(total, level.total, "level total");

            count += n;
        }
    }

    assert.strictEqual(count, book.orders.size, "index size equals resting orders");

    // Not crossed
    if (book.bids.prices.length > 0 && book.asks.prices.length > 0) {
        const bid = book.bids.prices[book.bids.prices.length - 1];
        const ask = book.asks.prices[0];

        assert.ok(bid < ask, `book is crossed: bid ${bid} ask ${ask}`);
    }
};

module.exports = { ex, mk, types, assertConsistent };
