const { EVENTS, REASONS } = require("../config/events.js");
const { removeOrder, shrinkNode } = require("./orderBook.js");
const { make, enter, cancelEvent } = require("./matching.js");

const isInt = (n) => Number.isInteger(n);

const rejected = (book, orderId, reason, seq, ts) =>
    make(EVENTS.CANCEL_REJECTED, { seq, ts, symbol: book.symbol }, { orderId, reason });

// Remove a resting order, it keeps the fills it already had
const cancel = (book, orderId, seq, ts) => {
    const node = book.orders.get(orderId);

    if (!node) {
        return [rejected(book, orderId, REASONS.ORDER_NOT_FOUND, seq, ts)];
    }

    const ctx = { seq, ts, symbol: book.symbol };
    const order = removeOrder(book, orderId);

    return [cancelEvent(order, ctx, REASONS.USER_REQUEST)];
};

// newQuantity is the new total quantity of the order, fills included
const replace = (book, orderId, newQuantity, newPrice, seq, ts) => {
    const node = book.orders.get(orderId);

    if (!node) {
        return [rejected(book, orderId, REASONS.ORDER_NOT_FOUND, seq, ts)];
    }

    const order = node.order;

    if (!isInt(newQuantity) || !isInt(newPrice) || newPrice <= 0 || newQuantity <= order.filled) {
        return [rejected(book, orderId, REASONS.INVALID_ORDER, seq, ts)];
    }

    const ctx = { seq, ts, symbol: book.symbol };

    // A smaller size at the same price keeps its place in the queue
    if (newPrice === order.price && newQuantity <= order.quantity) {
        const old = order.quantity;

        shrinkNode(node, newQuantity);

        return [make(EVENTS.ORDER_REPLACED, ctx, {
            orderId,
            userId: order.userId,
            oldQuantity: old,
            newQuantity,
            price: order.price
        })];
    }

    // Any other change loses priority: cancel, then enter again at the back
    const events = [cancelEvent(order, ctx, REASONS.REPLACED)];

    removeOrder(book, orderId);

    order.price = newPrice;
    order.quantity = newQuantity;

    events.push(make(EVENTS.ORDER_ACCEPTED, ctx, {
        orderId,
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

// End of session: every resting DAY order is removed
const expireAll = (book, seq, ts) => {
    const ctx = { seq, ts, symbol: book.symbol };
    const events = [];

    for (const id of [...book.orders.keys()]) {
        const order = removeOrder(book, id);

        events.push(make(EVENTS.ORDER_EXPIRED, ctx, {
            orderId: order.id,
            userId: order.userId,
            expiredQuantity: order.quantity - order.filled,
            filledQuantity: order.filled
        }));
    }

    return events;
};

module.exports = {
    cancel,
    replace,
    expireAll
};
