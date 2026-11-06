const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createBook } = require("../../src/engine/orderBook.js");
const { applyCommand, bookHash } = require("../../src/engine/engine.js");
const { generate } = require("./generator.js");
const { ex, mk, assertConsistent } = require("./helpers.js");

const replay = (commands) => {
    const book = createBook("TCS");
    const events = [];

    for (const c of commands) {
        events.push(...applyCommand(book, c));
    }

    return { book, events };
};

test("replaying the same command log twice gives byte-identical events and equal hashes", () => {
    const commands = generate(2024, 20000);

    const a = replay(commands);
    const b = replay(commands);

    assert.strictEqual(JSON.stringify(a.events), JSON.stringify(b.events));
    assert.strictEqual(bookHash(a.book), bookHash(b.book));
    assert.ok(a.events.length > 20000, "the stream really produced events");
    assertConsistent(a.book);
});

test("the stream exercises every kind of event", () => {
    const { events } = replay(generate(7, 20000));
    const seen = new Set(events.map((e) => e.type));

    for (const type of ["OrderAccepted", "OrderRejected", "TradeExecuted", "OrderPartiallyFilled", "OrderFilled", "OrderCancelled", "OrderExpired", "OrderReplaced", "CancelRejected"]) {
        assert.ok(seen.has(type), `no ${type} in the stream`);
    }

    const reasons = new Set(events.filter((e) => e.reason).map((e) => e.reason));

    for (const reason of ["USER_REQUEST", "NO_LIQUIDITY", "SELF_TRADE_PREVENTED", "IOC_REMAINDER", "FOK_NOT_FILLABLE", "PROTECTION_PRICE", "REPLACED", "ORDER_NOT_FOUND"]) {
        assert.ok(reasons.has(reason), `no ${reason} in the stream`);
    }
});

test("different streams end in different hashes", () => {
    const a = replay(generate(1, 5000));
    const b = replay(generate(2, 5000));

    assert.notStrictEqual(bookHash(a.book), bookHash(b.book));
});

test("a stream cut at any point and replayed from the start reaches the same hash", () => {
    const commands = generate(99, 3000);
    const book = createBook("TCS");
    const hashes = [];

    for (const c of commands) {
        applyCommand(book, c);
        hashes.push(bookHash(book));
    }

    for (const cut of [1, 10, 500, 1999, 3000]) {
        assert.strictEqual(bookHash(replay(commands.slice(0, cut)).book), hashes[cut - 1], `cut at ${cut}`);
    }
});

test("the hash sees queue order and fills, not just the totals", () => {
    const put = (first, second) => {
        const book = createBook("TCS");

        applyCommand(book, { seq: 1, ts: 1, type: "NEW_ORDER", payload: { orderType: "LIMIT", ...mk(first, 1, "SELL", 50000, 10) } });
        applyCommand(book, { seq: 2, ts: 2, type: "NEW_ORDER", payload: { orderType: "LIMIT", ...mk(second, 2, "SELL", 50000, 10) } });

        return bookHash(book);
    };

    assert.notStrictEqual(put(1, 2), put(2, 1));
    assert.strictEqual(put(1, 2), put(1, 2));
});

test("applyCommand stamps events with the command's own seq and ts and records lastSeq", () => {
    const book = createBook("TCS");

    const events = applyCommand(book, {
        seq: 41,
        ts: 1700000000123,
        type: "NEW_ORDER",
        payload: { orderType: "LIMIT", id: 101, userId: 7, side: "SELL", timeInForce: "DAY", price: 50000, quantity: 100 }
    });

    assert.deepStrictEqual(events, [ex("OrderAccepted", { seq: 41, ts: 1700000000123 })]);
    assert.strictEqual(book.lastSeq, 41);
});

test("an unknown order type is rejected and an unknown command type throws", () => {
    const book = createBook("TCS");

    const events = applyCommand(book, { seq: 1, ts: 1, type: "NEW_ORDER", payload: { orderType: "STOP", id: 5, userId: 3 } });

    assert.deepStrictEqual(events, [ex("OrderRejected", { seq: 1, ts: 1, orderId: 5, userId: 3, reason: "INVALID_ORDER" })]);
    assert.throws(() => applyCommand(book, { seq: 2, ts: 2, type: "BOGUS", payload: {} }), /Unknown command type/);
    assert.throws(() => applyCommand(book, { seq: 2.5, ts: 2, type: "EXPIRE", payload: {} }), /integer/);
});

test("returned events are independent of engine state", () => {
    const book = createBook("TCS");

    const events = applyCommand(book, {
        seq: 1,
        ts: 1,
        type: "NEW_ORDER",
        payload: { orderType: "LIMIT", id: 1, userId: 7, side: "SELL", timeInForce: "DAY", price: 50000, quantity: 10 }
    });

    const before = bookHash(book);

    events[0].quantity = 999999;
    events.push({ junk: true });

    assert.strictEqual(bookHash(book), before);
});

test("src/engine has no clock, no randomness and no I/O", () => {
    const dir = path.join(__dirname, "..", "..", "src", "engine");
    const banned = [/Date\.now/, /new Date/, /Math\.random/, /performance\.now/, /hrtime/, /require\(["']fs/, /require\(["']node:fs/, /require\(["']net/, /require\(["']http/, /require\(["']pg/, /require\(["']redis/, /console\./, /process\./, /setTimeout/, /setInterval/];

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
        const code = fs.readFileSync(path.join(dir, file), "utf8");

        for (const re of banned) {
            assert.ok(!re.test(code), `${file} uses ${re}`);
        }
    }
});
