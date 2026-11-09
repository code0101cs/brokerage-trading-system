const pool = require("../config/db.js");
const { lockWallets } = require("../config/ledger.js");
const { buyHold, availableCash, availableShares, placeHold } = require("../config/holds.js");
const { moveOrder } = require("../config/orders.js");

// Up to 10 digits and at most two decimals, what NUMERIC(12,2) holds
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

// The first cut of order intake: limit orders and their hold. Phase 4 adds the risk checks.
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

        if (orderType !== "LIMIT") {
            return res.status(400).json({
                error: "Order type must be LIMIT"
            });
        }

        if (!["DAY", "IOC", "FOK"].includes(timeInForce)) {
            return res.status(400).json({
                error: "Time in force must be DAY, IOC or FOK"
            });
        }

        if (!Number.isInteger(quantity) || quantity <= 0) {
            return res.status(400).json({
                error: "Quantity must be a positive whole number"
            });
        }

        if (!MONEY.test(price) || Number(price) <= 0) {
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
            `SELECT symbol FROM instruments
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

        let cashHold = "0.00";
        let shareHold = 0;

        if (side === "BUY") {
            // Check available balance (balance minus active holds)
            cashHold = await buyHold(client, quantity, price);

            const available = await availableCash(client, userId);

            if (Number(available) < Number(cashHold)) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Insufficient balance"
                });
            }
        } else {
            // Check available shares (balance minus active share holds)
            shareHold = quantity;

            const available = await availableShares(client, userId, symbol);

            if (available < quantity) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Insufficient shares"
                });
            }
        }

        // Create order
        const order = await client.query(
            `INSERT INTO orders
             (user_id, symbol, side, order_type, time_in_force, price, quantity, status, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8)
             RETURNING id`,
            [userId, symbol, side, orderType, timeInForce, price, quantity, idemp]
        );

        const orderId = order.rows[0].id;

        // NEW, PENDING_RISK, ACCEPTED
        await moveOrder(client, orderId, "NEW", "SUBMIT");
        await moveOrder(client, orderId, "PENDING_RISK", "RISK_PASS");

        // Reserve the cash or the shares
        await placeHold(client, userId, orderId, cashHold, shareHold);

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

module.exports = { placeOrder, getOrder };
