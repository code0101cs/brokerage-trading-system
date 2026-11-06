const { EVENTS, REASONS } = require("../config/events.js");
const { addOrder, takeFromNode, bestNode, remaining } = require("./orderBook.js");

const SIDES = ["BUY", "SELL"];
const TIFS = ["DAY", "IOC", "FOK"];

const isInt = (n) => Number.isInteger(n);

const make = (type, ctx, fields) => ({
    type,
    seq: ctx.seq,
    ts: ctx.ts,
    symbol: ctx.symbol,
    ...fields
});

// Copy the incoming order so the caller's object is never changed
const build = (input, orderType) => ({
    id: input.id,
    userId: input.userId,
    side: input.side,
    orderType,
    timeInForce: input.timeInForce || "DAY",
    price: orderType === "LIMIT" ? input.price : null,
    protectionPrice: input.protectionPrice === undefined ? null : input.protectionPrice,
    quantity: input.quantity,
    filled: input.filled || 0,
    value: input.value || 0
});

const valid = (o) => {
    if (!isInt(o.id) || !isInt(o.userId) || !SIDES.includes(o.side) || !TIFS.includes(o.timeInForce)) {
        return false;
    }

    if (!isInt(o.quantity) || o.quantity <= 0 || !isInt(o.filled) || o.filled < 0 || o.filled >= o.quantity) {
        return false;
    }

    if (o.orderType === "LIMIT") {
        return isInt(o.price) && o.price > 0;
    }

    return o.protectionPrice === null || (isInt(o.protectionPrice) && o.protectionPrice > 0);
};

// Progress of one order after a fill, partly or fully filled
const fillEvent = (order, price, qty, tradeId, ctx) =>
    make(remaining(order) === 0 ? EVENTS.ORDER_FILLED : EVENTS.ORDER_PARTIALLY_FILLED, ctx, {
        orderId: order.id,
        userId: order.userId,
        tradeId,
        fillPrice: price,
        fillQuantity: qty,
        filledQuantity: order.filled,
        remainingQuantity: remaining(order),
        filledValue: order.value
    });

// One match: the trade, then the book and the incoming order move
const fill = (book, node, order, qty, tradeId, ctx, events) => {
    const resting = node.order;
    const price = resting.price;
    const buy = order.side === "BUY" ? order : resting;
    const sell = order.side === "BUY" ? resting : order;

    events.push(make(EVENTS.TRADE_EXECUTED, ctx, {
        tradeId,
        price,
        quantity: qty,
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        buyUserId: buy.userId,
        sellUserId: sell.userId,
        aggressor: order.side
    }));

    resting.value += price * qty;
    takeFromNode(book, node, qty);

    order.filled += qty;
    order.value += price * qty;

    // Resting side first, then the incoming side
    events.push(fillEvent(resting, price, qty, tradeId, ctx));
    events.push(fillEvent(order, price, qty, tradeId, ctx));
};

// Match while the best opposite order is at a price the incoming order accepts
const run = (book, order, ctx, events) => {
    const opposite = order.side === "BUY" ? "SELL" : "BUY";

    // A limit order stops at its limit, a market order at its protection price if it has one
    const bound = order.orderType === "LIMIT" ? order.price : order.protectionPrice;
    let n = 0;

    while (remaining(order) > 0) {
        const node = bestNode(book, opposite);

        if (!node) {
            return "EXHAUSTED";
        }

        const best = node.order.price;

        if (bound !== null && (order.side === "BUY" ? best > bound : best < bound)) {
            return "BOUND";
        }

        n++;

        fill(book, node, order, Math.min(remaining(order), remaining(node.order)), `${ctx.symbol}-${ctx.seq}-${n}`, ctx, events);
    }

    return "DONE";
};

const cancelEvent = (order, ctx, reason) =>
    make(EVENTS.ORDER_CANCELLED, ctx, {
        orderId: order.id,
        userId: order.userId,
        cancelledQuantity: remaining(order),
        filledQuantity: order.filled,
        reason
    });

// Match, then rest whatever is left
const enter = (book, order, ctx, events) => {
    const stop = run(book, order, ctx, events);

    if (remaining(order) === 0) {
        return;
    }

    // A market order never rests
    if (order.orderType === "MARKET") {
        events.push(cancelEvent(order, ctx, stop === "BOUND" ? REASONS.PROTECTION_PRICE : REASONS.NO_LIQUIDITY));
        return;
    }

    addOrder(book, order);
};

const submit = (book, input, orderType, seq, ts) => {
    const order = build(input, orderType);
    const ctx = { seq, ts, symbol: book.symbol };
    const events = [];

    // Refuse bad input and ids that are already resting
    if (!valid(order)) {
        events.push(make(EVENTS.ORDER_REJECTED, ctx, { orderId: input.id, userId: input.userId, reason: "INVALID_ORDER" }));
        return events;
    }

    if (book.orders.has(order.id)) {
        events.push(make(EVENTS.ORDER_REJECTED, ctx, { orderId: order.id, userId: order.userId, reason: "DUPLICATE_ORDER_ID" }));
        return events;
    }

    events.push(make(EVENTS.ORDER_ACCEPTED, ctx, {
        orderId: order.id,
        userId: order.userId,
        side: order.side,
        orderType: order.orderType,
        timeInForce: order.timeInForce,
        price: order.price,
        quantity: order.quantity
    }));

    enter(book, order, ctx, events);

    return events;
};

const submitLimit = (book, order, seq, ts) => submit(book, order, "LIMIT", seq, ts);

const submitMarket = (book, order, seq, ts) => submit(book, order, "MARKET", seq, ts);

module.exports = {
    submitLimit,
    submitMarket,
    make,
    enter,
    cancelEvent
};
