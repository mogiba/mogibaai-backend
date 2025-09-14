// routes/razorpayRoute.js

const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { db } = require("../utils/firebaseUtils");
const { addCredits } = require("../services/creditsService");
const PLANS_HELPER = require("../utils/plans"); // server-side plans helper (use getTopupPlanById)

const router = express.Router();

// ---- Razorpay client ----
const rzp = new Razorpay({
  key_id: (process.env.RAZORPAY_KEY_ID || "").trim(),
  key_secret: (process.env.RAZORPAY_KEY_SECRET || "").trim(),
});

// ---- auth: prefer Firebase ID token -> fallback to x-uid header ----
async function requireAuth(req, res, next) {
  try {
    const h = req.headers || {};
    // Prefer Authorization header, but also accept X-Forwarded-Authorization from proxies
    const authHeader = (
      h["authorization"] ||
      h["Authorization"] ||
      h["x-forwarded-authorization"] ||
      h["X-Forwarded-Authorization"] ||
      ""
    ).toString();

    // 1) Try Authorization: Bearer <idToken>
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.split(" ")[1];
      try {
        const admin = require("../utils/firebaseUtils").admin;
        if (!admin || !admin.auth)
          throw new Error("firebase admin not initialized");
        const decoded = await admin.auth().verifyIdToken(token);
        if (decoded && decoded.uid) {
          req.uid = decoded.uid;
          return next();
        }
        // If verification did not produce uid, treat as unauthorized
        return res.status(401).json({ error: "UNAUTH_INVALID_TOKEN" });
      } catch (err) {
        console.warn(
          "DEBUG_RAZORPAY requireAuth verifyIdToken failed:",
          err.message || err,
        );
        return res.status(401).json({ error: "UNAUTH_INVALID_TOKEN" });
      }
    }
    try { console.log('DEBUG_RAZORPAY requireAuth: hasAuthorization=', Boolean(authHeader)); } catch (_) { }
    try { console.log('DEBUG_RAZORPAY requireAuth: x-uid header=', Boolean(h['x-uid'] || h['X-Uid'])); } catch (_) { }

    // 2) Fallback: x-uid header / query param
    const uid = h["x-uid"] || h["X-Uid"] || req.query?.uid || "";
    if (!uid) return res.status(401).json({ message: "Missing x-uid" });
    req.uid = uid;
    return next();
  } catch (e) {
    console.error("requireAuth error", e);
    return res.status(500).json({ error: "AUTH_CHECK_FAILED" });
  }
}

// ---- helpers ----
function shortReceipt(uid) {
  // Razorpay receipt must be <= 40 chars
  const tail = uid.slice(-8);
  const ts = Date.now().toString().slice(-8);
  return `rcpt_${tail}_${ts}`; // like rcpt_0bhn1Wq1_50938475
}

/**
 * Create a Razorpay Order
 * POST /api/payments/razorpay/create-order
 * body: { planId: string }
 */
router.post("/razorpay/create-order", requireAuth, async (req, res) => {
  try {
    // TEMP DEBUG: log a few key fields to help diagnose production issues (remove after verification)
    try {
      console.log(
        "DEBUG_RAZORPAY headers.authorization=",
        req.headers && req.headers.authorization,
      );
    } catch (_) { }
    try {
      console.log(
        "DEBUG_RAZORPAY headers['x-uid']=",
        req.headers && (req.headers["x-uid"] || req.headers["X-Uid"]),
      );
    } catch (_) { }
    try {
      console.log("DEBUG_RAZORPAY body=", JSON.stringify(req.body));
    } catch (_) { }

    const { planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "MISSING_PLANID" });

    // Lookup plan from server-side mapping (authoritative)
    const plan =
      (PLANS_HELPER.getTopupPlanById &&
        PLANS_HELPER.getTopupPlanById(planId)) ||
      PLANS_HELPER.TOPUP_MAP?.[planId] ||
      null;
    if (!plan) return res.status(400).json({ error: "INVALID_PLAN" });

    const amountINR = Number(plan.amountINR);
    if (!amountINR || isNaN(amountINR))
      return res.status(500).json({ error: "INVALID_PLAN_AMOUNT" });

    // Create order at Razorpay (convert rupees -> paise)
    const amountPaise = Math.round(amountINR * 100);

    const order = await rzp.orders.create({
      amount: amountPaise, // paise
      currency: "INR",
      receipt: shortReceipt(req.uid),
      notes: {
        uid: req.uid,
        planId: plan.planId,
        credits: String(plan.credits),
        category: plan.category,
      },
    });

    // Persist our order meta in Firestore (idempotent)
    await db.collection("razorpayOrders").doc(order.id).set({
      uid: req.uid,
      status: "created",
      planId: plan.planId,
      credits: plan.credits,
      category: plan.category,
      amountINR: amountINR,
      amountPaise: order.amount,
      currency: "INR",
      receipt: order.receipt,
      createdAt: new Date(),
    });

    // Return order + publishable key to client
    res.json({
      ok: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
      },
      keyId: rzp.key_id,
    });
  } catch (err) {
    console.error("❌ Razorpay order.create failed:", err?.error || err);
    res.status(500).json({ error: "RAZORPAY_CREATE_FAILED" });
  }
});

