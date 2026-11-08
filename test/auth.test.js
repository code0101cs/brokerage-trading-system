const assert = require("node:assert");
const jwt = require("jsonwebtoken");

const { useDb } = require("./helpers/db.js");
const { useServer } = require("./helpers/http.js");

const { state, dbTest } = useDb("auth");
const { call, signUp } = useServer();

dbTest("a new user can register, log in, deposit and see the starting balance", async () => {
    const reg = await call("POST", "/auth/register", { body: { name: "alice", password: "secret123" } });

    assert.strictEqual(reg.status, 201);
    assert.deepStrictEqual(reg.body, { message: "User registered successfully" });

    const login = await call("POST", "/auth/login", { body: { name: "alice", password: "secret123" } });

    assert.strictEqual(login.status, 200);
    assert.ok(login.body.token);

    const before = await call("GET", "/account/balance", { token: login.body.token });

    assert.deepStrictEqual(before.body, { accountBalance: "0.00", availableBalance: "0.00" });

    const dep = await call("POST", "/account/deposit", { token: login.body.token, key: "alice-dep-1" });

    assert.strictEqual(dep.status, 201);
    assert.strictEqual(dep.body.message, "Deposit successful");
    assert.ok(dep.body.transactionId);

    const after = await call("GET", "/account/balance", { token: login.body.token });

    assert.strictEqual(after.status, 200);
    assert.deepStrictEqual(after.body, { accountBalance: "1000000.00", availableBalance: "1000000.00" });
});

dbTest("register creates the wallet and stores a bcrypt hash, never the password", async () => {
    await call("POST", "/auth/register", { body: { name: "bobby", password: "secret123" } });

    const row = await state.pool.query(
        `SELECT u.password_hash, u.is_system, w.id AS wallet
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         WHERE u.name = 'bobby'`
    );

    assert.ok(row.rows[0].wallet);
    assert.strictEqual(row.rows[0].is_system, false);
    assert.match(row.rows[0].password_hash, /^\$2[aby]\$10\$/);
    assert.ok(!row.rows[0].password_hash.includes("secret123"));
});

dbTest("registering the same name twice returns 409", async () => {
    await call("POST", "/auth/register", { body: { name: "carol", password: "secret123" } });

    const again = await call("POST", "/auth/register", { body: { name: "carol", password: "other-pass" } });

    assert.strictEqual(again.status, 409);
    assert.deepStrictEqual(again.body, { error: "Name already taken" });

    // Nothing half-created: still one user and one wallet
    const rows = await state.pool.query("SELECT count(*) AS n FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.name = 'carol'");

    assert.strictEqual(rows.rows[0].n, 1);
});

dbTest("a system account name cannot be registered", async () => {
    for (const name of ["deposits", "exchange", "fees"]) {
        const res = await call("POST", "/auth/register", { body: { name, password: "secret123" } });

        assert.strictEqual(res.status, 409, name);
    }
});

dbTest("register rejects bad input with 400", async () => {
    const bad = [
        {},
        { name: "dave" },
        { password: "secret123" },
        { name: "", password: "secret123" },
        { name: "ab", password: "secret123" },
        { name: "x".repeat(51), password: "secret123" },
        { name: "dave", password: "12345" },
        { name: "dave", password: "p".repeat(73) },
        { name: 12345, password: "secret123" },
        { name: "dave", password: 123456 }
    ];

    for (const body of bad) {
        const res = await call("POST", "/auth/register", { body });

        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.ok(res.body.error);
    }

    const rows = await state.pool.query("SELECT count(*) AS n FROM users WHERE name = 'dave'");

    assert.strictEqual(rows.rows[0].n, 0);
});

dbTest("login returns a one hour token that carries the user id", async () => {
    const { userId } = await signUp("erin");
    const login = await call("POST", "/auth/login", { body: { name: "erin", password: "secret123" } });
    const decoded = jwt.verify(login.body.token, process.env.SECRET_KEY);

    assert.strictEqual(decoded.userId, userId);
    assert.strictEqual(typeof decoded.userId, "number");
    assert.strictEqual(decoded.exp - decoded.iat, 3600);
});

