const test = require("node:test");

// Serves the app on a free port. It starts on the first request, which is after the
// database helper has pointed the env at the test database (root hooks run side by side).
const useServer = () => {
    const state = { server: null, base: "", starting: null };

    const start = () => {
        if (!state.starting) {
            state.starting = new Promise((resolve) => {
                const app = require("../../src/app.js");

                state.server = app.listen(0, "127.0.0.1", () => {
                    state.base = `http://127.0.0.1:${state.server.address().port}`;
                    resolve();
                });
            });
        }

        return state.starting;
    };

    test.after(async () => {
        if (state.server) {
            await new Promise((resolve) => state.server.close(resolve));
        }
    });

    // One request, the answer is { status, body }
    const call = async (method, path, { token, body, key } = {}) => {
        await start();

        const headers = { "content-type": "application/json" };

        if (token) {
            headers.authorization = `Bearer ${token}`;
        }

        if (key) {
            headers["idempotency-key"] = key;
        }

        const res = await fetch(`${state.base}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        return { status: res.status, body: await res.json() };
    };

    // Register and log in, the answer is { token, userId }
    const signUp = async (name, password = "secret123") => {
        await call("POST", "/auth/register", { body: { name, password } });

        const login = await call("POST", "/auth/login", { body: { name, password } });
        const payload = JSON.parse(Buffer.from(login.body.token.split(".")[1], "base64url").toString());

        return { token: login.body.token, userId: payload.userId };
    };

    return { state, call, signUp };
};

module.exports = { useServer };
