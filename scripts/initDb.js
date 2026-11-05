const fs = require("node:fs");
const path = require("node:path");

// Dependency order: a table comes after every table it references
const tables = [
    "users",
    "wallets",
    "instruments",
    "orders",
    "order_events",
    "trades",
    "transactions",
    "entries",
    "share_entries",
    "holds",
    "positions",
    "settlements",
    "events",
    "outbox"
];

const modelsDir = path.join(__dirname, "..", "src", "models");

// Runs every model file inside one transaction, so a failure leaves nothing behind
const initDb = async (pool, reset) => {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // Wipe the schema first, only when asked
        if (reset) {
            await client.query("DROP SCHEMA public CASCADE");
            await client.query("CREATE SCHEMA public");
        }

        for (const table of tables) {
            const sql = fs.readFileSync(path.join(modelsDir, `${table}.sql`), "utf8");

            await client.query(sql);
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
};

const run = async () => {
    require("dotenv").config();

    const pool = require("../src/config/db.js");
    const reset = process.argv.includes("--reset");

    try {
        await initDb(pool, reset);
        console.log(`schema built in ${process.env.DB_NAME}, ${tables.length} tables`);
    } catch (error) {
        console.error("initDb failed:", error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
};

if (require.main === module) {
    run();
}

module.exports = { initDb, tables };
