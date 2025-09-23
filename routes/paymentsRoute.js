// routes/paymentsRoute.js
// Razorpay Payments (Top-Up + Subscription)
// Mount: app.use('/api/payments/razorpay', require('./routes/paymentsRoute'));

const express = require("express");
const rzpSvc = require("../services/razorpayService");
const creditsService = require("../services/creditsService");
const { db, admin } = require('../utils/firebaseUtils');
const requireAuth = require('../middlewares/requireAuth');
const { getAuthoritativePlanById, getTopupPlanById, getSubscriptionPlanById } = require('../utils/plans');
const { applyCouponIfAny, fetchCoupon, markCouponRedeemed } = require('../services/pricingResolver');

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
const DEBUG = Boolean(process.env.DEBUG_RAZORPAY === '1' || process.env.DEBUG === '1');

async function readUid(req) {
  // 1) Authorization: Bearer <token> OR X-Forwarded-Authorization
  const authHeader = (req.headers['authorization'] || req.headers['x-forwarded-authorization'] || '').toString();
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const admin = require('../utils/firebaseUtils').admin || require('firebase-admin');
      const decoded = await admin.auth().verifyIdToken(token).catch(() => null);
      if (decoded && decoded.uid) {
        if (DEBUG) console.log('[DEBUG_RAZORPAY] verified token for uid=', decoded.uid);
        return decoded.uid;
      }
      if (DEBUG) console.log('[DEBUG_RAZORPAY] authorization present but token invalid');
    } catch (e) {
      if (DEBUG) console.warn('[DEBUG_RAZORPAY] token verification error', e && e.message ? e.message : e);
    }
  }

  // 2) x-uid header / query / body fallback (legacy)
  const h = (req.headers['x-uid'] || req.headers['X-Uid'] || '').toString().trim();
  const q = (req.query.uid || '').toString().trim();
  const b = req.body && req.body.uid ? String(req.body.uid).trim() : '';
  if (DEBUG) console.log('[DEBUG_RAZORPAY] readUid fallback: header,x,y ->', !!h, !!q, !!b);
  return h || q || b || '';
}
const parseIntSafe = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const normalizeCategory = (c, def = "image") => {
  c = String(c || def).toLowerCase();
  return c === "video" ? "video" : "image";
};
const isRzpPlanId = (s) => typeof s === "string" && /^plan_/i.test(s);

