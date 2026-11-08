// Small helpers for tests that need users, instruments and money in the database
const { postEntries, systemId } = require("../../src/config/ledger.js");

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

const depositShares = async (pool, userId, symbol, quantity) => {
    const deposits = await systemId(pool, "deposits");

    return postEntries(pool, { idemp: key("depsh"), kind: "DEPOSIT", description: "test shares", shares: [{ debit: deposits, credit: userId, symbol, quantity }] });
};

module.exports = { addUser, addInstrument, balance, shareBalance, key, depositCash, depositShares };
