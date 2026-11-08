const { transition } = require("./orderStates.js");

// One step through the state machine. Returns the new status, or null when another
// request moved the order first (the caller answers 409).
const moveOrder = async (client, orderId, from, event, detail) => {
    const to = transition(from, event);

    const moved = await client.query(
        `UPDATE orders
         SET status = $1
         WHERE id = $2
         AND status = $3
         RETURNING id`,
        [to, orderId, from]
    );

    if (moved.rows.length === 0) {
        return null;
    }

    await client.query(
        `INSERT INTO order_events
         (order_id, event, from_status, to_status, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, event, from, to, detail ? JSON.stringify(detail) : null]
    );

    return to;
};

module.exports = { moveOrder };