dbTest("login refuses a wrong password, an unknown user and a system account", async () => {
    await signUp("frank");

    for (const body of [
        { name: "frank", password: "wrong-pass" },
        { name: "nobody", password: "secret123" },
        { name: "deposits", password: "!" },
        { name: "deposits", password: "secret123" }
    ]) {
        const res = await call("POST", "/auth/login", { body });

        assert.strictEqual(res.status, 401, JSON.stringify(body));
        assert.deepStrictEqual(res.body, { error: "Invalid name or password" });
    }

    const missing = await call("POST", "/auth/login", { body: { name: "frank" } });

    assert.strictEqual(missing.status, 400);
});

dbTest("protected routes need a valid token", async () => {
    const none = await call("GET", "/account/balance");

    assert.strictEqual(none.status, 401);

    const junk = await call("GET", "/account/balance", { token: "not.a.token" });

    assert.strictEqual(junk.status, 401);

    const expired = jwt.sign({ userId: 1 }, process.env.SECRET_KEY, { expiresIn: -10 });
    const old = await call("GET", "/account/balance", { token: expired });

    assert.strictEqual(old.status, 401);
    assert.deepStrictEqual(old.body, { error: "Invalid or expired token" });

    const forged = jwt.sign({ userId: 1 }, "some other secret", { expiresIn: "1h" });
    const fake = await call("POST", "/account/deposit", { token: forged, key: "k" });

    assert.strictEqual(fake.status, 401);
});

dbTest("deposit takes a chosen amount and adds to the balance", async () => {
    const { token } = await signUp("gina");

    await call("POST", "/account/deposit", { token, key: "gina-1", body: { amount: "250.50" } });
    await call("POST", "/account/deposit", { token, key: "gina-2", body: { amount: 100 } });
    await call("POST", "/account/deposit", { token, key: "gina-3", body: { amount: 0.1 } });

    const res = await call("GET", "/account/balance", { token });

    assert.deepStrictEqual(res.body, { accountBalance: "350.60", availableBalance: "350.60" });
});

dbTest("deposit needs an idempotency key and a repeated key returns 409 without paying twice", async () => {
    const { token } = await signUp("hank");

    const none = await call("POST", "/account/deposit", { token });

    assert.strictEqual(none.status, 400);
    assert.deepStrictEqual(none.body, { error: "No idempotency key" });

    const long = await call("POST", "/account/deposit", { token, key: "k".repeat(51) });

    assert.strictEqual(long.status, 400);

    const first = await call("POST", "/account/deposit", { token, key: "hank-1", body: { amount: "10.00" } });
    const second = await call("POST", "/account/deposit", { token, key: "hank-1", body: { amount: "10.00" } });

    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 409);

    const res = await call("GET", "/account/balance", { token });

    assert.strictEqual(res.body.accountBalance, "10.00");
});

dbTest("ten parallel deposits with one key pay exactly once", async () => {
    const { token } = await signUp("ivan");

    const all = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/account/deposit", { token, key: "ivan-same", body: { amount: "5.00" } })));
    const codes = all.map((r) => r.status).sort();

    assert.deepStrictEqual(codes, [201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);

    const res = await call("GET", "/account/balance", { token });

    assert.strictEqual(res.body.accountBalance, "5.00");
});

dbTest("deposit refuses bad amounts", async () => {
    const { token } = await signUp("judy");
    let n = 0;

    for (const amount of [0, "0.00", -5, "-1", 1.234, "abc", "", "1e3", "12345678901", null, true, [5], { a: 1 }]) {
        const res = await call("POST", "/account/deposit", { token, key: `judy-${++n}`, body: { amount } });

        assert.strictEqual(res.status, 400, JSON.stringify(amount));
    }

    const res = await call("GET", "/account/balance", { token });

    assert.strictEqual(res.body.accountBalance, "0.00");

    // The largest amount NUMERIC(12,2) holds is fine
    const big = await call("POST", "/account/deposit", { token, key: "judy-big", body: { amount: "9999999999.99" } });

    assert.strictEqual(big.status, 201);
});

dbTest("every deposit balances against the deposits account", async () => {
    const rows = await state.pool.query(
        `SELECT SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) AS net
         FROM entries`
    );

    // Money only moves, the whole ledger nets to zero
    assert.strictEqual(Number(rows.rows[0].net), 0);
});
