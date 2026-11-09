const express = require("express");
const router = express.Router();

const { placeOrder, getOrder } = require("../controller/orderController.js");
const authMiddleware = require("../middleware/authMiddleware.js");

router.post("/orders", authMiddleware, placeOrder);
router.get("/orders/:id", authMiddleware, getOrder);

module.exports = router;
