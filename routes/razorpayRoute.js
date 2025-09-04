const express = require("express");
const router = express.Router();
const { createOrder, verifySignature } = require("../services/razorpayService");
const { addCredits } = require("../services/creditsService");
const { db } = require("../utils/firebaseUtils");

// 🔐 Simple auth via X-UID header (replace with your real auth later)
function requireAuth(req, res, next) {
  const uid = req.headers["x-uid"]; // e.g., Firebase UID
  if (!uid) return res.status(401).json({ error: "UNAUTH" });
  req.uid = uid;
  next();
}

// 🧾 Create Razorpay order for a plan
// POST /api/payments/razorpay/create-order
// body: { credits: number, category: 'image'|'video', amountINR: number }
router.post("/razorpay/create-order", requireAuth, async (req, res) => {
  try {
    const { credits, category, amountINR } = req.body || {};
    if (!credits || !category || !amountINR) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }
    const order = await createOrder(req.uid, credits, category, amountINR);
    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ✅ Verify payment signature and credit the user (idempotent)
// POST /api/payments/razorpay/verify
// body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post("/razorpay/verify", requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const ok = verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!ok) return res.status(400).json({ error: "BAD_SIGNATURE" });

    // Idempotent order status update, then add credits
    const orderRef = db.collection("razorpayOrders").doc(razorpay_order_id);
    await db.runTransaction(async (t) => {
      const snap = await t.get(orderRef);
      if (!snap.exists) throw new Error("ORDER_NOT_FOUND");
      const d = snap.data();
      if (d.status === "paid") return; // already processed
      t.update(orderRef, { status: "paid", razorpay_payment_id });
    });

    const orderSnap = await orderRef.get();
    const { uid, credits, category } = orderSnap.data();

    // Only credit the same UID that initiated the order
    if (uid !== req.uid) return res.status(403).json({ error: "UID_MISMATCH" });

    await addCredits(uid, category, credits, {
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
