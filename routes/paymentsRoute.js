// routes/paymentsRoute.js
// Razorpay Payments (Top-Up + Subscription)
// Mount: app.use('/api/payments/razorpay', require('./routes/paymentsRoute'));

const express = require("express");
const rzpSvc = require("../services/razorpayService");
const creditsService = require("../services/creditsService");

// optional plans map
let PLANS = null;
try { PLANS = require("../utils/plans"); } catch { PLANS = null; }

const router = express.Router();

// TEMP DEBUG: echo headers + token decode (REMOVE IN PRODUCTION)
router.get('/debug/headers', async (req, res) => {
  try {
    const headers = req.headers || {};
    const out = { headers: {}, tokenInfo: null };
    // copy headers but limit length
    Object.keys(headers).forEach(k => { try { out.headers[k] = String(headers[k]).slice(0, 200); } catch { } });
    // try to decode Authorization Bearer token using firebase-admin if available
    const authHeader = (req.headers['authorization'] || '').toString();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const admin = require('firebase-admin');
        const decoded = await admin.auth().verifyIdToken(token).catch(() => null);
        if (decoded) out.tokenInfo = { uid: decoded.uid, email: decoded.email || null, iss: decoded.iss || null }; else out.tokenInfo = { error: 'invalid_token' };
      } catch (e) {
        out.tokenInfo = { error: 'firebase_admin_not_available', message: String(e.message || e) };
      }
    }
    res.json({ ok: true, debug: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* --------------- helpers --------------- */
const noStore = (res) => res.set("Cache-Control", "no-store");
const readUid = (req) => {
  const h = (req.headers["x-uid"] || req.headers["X-Uid"] || "").toString().trim();
  const q = (req.query.uid || "").toString().trim();
  const b = req.body && req.body.uid ? String(req.body.uid).trim() : "";
  return h || q || b || "";
};
const parseIntSafe = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const normalizeCategory = (c, def = "image") => {
  c = String(c || def).toLowerCase();
  return c === "video" ? "video" : "image";
};
const isRzpPlanId = (s) => typeof s === "string" && /^plan_/i.test(s);

/* ---------- topup plans ---------- */
const ALIASES = {
  img_baby_300: ["img_baby_300", "img-300", "image-300", "img300", "300img", "img_baby"],
  img_starter_900: ["img_starter_900", "img-900", "image-900", "img900", "900img", "img_starter"],
  img_pro_1800: ["img_pro_1800", "img-1800", "image-1800", "img1800", "1800img", "img_pro"],
  vid_baby_500: ["vid_baby_500", "vid-500", "video-500", "vid500", "500vid", "vid_baby"],
  vid_starter_900: ["vid_starter_900", "vid-900", "video-900", "vid900", "900vid", "vid_starter"],
  vid_pro_1800: ["vid_pro_1800", "vid-1800", "video-1800", "vid1800", "1800vid", "vid_pro"],
};
function toCanon(id) {
  const s = String(id || "").toLowerCase();
  for (const [canon, list] of Object.entries(ALIASES)) {
    if (list.map(x => x.toLowerCase()).includes(s)) return canon;
  }
  return s;
}
function planFromCanon(canon) {
  switch (canon) {
    case "img_baby_300": return { planId: canon, amountINR: 300, credits: 600, category: "image", label: "₹300 • 600 Image Credits" };
    case "img_starter_900": return { planId: canon, amountINR: 900, credits: 1800, category: "image", label: "₹900 • 1800 Image Credits" };
    case "img_pro_1800": return { planId: canon, amountINR: 1800, credits: 3700, category: "image", label: "₹1800 • 3700 Image Credits" };
    case "vid_baby_500": return { planId: canon, amountINR: 500, credits: 500, category: "video", label: "₹500 • 500 Video Credits" };
    case "vid_starter_900": return { planId: canon, amountINR: 900, credits: 1000, category: "video", label: "₹900 • 1000 Video Credits" };
    case "vid_pro_1800": return { planId: canon, amountINR: 1800, credits: 2100, category: "video", label: "₹1800 • 2100 Video Credits" };
    default: return null;
  }
}
function pickTopupPlan(incomingId) {
  const canon = toCanon(incomingId);
  if (PLANS && PLANS.TOPUP_MAP && PLANS.TOPUP_MAP[canon]) {
    const p = PLANS.TOPUP_MAP[canon];
    return {
      planId: p.planId || canon,
      amountINR: Number(p.amountINR),
      credits: Number(p.credits),
      category: normalizeCategory(p.category),
      label: p.label || "",
    };
  }
  return planFromCanon(canon);
}

/* ---------- subscription resolver ---------- */
function resolveSubscriptionPlan({ planId, rzpPlanId }) {
  // 1) plans.js -> subscription[]
  if (PLANS && Array.isArray(PLANS.plans?.subscription)) {
    const m = PLANS.plans.subscription.find(p => (p.id || p.planId) === planId);
    if (m && m.rzpPlan) return { id: m.id || m.planId, rzpPlan: m.rzpPlan };
  }
  // 2) explicit rzpPlanId from body
  if (isRzpPlanId(rzpPlanId)) return { id: planId || rzpPlanId, rzpPlan: rzpPlanId };
  // 3) treat planId itself as Razorpay plan id
  if (isRzpPlanId(planId)) return { id: planId, rzpPlan: planId };
  return null;
}

/* ---------- in-memory ---------- */
const ordersMem = new Map(); // orderId -> {...}
const subsMem = new Map(); // uid -> { subscriptionId, planId, status }

/* ================= TOP-UP ================= */
router.post("/create-order", express.json(), async (req, res) => {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: "Missing x-uid" });

  // Prefer planId-based flows (existing logic), but accept ad-hoc payloads from client
  const planIdRaw = String(req.body?.planId || "").trim();
  let plan = null;
  if (planIdRaw) {
    plan = pickTopupPlan(planIdRaw);
    if (!plan || !plan.amountINR || !plan.credits) return res.status(404).json({ message: "Invalid planId" });
  } else {
    // Fallback: compute amount and credits from provided totals (client-side topup)
    const total = Number(req.body?.total || 0);
    const base = Number(req.body?.base || 0);
    const gst = Number(req.body?.gst || 0);
    const credits = parseIntSafe(req.body?.credits, 0);
    const category = normalizeCategory(req.body?.category || req.body?.cat || req.body?.category || "image");

    let amountINR = 0;
    if (total > 0) amountINR = total;
    else if (base > 0) amountINR = base + gst;

    if (!amountINR || amountINR <= 0) {
      return res.status(400).json({ message: "planId required or provide total/base+gst" });
    }

    plan = {
      planId: req.body?.planId || `ad-hoc-${Date.now()}`,
      amountINR: Number(amountINR),
      credits: credits || 0,
      category,
    };
  }

  try {
    const order = await rzpSvc.createOrder({
      amount: plan.amountINR,
      currency: "INR",
      notes: { uid, planId: plan.planId, type: "topup", category: plan.category, credits: String(plan.credits) },
    });
    ordersMem.set(order.id, { uid, planId: plan.planId, category: plan.category, credits: plan.credits, amountINR: plan.amountINR, status: "created" });
    res.json({ order, keyId: rzpSvc.getPublicKey(), meta: { merchantName: "Mogibaa AI", prefill: {} } });
  } catch (e) {
    res.status(500).json({ message: e?.error?.description || e.message || "Failed to create order" });
  }
});

router.post("/verify", express.json(), async (req, res) => {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: "Missing x-uid" });

  const orderId = req.body.orderId || req.body.razorpay_order_id;
  const paymentId = req.body.paymentId || req.body.razorpay_payment_id;
  const signature = req.body.signature || req.body.razorpay_signature;
  if (!orderId || !paymentId || !signature) return res.status(400).json({ message: "Missing verification fields" });

  const ok = rzpSvc.verifyPaymentSignature({ order_id: orderId, payment_id: paymentId, signature });
  if (!ok) return res.status(400).json({ message: "Invalid signature" });

  let ord = ordersMem.get(orderId);
  if (!ord) {
    try {
      const fetched = await rzpSvc.fetchOrder(orderId);
      const notes = fetched?.notes || {};
      if (fetched && notes.uid && notes.type === "topup") {
        ord = {
          uid: notes.uid,
          planId: notes.planId,
          category: normalizeCategory(notes.category),
          credits: parseIntSafe(notes.credits, 0),
          amountINR: parseIntSafe(fetched.amount / 100, 0),
          status: fetched.status || "paid",
        };
        ordersMem.set(orderId, ord);
      }
    } catch { }
  }

  if (!ord) return res.json({ ok: true }); // webhook will credit
  if (ord.status === "paid") return res.json({ ok: true });
  if (ord.uid !== uid) return res.status(403).json({ message: "UID mismatch" });

  try {
    await creditsService.addCredits(uid, ord.category, ord.credits, { source: "razorpay", orderId, paymentId });
    ord.status = "paid"; ordersMem.set(orderId, ord);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e?.message || "Failed to add credits" });
  }
});

