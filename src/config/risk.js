const { isMarketOpen } = require("./market.js");
const { buyHold, availableCash, availableShares } = require("./holds.js");

// The largest value one order may have
const MAX_ORDER_VALUE = "10000000.00";

// Pre-trade checks, in the order the plan lists them. The answer is { reason } for the first
// check that fails, or { cashHold, shareHold } with what the order must reserve.
// A replace passes open (the unfilled part, what has to be funded) and own (the cash and shares
// the order already holds, which are free to be reused).
const vet = async (client, { userId, instrument, side, orderType, quantity, price, open = quantity, own = {} }) => {
    if (!isMarketOpen()) {
        return { reason: "Market closed" };
    }

    if (instrument.halted) {
        return { reason: "Instrument halted" };
    }

    // A market order has no price. A buy reserves up to the last price plus 5%, the collar, and
    // the engine stops there. The last price is the latest trade, else the reference price.
    let collar = null;

    if (orderType === "MARKET") {
        const last = await client.query(
            `SELECT ROUND(COALESCE(
                 (SELECT t.price FROM trades t WHERE t.symbol = i.symbol ORDER BY t.id DESC LIMIT 1),
                 i.reference_price
             ) * 1.05, 2) AS collar
             FROM instruments i
             WHERE i.symbol = $1`,
            [instrument.symbol]
        );

        collar = last.rows[0].collar;
    }

    // Lot, tick, size, value and band are all numeric comparisons, so they stay in SQL
    const found = await client.query(
        `SELECT $1::bigint % i.lot_size <> 0 AS bad_lot,
                $2::numeric % i.tick_size <> 0 AS bad_tick,
                $1::bigint > i.max_quantity AS too_many,
                $1::bigint * $5::numeric > $3::numeric AS too_big,
                ABS($2::numeric - i.reference_price) * 100 > i.reference_price * i.band_pct AS off_band
         FROM instruments i
         WHERE i.symbol = $4`,
        [quantity, price, MAX_ORDER_VALUE, instrument.symbol, price || collar]
    );

    const check = found.rows[0];

    if (check.bad_lot) {
        return { reason: "Invalid lot size" };
    }

    if (check.bad_tick) {
        return { reason: "Invalid tick size" };
    }

    if (check.too_many) {
        return { reason: "Quantity too large" };
    }

    if (check.too_big) {
        return { reason: "Order value too large" };
    }

    if (check.off_band) {
        return { reason: "Price outside allowed band" };
    }

    if (side === "BUY") {
        const cashHold = await buyHold(client, open, price || collar);
        const available = await availableCash(client, userId);

        const enough = await client.query("SELECT $1::numeric + $3::numeric >= $2::numeric AS ok", [available, cashHold, own.cash || "0.00"]);

        if (!enough.rows[0].ok) {
            return { reason: "Insufficient balance" };
        }

        return { cashHold, shareHold: 0, protection: orderType === "MARKET" ? collar : null };
    }

    const available = await availableShares(client, userId, instrument.symbol);

    if (available + (own.shares || 0) < open) {
        return { reason: "Insufficient shares" };
    }

    return { cashHold: "0.00", shareHold: open, protection: null };
};

module.exports = { vet, MAX_ORDER_VALUE };
