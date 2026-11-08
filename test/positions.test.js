const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { addUser, addInstrument } = require("./helpers/ledger.js");
const { buyFill, sellFill } = require("../src/config/positions.js");

const { state, dbTest } = useDb("positions");

// Each step is [side, quantity, price, ok, expected position after it]. ok is false for a refused sell.
// Every expected number was worked out by hand: avg_cost keeps 4 decimals, realised P&L is rounded to 2 per sell.
const sequences = [
    {
        name: "a single buy",
        steps: [["BUY", 100, "500.00", true, { quantity: 100, avg_cost: "500.0000", realized_pnl: "0.00" }]]
    },
    {
        name: "two buys average out: (100*500 + 100*520) / 200 = 510",
        steps: [
            ["BUY", 100, "500.00", true, { quantity: 100, avg_cost: "500.0000", realized_pnl: "0.00" }],
            ["BUY", 100, "520.00", true, { quantity: 200, avg_cost: "510.0000", realized_pnl: "0.00" }]
        ]
    },
    {
        name: "three buys, the last average rounds to 4 decimals: 5899.93 / 57 = 103.50754...",
        steps: [
            ["BUY", 30, "100.00", true, { quantity: 30, avg_cost: "100.0000", realized_pnl: "0.00" }],
            ["BUY", 20, "110.00", true, { quantity: 50, avg_cost: "104.0000", realized_pnl: "0.00" }],
            ["BUY", 7, "99.99", true, { quantity: 57, avg_cost: "103.5075", realized_pnl: "0.00" }]
        ]
    },
    {
        name: "a partial sell at a profit leaves the average alone: (520 - 500) * 40 = 800",
        steps: [
            ["BUY", 100, "500.00", true, { quantity: 100, avg_cost: "500.0000", realized_pnl: "0.00" }],
            ["SELL", 40, "520.00", true, { quantity: 60, avg_cost: "500.0000", realized_pnl: "800.00" }]
        ]
    },
    {
        name: "a sell at a loss: (190.50 - 200) * 20 = -190",
        steps: [
            ["BUY", 50, "200.00", true, { quantity: 50, avg_cost: "200.0000", realized_pnl: "0.00" }],
            ["SELL", 20, "190.50", true, { quantity: 30, avg_cost: "200.0000", realized_pnl: "-190.00" }]
        ]
    },
    {
        name: "selling everything leaves a flat position that keeps its profit",
        steps: [
            ["BUY", 10, "1000.00", true, { quantity: 10, avg_cost: "1000.0000", realized_pnl: "0.00" }],
            ["SELL", 10, "1010.50", true, { quantity: 0, avg_cost: "1000.0000", realized_pnl: "105.00" }]
        ]
    },
    {
        name: "buying again after going flat starts a fresh average: 5 * 900 / 5 = 900",
        steps: [
            ["BUY", 10, "1000.00", true, { quantity: 10, avg_cost: "1000.0000", realized_pnl: "0.00" }],
            ["SELL", 10, "1010.50", true, { quantity: 0, avg_cost: "1000.0000", realized_pnl: "105.00" }],
            ["BUY", 5, "900.00", true, { quantity: 5, avg_cost: "900.0000", realized_pnl: "105.00" }]
        ]
    },
    {
        name: "repeating decimals: avg 72/7 = 10.2857, sells give +1.4286 -> 1.43 and -1.4285 -> -1.43",
        steps: [
            ["BUY", 3, "10.00", true, { quantity: 3, avg_cost: "10.0000", realized_pnl: "0.00" }],
            ["BUY", 4, "10.50", true, { quantity: 7, avg_cost: "10.2857", realized_pnl: "0.00" }],
            ["SELL", 2, "11.00", true, { quantity: 5, avg_cost: "10.2857", realized_pnl: "1.43" }],
            ["SELL", 5, "10.00", true, { quantity: 0, avg_cost: "10.2857", realized_pnl: "0.00" }]
        ]
    },
    {
        name: "short selling is blocked: 11 against 10 held is refused and nothing moves",
        steps: [
            ["BUY", 10, "50.00", true, { quantity: 10, avg_cost: "50.0000", realized_pnl: "0.00" }],
            ["SELL", 11, "55.00", false, { quantity: 10, avg_cost: "50.0000", realized_pnl: "0.00" }],
            ["SELL", 10, "55.00", true, { quantity: 0, avg_cost: "50.0000", realized_pnl: "50.00" }],
            ["SELL", 1, "55.00", false, { quantity: 0, avg_cost: "50.0000", realized_pnl: "50.00" }]
        ]
    },
    {
        name: "selling with no position at all is refused and creates no row",
        steps: [["SELL", 1, "10.00", false, null]]
    },
    {
        name: "penny prices: (0.02 - 0.01) * 3 = 0.03",
        steps: [
            ["BUY", 3, "0.01", true, { quantity: 3, avg_cost: "0.0100", realized_pnl: "0.00" }],
            ["SELL", 3, "0.02", true, { quantity: 0, avg_cost: "0.0100", realized_pnl: "0.03" }]
        ]
    },
    {
        name: "penny average 0.05 / 3 = 0.0167, then (0.02 - 0.0167) * 3 = 0.0099 -> 0.01",
        steps: [
            ["BUY", 1, "0.01", true, { quantity: 1, avg_cost: "0.0100", realized_pnl: "0.00" }],
            ["BUY", 2, "0.02", true, { quantity: 3, avg_cost: "0.0167", realized_pnl: "0.00" }],
            ["SELL", 3, "0.02", true, { quantity: 0, avg_cost: "0.0167", realized_pnl: "0.01" }]
        ]
    },
    {
        name: "large size: 18595600 / 15000 = 1239.7067, then 20.2933 * 15000 = 304399.50",
        steps: [
            ["BUY", 10000, "1234.56", true, { quantity: 10000, avg_cost: "1234.5600", realized_pnl: "0.00" }],
            ["BUY", 5000, "1250.00", true, { quantity: 15000, avg_cost: "1239.7067", realized_pnl: "0.00" }],
            ["SELL", 15000, "1260.00", true, { quantity: 0, avg_cost: "1239.7067", realized_pnl: "304399.50" }]
        ]
    },
    {
        name: "to the cent: avg 1000.01 / 3 = 333.3367, then (333.34 - 333.3367) * 3 = 0.0099 -> 0.01",
        steps: [
            ["BUY", 1, "333.33", true, { quantity: 1, avg_cost: "333.3300", realized_pnl: "0.00" }],
            ["BUY", 2, "333.34", true, { quantity: 3, avg_cost: "333.3367", realized_pnl: "0.00" }],
            ["SELL", 3, "333.34", true, { quantity: 0, avg_cost: "333.3367", realized_pnl: "0.01" }]
        ]
    },
    {
        name: "profit on part, loss on the rest, nets out: +400 then -150 = 250",
        steps: [
            ["BUY", 100, "100.00", true, { quantity: 100, avg_cost: "100.0000", realized_pnl: "0.00" }],
            ["SELL", 50, "108.00", true, { quantity: 50, avg_cost: "100.0000", realized_pnl: "400.00" }],
            ["SELL", 50, "97.00", true, { quantity: 0, avg_cost: "100.0000", realized_pnl: "250.00" }]
        ]
    }
];

