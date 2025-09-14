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
  img_baby_300: { planId: "img_baby_300", category: "image", amountINR: 300, credits: 600, label: "₹300 • 600 Image Credits" },
  img_starter_900: { planId: "img_starter_900", category: "image", amountINR: 900, credits: 1800, label: "₹900 • 1800 Image Credits" },
  img_pro_1800: { planId: "img_pro_1800", category: "image", amountINR: 1800, credits: 3700, label: "₹1800 • 3700 Image Credits" },

  // ===== Video Plans =====
  vid_baby_500: { planId: "vid_baby_500", category: "video", amountINR: 500, credits: 500, label: "₹500 • 500 Video Credits" },
  vid_starter_900: { planId: "vid_starter_900", category: "video", amountINR: 900, credits: 1000, label: "₹900 • 1000 Video Credits" },
  vid_pro_1800: { planId: "vid_pro_1800", category: "video", amountINR: 1800, credits: 2100, label: "₹1800 • 2100 Video Credits" },
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
  } catch (_) { }
  return {};
}
const FILE_RZP = readJsonPlans();

function resolveRzpPlan(which) {
  switch (which) {
    case "starter":
      return process.env.RZP_PLAN_STARTER || FILE_RZP.starter || "";
    case "pro":
      return process.env.RZP_PLAN_PRO || FILE_RZP.pro || "";
    case "ultra":
      return process.env.RZP_PLAN_ULTRA || FILE_RZP.ultra || "";
    default:
      return "";
  }
}

// Authoritative mapping for subscription plans used by server for pricing/credits
// Also compute savings vs pay-as-you-go rates: image ₹0.50/credit, video ₹1.50/credit
function computeSavings(amountINR, credits) {
  const img = (credits?.image || 0) * 0.5;
  const vid = (credits?.video || 0) * 1.5;
  const value = Math.round((img + vid));
  const savingsINR = Math.max(0, value - Number(amountINR || 0));
  const savingsPercent = value > 0 ? Math.round((savingsINR / value) * 100) : 0;
  return { valueINR: value, savingsINR, savingsPercent };
}

const SUBSCRIPTION = [
  {
    id: "sub-starter",
    planId: "starter_monthly",
    name: "Starter",
    amountINR: 999,
    credits: { image: 800, video: 200 },
    billingInterval: "monthly",
    features: ["800 Image Credits", "200 Video Credits", "All AI Tools Access", "Basic Support"],
    category: "subscription",
    rzpPlan: resolveRzpPlan("starter"),
  },
  {
    id: "sub-pro",
    planId: "pro_monthly",
    name: "Pro",
    amountINR: 1999,
    credits: { image: 1300, video: 540 },
    billingInterval: "monthly",
    features: ["1,300 Image Credits", "540 Video Credits", "Priority Support", "Unlimited Project Save"],
    category: "subscription",
    rzpPlan: resolveRzpPlan("pro"),
  },
  {
    id: "sub-ultra",
    planId: "ultra_monthly",
    name: "Ultra",
    amountINR: 3999,
    credits: { image: 2200, video: 1200 },
    billingInterval: "monthly",
    features: ["2,200 Image Credits", "1,200 Video Credits", "Dedicated Support", "All Features Unlocked"],
    category: "subscription",
    rzpPlan: resolveRzpPlan("ultra"),
  },
].map((p) => ({
  ...p,
  ...computeSavings(p.amountINR, p.credits),
}));

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
  return SUBSCRIPTION.find((p) => p.id === id || p.planId === id) || null;
}

/** Get authoritative plan by id for server trust (top-up or subscription) */
function getAuthoritativePlanById(planId) {
  if (!planId) return null;
  // check top-up map first
  if (TOPUP_MAP[planId]) {
    const p = TOPUP_MAP[planId];
    return {
      type: 'topup',
      planId: p.planId,
      name: p.label,
      amountINR: Number(p.amountINR),
      credits: p.credits,
      billingInterval: null,
      features: [],
      category: p.category,
    };
  }
  // subscription
  const s = getSubscriptionPlanById(planId);
  if (s) {
    return {
      type: 'subscription',
      planId: s.planId || s.id,
      name: s.name || s.title,
      amountINR: Number(s.amountINR || s.price),
      credits: s.credits || { image: 0, video: 0 },
      billingInterval: s.billingInterval || 'monthly',
      features: s.features || [],
      category: 'subscription',
      rzpPlan: s.rzpPlan || '',
    };
  }
  return null;
}

module.exports = {
  TOPUP_MAP,
  plans,
  getPlans,
  getTopupPlanById,
  getSubscriptionPlanById,
  resolveRzpPlan,
  getAuthoritativePlanById,
};
