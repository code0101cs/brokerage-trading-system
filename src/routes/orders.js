const express = require("express");
const router = express.Router();

const { placeOrder, getOrder, cancelOrder, replaceOrder } = require("../controller/orderController.js");
const authMiddleware = require("../middleware/authMiddleware.js");

router.post("/orders", authMiddleware, placeOrder);
router.get("/orders/:id", authMiddleware, getOrder);
router.delete("/orders/:id", authMiddleware, cancelOrder);
router.patch("/orders/:id", authMiddleware, replaceOrder);

module.exports = router;
