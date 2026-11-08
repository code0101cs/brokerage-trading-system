const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { useDb } = require("./helpers/db.js");
const { addUser, addInstrument, depositCash } = require("./helpers/ledger.js");

const { state, dbTest } = useDb("auditcli");

const root = path.join(__dirname, "..");

// Runs `npm run audit`'s script as its own process against the test database
const audit = (env) =>
    spawnSync(process.execPath, ["scripts/audit.js"], {
        cwd: root,
        env: { ...process.env, DB_NAME: state.dbName, ...env },
        encoding: "utf8"
    });

dbTest("the audit command prints PASS for every check and exits 0 on a healthy ledger", async () => {
    await addInstrument(state.pool, "TCS", "500.00");

    const user = await addUser(state.pool, "cli-user");

    await depositCash(state.pool, user, "1000.00");

    const out = audit();

    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /PASS cash_never_negative \(I1\)/);
    assert.match(out.stdout, /PASS positions_never_negative \(I2\)/);
    assert.match(out.stdout, /PASS debits_equal_credits \(I3\)/);
    assert.match(out.stdout, /audit: 7 passed, 0 failed/);
    assert.ok(!out.stdout.includes("FAIL"));
});

dbTest("a row corrupted by hand makes the audit command print FAIL with the row and exit 1", async () => {
    // A debit with no credit, written straight into the table
    await state.pool.query("INSERT INTO entries (user_id, transaction_id, amount, entry_type) VALUES (1, 1, 5.00, 'DEBIT')");

    const out = audit();

    assert.strictEqual(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stdout, /FAIL debits_equal_credits \(I3\): 1 violation\(s\)/);
    assert.match(out.stdout, /"transaction_id":1/);
    assert.match(out.stdout, /audit: \d+ passed, 1 failed/);
});

dbTest("an audit that cannot reach the database exits 2 instead of passing", async () => {
    const out = audit({ DB_PORT: "1" });

    assert.strictEqual(out.status, 2);
    assert.match(out.stderr, /audit could not run/);
    assert.ok(!out.stdout.includes("PASS"));
});
