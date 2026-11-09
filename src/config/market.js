// Trading hours: Monday to Friday, 09:15 to 15:30 India time (UTC+5:30, no holidays).
// MARKET_HOURS=always or never overrides the clock, for development and tests.
const OPEN = 9 * 60 + 15;
const CLOSE = 15 * 60 + 30;

const isMarketOpen = (now = new Date()) => {
    if (process.env.MARKET_HOURS === "always") {
        return true;
    }

    if (process.env.MARKET_HOURS === "never") {
        return false;
    }

    const ist = new Date(now.getTime() + 330 * 60 * 1000);
    const day = ist.getUTCDay();
    const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();

    return day >= 1 && day <= 5 && minutes >= OPEN && minutes < CLOSE;
};

module.exports = { isMarketOpen };
