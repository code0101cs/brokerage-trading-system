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

module.exports = {
    deposit,
    balance
};
