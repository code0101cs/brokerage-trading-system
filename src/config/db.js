const { Pool, types } = require("pg");

// BIGINT (ids, quantities, counts) as a number, NUMERIC stays a string so money is exact
types.setTypeParser(20, (value) => Number(value));

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT
});

module.exports = pool;
