const assert = require("node:assert");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");
const { addInstrument, addTrade, chargeFee } = require("./helpers/ledger.js");
const { buyFill, sellFill } = require("../src/config/positions.js");

const { state, dbTest } = useDb("portfolio");
const { call, signUp } = useServer();

const portfolio = (user) => call("GET", "/account/portfolio", { token: user.token });

dbTest("a new user has an empty portfolio and zero P&L", async () => {
    const user = await signUp("newbie");
    const res = await portfolio(user);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { portfolio: [], realizedPnl: "0.00", unrealizedPnl: "0.00", feesPaid: "0.00", netPnl: "0.00" });
});

dbTest("the portfolio needs a token", async () => {
    const res = await call("GET", "/account/portfolio");

    assert.strictEqual(res.status, 401);
});

dbTest("profit, loss, flat and closed positions match the hand-calculated values", async () => {
    for (const [symbol, ref] of [["TCS", "500.00"], ["INFY", "1500.00"], ["WIPRO", "400.00"], ["HDFC", "110.00"], ["RELI", "100.00"]]) {
        await addInstrument(state.pool, symbol, ref);
    }

    const me = await signUp("hero");
    const other = await signUp("other");

    // Positions. avg cost 500 / 1500 / 400, RELI builds to 103.5075 over three buys, HDFC is bought and sold
    await buyFill(state.pool, me.userId, "TCS", 100, "500.00");
    await buyFill(state.pool, me.userId, "INFY", 10, "1500.00");
    await buyFill(state.pool, me.userId, "WIPRO", 50, "400.00");
    await buyFill(state.pool, me.userId, "RELI", 30, "100.00");
    await buyFill(state.pool, me.userId, "RELI", 20, "110.00");
    await buyFill(state.pool, me.userId, "RELI", 7, "99.99");
    await buyFill(state.pool, me.userId, "HDFC", 10, "100.00");
    await sellFill(state.pool, me.userId, "HDFC", 10, "120.00");

    // Marks: the latest trade by id, not the highest price. INFY has no trade, so it falls back to its reference price
    await addTrade(state.pool, "TCS", "510.00", 5, other.userId, other.userId);
    await addTrade(state.pool, "TCS", "520.00", 5, other.userId, other.userId);
    await addTrade(state.pool, "WIPRO", "380.00", 5, other.userId, other.userId);
    await addTrade(state.pool, "RELI", "105.00", 5, other.userId, other.userId);

    // Fees paid by me are 15.00 + 0.30 + 4.70, the other user's fee must not count
    await chargeFee(state.pool, me.userId, "15.00");
    await chargeFee(state.pool, me.userId, "0.30");
    await chargeFee(state.pool, me.userId, "4.70");
    await chargeFee(state.pool, other.userId, "99.00");

    const res = await portfolio(me);

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.portfolio, [
        { symbol: "HDFC", quantity: 0, avg_cost: "100.0000", mark_price: "110.00", market_value: "0.00", unrealized_pnl: "0.00", realized_pnl: "200.00" },
        { symbol: "INFY", quantity: 10, avg_cost: "1500.0000", mark_price: "1500.00", market_value: "15000.00", unrealized_pnl: "0.00", realized_pnl: "0.00" },
        { symbol: "RELI", quantity: 57, avg_cost: "103.5075", mark_price: "105.00", market_value: "5985.00", unrealized_pnl: "85.07", realized_pnl: "0.00" },
        { symbol: "TCS", quantity: 100, avg_cost: "500.0000", mark_price: "520.00", market_value: "52000.00", unrealized_pnl: "2000.00", realized_pnl: "0.00" },
        { symbol: "WIPRO", quantity: 50, avg_cost: "400.0000", mark_price: "380.00", market_value: "19000.00", unrealized_pnl: "-1000.00", realized_pnl: "0.00" }
    ]);

    // Realised 200.00, unrealised 2000.00 + 0 - 1000.00 + 85.07 = 1085.07, fees 20.00, net 200.00 + 1085.07 - 20.00
    assert.strictEqual(res.body.realizedPnl, "200.00");
    assert.strictEqual(res.body.unrealizedPnl, "1085.07");
    assert.strictEqual(res.body.feesPaid, "20.00");
    assert.strictEqual(res.body.netPnl, "1265.07");
});

dbTest("the mark follows the latest trade as it arrives", async () => {
    const me = await signUp("me2");

    await buyFill(state.pool, me.userId, "TCS", 100, "500.00");

    // The latest trade so far on TCS is 520.00
    assert.strictEqual((await portfolio(me)).body.portfolio[0].unrealized_pnl, "2000.00");

    await addTrade(state.pool, "TCS", "530.00", 1, me.userId, me.userId);

    const res = await portfolio(me);

    assert.strictEqual(res.body.portfolio[0].mark_price, "530.00");
    assert.strictEqual(res.body.portfolio[0].unrealized_pnl, "3000.00");
    assert.strictEqual(res.body.netPnl, "3000.00");

    // A trade in another symbol changes nothing here
    await addTrade(state.pool, "INFY", "9999.00", 1, me.userId, me.userId);

    assert.strictEqual((await portfolio(me)).body.portfolio[0].mark_price, "530.00");
});

dbTest("a price drop makes unrealised P&L negative and net P&L follows", async () => {
    const me = await signUp("me3");

    await buyFill(state.pool, me.userId, "TCS", 10, "600.00");
    await chargeFee(state.pool, me.userId, "1.80");

    const res = await portfolio(me);

    // Mark is 530.00: (530 - 600) * 10 = -700.00, minus the 1.80 fee
    assert.strictEqual(res.body.portfolio[0].unrealized_pnl, "-700.00");
    assert.strictEqual(res.body.netPnl, "-701.80");
});

dbTest("the portfolio only shows the caller's own positions", async () => {
    const a = await signUp("owner-a");
    const b = await signUp("owner-b");

    await buyFill(state.pool, a.userId, "WIPRO", 7, "400.00");

    assert.strictEqual((await portfolio(a)).body.portfolio.length, 1);
    assert.deepStrictEqual((await portfolio(b)).body.portfolio, []);
});
