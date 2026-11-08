const express = require("express");
const router = express.Router();

const { deposit, balance } = require("../controller/accountController.js");
const authMiddleware = require("../middleware/authMiddleware.js");

router.post("/deposit", authMiddleware, deposit);
router.get("/balance", authMiddleware, balance);

module.exports = router;
