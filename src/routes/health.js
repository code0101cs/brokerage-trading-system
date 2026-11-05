const express = require("express");
const router = express.Router();

const { health } = require("../controller/healthController.js");

router.get("/health", health);

module.exports = router;
