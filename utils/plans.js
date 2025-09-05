// utils/plans.js

/**
 * Fixed plans mapping for Mogibaa AI credits top-up.
 * DO NOT take amount/credits from client.
 * Always use this server-side mapping to prevent tampering.
 */

const PLANS = {
  // ===== Image Plans =====
  img_baby_300: {
    planId: "img_baby_300",
    category: "image",
    amountINR: 300,
    credits: 600,
    label: "₹300 • 600 Image Credits",
  },
  img_starter_900: {
    planId: "img_starter_900",
    category: "image",
    amountINR: 900,
    credits: 1800,
    label: "₹900 • 1800 Image Credits",
  },
  img_pro_1800: {
    planId: "img_pro_1800",
    category: "image",
    amountINR: 1800,
    credits: 3700,
    label: "₹1800 • 3700 Image Credits",
  },

  // ===== Video Plans =====
  vid_baby_500: {
    planId: "vid_baby_500",
    category: "video",
    amountINR: 500,
    credits: 500,
    label: "₹500 • 500 Video Credits",
  },
  vid_starter_900: {
    planId: "vid_starter_900",
    category: "video",
    amountINR: 900,
    credits: 1000,
    label: "₹900 • 1000 Video Credits",
  },
  vid_pro_1800: {
    planId: "vid_pro_1800",
    category: "video",
    amountINR: 1800,
    credits: 2100,
    label: "₹1800 • 2100 Video Credits",
  },
};

module.exports = PLANS;
