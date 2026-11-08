const pool = require("../config/db.js");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const register = async (req, res) => {
    const client = await pool.connect();

    try {
        const { name, password } = req.body || {};

        if (typeof name !== "string" || typeof password !== "string" || !name || !password) {
            return res.status(400).json({
                error: "Name and password are required"
            });
        }

        if (name.length < 3 || name.length > 50) {
            return res.status(400).json({
                error: "Name must be 3 to 50 characters"
            });
        }

        // bcrypt only reads the first 72 bytes
        if (password.length < 6 || Buffer.byteLength(password) > 72) {
            return res.status(400).json({
                error: "Password must be 6 to 72 characters"
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        await client.query("BEGIN");

        // Create user
        const user = await client.query(
            `INSERT INTO users (name, password_hash)
             VALUES ($1, $2)
             RETURNING id`,
            [name, passwordHash]
        );

        // Create wallet
        await client.query(
            `INSERT INTO wallets (user_id)
             VALUES ($1)`,
            [user.rows[0].id]
        );

        await client.query("COMMIT");

        return res.status(201).json({
            message: "User registered successfully"
        });
    } catch (error) {
        await client.query("ROLLBACK");

        if (error.code === "23505") {
            return res.status(409).json({
                error: "Name already taken"
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

const login = async (req, res) => {
    try {
        const { name, password } = req.body || {};

        if (typeof name !== "string" || typeof password !== "string" || !name || !password) {
            return res.status(400).json({
                error: "Name and password are required"
            });
        }

        const user = await pool.query(
            `SELECT id, password_hash
             FROM users
             WHERE name = $1`,
            [name]
        );

        if (user.rows.length === 0) {
            return res.status(401).json({
                error: "Invalid name or password"
            });
        }

        const validPass = await bcrypt.compare(password, user.rows[0].password_hash);

        if (!validPass) {
            return res.status(401).json({
                error: "Invalid name or password"
            });
        }

        const token = jwt.sign(
            { userId: user.rows[0].id },
            process.env.SECRET_KEY,
            { expiresIn: "1h" }
        );

        return res.status(200).json({ token });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            error: "Internal server error"
        });
    }
};

module.exports = {
    register,
    login
};