/**
 * (Optional) Checkout signature verify (client->server)
 * POST /api/payments/razorpay/verify
 * body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
router.post("/razorpay/verify", requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "MISSING_FIELDS" });
    }

    const sign = crypto
      .createHmac("sha256", (process.env.RAZORPAY_KEY_SECRET || "").trim())
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (sign !== razorpay_signature) {
      return res.status(400).json({ error: "BAD_SIGNATURE" });
    }

    // Mark as "paid" (idempotent)
    const orderRef = db.collection("razorpayOrders").doc(razorpay_order_id);
    await db.runTransaction(async (t) => {
      const snap = await t.get(orderRef);
      if (!snap.exists) throw new Error("ORDER_NOT_FOUND");
      if (snap.data().status === "paid") return;
      t.update(orderRef, {
        status: "paid",
        razorpay_payment_id,
        paidVia: "verify",
        paidAt: new Date(),
      });
    });

    // Add credits
    const orderSnap = await db
      .collection("razorpayOrders")
      .doc(razorpay_order_id)
      .get();
    const { uid, credits, category, planId } = orderSnap.data();
    if (uid !== req.uid) return res.status(403).json({ error: "UID_MISMATCH" });

    await addCredits(uid, category, credits, {
      source: "checkout_verify",
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      planId,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("❌ verify failed:", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Razorpay Webhook – signature verified with RAZORPAY_WEBHOOK_SECRET
 * POST /api/payments/razorpay/webhook
 *
 * NOTE: In index.js we mounted express.raw({type:'application/json'}) for this path.
 * So here req.body is a Buffer. Convert to string -> JSON.
 */
router.post("/razorpay/webhook", async (req, res) => {
  try {
    const secret = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
    if (!secret) return res.status(500).send("WEBHOOK_SECRET_MISSING");

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) return res.status(400).send("SIGNATURE_MISSING");

    const bodyBuf = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body);
    const expected = crypto
      .createHmac("sha256", secret)
      .update(bodyBuf)
      .digest("hex");
    if (expected !== signature) {
      return res.status(400).send("BAD_SIGNATURE");
    }

    const payload = JSON.parse(bodyBuf.toString("utf8"));
    const event = payload?.event;

    // We use payment events; get order/payment IDs if present
    const paymentEntity = payload?.payload?.payment?.entity || {};
    const orderId =
      paymentEntity.order_id || payload?.payload?.order?.entity?.id;
    const paymentId = paymentEntity.id;

    if (!orderId) {
      // nothing to do
      console.warn("Webhook without order_id, ignoring");
      return res.json({ ok: true });
    }

    if (event === "payment.failed") {
      await db
        .collection("razorpayOrders")
        .doc(orderId)
        .set(
          {
            status: "failed",
            razorpay_payment_id: paymentId || null,
            webhookEvent: event,
            failedAt: new Date(),
          },
          { merge: true },
        );
      return res.json({ ok: true });
    }

    // For payment.authorized/payment.captured => credit user once (idempotent)
    if (event === "payment.authorized" || event === "payment.captured") {
      const orderRef = db.collection("razorpayOrders").doc(orderId);

      // Read order meta to know uid/credits/category
      const snap = await orderRef.get();
      if (!snap.exists) {
        // Create shell doc if not exists (rare)
        await orderRef.set(
          { status: "unknown", createdFrom: "webhook" },
          { merge: true },
        );
      }

      let orderData = (await orderRef.get()).data() || {};
      const { uid, credits, category, planId } = orderData;

      // Idempotent: do not double-credit
      await db.runTransaction(async (t) => {
        const s = await t.get(orderRef);
        const d = s.data() || {};
        if (d.status === "paid") return; // already handled
        t.set(
          orderRef,
          {
            status: "paid",
            razorpay_payment_id: paymentId || null,
            webhookEvent: event,
            paidAt: new Date(),
          },
          { merge: true },
        );
      });

      if (uid && credits && category) {
        await addCredits(uid, category, Number(credits), {
          source: "webhook",
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId || null,
        });
      } else {
        console.warn(
          "Order meta incomplete (uid/credits/category missing) for",
          orderId,
        );
      }

      return res.json({ ok: true });
    }

    // any other events – acknowledge
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ webhook error:", e);
    // Always 200 to avoid retries storm; but log the error.
    return res.status(200).json({ ok: false, error: e.message });
  }
});

module.exports = router;
