const test = require("node:test");
const assert = require("node:assert");

const app = require("../src/app.js");

test("GET /health answers 200", async () => {
    const server = app.listen(0);

    try {
        const port = server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.status, "ok");
    } finally {
        server.close();
    }
});
