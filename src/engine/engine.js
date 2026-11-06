const crypto = require("crypto");

const { EVENTS, REASONS } = require("../config/events.js");
const { snapshot } = require("./orderBook.js");
const { submitLimit, submitMarket, make } = require("./matching.js");
const { cancel, replace, expireAll } = require("./amend.js");

// One command in, a list of events out. No clock, no randomness, no I/O.
const applyCommand = (book, command) => {
    const { seq, ts, type, payload } = command;

    if (!Number.isInteger(seq) || !Number.isInteger(ts)) {
        throw new Error("Command needs an integer seq and ts");
    }

    let events;

    if (type === "NEW_ORDER") {
        if (payload.orderType === "LIMIT") {
            events = submitLimit(book, payload, seq, ts);
        } else if (payload.orderType === "MARKET") {
            events = submitMarket(book, payload, seq, ts);
        } else {
            events = [make(EVENTS.ORDER_REJECTED, { seq, ts, symbol: book.symbol }, {
                orderId: payload.id,
                userId: payload.userId,
                reason: REASONS.INVALID_ORDER
            })];
        }
    } else if (type === "CANCEL") {
        events = cancel(book, payload.orderId, seq, ts);
    } else if (type === "REPLACE") {
        events = replace(book, payload.orderId, payload.quantity, payload.price, seq, ts);
    } else if (type === "EXPIRE") {
        events = expireAll(book, seq, ts);
    } else {
        throw new Error(`Unknown command type: ${type}`);
    }

    book.lastSeq = seq;

    return events;
};

// Hash of the full book state, queue order included
const bookHash = (book) =>
    crypto.createHash("sha256").update(JSON.stringify(snapshot(book))).digest("hex");

module.exports = {
    applyCommand,
    bookHash
};
