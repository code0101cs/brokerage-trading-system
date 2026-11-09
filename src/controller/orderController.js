const pool = require("../config/db.js");
const { lockWallets } = require("../config/ledger.js");
const { placeHold, resizeHold, releaseHold } = require("../config/holds.js");
const gateway = require("../config/gateway.js");
const { moveOrder } = require("../config/orders.js");
const { vet } = require("../config/risk.js");

// Up to 10 digits and at most two decimals, what NUMERIC(12,2) holds
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

// Stores the order as REJECTED with its reason, so the refusal is on record, and answers 400
const rejectOrder = async (client, res, orderId, reason) => {
    await moveOrder(client, orderId, "PENDING_RISK", "RISK_FAIL", { reason });

    await client.query(
        `UPDATE orders
         SET reject_reason = $1
         WHERE id = $2`,
        [reason, orderId]
    );

    await client.query("COMMIT");

    return res.status(400).json({
        error: reason,
        orderId
    });
};

const placeOrder = async (req, res) => {
    const client = await pool.connect();

    try {
        const idemp = req.headers["idempotency-key"];

        if (!idemp) {
            return res.status(400).json({
                error: "No idempotency key"
            });
        }

        if (idemp.length > 50) {
            return res.status(400).json({
                error: "Idempotency key too long"
            });
        }

        const userId = req.user.userId;
        const { symbol, side, orderType, quantity } = req.body || {};
        const timeInForce = (req.body || {}).timeInForce || "DAY";
        const rawPrice = (req.body || {}).price;
        const price = typeof rawPrice === "string" || typeof rawPrice === "number" ? String(rawPrice) : "";

        if (typeof symbol !== "string" || !symbol) {
            return res.status(400).json({
                error: "Symbol is required"
            });
        }

        if (side !== "BUY" && side !== "SELL") {
            return res.status(400).json({
                error: "Side must be BUY or SELL"
            });
        }

        if (orderType !== "LIMIT" && orderType !== "MARKET") {
            return res.status(400).json({
                error: "Order type must be LIMIT or MARKET"
            });
        }

        if (!["DAY", "IOC", "FOK"].includes(timeInForce)) {
            return res.status(400).json({
                error: "Time in force must be DAY, IOC or FOK"
            });
        }

        if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            return res.status(400).json({
                error: "Quantity must be a positive whole number"
            });
        }

        // A market order takes the market price, so it must not bring one
        if (orderType === "MARKET" && rawPrice !== undefined && rawPrice !== null) {
            return res.status(400).json({
                error: "Market orders take no price"
            });
        }

        if (orderType === "LIMIT" && (!MONEY.test(price) || Number(price) <= 0)) {
            return res.status(400).json({
                error: "Price must be positive with at most two decimals"
            });
        }

        // Check duplicate idempotency key
        const check = await client.query(
            `SELECT id FROM orders
             WHERE idempotency_key = $1`,
            [idemp]
        );

        if (check.rows.length !== 0) {
            return res.status(409).json({
                error: "Order with same idempotency key exists"
            });
        }

        const instrument = await client.query(
            `SELECT symbol, halted FROM instruments
             WHERE symbol = $1`,
            [symbol]
        );

        if (instrument.rows.length === 0) {
            return res.status(400).json({
                error: "Unknown symbol"
            });
        }

        await client.query("BEGIN");

        // Lock the user's wallet
        await lockWallets(client, [userId]);

        // Create order
        const order = await client.query(
            `INSERT INTO orders
             (user_id, symbol, side, order_type, time_in_force, price, quantity, status, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8)
             RETURNING id`,
            [userId, symbol, side, orderType, timeInForce, orderType === "MARKET" ? null : price, quantity, idemp]
        );

        const orderId = order.rows[0].id;

        // NEW to PENDING_RISK
        await moveOrder(client, orderId, "NEW", "SUBMIT");

        // Risk checks against the instrument and the ledger
        const risk = await vet(client, { userId, instrument: instrument.rows[0], side, orderType, quantity, price: orderType === "MARKET" ? null : price });

        if (risk.reason) {
            return await rejectOrder(client, res, orderId, risk.reason);
        }

        // PENDING_RISK to ACCEPTED, then reserve the cash or the shares
        await moveOrder(client, orderId, "PENDING_RISK", "RISK_PASS");
        await placeHold(client, userId, orderId, risk.cashHold, risk.shareHold);

        // A market buy keeps its collar, the engine gets it as the protection price
        if (risk.protection) {
            await client.query(
                `UPDATE orders
                 SET protection_price = $1
                 WHERE id = $2`,
                [risk.protection, orderId]
            );
        }

        await client.query("COMMIT");

        return res.status(201).json({
            message: "Order accepted",
            orderId
        });
    } catch (error) {
        await client.query("ROLLBACK");

        // Two requests with the same idempotency key raced each other
        if (error.code === "23505") {
            return res.status(409).json({
                error: "Order with same idempotency key exists"
            });
        }

        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    } finally {
        client.release();
    }
};

