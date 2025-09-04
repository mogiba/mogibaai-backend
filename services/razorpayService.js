// services/razorpayService.js
// Fully self-contained Razorpay service

const Razorpay = require("razorpay");
const crypto = require("crypto");
const { db, admin } = require("../utils/firebaseUtils");

// --- Env checks ------------------------------------------------------------
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  throw new Error(
    "Razorpay keys missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your .env"
  );
}

// --- Razorpay Instance -----------------------------------------------------
const razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });

// --- Helpers ---------------------------------------------------------------
/**
 * Create a Razorpay order and persist a record in Firestore.
 * @param {string} uid            Firebase UID of the buyer
 * @param {number} credits        Number of credits to award after payment
 * @param {"image"|"video"} category  Credits bucket
 * @param {number} amountINR      Amount in INR to charge (e.g. 300)
 * @returns {Promise<object>}     Razorpay order object
 */
async function createOrder(uid, credits, category, amountINR) {
  if (!uid || !credits || !category || !amountINR)
    throw new Error("MISSING_PARAMS");

  // Razorpay expects amount in paise
  const amountPaise = Math.round(amountINR * 100);

  // ✅ Receipt must be <= 40 chars. Shorten uid + use compact timestamp
  const uidPart = String(uid).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16);
  const tsPart = Date.now().toString().slice(-10);
  const receipt = `rcpt_${uidPart}_${tsPart}`; // always <= 40

  let order;
  try {
    order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: { uid, credits, category },
    });
  } catch (err) {
    console.error("❌ Razorpay order.create failed:", err);
    throw new Error("RAZORPAY_CREATE_FAILED");
  }

  try {
    await db.collection("razorpayOrders").doc(order.id).set({
      uid,
      credits,
      category,
      amountINR,
      status: "created",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("❌ Firestore write failed for order:", order.id, err);
    // Even if Firestore fails, return the order so client can continue
  }

  return order; // { id, amount, currency, ... }
}

/**
 * Verify Razorpay signature for a successful payment.
 */
function verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return false;
  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", KEY_SECRET)
    .update(body)
    .digest("hex");
  return expectedSignature === razorpay_signature;
}

module.exports = { razorpay, createOrder, verifySignature };
