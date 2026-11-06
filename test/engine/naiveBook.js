// A deliberately naive reference book: one array of resting orders, linear scans, no cleverness.
// It is written separately from src/engine so the two can be compared event by event.
const { EVENTS, REASONS } = require("../../src/config/events.js");

const isInt = Number.isInteger;

const createNaive = (symbol) => ({ symbol, resting: [], arrival: 0 });

const left = (o) => o.quantity - o.filled;

const ev = (type, c, fields) => ({ type, seq: c.seq, ts: c.ts, symbol: c.symbol, ...fields });

const okOrder = (o) => {
    if (!isInt(o.id) || !isInt(o.userId)) {
        return false;
    }

    if (o.side !== "BUY" && o.side !== "SELL") {
        return false;
    }

    if (!["DAY", "IOC", "FOK"].includes(o.tif)) {
        return false;
    }

    if (!isInt(o.quantity) || o.quantity <= 0 || !isInt(o.filled) || o.filled < 0 || o.filled >= o.quantity) {
        return false;
    }

    if (o.orderType === "LIMIT") {
        return isInt(o.price) && o.price > 0;
    }

    return o.protection === null || (isInt(o.protection) && o.protection > 0);
};

// Resting orders an incoming order of this side could trade with, best first, oldest first
const candidates = (naive, side) => {
    const list = naive.resting.filter((o) => o.side !== side);

    list.sort((a, b) => {
        if (a.price !== b.price) {
            return side === "BUY" ? a.price - b.price : b.price - a.price;
        }

        return a.arrival - b.arrival;
    });

    return list;
};

const tooFar = (o, price, bound) => bound !== null && (o.side === "BUY" ? price > bound : price < bound);

const boundOf = (o) => (o.orderType === "LIMIT" ? o.price : o.protection);

const cancelled = (o, c, reason) =>
    ev(EVENTS.ORDER_CANCELLED, c, {
        orderId: o.id,
        userId: o.userId,
        cancelledQuantity: left(o),
        filledQuantity: o.filled,
        reason
    });

const fillEvent = (o, price, qty, tradeId, c) =>
    ev(left(o) === 0 ? EVENTS.ORDER_FILLED : EVENTS.ORDER_PARTIALLY_FILLED, c, {
        orderId: o.id,
        userId: o.userId,
        tradeId,
        fillPrice: price,
        fillQuantity: qty,
        filledQuantity: o.filled,
        remainingQuantity: left(o),
        filledValue: o.value
    });

// Fill or kill, looked at before anything trades
const fokProblem = (naive, o) => {
    const bound = boundOf(o);
    let need = left(o);

    for (const r of candidates(naive, o.side)) {
        if (tooFar(o, r.price, bound)) {
            break;
        }

        if (r.userId === o.userId) {
            return REASONS.SELF_TRADE_PREVENTED;
        }

        need -= left(r);

        if (need <= 0) {
            return null;
        }
    }

    return REASONS.FOK_NOT_FILLABLE;
};

const matchLoop = (naive, o, c, events) => {
    const bound = boundOf(o);
    let n = 0;

    while (left(o) > 0) {
        const r = candidates(naive, o.side)[0];

        if (!r) {
            return "EXHAUSTED";
        }

        if (tooFar(o, r.price, bound)) {
            return "BOUND";
        }

        if (r.userId === o.userId) {
            return "SELF_TRADE";
        }

        n++;

        const qty = Math.min(left(o), left(r));
        const tradeId = `${c.symbol}-${c.seq}-${n}`;
        const buy = o.side === "BUY" ? o : r;
        const sell = o.side === "BUY" ? r : o;

        events.push(ev(EVENTS.TRADE_EXECUTED, c, {
            tradeId,
            price: r.price,
            quantity: qty,
            buyOrderId: buy.id,
            sellOrderId: sell.id,
            buyUserId: buy.userId,
            sellUserId: sell.userId,
            aggressor: o.side
        }));

        r.filled += qty;
        r.value += r.price * qty;
        o.filled += qty;
        o.value += r.price * qty;

        if (left(r) === 0) {
            naive.resting.splice(naive.resting.indexOf(r), 1);
        }

        events.push(fillEvent(r, r.price, qty, tradeId, c));
        events.push(fillEvent(o, r.price, qty, tradeId, c));
    }

    return "DONE";
};

const enter = (naive, o, c, events) => {
    if (o.tif === "FOK") {
        const why = fokProblem(naive, o);

        if (why) {
            events.push(cancelled(o, c, why));
            return;
        }
    }

    const stop = matchLoop(naive, o, c, events);

    if (left(o) === 0) {
        return;
    }

    if (stop === "SELF_TRADE") {
        events.push(cancelled(o, c, REASONS.SELF_TRADE_PREVENTED));
    } else if (o.orderType === "MARKET") {
        events.push(cancelled(o, c, stop === "BOUND" ? REASONS.PROTECTION_PRICE : REASONS.NO_LIQUIDITY));
    } else if (o.tif === "IOC") {
        events.push(cancelled(o, c, REASONS.IOC_REMAINDER));
    } else {
        o.arrival = ++naive.arrival;
        naive.resting.push(o);
    }
};

