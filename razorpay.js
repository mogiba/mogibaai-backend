// razorpay.js (backend)
const express = require("express");
const Razorpay = require("razorpay");
require("dotenv").config();

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

router.post("/create-order", async (req, res) => {
  try {
    const { amount, currency } = req.body;
    const options = {
      amount: amount,
      currency: currency,
      receipt: `receipt_order_${Math.floor(Math.random() * 10000)}`
    };
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (error) {
    res.status(500).send(error.toString());
  }
});

module.exports = router;
