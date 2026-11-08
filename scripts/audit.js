// Reconciliation audit. Every check is a query that returns the rows that break the rule,
// so an empty result is a PASS. The names for I1 to I3 match docs/invariants.md.

const CASH = "CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END";
const SHARES = "CASE WHEN entry_type = 'CREDIT' THEN quantity ELSE -quantity END";

const checks = [
    {
        name: "cash_never_negative",
        invariant: "I1",
        about: "no trading account has a negative cash balance",
        sql: `SELECT e.user_id, SUM(${CASH}) AS balance
              FROM entries e
              JOIN users u ON u.id = e.user_id
              WHERE NOT u.is_system
              GROUP BY e.user_id
              HAVING SUM(${CASH}) < 0`
    },
    {
        name: "positions_never_negative",
        invariant: "I2",
        about: "no trading account holds a negative number of shares",
        sql: `SELECT se.user_id, se.symbol, SUM(${SHARES}) AS shares
              FROM share_entries se
              JOIN users u ON u.id = se.user_id
              WHERE NOT u.is_system
              GROUP BY se.user_id, se.symbol
              HAVING SUM(${SHARES}) < 0
              UNION ALL
              SELECT user_id, symbol, quantity
              FROM positions
              WHERE quantity < 0`
    },
    {
        name: "debits_equal_credits",
        invariant: "I3",
        about: "every transaction has debits equal to credits, in cash and in shares",
        sql: `SELECT 'cash' AS ledger, transaction_id, NULL::varchar AS symbol,
                     SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) AS debits,
                     SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END) AS credits
              FROM entries
              GROUP BY transaction_id
              HAVING SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END)
                  <> SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)
              UNION ALL
              SELECT 'shares', transaction_id, symbol,
                     SUM(CASE WHEN entry_type = 'DEBIT' THEN quantity ELSE 0 END),
                     SUM(CASE WHEN entry_type = 'CREDIT' THEN quantity ELSE 0 END)
              FROM share_entries
              GROUP BY transaction_id, symbol
              HAVING SUM(CASE WHEN entry_type = 'DEBIT' THEN quantity ELSE 0 END)
                  <> SUM(CASE WHEN entry_type = 'CREDIT' THEN quantity ELSE 0 END)`
    },
    {
        name: "every_transaction_has_entries",
        invariant: "I3",
        about: "no transaction exists without ledger rows",
        sql: `SELECT t.id AS transaction_id, t.kind
              FROM transactions t
              WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.transaction_id = t.id)
              AND NOT EXISTS (SELECT 1 FROM share_entries s WHERE s.transaction_id = t.id)`
    },
    {
        name: "positions_match_share_entries",
        invariant: "-",
        about: "each position quantity equals the sum of its share ledger rows",
        sql: `SELECT COALESCE(p.user_id, s.user_id) AS user_id,
                     COALESCE(p.symbol, s.symbol) AS symbol,
                     COALESCE(p.quantity, 0) AS position,
                     COALESCE(s.shares, 0) AS ledger
              FROM positions p
              FULL OUTER JOIN (
                  SELECT se.user_id, se.symbol, SUM(${SHARES}) AS shares
                  FROM share_entries se
                  JOIN users u ON u.id = se.user_id
                  WHERE NOT u.is_system
                  GROUP BY se.user_id, se.symbol
              ) s ON s.user_id = p.user_id AND s.symbol = p.symbol
              WHERE COALESCE(p.quantity, 0) <> COALESCE(s.shares, 0)`
    },
    {
        name: "holds_within_balances",
        invariant: "-",
        about: "active holds never exceed the cash or the shares they reserve",
        sql: `SELECT h.user_id, 'cash' AS kind, NULL::varchar AS symbol,
                     SUM(h.cash_amount) AS held, COALESCE(b.balance, 0) AS balance
              FROM holds h
              LEFT JOIN (
                  SELECT user_id, SUM(${CASH}) AS balance
                  FROM entries
                  GROUP BY user_id
              ) b ON b.user_id = h.user_id
              WHERE h.status = 'ACTIVE'
              AND h.cash_amount > 0
              GROUP BY h.user_id, b.balance
              HAVING SUM(h.cash_amount) > COALESCE(b.balance, 0)
              UNION ALL
              SELECT h.user_id, 'shares', o.symbol,
                     SUM(h.share_quantity), COALESCE(sb.shares, 0)
              FROM holds h
              JOIN orders o ON o.id = h.order_id
              LEFT JOIN (
                  SELECT user_id, symbol, SUM(${SHARES}) AS shares
                  FROM share_entries
                  GROUP BY user_id, symbol
              ) sb ON sb.user_id = h.user_id AND sb.symbol = o.symbol
              WHERE h.status = 'ACTIVE'
              AND h.share_quantity > 0
              GROUP BY h.user_id, o.symbol, sb.shares
              HAVING SUM(h.share_quantity) > COALESCE(sb.shares, 0)`
    },
    {
        name: "exchange_is_flat",
        invariant: "-",
        about: "the clearing account holds no cash and no shares",
        sql: `SELECT 'cash' AS ledger, NULL::varchar AS symbol, SUM(${CASH}) AS balance
              FROM entries e
              JOIN users u ON u.id = e.user_id
              WHERE u.name = 'exchange' AND u.is_system
              HAVING SUM(${CASH}) <> 0
              UNION ALL
              SELECT 'shares', se.symbol, SUM(${SHARES})
              FROM share_entries se
              JOIN users u ON u.id = se.user_id
              WHERE u.name = 'exchange' AND u.is_system
              GROUP BY se.symbol
              HAVING SUM(${SHARES}) <> 0`
    }
];

// Runs every check on a pool or a client, the answer is one result per check
const runAudit = async (db) => {
    const results = [];

    for (const check of checks) {
        const found = await db.query(check.sql);

        results.push({
            name: check.name,
            invariant: check.invariant,
            about: check.about,
            ok: found.rows.length === 0,
            rows: found.rows
        });
    }

    return results;
};

const run = async () => {
    require("dotenv").config({ quiet: true });

    const pool = require("../src/config/db.js");

    try {
        const results = await runAudit(pool);

        for (const r of results) {
            const tag = r.invariant === "-" ? "" : ` (${r.invariant})`;

            if (r.ok) {
                console.log(`PASS ${r.name}${tag}`);
            } else {
                console.log(`FAIL ${r.name}${tag}: ${r.rows.length} violation(s), ${r.about}`);

                for (const row of r.rows.slice(0, 10)) {
                    console.log(`     ${JSON.stringify(row)}`);
                }
            }
        }

        const failed = results.filter((r) => !r.ok).length;

        console.log(`audit: ${results.length - failed} passed, ${failed} failed`);

        process.exitCode = failed === 0 ? 0 : 1;
    } catch (error) {
        console.error("audit could not run:", error.message);
        process.exitCode = 2;
    } finally {
        await pool.end();
    }
};

if (require.main === module) {
    run();
}

module.exports = { checks, runAudit };
