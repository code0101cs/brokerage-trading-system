const express = require("express");
const router = express.Router();

const { placeOrder } = require("../controller/orderController.js");
const authMiddleware = require("../middleware/authMiddleware.js");

router.post("/orders", authMiddleware, placeOrder);

module.exports = router;
