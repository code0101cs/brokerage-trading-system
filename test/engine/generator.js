// Small seeded generator, so a stream can be replayed exactly. Tests only, the engine has no randomness.
const rng = (seed) => {
    let a = seed >>> 0;

    return () => {
        a = (a + 0x6d2b79f5) >>> 0;

        let t = a;

        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

// A list of commands: limit, market, IOC, FOK, cancel, replace and a rare end of session
const generate = (seed, count, users = 30) => {
    const rand = rng(seed);
    const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const commands = [];
    let mid = 10000;
    let nextId = 1;

    for (let seq = 1; seq <= count; seq++) {
        const ts = 1700000000000 + seq * 10;
        const roll = rand();

        // The middle price drifts slowly
        mid = Math.max(500, mid + int(-3, 3) * 5);

        if (roll < 0.5) {
            const side = rand() < 0.5 ? "BUY" : "SELL";
            const tif = rand() < 0.1 ? "IOC" : rand() < 0.07 ? "FOK" : "DAY";

            commands.push({
                seq,
                ts,
                type: "NEW_ORDER",
                payload: {
                    orderType: "LIMIT",
                    id: nextId++,
                    userId: int(1, users),
                    side,
                    timeInForce: tif,
                    price: mid + int(-40, 40) * 5,
                    quantity: rand() < 0.1 ? int(100, 600) : int(1, 60)
                }
            });
        } else if (roll < 0.65) {
            commands.push({
                seq,
                ts,
                type: "NEW_ORDER",
                payload: {
                    orderType: "MARKET",
                    id: nextId++,
                    userId: int(1, users),
                    side: rand() < 0.5 ? "BUY" : "SELL",
                    timeInForce: rand() < 0.1 ? "FOK" : "IOC",
                    protectionPrice: rand() < 0.5 ? mid + int(-30, 30) * 5 : null,
                    quantity: int(1, 80)
                }
            });
        } else if (roll < 0.8 && nextId > 1) {
            // Often an id that is long gone, which exercises CancelRejected
            commands.push({ seq, ts, type: "CANCEL", payload: { orderId: int(1, nextId - 1) } });
        } else if (roll < 0.95 && nextId > 1) {
            commands.push({
                seq,
                ts,
                type: "REPLACE",
                payload: { orderId: int(1, nextId - 1), quantity: int(1, 120), price: mid + int(-40, 40) * 5 }
            });
        } else if (roll < 0.953) {
            commands.push({ seq, ts, type: "EXPIRE", payload: {} });
        } else if (roll < 0.963) {
            // Bad input: a zero quantity or a price that is not positive
            const bad = rand() < 0.5;

            commands.push({
                seq,
                ts,
                type: "NEW_ORDER",
                payload: {
                    orderType: "LIMIT",
                    id: nextId++,
                    userId: int(1, users),
                    side: "BUY",
                    timeInForce: "DAY",
                    price: bad ? -5 : mid,
                    quantity: bad ? 10 : 0
                }
            });
        } else {
            commands.push({
                seq,
                ts,
                type: "NEW_ORDER",
                payload: {
                    orderType: "LIMIT",
                    id: nextId++,
                    userId: int(1, users),
                    side: rand() < 0.5 ? "BUY" : "SELL",
                    timeInForce: "DAY",
                    price: mid + int(-10, 10) * 5,
                    quantity: int(1, 30)
                }
            });
        }
    }

    return commands;
};

module.exports = { generate, rng };
