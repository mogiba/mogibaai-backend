// utils/plans.js
/**
 * Centralized plans for Mogibaa AI
 *
 * TOP-UP:
 *  - This file is the single source of truth for amount/credits.
 *
 * SUBSCRIPTION:
 *  - Works WITHOUT .env as well.
 *  - rzpPlan is resolved in this order:
 *      1) process.env.RZP_PLAN_* (if present)
 *      2) secrets/razorpay-plans.json  -> { starter, pro, ultra }
 *      3) fallback: ''  (server route accepts rzpPlanId in body or planId like 'plan_...')
 */

const fs = require("fs");
const path = require("path");

/* ========== TOP-UP mapping (by key) ========== */
const TOPUP_MAP = {
  // ===== Image Plans =====
  img_baby_300:   { planId: "img_baby_300",   category: "image", amountINR: 300,  credits: 600,  label: "₹300 • 600 Image Credits" },
  img_starter_900:{ planId: "img_starter_900",category: "image", amountINR: 900,  credits: 1800, label: "₹900 • 1800 Image Credits" },
  img_pro_1800:   { planId: "img_pro_1800",   category: "image", amountINR: 1800, credits: 3700, label: "₹1800 • 3700 Image Credits" },

  // ===== Video Plans =====
  vid_baby_500:   { planId: "vid_baby_500",   category: "video", amountINR: 500,  credits: 500,  label: "₹500 • 500 Video Credits" },
  vid_starter_900:{ planId: "vid_starter_900",category: "video", amountINR: 900,  credits: 1000, label: "₹900 • 1000 Video Credits" },
  vid_pro_1800:   { planId: "vid_pro_1800",   category: "video", amountINR: 1800, credits: 2100, label: "₹1800 • 2100 Video Credits" },
};

/* -------- Helpers: map -> arrays (routes expect arrays) -------- */
function mapToArray(filterCategory) {
  return Object.values(TOPUP_MAP)
    .filter((p) => !filterCategory || p.category === filterCategory)
    .map((p) => ({
      // keep both id & planId for compatibility
      id: p.planId,
      planId: p.planId,
      title: p.label,
      price: p.amountINR,
      credits: p.credits,
      category: p.category,
    }));
}

/* ========== Subscription Plan ID resolution (no .env required) ========== */
function readJsonPlans() {
  try {
    const p = path.join(__dirname, "..", "secrets", "razorpay-plans.json");
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw);
    }
  } catch (_) {}
  return {};
}
const FILE_RZP = readJsonPlans();

function resolveRzpPlan(which) {
  switch (which) {
    case "starter":
      return process.env.RZP_PLAN_STARTER || FILE_RZP.starter || "";
    case "pro":
      return process.env.RZP_PLAN_PRO     || FILE_RZP.pro     || "";
    case "ultra":
      return process.env.RZP_PLAN_ULTRA   || FILE_RZP.ultra   || "";
    default:
      return "";
  }
}

const SUBSCRIPTION = [
  {
    id: "sub-starter",
    title: "Starter",
    price: 999,
    rzpPlan: resolveRzpPlan("starter"), // may be '' → server route can accept rzpPlanId from client
    features: ["200 Image Credits", "8 Video Credits", "All AI Tools Access", "Basic Support"],
  },
  {
    id: "sub-pro",
    title: "Pro",
    price: 1999,
    rzpPlan: resolveRzpPlan("pro"),
    features: ["2,500 Image Credits", "100 Video Credits", "Priority Support", "Unlimited Project Save"],
  },
  {
    id: "sub-ultra",
    title: "Ultra",
    price: 3999,
    rzpPlan: resolveRzpPlan("ultra"),
    features: ["6,000 Image Credits", "300 Video Credits", "Dedicated Support", "All Features Unlocked"],
  },
];

/* ========== Exported structure ========== */
const plans = {
  topup: {
    image: mapToArray("image"),
    video: mapToArray("video"),
  },
  subscription: SUBSCRIPTION,
};

/** getPlans({ type, category }) -> Array */
async function getPlans({ type = "topup", category = "image" } = {}) {
  type = String(type || "topup").toLowerCase();
  category = String(category || "image").toLowerCase();
  if (type === "subscription") return plans.subscription;
  return plans.topup[category] || [];
}

/** Optional direct lookups */
function getTopupPlanById(planId) {
  return TOPUP_MAP[planId] || null;
}
function getSubscriptionPlanById(id) {
  return SUBSCRIPTION.find((p) => p.id === id) || null;
}

module.exports = {
  TOPUP_MAP,
  plans,
  getPlans,
  getTopupPlanById,
  getSubscriptionPlanById,
  resolveRzpPlan,
};
