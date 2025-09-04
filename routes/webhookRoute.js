// routes/webhookRoute.js
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { db, admin } = require("../utils/firebaseUtils");
const { addCredits } = require("../services/creditsService");

// Razorpay Webhook Handler
router.post("/razorpay/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.body; // Buffer (raw)

    // 🔐 Signature verify
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      console.error("❌ Invalid webhook signature");
      return res.status(400).send("Invalid signature");
    }

    // JSON parse
    const event = JSON.parse(rawBody.toString());
    console.log("📩 Webhook Event:", event.event);

    // We care about payment.captured
    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;

      // Firestoreలో order doc update
      const orderRef = db.collection("razorpayOrders").doc(orderId);

      await db.runTransaction(async (t) => {
        const snap = await t.get(orderRef);
        if (!snap.exists) return;
        const data = snap.data();
        if (data.status === "paid") return; // already processed

        t.update(orderRef, {
          status: "paid",
          razorpay_payment_id: paymentId,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          via: "webhook",
        });

        // ✅ Credits add చేయండి
        await addCredits(data.uid, data.category, data.credits, {
          source: "webhook",
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
        });
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("🚨 Webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

module.exports = router;