/* =============== SUBSCRIPTIONS =============== */
async function createSubscriptionHandler(req, res) {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: "Missing x-uid" });

  const planId = String(req.body?.planId || "");
  const rzpPlanId = String(req.body?.rzpPlanId || "");
  if (!planId && !isRzpPlanId(rzpPlanId)) return res.status(400).json({ message: "planId or rzpPlanId required" });

  const plan = resolveSubscriptionPlan({ planId, rzpPlanId });
  if (!plan || !isRzpPlanId(plan.rzpPlan)) {
    return res.status(400).json({ message: "Razorpay plan id missing. Pass rzpPlanId or define in utils/plans.js" });
  }

  try {
    const sub = await rzpSvc.createSubscription({
      rzpPlanId: plan.rzpPlan,
      totalCount: Number(req.body?.totalCount) || 12,
      notes: { uid, appPlanId: plan.id, type: "subscription" },
      customerNotify: 1,
    });
    subsMem.set(uid, { subscriptionId: sub.id, planId: plan.id, status: sub.status || "created" });
    res.json({ subscriptionId: sub.id, keyId: rzpSvc.getPublicKey(), meta: { merchantName: "Mogibaa AI", prefill: {} } });
  } catch (e) {
    res.status(500).json({ message: e?.error?.description || e.message || "Failed to create subscription" });
  }
}
async function getSubscriptionStatusHandler(req, res) {
  noStore(res);
  const uid = readUid(req);
  if (!uid) return res.status(401).json({ status: "unauthorized" });
  if (!rzpSvc.isConfigured()) return res.json({ status: "unknown" });

  const rec = subsMem.get(uid);
  if (!rec) return res.json({ status: "none" });

  try {
    const s = await rzpSvc.fetchSubscription(rec.subscriptionId);
    subsMem.set(uid, { ...rec, status: s.status });
    res.json({ status: s.status, subscriptionId: s.id });
  } catch {
    res.json({ status: rec.status || "unknown", subscriptionId: rec.subscriptionId });
  }
}
async function cancelSubscriptionHandler(req, res) {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: "Missing x-uid" });

  const rec = subsMem.get(uid);
  if (!rec || !rec.subscriptionId) return res.status(404).json({ message: "No subscription found" });

  try {
    const out = await rzpSvc.cancelSubscription(rec.subscriptionId, true);
    subsMem.set(uid, { ...rec, status: out.status });
    res.json({ ok: true, status: out.status });
  } catch (e) {
    res.status(500).json({ message: e?.error?.description || e.message || "Failed to cancel" });
  }
}

