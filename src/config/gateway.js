// The line to the exchange. Phase 5 puts the matching engine behind it. Until then no order is
// on a book, so an order that is still open is always found: both calls answer true. An answer
// of false means the order was no longer resting, because a fill got there first.
const gateway = {
    cancel: async (order) => true,
    replace: async (order, quantity, price) => true
};

module.exports = gateway;
