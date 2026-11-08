// A buy fill: more shares, and a new average cost worked out in SQL
const buyFill = async (client, userId, symbol, qty, price) => {
    await client.query(
        `INSERT INTO positions
         (user_id, symbol, quantity, avg_cost)
         VALUES ($1, $2, $3::bigint, $4::numeric)
         ON CONFLICT (user_id, symbol) DO UPDATE
         SET avg_cost = (positions.quantity * positions.avg_cost + $3::bigint * $4::numeric)
                        / (positions.quantity + $3::bigint),
             quantity = positions.quantity + $3::bigint`,
        [userId, symbol, qty, price]
    );
};

// A sell fill: fewer shares, realised profit added, average cost left alone.
// Returns false and changes nothing when the user holds less than qty (no short selling).
const sellFill = async (client, userId, symbol, qty, price) => {
    const sold = await client.query(
        `UPDATE positions
         SET realized_pnl = realized_pnl + ROUND(($4::numeric - avg_cost) * $3::bigint, 2),
             quantity = quantity - $3::bigint
         WHERE user_id = $1
         AND symbol = $2
         AND quantity >= $3::bigint
         RETURNING quantity`,
        [userId, symbol, qty, price]
    );

    return sold.rows.length === 1;
};

module.exports = {
    buyFill,
    sellFill
};
