const test = require("node:test");
const assert = require("node:assert");

const { createBook, snapshot } = require("../../src/engine/orderBook.js");
const { applyCommand } = require("../../src/engine/engine.js");
const { createNaive, apply, view } = require("./naiveBook.js");
const { generate } = require("./generator.js");

// The real book's resting orders in the same shape the naive book reports them
const engineView = (book) => {
    const snap = snapshot(book);
    const flat = (levels) => levels.flatMap((l) => l.orders.map((o) => [o.id, o.price, o.quantity, o.filled]));

    return { bids: flat(snap.bids), asks: flat(snap.asks) };
};

const compare = (seed, count, users) => {
    const real = createBook("TCS");
    const naive = createNaive("TCS");
    let events = 0;

    for (const command of generate(seed, count, users)) {
        const a = applyCommand(real, command);
        const b = apply(naive, command);

        // Every emitted event must agree, in the same order
        assert.deepStrictEqual(a, b, `seed ${seed}, seq ${command.seq} (${command.type})`);
        events += a.length;

        if (command.seq % 500 === 0) {
            assert.deepStrictEqual(engineView(real), view(naive), `books differ at seed ${seed}, seq ${command.seq}`);
        }
    }

    assert.deepStrictEqual(engineView(real), view(naive), `books differ at the end of seed ${seed}`);

    return events;
};

test("the engine and the naive reference agree on every event of 100k random commands", () => {
    const events = compare(1, 100000, 30);

    assert.ok(events > 100000);
});

test("they agree on more seeds", () => {
    for (const seed of [11, 12, 13, 14, 15]) {
        compare(seed, 20000, 30);
    }
});

test("they agree with only two users, where self-trade prevention is constant", () => {
    compare(21, 30000, 2);
});

test("the naive reference really is independent: it catches a changed rule", () => {
    // Same stream, but the naive book is fed a command the engine never saw
    const real = createBook("TCS");
    const naive = createNaive("TCS");
    const commands = generate(5, 2000);

    for (const c of commands.slice(0, 1000)) {
        applyCommand(real, c);
        apply(naive, c);
    }

    const extra = { seq: 1001, ts: 1, type: "NEW_ORDER", payload: { orderType: "LIMIT", id: 999999, userId: 1, side: "SELL", timeInForce: "DAY", price: 1, quantity: 5 } };

    apply(naive, extra);

    assert.notDeepStrictEqual(engineView(real), view(naive));
});
