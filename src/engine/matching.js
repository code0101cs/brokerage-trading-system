const { EVENTS, REASONS } = require("../config/events.js");
const { addOrder, takeFromNode, bestNode, remaining, sideOf } = require("./orderBook.js");

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

// A limit order stops at its limit, a market order at its protection price if it has one
const boundOf = (order) => (order.orderType === "LIMIT" ? order.price : order.protectionPrice);

// True when a price is worse than the order accepts
const beyond = (order, price, bound) => bound !== null && (order.side === "BUY" ? price > bound : price < bound);

// Fill or kill is decided up front: null when the book can fill it all, else why not
const shortfall = (book, order) => {
    const opposite = order.side === "BUY" ? "SELL" : "BUY";
    const side = sideOf(book, opposite);
    const bound = boundOf(order);
    const count = side.prices.length;
    let need = remaining(order);

    for (let i = 0; i < count; i++) {
        const price = opposite === "SELL" ? side.prices[i] : side.prices[count - 1 - i];

        if (beyond(order, price, bound)) {
            break;
        }

        for (let node = side.levels.get(price).head; node; node = node.next) {
            if (node.order.userId === order.userId) {
                return REASONS.SELF_TRADE_PREVENTED;
            }

            need -= remaining(node.order);

            if (need <= 0) {
                return null;
            }
        }
    }

    return REASONS.FOK_NOT_FILLABLE;
};

// Match while the best opposite order is at a price the incoming order accepts
const run = (book, order, ctx, events) => {
    const opposite = order.side === "BUY" ? "SELL" : "BUY";
    const bound = boundOf(order);
    let n = 0;

    while (remaining(order) > 0) {
        const node = bestNode(book, opposite);

        if (!node) {
            return "EXHAUSTED";
        }

        if (beyond(order, node.order.price, bound)) {
            return "BOUND";
        }

        // Never trade with yourself
        if (node.order.userId === order.userId) {
            return "SELF_TRADE";
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
    // Fill or kill: all or nothing, before any trade is emitted
    if (order.timeInForce === "FOK") {
        const why = shortfall(book, order);

        if (why) {
            events.push(cancelEvent(order, ctx, why));
            return;
        }
    }

    const stop = run(book, order, ctx, events);

    if (remaining(order) === 0) {
        return;
    }

    // The incoming remainder is cancelled, the resting order is left alone
    if (stop === "SELF_TRADE") {
        events.push(cancelEvent(order, ctx, REASONS.SELF_TRADE_PREVENTED));
        return;
    }

    // A market order never rests
    if (order.orderType === "MARKET") {
        events.push(cancelEvent(order, ctx, stop === "BOUND" ? REASONS.PROTECTION_PRICE : REASONS.NO_LIQUIDITY));
        return;
    }

    // Immediate or cancel: whatever did not trade is cancelled
    if (order.timeInForce === "IOC") {
        events.push(cancelEvent(order, ctx, REASONS.IOC_REMAINDER));
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
