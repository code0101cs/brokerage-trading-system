const SYSTEM_ACCOUNTS = ["deposits", "exchange", "fees"];

// The three system accounts are ordinary users with an unusable password hash
const seedSystem = async (client) => {
    for (const name of SYSTEM_ACCOUNTS) {
        await client.query(
            `INSERT INTO users (name, password_hash, is_system)
             VALUES ($1, '!', TRUE)
             ON CONFLICT (name) DO NOTHING`,
            [name]
        );
    }
};

// Id of a system account
const systemId = async (client, name) => {
    const row = await client.query(
        `SELECT id
         FROM users
         WHERE name = $1 AND is_system`,
        [name]
    );

    return row.rows[0].id;
};

// One transactions row, then a DEBIT and a CREDIT row for every leg.
// Runs inside the caller's BEGIN and COMMIT, a repeated idemp raises 23505.
const postEntries = async (client, { idemp, kind, description, cash = [], shares = [] }) => {
    if (cash.length === 0 && shares.length === 0) {
        throw new Error("Nothing to post");
    }

    // Create transaction
    const transaction = await client.query(
        `INSERT INTO transactions
         (idempotency_key, kind, description)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [idemp, kind, description]
    );

    const transId = transaction.rows[0].id;

    for (const leg of cash) {
        if (leg.debit === leg.credit) {
            throw new Error("Debit and credit must be different accounts");
        }

        // Debit payer
        await client.query(
            `INSERT INTO entries
             (user_id, transaction_id, amount, entry_type)
             VALUES ($1, $2, $3, 'DEBIT')`,
            [leg.debit, transId, leg.amount]
        );

        // Credit receiver
        await client.query(
            `INSERT INTO entries
             (user_id, transaction_id, amount, entry_type)
             VALUES ($1, $2, $3, 'CREDIT')`,
            [leg.credit, transId, leg.amount]
        );
    }

    for (const leg of shares) {
        if (leg.debit === leg.credit) {
            throw new Error("Debit and credit must be different accounts");
        }

        // Debit giver
        await client.query(
            `INSERT INTO share_entries
             (user_id, transaction_id, symbol, quantity, entry_type)
             VALUES ($1, $2, $3, $4, 'DEBIT')`,
            [leg.debit, transId, leg.symbol, leg.quantity]
        );

        // Credit taker
        await client.query(
            `INSERT INTO share_entries
             (user_id, transaction_id, symbol, quantity, entry_type)
             VALUES ($1, $2, $3, $4, 'CREDIT')`,
            [leg.credit, transId, leg.symbol, leg.quantity]
        );
    }

    return transId;
};

module.exports = {
    SYSTEM_ACCOUNTS,
    seedSystem,
    systemId,
    postEntries
};
