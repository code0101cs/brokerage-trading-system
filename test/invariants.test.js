const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "invariants.md"), "utf8");

// Rows of the main table: | I1 | rule | kind | `check` | file | phase |
const rows = doc
    .split("\n")
    .filter((line) => /^\| I\d /.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()).filter((cell) => cell !== ""));

test("I1 to I8 each appear exactly once", () => {
    const ids = rows.map((r) => r[0]);

    assert.deepStrictEqual(ids, ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"]);
});

test("every invariant has one named check and one owning phase", () => {
    for (const row of rows) {
        assert.strictEqual(row.length, 6, `${row[0]} needs six columns`);
        assert.match(row[3], /^`[a-z_]+`$/, `${row[0]} needs a named check`);
        assert.match(row[5], /^Phase [1-8] \(task \d\.\d\)$/, `${row[0]} needs an owning phase`);
    }
});

test("check names are unique", () => {
    const names = rows.map((r) => r[3]);

    assert.strictEqual(new Set(names).size, names.length);
});

test("every check has a section in the doc", () => {
    for (const row of rows) {
        const name = row[3].replace(/`/g, "");

        assert.ok(doc.includes(`: \`${name}\``), `${name} has no section`);
    }
});