// Atomically redeem a coupon for this order if not already redeemed
async function redeemCouponOnce({ orderId, couponCode }) {
  const code = (couponCode || '').toString().toUpperCase();
  if (!orderId || !code) return { ok: false };
  const orderRef = db.collection('orders').doc(String(orderId));
  const couponRef = db.collection('coupons').doc(code);
  const { FieldValue } = admin.firestore;
  try {
    await db.runTransaction(async (tx) => {
      const [oSnap, cSnap] = await Promise.all([tx.get(orderRef), tx.get(couponRef)]);
      if (!cSnap.exists) throw new Error('COUPON_NOT_FOUND');
      const o = oSnap.exists ? (oSnap.data() || {}) : {};
      if (o.couponRedeemed === true) return; // idempotent
      const c = cSnap.data() || {};
      const max = c.maxRedemptions != null ? parseIntSafe(c.maxRedemptions, 0) : null;
      const cur = parseIntSafe(c.redeemed, 0);
      if (max != null && cur >= max) throw new Error('COUPON_MAX_REDEEMED');
      tx.set(couponRef, { redeemed: cur + 1 }, { merge: true });
      tx.set(orderRef, { couponRedeemed: true }, { merge: true });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

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
router.post("/create-order", express.json(), requireAuth, async (req, res) => {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = req.uid;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  // Only trust server-side plan mapping
  const incomingPlanId = String(req.body?.planId || '').trim();
  const couponCodeRaw = String(req.body?.couponCode || req.body?.coupon || '').trim();
  const couponCode = couponCodeRaw ? couponCodeRaw.toUpperCase() : '';
  const planValidityDays = Number(req.body?.planValidityDays || 30);
  const plan = getAuthoritativePlanById(incomingPlanId) || getTopupPlanById(incomingPlanId);
  if (!plan || plan.type !== 'topup') {
    return res.status(400).json({ message: 'Invalid planId' });
  }

  try {
    // Optional coupon for plans: apply only if coupon is valid for scope 'plans'
    let finalAmountINR = Number(plan.amountINR);
    let couponApplied = null;
    if (couponCode) {
      const coupon = await fetchCoupon(couponCode);
      const applied = applyCouponIfAny(finalAmountINR, couponCode, { couponNorm: coupon, scope: 'plans', planId: plan.planId });
      if (applied.applied) {
        finalAmountINR = applied.finalAmount;
        couponApplied = { code: coupon.code, type: coupon.type, value: coupon.value, discountINR: applied.discountAmount };
      }
    }

    const order = await rzpSvc.createOrder({
      amount: finalAmountINR,
      currency: 'INR',
      notes: {
        uid,
        planId: plan.planId,
        type: 'topup',
        category: plan.category,
        credits: String(plan.credits),
        coupon: couponApplied?.code || undefined,
        couponDiscountINR: couponApplied?.discountINR || 0,
        planValidityDays: Number.isFinite(planValidityDays) && planValidityDays > 0 ? String(planValidityDays) : undefined,
      }
    });

    // Persist order metadata (idempotent)
    await db.collection('orders').doc(order.id).set({
      uid,
      planId: plan.planId,
      category: plan.category,
      credits: plan.credits,
      amountPaise: order.amount,
      amountINR: finalAmountINR,
      amountINROriginal: Number(plan.amountINR),
      currency: order.currency || 'INR',
      receipt: order.receipt || null,
      status: 'created',
      createdAt: new Date(),
      provider: 'razorpay',
      coupon: couponApplied || null,
      planValidityDays: Number.isFinite(planValidityDays) && planValidityDays > 0 ? planValidityDays : null,
    }, { merge: true });

    res.json({ order, keyId: rzpSvc.getPublicKey() });
  } catch (e) {
    res.status(500).json({ message: e?.error?.description || e.message || 'Failed to create order' });
  }
});

router.post("/verify", express.json(), requireAuth, async (req, res) => {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = req.uid;
  if (!uid) return res.status(401).json({ message: 'Unauthorized' });

  const orderId = req.body.orderId || req.body.razorpay_order_id;
  const paymentId = req.body.paymentId || req.body.razorpay_payment_id;
  const signature = req.body.signature || req.body.razorpay_signature;
  if (!orderId || !paymentId || !signature) return res.status(400).json({ message: "Missing verification fields" });

  const ok = rzpSvc.verifyPaymentSignature({ order_id: orderId, payment_id: paymentId, signature });
  if (!ok) return res.status(400).json({ message: "Invalid signature" });

  try {
    const ref = db.collection('orders').doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) {
      // fetch as fallback
      const fetched = await rzpSvc.fetchOrder(orderId).catch(() => null);
      const notes = fetched?.notes || {};
      await ref.set({
        uid: notes.uid || uid,
        planId: notes.planId || null,
        category: normalizeCategory(notes.category),
        credits: parseIntSafe(notes.credits, 0),
        amountPaise: fetched?.amount || null,
        currency: fetched?.currency || 'INR',
        status: 'paid',
        verifiedAt: new Date(),
      }, { merge: true });
    }
    const ord = (await ref.get()).data() || {};
    if (ord.uid && ord.uid !== uid) return res.status(403).json({ message: 'UID mismatch' });

    // idempotent using credited flag primarily
    if (ord.credited === true) {
      return res.json({ ok: true, credited: false, orderId });
    }

    await ref.set({ status: 'paid', paymentId, verifiedAt: new Date(), credited: true }, { merge: true });
    await creditsService.addCredits(uid, ord.category || 'image', ord.credits || 0, { source: 'razorpay', orderId, paymentId });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e?.message || 'Verification failed' });
  }
});

/* =============== SUBSCRIPTIONS =============== */
async function createSubscriptionHandler(req, res) {
  noStore(res);
  if (!rzpSvc.isConfigured()) return res.status(503).json({ message: "Razorpay keys not configured" });

  const uid = req.uid || (await readUid(req));
  if (!uid) return res.status(401).json({ message: "Unauthorized" });
  if (DEBUG) {
    const hasAuth = !!(req.headers['authorization'] || req.headers['x-forwarded-authorization']);
    console.log('[DEBUG_RAZORPAY][subscribe] uid=', uid, 'authHeaderPresent=', hasAuth);
  }

  const planId = String(req.body?.planId || "");
  const rzpPlanId = String(req.body?.rzpPlanId || "");
  if (!planId && !isRzpPlanId(rzpPlanId)) return res.status(400).json({ message: "planId or rzpPlanId required" });

  const plan = resolveSubscriptionPlan({ planId, rzpPlanId });
  if (!plan || !isRzpPlanId(plan.rzpPlan)) {
    if (DEBUG) console.warn('[DEBUG_RAZORPAY][subscribe] Missing rzpPlan for planId=', planId, 'env/file likely not configured');
    return res.status(400).json({ message: "Razorpay plan id missing. Configure RZP_PLAN_* env or provide rzpPlanId (plan_...)." });
  }

  try {
    const sub = await rzpSvc.createSubscription({
      rzpPlanId: plan.rzpPlan,
      totalCount: Number(req.body?.totalCount) || 12,
      notes: { uid, appPlanId: plan.id, type: "subscription" },
      customerNotify: 1,
    });
    subsMem.set(uid, { subscriptionId: sub.id, planId: plan.id, status: sub.status || "created" });
    res.json({ id: sub.id, subscriptionId: sub.id, keyId: rzpSvc.getPublicKey(), meta: { merchantName: "Mogibaa AI", prefill: {} } });
  } catch (e) {
    res.status(500).json({ message: e?.error?.description || e.message || "Failed to create subscription" });
  }
}
async function getSubscriptionStatusHandler(req, res) {
  noStore(res);
  const uid = await readUid(req);
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

  const uid = await readUid(req);
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
router.post(["/create-subscription", "/subscribe"], express.json(), requireAuth, createSubscriptionHandler);
router.get(["/subscription", "/sub-status"], getSubscriptionStatusHandler);
router.post(["/cancel", "/sub-cancel"], express.json(), cancelSubscriptionHandler);

/* ================= webhook ================= */
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["x-razorpay-signature"] || "";
  const payload = req.body;
  if (!rzpSvc.verifyWebhookSignature(payload, sig)) return res.status(400).send("bad signature");

  let evt = null;
  try { evt = JSON.parse(payload.toString("utf8")); } catch { return res.status(200).send("ok"); }

  async function grantSubscriptionCreditsOnce({ uid, appPlanId, invoiceId, subscriptionId }) {
    if (!uid || !appPlanId) return;
    const grantId = invoiceId || `sub_${subscriptionId || ""}_${evt?.event || "unknown"}`;
    if (!grantId) return;
    const ref = db.collection('subscription_grants').doc(String(grantId));
    const snap = await ref.get();
    if (snap.exists) return; // idempotent
    // get plan credits
    let plan = null;
    try { plan = getSubscriptionPlanById(appPlanId) || (PLANS && Array.isArray(PLANS.plans?.subscription) ? PLANS.plans.subscription.find(p => (p.id || p.planId) === appPlanId) : null); } catch { plan = null; }
    const img = Number(plan?.credits?.image || 0);
    const vid = Number(plan?.credits?.video || 0);
    // Do not proceed if neither is positive
    if (img <= 0 && vid <= 0) return;
    // Commit grant doc first to avoid races
    await ref.set({ uid, appPlanId, subscriptionId: subscriptionId || null, credits: { image: img, video: vid }, createdAt: new Date() });
    // Apply credits
    if (img > 0) await creditsService.addCredits(uid, 'image', img, { source: 'razorpay:subscription', invoiceId, subscriptionId, appPlanId });
    if (vid > 0) await creditsService.addCredits(uid, 'video', vid, { source: 'razorpay:subscription', invoiceId, subscriptionId, appPlanId });
  }

  try {
    // top-up credit
    if (evt.event === 'payment.captured' || evt.event === 'payment.authorized') {
      const pay = evt.payload?.payment?.entity;
      const notes = pay?.notes || {};
      const orderId = pay?.order_id;
      const uid = notes.uid;
      if (notes.type === 'topup' && uid && orderId) {
        const category = normalizeCategory(notes.category);
        const credits = parseIntSafe(notes.credits, 0);
        const ref = db.collection('orders').doc(orderId);
        const snap = await ref.get();
        const ord = snap.exists ? snap.data() : {};
        const couponCode = (notes.coupon || ord?.coupon?.code || '').toString().toUpperCase();
        const planId = notes.planId || ord.planId || null;
        const planValidityDays = parseIntSafe(notes.planValidityDays || ord.planValidityDays || '0', 0);

        const expAt = planValidityDays > 0 ? new Date(Date.now() + planValidityDays * 24 * 60 * 60 * 1000) : null;
        const ensureUserPlanFields = async () => {
          if (!planId) return;
          try {
            const uref = db.collection('users').doc(uid);
            const patch = { planId };
            if (expAt) patch.planExpiryAt = expAt;
            await uref.set(patch, { merge: true });
          } catch (_) { }
        };

        const recordBillingEventOnce = async () => {
          try {
            const evRef = db.collection('billingEvents').doc(String(orderId));
            const evSnap = await evRef.get();
            if (evSnap.exists && evSnap.data()?.paidLogged) return;
            await evRef.set({
              orderId,
              paymentId: pay?.id || null,
              event: evt.event,
              uid,
              planId,
              category,
              credits,
              amountPaise: pay?.amount || null,
              amountINR: ord?.amountINR || null,
              coupon: couponCode || null,
              planExpiryAt: expAt || null,
              createdAt: new Date(),
              paidLogged: true,
            }, { merge: true });
          } catch (_) { }
        };

        // Idempotent crediting
        if (ord.credited === true) {
          // already credited earlier; still ensure plan fields, coupon redemption, and audit
          await ensureUserPlanFields();
          if (couponCode) {
            const redeemedFlag = ord?.couponRedeemed === true;
            if (!redeemedFlag) await redeemCouponOnce({ orderId, couponCode });
          }
          await recordBillingEventOnce();
        } else {
          await ref.set({
            uid,
            planId: planId || null,
            category,
            credits,
            amountPaise: pay?.amount || ord.amountPaise || null,
            currency: pay?.currency || ord.currency || 'INR',
            status: 'paid',
            paymentId: pay?.id,
            webhookAt: new Date(),
            credited: true,
          }, { merge: true });
          await creditsService.addCredits(uid, category, credits, { source: 'razorpay:webhook', orderId, paymentId: pay?.id });
          await ensureUserPlanFields();
          if (couponCode) await redeemCouponOnce({ orderId, couponCode });
          await recordBillingEventOnce();
        }
      }
    }

    if (evt.event === 'payment.failed') {
      const pay = evt.payload?.payment?.entity;
      const orderId = pay?.order_id;
      if (orderId) await db.collection('orders').doc(orderId).set({ status: 'failed', webhookAt: new Date() }, { merge: true });
    }

    // subscription events
    if (evt.event === "invoice.paid") {
      const invoice = evt.payload?.invoice?.entity || null;
      const notes = invoice?.notes || {};
      const uid = notes.uid || notes.userId || null;
      const appPlanId = notes.appPlanId || notes.planId || null;
      const subscriptionId = invoice?.subscription_id || null;
      if (uid && subscriptionId) {
        subsMem.set(uid, { subscriptionId, planId: appPlanId || subsMem.get(uid)?.planId || "", status: "active" });
      }
      if (uid && appPlanId) {
        await grantSubscriptionCreditsOnce({ uid, appPlanId, invoiceId: invoice?.id || null, subscriptionId });
      }
    }

    if (
      evt.event === "subscription.activated" ||
      evt.event === "subscription.charged" ||
      evt.event === "subscription.completed" ||
      evt.event === "subscription.paused" ||
      evt.event === "subscription.cancelled"
    ) {
      const sub = evt.payload?.subscription?.entity || null;
      const notes = sub?.notes || {};
      const uid = notes.uid || null;
      const appPlanId = notes.appPlanId || null;
      if (uid && sub?.id) {
        subsMem.set(uid, { subscriptionId: sub.id, planId: appPlanId || subsMem.get(uid)?.planId || "", status: sub.status || "active" });
      }
      // On activation, grant once as a fallback (some accounts may not receive invoice.paid immediately)
      if (evt.event === 'subscription.activated' && uid && appPlanId) {
        await grantSubscriptionCreditsOnce({ uid, appPlanId, invoiceId: null, subscriptionId: sub?.id || null });
      }
    }
  } catch { }
  res.status(200).send("ok");
});

module.exports = router;
