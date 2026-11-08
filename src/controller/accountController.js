const pool = require("../config/db.js");
const { postEntries, systemId } = require("../config/ledger.js");

// Whole rupees up to 10 digits and at most two decimals, what NUMERIC(12,2) holds
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

const deposit = async (req, res) => {
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
        const body = req.body || {};
        const raw = body.amount === undefined ? "1000000.00" : body.amount;
        const amount = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";

        if (!MONEY.test(amount) || Number(amount) <= 0) {
            return res.status(400).json({
                error: "Amount must be positive with at most two decimals"
            });
        }

        // Check duplicate idempotency key
        const check = await client.query(
            `SELECT id FROM transactions
             WHERE idempotency_key = $1`,
            [idemp]
        );

        if (check.rows.length !== 0) {
            return res.status(409).json({
                error: "Transaction with same idempotency key exists"
            });
        }

        await client.query("BEGIN");

        // Credit simulated money from the deposits account
        const deposits = await systemId(client, "deposits");

        const transId = await postEntries(client, {
            idemp,
            kind: "DEPOSIT",
            description: "Paper money deposit",
            cash: [{ debit: deposits, credit: userId, amount }]
        });

        await client.query("COMMIT");

        return res.status(201).json({
            message: "Deposit successful",
            transactionId: transId
        });
    } catch (error) {
        await client.query("ROLLBACK");

        // Two requests with the same idempotency key raced each other
        if (error.code === "23505") {
            return res.status(409).json({
                error: "Transaction with same idempotency key exists"
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

const balance = async (req, res) => {
    try {
        const userId = req.user.userId;

        // Balance from the entries, available is balance minus active holds
        const funds = await pool.query(
            `SELECT b.balance,
                    b.balance - h.held AS available
             FROM (SELECT COALESCE(
                       SUM(
                           CASE
                               WHEN entry_type = 'CREDIT' THEN amount
                               WHEN entry_type = 'DEBIT' THEN -amount
                           END
                       ), 0.00
                   ) AS balance
                   FROM entries
                   WHERE user_id = $1) b,
                  (SELECT COALESCE(SUM(cash_amount), 0.00) AS held
                   FROM holds
                   WHERE user_id = $1
                   AND status = 'ACTIVE') h`,
            [userId]
        );

        return res.status(200).json({
            accountBalance: funds.rows[0].balance,
            availableBalance: funds.rows[0].available
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
};

// Every position with its mark: the latest trade price, else the instrument's reference price
const POSITIONS = `
    SELECT p.symbol,
           p.quantity,
           p.avg_cost,
           m.mark AS mark_price,
           ROUND(p.quantity * m.mark, 2) AS market_value,
           ROUND((m.mark - p.avg_cost) * p.quantity, 2) AS unrealized_pnl,
           p.realized_pnl
    FROM positions p
    JOIN instruments i ON i.symbol = p.symbol
    CROSS JOIN LATERAL (
        SELECT COALESCE(
            (SELECT t.price
             FROM trades t
             WHERE t.symbol = p.symbol
             ORDER BY t.id DESC
             LIMIT 1),
            i.reference_price
        ) AS mark
    ) m
    WHERE p.user_id = $1`;

const portfolio = async (req, res) => {
    try {
        const userId = req.user.userId;

        const rows = await pool.query(
            `${POSITIONS}
             ORDER BY p.symbol`,
            [userId]
        );

        // Net P&L: realised plus unrealised, minus the fees this user paid
        const totals = await pool.query(
            `WITH pos AS (${POSITIONS}),
             tot AS (
                 SELECT (SELECT COALESCE(SUM(realized_pnl), 0.00) FROM pos) AS realized,
                        (SELECT COALESCE(SUM(unrealized_pnl), 0.00) FROM pos) AS unrealized,
                        (SELECT COALESCE(SUM(e.amount), 0.00)
                         FROM entries e
                         JOIN transactions t ON t.id = e.transaction_id
                         WHERE t.kind = 'FEE'
                         AND e.user_id = $1
                         AND e.entry_type = 'DEBIT') AS fees
             )
             SELECT realized, unrealized, fees, realized + unrealized - fees AS net
             FROM tot`,
            [userId]
        );

        return res.status(200).json({
            portfolio: rows.rows,
            realizedPnl: totals.rows[0].realized,
            unrealizedPnl: totals.rows[0].unrealized,
            feesPaid: totals.rows[0].fees,
            netPnl: totals.rows[0].net
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
};

module.exports = {
    deposit,
    balance,
    portfolio
};
