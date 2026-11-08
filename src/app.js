const express = require("express");
const app = express();

const healthRoutes = require("./routes/health.js");
const authRoutes = require("./routes/auth.js");
const accountRoutes = require("./routes/account.js");
const orderRoutes = require("./routes/orders.js");

app.use(express.json());

app.use("/", healthRoutes);
app.use("/", orderRoutes);
app.use("/auth", authRoutes);
app.use("/account", accountRoutes);

module.exports = app;
