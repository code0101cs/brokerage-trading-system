const { isMarketOpen } = require("./market.js");
const { buyHold, availableCash, availableShares } = require("./holds.js");

// The largest value one order may have
const MAX_ORDER_VALUE = "10000000.00";

// Pre-trade checks, in the order the plan lists them. The answer is { reason } for the first
// check that fails, or { cashHold, shareHold } with what the order must reserve.
const vet = async (client, { userId, instrument, side, quantity, price }) => {
    if (!isMarketOpen()) {
        return { reason: "Market closed" };
    }

    if (instrument.halted) {
        return { reason: "Instrument halted" };
    }

    // Lot, tick, size, value and band are all numeric comparisons, so they stay in SQL
    const found = await client.query(
        `SELECT $1::bigint % i.lot_size <> 0 AS bad_lot,
                $2::numeric % i.tick_size <> 0 AS bad_tick,
                $1::bigint > i.max_quantity AS too_many,
                $1::bigint * $2::numeric > $3::numeric AS too_big,
                ABS($2::numeric - i.reference_price) * 100 > i.reference_price * i.band_pct AS off_band
         FROM instruments i
         WHERE i.symbol = $4`,
        [quantity, price, MAX_ORDER_VALUE, instrument.symbol]
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
        const cashHold = await buyHold(client, quantity, price);
        const available = await availableCash(client, userId);

        const enough = await client.query("SELECT $1::numeric >= $2::numeric AS ok", [available, cashHold]);

        if (!enough.rows[0].ok) {
            return { reason: "Insufficient balance" };
        }

        return { cashHold, shareHold: 0 };
    }

    const available = await availableShares(client, userId, instrument.symbol);

    if (available < quantity) {
        return { reason: "Insufficient shares" };
    }

    return { cashHold: "0.00", shareHold: quantity };
};

module.exports = { vet, MAX_ORDER_VALUE };