/* aliases + main paths (so UI ఏ పేర్లు వాడినా OK) */
router.post(["/create-subscription", "/subscribe"], express.json(), createSubscriptionHandler);
router.get(["/subscription", "/sub-status"], getSubscriptionStatusHandler);
router.post(["/cancel", "/sub-cancel"], express.json(), cancelSubscriptionHandler);

/* ================= webhook ================= */
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["x-razorpay-signature"] || "";
  const payload = req.body;
  if (!rzpSvc.verifyWebhookSignature(payload, sig)) return res.status(400).send("bad signature");

  let evt = null;
  try { evt = JSON.parse(payload.toString("utf8")); } catch { return res.status(200).send("ok"); }

  try {
    // top-up credit
    if (evt.event === "payment.captured" || evt.event === "payment.authorized") {
      const pay = evt.payload?.payment?.entity;
      const notes = pay?.notes || {};
      const orderId = pay?.order_id;
      const uid = notes.uid;
      if (notes.type === "topup" && uid && orderId) {
        const category = normalizeCategory(notes.category);
        const credits = parseIntSafe(notes.credits, 0);
        const rec = ordersMem.get(orderId) || { status: "created" };
        if (rec.status !== "paid") {
          await creditsService.addCredits(uid, category, credits, { source: "razorpay:webhook", orderId, paymentId: pay?.id });
          rec.status = "paid"; rec.uid = uid; rec.category = category; rec.credits = credits;
          ordersMem.set(orderId, rec);
        }
      }
    }

    // subscription status track
    if (
      evt.event === "invoice.paid" ||
      evt.event === "subscription.activated" ||
      evt.event === "subscription.charged" ||
      evt.event === "subscription.cancelled" ||
      evt.event === "subscription.completed" ||
      evt.event === "subscription.paused"
    ) {
      const sub = evt.payload?.subscription?.entity || null;
      const notes =
        evt.payload?.subscription?.entity?.notes ||
        evt.payload?.invoice?.entity?.notes || {};
      const uid = notes.uid;
      if (uid && sub?.id) {
        subsMem.set(uid, {
          subscriptionId: sub.id,
          planId: notes.appPlanId || subsMem.get(uid)?.planId || "",
          status: sub.status || "active",
        });
      }
    }
  } catch { }
  res.status(200).send("ok");
});

module.exports = router;
