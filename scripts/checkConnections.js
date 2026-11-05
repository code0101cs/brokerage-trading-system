require("dotenv").config();

const { createClient } = require("redis");
const pool = require("../src/config/db.js");

const run = async () => {
    let failed = false;

    // Check Postgres
    try {
        const db = await pool.query("SELECT version() AS version");
        console.log(`postgres ok: ${db.rows[0].version}`);
    } catch (error) {
        failed = true;
        console.error("postgres failed:", error.message);
    }

    // Check Redis
    const redis = createClient({ url: process.env.REDIS_URL });
    redis.on("error", () => {});

    try {
        await redis.connect();
        const pong = await redis.ping();
        console.log(`redis ok: ${pong}`);
    } catch (error) {
        failed = true;
        console.error("redis failed:", error.message);
    }

    await pool.end();
    await redis.destroy();

    process.exit(failed ? 1 : 0);
};

run();
