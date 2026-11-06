const createSide = () => ({
    levels: new Map(),
    prices: []
});

const createBook = (symbol) => ({
    symbol,
    lastSeq: 0,
    bids: createSide(),
    asks: createSide(),
    orders: new Map()
});

const remaining = (order) => order.quantity - order.filled;

// Average fill price in paise, derived from the filled value
const avgPrice = (order) => (order.filled === 0 ? null : order.value / order.filled);

const sideOf = (book, side) => (side === "BUY" ? book.bids : book.asks);

// First index whose price is at or above the one asked for
const lowerBound = (prices, price) => {
    let lo = 0;
    let hi = prices.length;

    while (lo < hi) {
        const mid = (lo + hi) >>> 1;

        if (prices[mid] < price) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }

    return lo;
};

// Rest an order at the back of its price level
const addOrder = (book, order) => {
    const side = sideOf(book, order.side);
    let level = side.levels.get(order.price);

    if (!level) {
        level = { price: order.price, total: 0, count: 0, head: null, tail: null };
        side.levels.set(order.price, level);
        side.prices.splice(lowerBound(side.prices, order.price), 0, order.price);
    }

    const node = { order, prev: level.tail, next: null, level };

    if (level.tail) {
        level.tail.next = node;
    } else {
        level.head = node;
    }

    level.tail = node;
    level.total += remaining(order);
    level.count++;
    book.orders.set(order.id, node);

    return node;
};

// Unlink a node, drop its level when it was the last order there
const removeNode = (book, node) => {
    const level = node.level;
    const side = sideOf(book, node.order.side);

    if (node.prev) {
        node.prev.next = node.next;
    } else {
        level.head = node.next;
    }

    if (node.next) {
        node.next.prev = node.prev;
    } else {
        level.tail = node.prev;
    }

    level.total -= remaining(node.order);
    level.count--;
    book.orders.delete(node.order.id);

    if (level.count === 0) {
        side.levels.delete(level.price);
        side.prices.splice(lowerBound(side.prices, level.price), 1);
    }

    return node.order;
};

// Cancel by id, O(1) apart from dropping an emptied level
const removeOrder = (book, id) => {
    const node = book.orders.get(id);

    if (!node) {
        return null;
    }

    return removeNode(book, node);
};

// Take shares from a resting order, remove it when it is used up
const takeFromNode = (book, node, qty) => {
    node.order.filled += qty;
    node.level.total -= qty;

    if (remaining(node.order) === 0) {
        removeNode(book, node);
    }
};

// Shrink a resting order in place, it keeps its queue position
const shrinkNode = (node, newQuantity) => {
    node.level.total -= node.order.quantity - newQuantity;
    node.order.quantity = newQuantity;
};

// First order in line at the best price of one side
const bestNode = (book, side) => {
    const s = sideOf(book, side);

    if (s.prices.length === 0) {
        return null;
    }

    const price = side === "BUY" ? s.prices[s.prices.length - 1] : s.prices[0];

    return s.levels.get(price).head;
};

const bestOf = (book, side) => {
    const node = bestNode(book, side);

    if (!node) {
        return null;
    }

    return {
        price: node.level.price,
        quantity: node.level.total
    };
};

const bestBid = (book) => bestOf(book, "BUY");

const bestAsk = (book) => bestOf(book, "SELL");

// Top n levels of each side, best first
const depth = (book, n) => {
    const bids = [];
    const asks = [];

    for (let i = book.bids.prices.length - 1; i >= 0 && bids.length < n; i--) {
        const level = book.bids.levels.get(book.bids.prices[i]);

        bids.push({ price: level.price, quantity: level.total, orders: level.count });
    }

    for (let i = 0; i < book.asks.prices.length && asks.length < n; i++) {
        const level = book.asks.levels.get(book.asks.prices[i]);

        asks.push({ price: level.price, quantity: level.total, orders: level.count });
    }

    return { bids, asks };
};

const sideSnapshot = (side, best) => {
    const out = [];

    for (const price of side.prices) {
        const level = side.levels.get(price);
        const orders = [];

        for (let node = level.head; node; node = node.next) {
            const o = node.order;

            orders.push({
                id: o.id,
                userId: o.userId,
                side: o.side,
                timeInForce: o.timeInForce,
                price: o.price,
                quantity: o.quantity,
                filled: o.filled,
                value: o.value
            });
        }

        out.push({ price, total: level.total, orders });
    }

    // Best price first
    return best === "high" ? out.reverse() : out;
};

// Full state as plain data, orders in queue order
const snapshot = (book) => ({
    symbol: book.symbol,
    lastSeq: book.lastSeq,
    bids: sideSnapshot(book.bids, "high"),
    asks: sideSnapshot(book.asks, "low")
});

module.exports = {
    createBook,
    addOrder,
    removeNode,
    removeOrder,
    takeFromNode,
    shrinkNode,
    bestNode,
    bestBid,
    bestAsk,
    depth,
    snapshot,
    remaining,
    avgPrice,
    sideOf
};