// The order and its lifecycle log, only for the user who placed it
const getOrder = async (req, res) => {
    try {
        const id = req.params.id;

        if (!/^\d{1,15}$/.test(id)) {
            return res.status(400).json({
                error: "Invalid order id"
            });
        }

        const order = await pool.query(
            `SELECT id, symbol, side, order_type, time_in_force, price, quantity, filled_quantity, status, reject_reason, created_at
             FROM orders
             WHERE id = $1
             AND user_id = $2`,
            [id, req.user.userId]
        );

        if (order.rows.length === 0) {
            return res.status(404).json({
                error: "Order not found"
            });
        }

        const events = await pool.query(
            `SELECT event, from_status, to_status, detail, created_at
             FROM order_events
             WHERE order_id = $1
             ORDER BY id`,
            [id]
        );

        return res.status(200).json({
            order: order.rows[0],
            events: events.rows
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
};

// Statuses where an order is resting and can still be cancelled or replaced
const OPEN = ["ACCEPTED", "WORKING", "PARTIALLY_FILLED"];

// Cancel in two steps. First PENDING_CANCEL is saved, then the exchange is asked, and only when
// it confirms does the order become CANCELLED and its hold go back to the user.
const cancelOrder = async (req, res) => {
    const client = await pool.connect();

    try {
        const id = req.params.id;

        if (!/^\d{1,15}$/.test(id)) {
            return res.status(400).json({
                error: "Invalid order id"
            });
        }

        await client.query("BEGIN");

        // Lock the order, it must be the user's own
        const found = await client.query(
            `SELECT id, user_id, symbol, side, status FROM orders
             WHERE id = $1
             AND user_id = $2
             FOR UPDATE`,
            [id, req.user.userId]
        );

        if (found.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Order not found"
            });
        }

        const order = found.rows[0];

        if (order.status === "FILLED") {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order already filled"
            });
        }

        if (order.status === "PENDING_CANCEL") {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Cancel already requested"
            });
        }

        if (!OPEN.includes(order.status)) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order already closed"
            });
        }

        // Step one: PENDING_CANCEL
        if ((await moveOrder(client, order.id, order.status, "CANCEL_REQUEST")) === null) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order was changed by another request"
            });
        }

        await client.query("COMMIT");

        // Ask the exchange to take the order off the book
        const removed = await gateway.cancel(order);

        // It was no longer resting: a fill got there first, and the fill closes the order
        if (!removed) {
            return res.status(409).json({
                error: "Order already filled"
            });
        }

        // Step two: confirmed, so CANCELLED and the hold goes back
        await client.query("BEGIN");

        await client.query("SELECT id FROM orders WHERE id = $1 FOR UPDATE", [order.id]);

        if ((await moveOrder(client, order.id, "PENDING_CANCEL", "CANCELLED")) === null) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order already filled"
            });
        }

        await releaseHold(client, order.id);

        await client.query("COMMIT");

        return res.status(200).json({
            message: "Order cancelled",
            orderId: order.id
        });
    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    } finally {
        client.release();
    }
};

