// services/razorpayService.js
// Thin, safe wrapper around Razorpay SDK.
// Env:
//   RAZORPAY_KEY_ID
//   RAZORPAY_KEY_SECRET
//   RAZORPAY_WEBHOOK_SECRET

"use strict";

const crypto = require("crypto");
let Razorpay;
try {
  Razorpay = require("razorpay");
} catch {
  Razorpay = null;
}

/* ---------------- Env ---------------- */
const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

/* ---------------- Client (lazy) ---------------- */
let client = null;
function ensureClient() {
  if (!KEY_ID || !KEY_SECRET) {
    const err = new Error("Razorpay keys not configured");
    err.code = "RZP_NOT_CONFIGURED";
    throw err;
  }
  if (!Razorpay) {
    const err = new Error("razorpay package not installed");
    err.code = "RZP_SDK_MISSING";
    throw err;
  }
  if (!client) client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return client;
}

/* ---------------- Helpers ---------------- */
const toPaise = (amountInRupees) => {
  const n = Number(amountInRupees);
  const p = Math.round(n * 100);
  if (!Number.isFinite(p) || p <= 0) {
    const err = new Error("Invalid amount");
    err.code = "RZP_INVALID_AMOUNT";
    throw err;
  }
  return p;
};

// Build a **short, safe** receipt (max 40 chars as per Razorpay)
function buildSafeReceipt(receipt, notes = {}) {
  let r = receipt && String(receipt).trim();
  if (!r) {
    const t = Date.now().toString(36); // short timestamp
    const u = String(notes.uid || "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8);
    const p = String(notes.planId || "")
      .replace(/[^a-z0-9_-]/gi, "")
      .slice(0, 10);
    r = `r_${t}${u ? "_" + u : ""}${p ? "_" + p : ""}`; // e.g. r_lmno12_abcd1234_img300
  }
  // allow only safe chars and trim to <= 40
  r = r.replace(/[^a-z0-9_.\-]/gi, "_");
  if (r.length > 40) r = r.slice(0, 40);
  return r;
}

/* ---------------- Top-Up: Orders ---------------- */
async function createOrder({ amount, currency = "INR", notes = {}, receipt }) {
  const rzp = ensureClient();
  const order = await rzp.orders.create({
    amount: toPaise(amount),
    currency,
    notes,
    receipt: buildSafeReceipt(receipt, notes), // <= 40 chars, always safe
  });
  return order; // { id, amount, status, ... }
}

function verifyPaymentSignature({ order_id, payment_id, signature }) {
  const hmac = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(`${order_id}|${payment_id}`)
    .digest("hex");
  return hmac === signature;
}

async function fetchOrder(orderId) {
  const rzp = ensureClient();
  return rzp.orders.fetch(orderId);
}

async function fetchPayment(paymentId) {
  const rzp = ensureClient();
  return rzp.payments.fetch(paymentId);
}

/* ---------------- Subscriptions ---------------- */
async function createSubscription({ rzpPlanId, totalCount = 12, notes = {}, customerNotify = 1 }) {
  const rzp = ensureClient();
  if (!rzpPlanId) {
    const err = new Error("Missing Razorpay plan id");
    err.code = "RZP_PLAN_MISSING";
    throw err;
  }
  const sub = await rzp.subscriptions.create({
    plan_id: rzpPlanId,
    total_count: totalCount,
    customer_notify: customerNotify,
    notes,
  });
  return sub; // { id, status, ... }
}

async function fetchSubscription(subscriptionId) {
  const rzp = ensureClient();
  return rzp.subscriptions.fetch(subscriptionId);
}

async function cancelSubscription(subscriptionId, cancelAtCycleEnd = true) {
  const rzp = ensureClient();
  return rzp.subscriptions.cancel(subscriptionId, { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 });
}

/* ---------------- Webhook ---------------- */
function verifyWebhookSignature(payloadBuffer, signature) {
  if (!WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payloadBuffer).digest("hex");
  return expected === signature;
}

/* ---------------- Misc ---------------- */
function getPublicKey() {
  return KEY_ID;
}
function isConfigured() {
  return Boolean(KEY_ID && KEY_SECRET);
}

/* ---------------- Exports ---------------- */
module.exports = {
  // config
  getPublicKey,
  isConfigured,

  // orders (top-up)
  createOrder,
  verifyPaymentSignature,
  fetchOrder,
  fetchPayment,

  // subscriptions
  createSubscription,
  fetchSubscription,
  cancelSubscription,

  // webhooks
  verifyWebhookSignature,
};
