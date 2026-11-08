const { feeSql } = require("./fees.js");

// What is still unfilled on an order, in cash
const REST = "(o.quantity - o.filled_quantity) * o.price";

// Cash a buy order reserves: its value plus the fee estimate
const buyHold = async (client, quantity, price) => {
    const hold = await client.query(
        `SELECT v + ${feeSql("v")} AS hold
         FROM (SELECT $1::numeric * $2::numeric AS v) t`,
        [quantity, price]
    );

    return hold.rows[0].hold;
};

// Balance minus active holds
const availableCash = async (client, userId) => {
    const funds = await client.query(
        `SELECT COALESCE(
             SUM(
                 CASE
                     WHEN entry_type = 'CREDIT' THEN amount
                     WHEN entry_type = 'DEBIT' THEN -amount
                 END
             ), 0.00
         ) - COALESCE(
             (SELECT SUM(cash_amount)
              FROM holds
              WHERE user_id = $1
              AND status = 'ACTIVE'), 0.00
         ) AS available
         FROM entries
         WHERE user_id = $1`,
        [userId]
    );

    return funds.rows[0].available;
};

// Share balance minus the shares active sell orders have reserved
const availableShares = async (client, userId, symbol) => {
    const shares = await client.query(
        `SELECT (COALESCE(
             SUM(
                 CASE
                     WHEN entry_type = 'CREDIT' THEN quantity
                     WHEN entry_type = 'DEBIT' THEN -quantity
                 END
             ), 0
         ) - COALESCE(
             (SELECT SUM(h.share_quantity)
              FROM holds h
              JOIN orders o ON o.id = h.order_id
              WHERE h.user_id = $1
              AND h.status = 'ACTIVE'
              AND o.symbol = $2), 0
         ))::bigint AS available
         FROM share_entries
         WHERE user_id = $1
         AND symbol = $2`,
        [userId, symbol]
    );

    return shares.rows[0].available;
};

const placeHold = async (client, userId, orderId, cashAmount, shareQuantity) => {
    await client.query(
        `INSERT INTO holds
         (user_id, order_id, cash_amount, share_quantity)
         VALUES ($1, $2, $3, $4)`,
        [userId, orderId, cashAmount, shareQuantity]
    );
};

// After a fill: the hold shrinks to what is still unfilled, and is released when nothing is left
const resizeHold = async (client, orderId) => {
    await client.query(
        `UPDATE holds h
         SET cash_amount = CASE
                 WHEN o.side = 'BUY' AND o.price IS NOT NULL THEN ${REST} + ${feeSql(REST)}
                 ELSE h.cash_amount
             END,
             share_quantity = CASE
                 WHEN o.side = 'SELL' THEN o.quantity - o.filled_quantity
                 ELSE h.share_quantity
             END,
             status = CASE
                 WHEN o.quantity - o.filled_quantity = 0 THEN 'RELEASED'
                 ELSE h.status
             END
         FROM orders o
         WHERE o.id = h.order_id
         AND h.order_id = $1
         AND h.status = 'ACTIVE'`,
        [orderId]
    );
};

// Cancelled, expired or rejected: nothing stays reserved
const releaseHold = async (client, orderId) => {
    await client.query(
        `UPDATE holds
         SET status = 'RELEASED'
         WHERE order_id = $1
         AND status = 'ACTIVE'`,
        [orderId]
    );
};

module.exports = {
    buyHold,
    availableCash,
    availableShares,
    placeHold,
    resizeHold,
    releaseHold
};
