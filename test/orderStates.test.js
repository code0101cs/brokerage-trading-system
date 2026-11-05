const test = require("node:test");
const assert = require("node:assert");

const { STATES, TRIGGERS, TRANSITIONS, TERMINAL, transition } = require("../src/config/orderStates.js");

// The legal moves, written out separately from the table
const legal = [
    ["NEW", "SUBMIT", "PENDING_RISK"],
    ["PENDING_RISK", "RISK_PASS", "ACCEPTED"],
    ["PENDING_RISK", "RISK_FAIL", "REJECTED"],
    ["ACCEPTED", "ACK", "WORKING"],
    ["ACCEPTED", "PARTIAL_FILL", "PARTIALLY_FILLED"],
    ["ACCEPTED", "FILL", "FILLED"],
    ["ACCEPTED", "CANCEL_REQUEST", "PENDING_CANCEL"],
    ["ACCEPTED", "CANCELLED", "CANCELLED"],
    ["ACCEPTED", "EXPIRE", "EXPIRED"],
    ["WORKING", "PARTIAL_FILL", "PARTIALLY_FILLED"],
    ["WORKING", "FILL", "FILLED"],
    ["WORKING", "CANCEL_REQUEST", "PENDING_CANCEL"],
    ["WORKING", "CANCELLED", "CANCELLED"],
    ["WORKING", "EXPIRE", "EXPIRED"],
    ["PARTIALLY_FILLED", "PARTIAL_FILL", "PARTIALLY_FILLED"],
    ["PARTIALLY_FILLED", "FILL", "FILLED"],
    ["PARTIALLY_FILLED", "CANCEL_REQUEST", "PENDING_CANCEL"],
    ["PARTIALLY_FILLED", "CANCELLED", "CANCELLED"],
    ["PARTIALLY_FILLED", "EXPIRE", "EXPIRED"],
    ["PENDING_CANCEL", "PARTIAL_FILL", "PENDING_CANCEL"],
    ["PENDING_CANCEL", "FILL", "FILLED"],
    ["PENDING_CANCEL", "CANCELLED", "CANCELLED"],
    ["PENDING_CANCEL", "EXPIRE", "EXPIRED"]
];

test("every state and event pair matches the table", () => {
    let checked = 0;

    for (const state of STATES) {
        for (const event of TRIGGERS) {
            const want = legal.find((l) => l[0] === state && l[1] === event);

            if (want) {
                assert.strictEqual(transition(state, event), want[2], `${state} + ${event}`);
            } else {
                assert.throws(() => transition(state, event), /Illegal transition/, `${state} + ${event}`);
            }

            checked++;
        }
    }

    assert.strictEqual(checked, STATES.length * TRIGGERS.length);
});

test("table has a row for every state and nothing else", () => {
    assert.deepStrictEqual(Object.keys(TRANSITIONS).sort(), [...STATES].sort());
});

test("table lists exactly the legal moves", () => {
    let count = 0;

    for (const state of STATES) {
        count += Object.keys(TRANSITIONS[state]).length;
    }

    assert.strictEqual(count, legal.length);
});

test("terminal states accept no events", () => {
    for (const state of TERMINAL) {
        for (const event of TRIGGERS) {
            assert.throws(() => transition(state, event), /Illegal transition/);
        }
    }
});

test("only terminal states have no way out", () => {
    for (const state of STATES) {
        const stuck = Object.keys(TRANSITIONS[state]).length === 0;

        assert.strictEqual(stuck, TERMINAL.includes(state), state);
    }
});

test("every state is reachable from NEW", () => {
    const seen = new Set(["NEW"]);
    const queue = ["NEW"];

    while (queue.length > 0) {
        const state = queue.shift();

        for (const next of Object.values(TRANSITIONS[state])) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }

    assert.strictEqual(seen.size, STATES.length);
});

test("unknown state or event throws", () => {
    assert.throws(() => transition("BOGUS", "SUBMIT"), /Unknown state/);
    assert.throws(() => transition("NEW", "BOGUS"), /Unknown event/);
    assert.throws(() => transition("constructor", "SUBMIT"), /Unknown state/);
});