const positionOf = async (userId, symbol) => {
    const rows = await state.pool.query(
        `SELECT quantity, avg_cost, realized_pnl
         FROM positions
         WHERE user_id = $1 AND symbol = $2`,
        [userId, symbol]
    );

    return rows.rows[0] || null;
};

dbTest("table of buy and sell sequences matches the hand-calculated values to the paisa", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    assert.ok(sequences.length >= 10);

    let n = 0;

    for (const seq of sequences) {
        const userId = await addUser(state.pool, `trader-${++n}`);
        let step = 0;

        for (const [side, qty, price, ok, want] of seq.steps) {
            step++;

            const done = side === "BUY"
                ? (await buyFill(state.pool, userId, "TCS", qty, price), true)
                : await sellFill(state.pool, userId, "TCS", qty, price);

            const where = `${seq.name}, step ${step}`;

            assert.strictEqual(done, ok, `${where}: accepted or refused`);
            assert.deepStrictEqual(await positionOf(userId, "TCS"), want, where);
        }
    }

});

dbTest("positions are kept per user and per symbol", async () => {
    await addInstrument(state.pool, "INFY", "1500.00");

    const a = await addUser(state.pool, "pos-a");
    const b = await addUser(state.pool, "pos-b");

    await buyFill(state.pool, a, "TCS", 10, "500.00");
    await buyFill(state.pool, a, "INFY", 5, "1500.00");
    await buyFill(state.pool, b, "TCS", 20, "400.00");

    assert.deepStrictEqual(await positionOf(a, "TCS"), { quantity: 10, avg_cost: "500.0000", realized_pnl: "0.00" });
    assert.deepStrictEqual(await positionOf(a, "INFY"), { quantity: 5, avg_cost: "1500.0000", realized_pnl: "0.00" });
    assert.deepStrictEqual(await positionOf(b, "TCS"), { quantity: 20, avg_cost: "400.0000", realized_pnl: "0.00" });
    assert.strictEqual(await positionOf(b, "INFY"), null);

    // A sell in one symbol does not touch the other
    await sellFill(state.pool, a, "TCS", 10, "510.00");

    assert.strictEqual((await positionOf(a, "INFY")).quantity, 5);
    assert.strictEqual((await positionOf(b, "TCS")).quantity, 20);
});

dbTest("parallel buys lose no update", async () => {
    const user = await addUser(state.pool, "pos-race");

    await Promise.all(Array.from({ length: 30 }, () => buyFill(state.pool, user, "TCS", 5, "100.00")));

    assert.deepStrictEqual(await positionOf(user, "TCS"), { quantity: 150, avg_cost: "100.0000", realized_pnl: "0.00" });
});

dbTest("parallel sells cannot take the position below zero", async () => {
    const user = await addUser(state.pool, "pos-race-sell");

    await buyFill(state.pool, user, "TCS", 100, "100.00");

    const results = await Promise.all(Array.from({ length: 15 }, () => sellFill(state.pool, user, "TCS", 10, "110.00")));

    assert.strictEqual(results.filter((r) => r).length, 10);
    assert.strictEqual(results.filter((r) => !r).length, 5);
    assert.deepStrictEqual(await positionOf(user, "TCS"), { quantity: 0, avg_cost: "100.0000", realized_pnl: "1000.00" });
});

dbTest("the database itself refuses a negative quantity", async () => {
    const user = await addUser(state.pool, "pos-check");

    await buyFill(state.pool, user, "TCS", 5, "100.00");

    await assert.rejects(state.pool.query("UPDATE positions SET quantity = -1 WHERE user_id = $1", [user]), (e) => e.code === "23514");
});