const newOrder = (naive, p, c) => {
    if (p.orderType !== "LIMIT" && p.orderType !== "MARKET") {
        return [ev(EVENTS.ORDER_REJECTED, c, { orderId: p.id, userId: p.userId, reason: REASONS.INVALID_ORDER })];
    }

    const o = {
        id: p.id,
        userId: p.userId,
        side: p.side,
        orderType: p.orderType,
        tif: p.timeInForce || "DAY",
        price: p.orderType === "LIMIT" ? p.price : null,
        protection: p.protectionPrice === undefined ? null : p.protectionPrice,
        quantity: p.quantity,
        filled: p.filled || 0,
        value: p.value || 0,
        arrival: 0
    };

    if (!okOrder(o)) {
        return [ev(EVENTS.ORDER_REJECTED, c, { orderId: p.id, userId: p.userId, reason: REASONS.INVALID_ORDER })];
    }

    if (naive.resting.some((r) => r.id === o.id)) {
        return [ev(EVENTS.ORDER_REJECTED, c, { orderId: o.id, userId: o.userId, reason: REASONS.DUPLICATE_ORDER_ID })];
    }

    const events = [ev(EVENTS.ORDER_ACCEPTED, c, {
        orderId: o.id,
        userId: o.userId,
        side: o.side,
        orderType: o.orderType,
        timeInForce: o.tif,
        price: o.price,
        quantity: o.quantity
    })];

    enter(naive, o, c, events);

    return events;
};

const cancelOrder = (naive, id, c) => {
    const o = naive.resting.find((r) => r.id === id);

    if (!o) {
        return [ev(EVENTS.CANCEL_REJECTED, c, { orderId: id, reason: REASONS.ORDER_NOT_FOUND })];
    }

    naive.resting.splice(naive.resting.indexOf(o), 1);

    return [cancelled(o, c, REASONS.USER_REQUEST)];
};

const replaceOrder = (naive, p, c) => {
    const o = naive.resting.find((r) => r.id === p.orderId);

    if (!o) {
        return [ev(EVENTS.CANCEL_REJECTED, c, { orderId: p.orderId, reason: REASONS.ORDER_NOT_FOUND })];
    }

    if (!isInt(p.quantity) || !isInt(p.price) || p.price <= 0 || p.quantity <= o.filled) {
        return [ev(EVENTS.CANCEL_REJECTED, c, { orderId: p.orderId, reason: REASONS.INVALID_ORDER })];
    }

    if (p.price === o.price && p.quantity <= o.quantity) {
        const old = o.quantity;

        o.quantity = p.quantity;

        return [ev(EVENTS.ORDER_REPLACED, c, { orderId: o.id, userId: o.userId, oldQuantity: old, newQuantity: p.quantity, price: o.price })];
    }

    const events = [cancelled(o, c, REASONS.REPLACED)];

    naive.resting.splice(naive.resting.indexOf(o), 1);

    o.price = p.price;
    o.quantity = p.quantity;

    events.push(ev(EVENTS.ORDER_ACCEPTED, c, {
        orderId: o.id,
        userId: o.userId,
        side: o.side,
        orderType: o.orderType,
        timeInForce: o.tif,
        price: o.price,
        quantity: o.quantity
    }));

    enter(naive, o, c, events);

    return events;
};

const expireOrders = (naive, c) => {
    const events = naive.resting.map((o) =>
        ev(EVENTS.ORDER_EXPIRED, c, { orderId: o.id, userId: o.userId, expiredQuantity: left(o), filledQuantity: o.filled })
    );

    naive.resting = [];

    return events;
};

const apply = (naive, command) => {
    const c = { seq: command.seq, ts: command.ts, symbol: naive.symbol };

    if (command.type === "NEW_ORDER") {
        return newOrder(naive, command.payload, c);
    }

    if (command.type === "CANCEL") {
        return cancelOrder(naive, command.payload.orderId, c);
    }

    if (command.type === "REPLACE") {
        return replaceOrder(naive, command.payload, c);
    }

    if (command.type === "EXPIRE") {
        return expireOrders(naive, c);
    }

    throw new Error(`Unknown command type: ${command.type}`);
};

// Resting orders per side in priority order, as [id, price, quantity, filled]
const view = (naive) => {
    const pick = (side) =>
        candidates(naive, side === "BUY" ? "SELL" : "BUY").map((o) => [o.id, o.price, o.quantity, o.filled]);

    return { bids: pick("BUY"), asks: pick("SELL") };
};

module.exports = { createNaive, apply, view };
