const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, depositCash, depositShares, balance, shareBalance, key } = require("./helpers/ledger.js");
const { rng } = require("./engine/generator.js");
const { postEntries, systemId, lockWallets } = require("../src/config/ledger.js");
const { availableCash, availableShares } = require("../src/config/holds.js");
const { buyFill, sellFill } = require("../src/config/positions.js");
const { feeSql } = require("../src/config/fees.js");
const { runAudit, checks } = require("../scripts/audit.js");

const { state, dbTest } = useDb("audit");
const { call, signUp } = useServer();

const SYMBOLS = [["TCS", "500.00"], ["INFY", "1500.00"], ["WIPRO", "400.00"]];

// Settle one trade the way the fill handler will: lock both wallets in order, check, post the
// cash and share legs through the exchange, post both fees, move both positions
const settle = async (n, buyer, seller, symbol, qty, price) => {
    const client = await state.pool.connect();

    try {
        await client.query("BEGIN");
        await lockWallets(client, [buyer, seller]);

        const v = await client.query("SELECT $1::bigint * $2::numeric AS value", [qty, price]);
        const value = v.rows[0].value;
        const f = await client.query(`SELECT ${feeSql("$1::numeric")} AS fee`, [value]);
        const fee = f.rows[0].fee;

        // Not enough cash for the value and its fee, or not enough shares: skip, nothing written
        const cash = await client.query("SELECT $1::numeric >= $2::numeric + $3::numeric AS ok", [await availableCash(client, buyer), value, fee]);

        if (!cash.rows[0].ok || (await availableShares(client, seller, symbol)) < qty) {
            await client.query("ROLLBACK");
            return false;
        }

        const exchange = await systemId(client, "exchange");
        const fees = await systemId(client, "fees");

        await postEntries(client, {
            idemp: `trade:${n}`,
            kind: "TRADE",
            description: `${symbol} ${qty} at ${price}`,
            cash: [
                { debit: buyer, credit: exchange, amount: value },
                { debit: exchange, credit: seller, amount: value }
            ],
            shares: [
                { debit: seller, credit: exchange, symbol, quantity: qty },
                { debit: exchange, credit: buyer, symbol, quantity: qty }
            ]
        });

        await postEntries(client, { idemp: `fee:${n}:${buyer}`, kind: "FEE", description: "buy fee", cash: [{ debit: buyer, credit: fees, amount: fee }] });
        await postEntries(client, { idemp: `fee:${n}:${seller}`, kind: "FEE", description: "sell fee", cash: [{ debit: seller, credit: fees, amount: fee }] });

        await buyFill(client, buyer, symbol, qty, price);

        if (!(await sellFill(client, seller, symbol, qty, price))) {
            throw new Error("seller position is short");
        }

        await client.query("COMMIT");

        return true;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

let users = [];
let executed = 0;
let depositedCash = "0.00";

dbTest("the audit passes after 20 users make 1000 random transfers, run eight at a time", async () => {
    for (const [symbol, ref] of SYMBOLS) {
        await addInstrument(state.pool, symbol, ref);
    }

    for (let i = 0; i < 20; i++) {
        users.push((await signUp(`trader-${i}`)).userId);
    }

    // Everyone starts with 200000.00 and 300 shares of each symbol, at the reference price
    for (const u of users) {
        await depositCash(state.pool, u, "200000.00");

        for (const [symbol, ref] of SYMBOLS) {
            await depositShares(state.pool, u, symbol, 300, ref);
        }
    }

    depositedCash = "4000000.00";

    assert.ok((await runAudit(state.pool)).every((r) => r.ok), "the audit passes before any trade");

    const rand = rng(20241106);
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    let attempts = 0;

    while (executed < 1000 && attempts < 4000) {
        const batch = [];

        for (let i = 0; i < 8; i++) {
            const buyer = users[int(0, 19)];
            let seller = users[int(0, 19)];

            if (seller === buyer) {
                seller = users[(users.indexOf(buyer) + 1) % 20];
            }

            const [symbol, ref] = SYMBOLS[int(0, 2)];
            const cents = Math.round(Number(ref) * 100 * (0.9 + rand() * 0.2));
            const price = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

            batch.push(settle(++attempts, buyer, seller, symbol, int(1, 40), price));
        }

        for (const ok of await Promise.all(batch)) {
            if (ok) {
                executed++;
            }
        }
    }

    assert.ok(executed >= 1000, `only ${executed} trades went through`);

    const results = await runAudit(state.pool);

    for (const r of results) {
        assert.ok(r.ok, `${r.name} failed: ${JSON.stringify(r.rows.slice(0, 3))}`);
    }

    assert.strictEqual(results.length, checks.length);
});

dbTest("every trade wrote four cash rows and four share rows, and each fee one", async () => {
    const trades = await state.pool.query(
        `SELECT t.id,
                (SELECT count(*) FROM entries e WHERE e.transaction_id = t.id) AS cash_rows,
                (SELECT count(*) FROM share_entries s WHERE s.transaction_id = t.id) AS share_rows
         FROM transactions t
         WHERE t.kind = 'TRADE'`
    );

    assert.strictEqual(trades.rows.length, executed);

    for (const t of trades.rows) {
        assert.strictEqual(t.cash_rows, 4);
        assert.strictEqual(t.share_rows, 4);
    }

    const fees = await state.pool.query("SELECT count(*) AS n FROM transactions WHERE kind = 'FEE'");

    assert.strictEqual(fees.rows[0].n, executed * 2);
});

dbTest("money and shares are conserved: nothing was created or lost", async () => {
    const fees = await systemId(state.pool, "fees");
    const exchange = await systemId(state.pool, "exchange");

    let cash = 0;

    for (const u of users) {
        cash += Math.round(Number(await balance(state.pool, u)) * 100);
    }

    const feeCash = Math.round(Number(await balance(state.pool, fees)) * 100);

    // Traders plus collected fees hold exactly what was deposited
    assert.strictEqual(cash + feeCash, Math.round(Number(depositedCash) * 100));
    assert.strictEqual(Number(await balance(state.pool, exchange)), 0);
    assert.ok(feeCash > 0, "fees were collected");

    for (const [symbol] of SYMBOLS) {
        let shares = 0;

        for (const u of users) {
            shares += Number(await shareBalance(state.pool, u, symbol));
        }

        assert.strictEqual(shares, 20 * 300, `${symbol} shares are conserved`);
        assert.strictEqual(Number(await shareBalance(state.pool, exchange, symbol)), 0);
    }
});

dbTest("real orders with their holds keep the audit green", async () => {
    // Top up six traders so the orders below fit whatever the random trades left them with
    for (const u of users.slice(0, 6)) {
        await depositCash(state.pool, u, "100000.00");
        await depositShares(state.pool, u, "INFY", 100, "1500.00");
    }

    // Place a buy and a sell for several users through the API
    for (let i = 0; i < 6; i++) {
        const login = await call("POST", "/auth/login", { body: { name: `trader-${i}`, password: "secret123" } });
        const token = login.body.token;

        const buy = await call("POST", "/orders", { token, key: key("buy"), body: { symbol: "TCS", side: "BUY", orderType: "LIMIT", quantity: 100, price: "500.00" } });
        const sell = await call("POST", "/orders", { token, key: key("sell"), body: { symbol: "INFY", side: "SELL", orderType: "LIMIT", quantity: 50, price: "1500.00" } });

        assert.strictEqual(buy.status, 201);
        assert.strictEqual(sell.status, 201);
    }

    const active = await state.pool.query("SELECT count(*) AS n FROM holds WHERE status = 'ACTIVE'");

    assert.strictEqual(active.rows[0].n, 12);
    assert.ok((await runAudit(state.pool)).every((r) => r.ok));
});