// Change the quantity or the price of a resting limit order. The new values are checked like a
// new order, the hold is resized in the same transaction, and the exchange is told before commit,
// so if it refuses nothing has changed.
const replaceOrder = async (req, res) => {
    const client = await pool.connect();

    try {
        const id = req.params.id;
        const { quantity } = req.body || {};
        const rawPrice = (req.body || {}).price;
        const price = typeof rawPrice === "string" || typeof rawPrice === "number" ? String(rawPrice) : "";

        if (!/^\d{1,15}$/.test(id)) {
            return res.status(400).json({
                error: "Invalid order id"
            });
        }

        if (quantity === undefined && rawPrice === undefined) {
            return res.status(400).json({
                error: "Nothing to change"
            });
        }

        if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity <= 0)) {
            return res.status(400).json({
                error: "Quantity must be a positive whole number"
            });
        }

        if (rawPrice !== undefined && (!MONEY.test(price) || Number(price) <= 0)) {
            return res.status(400).json({
                error: "Price must be positive with at most two decimals"
            });
        }

        await client.query("BEGIN");

        // Lock the order, then the wallet, always in that order
        const found = await client.query(
            `SELECT id, user_id, symbol, side, order_type, price, quantity, filled_quantity, status FROM orders
             WHERE id = $1
             AND user_id = $2
             FOR UPDATE`,
            [id, req.user.userId]
        );

        if (found.rows.length === 0) {
            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "Order not found"
            });
        }

        const order = found.rows[0];

        if (order.status === "FILLED") {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order already filled"
            });
        }

        if (!OPEN.includes(order.status)) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order can no longer be changed"
            });
        }

        if (order.order_type !== "LIMIT") {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Only limit orders can be changed"
            });
        }

        const newQuantity = quantity === undefined ? order.quantity : quantity;
        const newPrice = rawPrice === undefined ? order.price : price;

        if (newQuantity <= order.filled_quantity) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Quantity must be above the filled quantity"
            });
        }

        await lockWallets(client, [order.user_id]);

        const instrument = await client.query(
            `SELECT symbol, halted FROM instruments
             WHERE symbol = $1`,
            [order.symbol]
        );

        const hold = await client.query(
            `SELECT cash_amount, share_quantity FROM holds
             WHERE order_id = $1
             AND status = 'ACTIVE'`,
            [order.id]
        );

        // Same checks as a new order. Funds are needed for the unfilled part only, and what the
        // order already holds counts as available.
        const risk = await vet(client, {
            userId: order.user_id,
            instrument: instrument.rows[0],
            side: order.side,
            orderType: "LIMIT",
            quantity: newQuantity,
            price: newPrice,
            open: newQuantity - order.filled_quantity,
            own: { cash: hold.rows[0].cash_amount, shares: hold.rows[0].share_quantity }
        });

        if (risk.reason) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                error: risk.reason
            });
        }

        await client.query(
            `UPDATE orders
             SET quantity = $1, price = $2
             WHERE id = $3`,
            [newQuantity, newPrice, order.id]
        );

        // The hold follows the new unfilled size and price
        await resizeHold(client, order.id);

        // Tell the exchange, and keep everything only if it took the change
        const taken = await gateway.replace(order, newQuantity, newPrice);

        if (!taken) {
            await client.query("ROLLBACK");

            return res.status(409).json({
                error: "Order already filled"
            });
        }

        await client.query("COMMIT");

        return res.status(200).json({
            message: "Order replaced",
            orderId: order.id
        });
    } catch (error) {
        await client.query("ROLLBACK");

        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    } finally {
        client.release();
    }
};

module.exports = { placeOrder, getOrder, cancelOrder, replaceOrder };
