// Small helpers for tests that need users, instruments and money in the database
const { postEntries, systemId, lockWallets } = require("../../src/config/ledger.js");
const { buyFill, sellFill } = require("../../src/config/positions.js");
const { resizeHold } = require("../../src/config/holds.js");
const { moveOrder } = require("../../src/config/orders.js");
const { feeSql } = require("../../src/config/fees.js");

const addUser = async (pool, name) => {
    const user = await pool.query(
        `INSERT INTO users (name, password_hash)
         VALUES ($1, 'x')
         RETURNING id`,
        [name]
    );

    await pool.query("INSERT INTO wallets (user_id) VALUES ($1)", [user.rows[0].id]);

    return user.rows[0].id;
};

const addInstrument = async (pool, symbol, price) => {
    await pool.query(
        `INSERT INTO instruments (symbol, name, reference_price)
         VALUES ($1, $1, $2)`,
        [symbol, price]
    );
};

// Cash balance, shares are SUM over share_entries the same way
const balance = async (pool, userId) => {
    const row = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END), 0) AS balance
         FROM entries
         WHERE user_id = $1`,
        [userId]
    );

    return row.rows[0].balance;
};

const shareBalance = async (pool, userId, symbol) => {
    const row = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN quantity ELSE -quantity END), 0) AS qty
         FROM share_entries
         WHERE user_id = $1 AND symbol = $2`,
        [userId, symbol]
    );

    return row.rows[0].qty;
};

let counter = 0;

// A unique idempotency key for tests that do not care about it
const key = (prefix) => `${prefix}-${++counter}`;

const depositCash = async (pool, userId, amount) => {
    const deposits = await systemId(pool, "deposits");

    return postEntries(pool, { idemp: key("dep"), kind: "DEPOSIT", description: "test deposit", cash: [{ debit: deposits, credit: userId, amount }] });
};

// With a cost the position is created too, the way real code that hands out shares must
const depositShares = async (pool, userId, symbol, quantity, cost) => {
    const deposits = await systemId(pool, "deposits");

    if (cost !== undefined) {
        await buyFill(pool, userId, symbol, quantity, cost);
    }

    return postEntries(pool, { idemp: key("depsh"), kind: "DEPOSIT", description: "test shares", shares: [{ debit: deposits, credit: userId, symbol, quantity }] });
};

// A trade row, with the two filled orders it needs
const addTrade = async (pool, symbol, price, quantity, buyerId, sellerId) => {
    const order = async (userId, side) => {
        const row = await pool.query(
            `INSERT INTO orders
             (user_id, symbol, side, order_type, time_in_force, price, quantity, filled_quantity, status, idempotency_key)
             VALUES ($1, $2, $3, 'LIMIT', 'DAY', $4, $5, $5, 'FILLED', $6)
             RETURNING id`,
            [userId, symbol, side, price, quantity, key("ord")]
        );

        return row.rows[0].id;
    };

    const buyOrder = await order(buyerId, "BUY");
    const sellOrder = await order(sellerId, "SELL");

    const trade = await pool.query(
        `INSERT INTO trades
         (trade_id, symbol, price, quantity, buy_order_id, sell_order_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [key("trade"), symbol, price, quantity, buyOrder, sellOrder]
    );

    return trade.rows[0].id;
};

// A fee the user paid to the fees account
const chargeFee = async (pool, userId, amount) => {
    const fees = await systemId(pool, "fees");

    return postEntries(pool, { idemp: key("fee"), kind: "FEE", description: "test fee", cash: [{ debit: userId, credit: fees, amount }] });
};

// One fill of a resting order against a counterparty, the way the Phase 5 fill handler will do
// it: the cash and share legs, the buyer's fee, both positions, the order's progress, its hold
const fillOrder = async (pool, orderId, counterId, quantity, price) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const found = await client.query(
            `SELECT user_id, symbol, side, quantity, filled_quantity, status FROM orders
             WHERE id = $1
             FOR UPDATE`,
            [orderId]
        );

        const o = found.rows[0];
        const buyer = o.side === "BUY" ? o.user_id : counterId;
        const seller = o.side === "BUY" ? counterId : o.user_id;

        await lockWallets(client, [buyer, seller]);

        const value = (await client.query("SELECT $1::bigint * $2::numeric AS v", [quantity, price])).rows[0].v;
        const fee = (await client.query(`SELECT ${feeSql("$1::numeric")} AS fee`, [value])).rows[0].fee;
        const exchange = await systemId(client, "exchange");
        const fees = await systemId(client, "fees");

        await postEntries(client, {
            idemp: key("fill"),
            kind: "TRADE",
            description: "test fill",
            cash: [
                { debit: buyer, credit: exchange, amount: value },
                { debit: exchange, credit: seller, amount: value }
            ],
            shares: [
                { debit: seller, credit: exchange, symbol: o.symbol, quantity },
                { debit: exchange, credit: buyer, symbol: o.symbol, quantity }
            ]
        });

        await postEntries(client, { idemp: key("fillfee"), kind: "FEE", description: "buy fee", cash: [{ debit: buyer, credit: fees, amount: fee }] });
        await buyFill(client, buyer, o.symbol, quantity, price);
        await sellFill(client, seller, o.symbol, quantity, price);

        await client.query("UPDATE orders SET filled_quantity = filled_quantity + $1 WHERE id = $2", [quantity, orderId]);
        await moveOrder(client, orderId, o.status, o.filled_quantity + quantity === o.quantity ? "FILL" : "PARTIAL_FILL");
        await resizeHold(client, orderId);

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

module.exports = { addUser, addInstrument, balance, shareBalance, key, depositCash, depositShares, addTrade, chargeFee, fillOrder };
