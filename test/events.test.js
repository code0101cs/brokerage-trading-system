const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { EVENTS, REASONS } = require("../src/config/events.js");

const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "events.md"), "utf8");

// Pull every json example out of the doc
const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));

test("every event type has exactly one example in docs/events.md", () => {
    for (const type of Object.values(EVENTS)) {
        const found = blocks.filter((b) => b.type === type);

        assert.strictEqual(found.length, 1, `${type} needs exactly one example`);
    }

    assert.strictEqual(blocks.length, Object.keys(EVENTS).length);
});

test("every example has type, seq, ts and symbol", () => {
    for (const ev of blocks) {
        assert.ok(Object.values(EVENTS).includes(ev.type));
        assert.ok(Number.isInteger(ev.seq));
        assert.ok(Number.isInteger(ev.ts));
        assert.strictEqual(typeof ev.symbol, "string");
    }
});

test("reasons used in examples are known", () => {
    for (const ev of blocks) {
        if (ev.reason) {
            assert.ok(Object.values(REASONS).includes(ev.reason), `${ev.reason} is not in REASONS`);
        }
    }
});

test("prices and quantities in examples are whole numbers", () => {
    const keys = ["price", "fillPrice", "quantity", "fillQuantity", "filledQuantity", "remainingQuantity", "filledValue", "cancelledQuantity", "expiredQuantity", "oldQuantity", "newQuantity"];

    for (const ev of blocks) {
        for (const key of keys) {
            if (ev[key] !== undefined && ev[key] !== null) {
                assert.ok(Number.isInteger(ev[key]), `${ev.type}.${key} must be an integer`);
            }
        }
    }
});

test("fill examples agree with themselves", () => {
    for (const ev of blocks.filter((b) => b.type === EVENTS.ORDER_PARTIALLY_FILLED || b.type === EVENTS.ORDER_FILLED)) {
        assert.ok(ev.filledQuantity >= ev.fillQuantity);
        assert.ok(ev.filledValue >= ev.fillPrice * ev.fillQuantity);
    }

    const filled = blocks.find((b) => b.type === EVENTS.ORDER_FILLED);

    assert.strictEqual(filled.remainingQuantity, 0);
});
