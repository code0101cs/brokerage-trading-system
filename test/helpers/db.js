require("dotenv").config({ quiet: true });

const test = require("node:test");
const { Pool, types } = require("pg");

const { initDb } = require("../../scripts/initDb.js");

// Same as src/config/db.js, the helper pool does not load that file
types.setTypeParser(20, (value) => Number(value));

const config = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
};

// Each test file gets its own fresh database, so files can run side by side
const useDb = (name) => {
    const dbName = `brokerage_test_${name}`;
    const state = { pool: null, skip: false, dbName };

    test.before(async () => {
        const admin = new Pool({ ...config, database: process.env.DB_NAME });

        try {
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
            await admin.query(`CREATE DATABASE ${dbName}`);
        } catch (error) {
            // CI must have a database, a laptop without one just skips
            if (process.env.REQUIRE_DB === "1") {
                throw error;
            }

            state.skip = "postgres is not reachable";
            return;
        } finally {
            await admin.end();
        }

        // Anything loaded after this point, the app included, talks to the new database
        process.env.DB_NAME = dbName;
        process.env.SECRET_KEY = process.env.SECRET_KEY || "test-secret";
        process.env.MARKET_HOURS = process.env.MARKET_HOURS || "always";

        state.pool = new Pool({ ...config, database: dbName });

        await initDb(state.pool, false);
    });

    test.after(async () => {
        if (state.pool) {
            await state.pool.end();
        }

        // The app's own pool, if the test loaded it
        const key = require.resolve("../../src/config/db.js");

        if (require.cache[key]) {
            await require.cache[key].exports.end();
        }

        if (!state.skip) {
            const admin = new Pool({ ...config, database: "postgres" });

            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
            await admin.end();
        }
    });

    // Decides at run time, after the before hook has tried to connect
    const dbTest = (title, fn) => {
        test(title, async (t) => {
            if (state.skip) {
                return t.skip(state.skip);
            }

            await fn(t);
        });
    };

    return { state, dbTest };
};

module.exports = { useDb, config };
