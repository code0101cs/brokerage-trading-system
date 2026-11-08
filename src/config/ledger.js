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

module.exports = {
    SYSTEM_ACCOUNTS,
    seedSystem,
    systemId
};
