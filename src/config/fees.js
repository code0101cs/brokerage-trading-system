// Brokerage fee as a SQL expression: 0.03% of the value, rounded up to the next paisa, capped at 20.00.
// ROUND(..., 2) changes no value, it only stops numeric division adding a long tail of zeros.
// The value is a SQL expression written by us, never user input.
const feeSql = (value) => `ROUND(LEAST(CEIL((${value}) * 0.0003 * 100) / 100, 20.00), 2)`;

module.exports = { feeSql };
