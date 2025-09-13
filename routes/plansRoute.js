// routes/plansRoute.js
// GET /api/plans?type=topup|subscription&category=image|video
// - Firestore/External utils లేకపోయినా పనిచేసేలా safe fallbacks.
// - ఫలితం ఎల్లప్పుడూ { plans: [...] } రూపంలో వస్తుంది.

const express = require('express');
const router = express.Router();

/* ---------------- In-memory cache (5m) ---------------- */
const TTL = 5 * 60 * 1000;
const cache = {
  topup: { image: { t: 0, data: [] }, video: { t: 0, data: [] } },
  subscription: { t: 0, data: [] }
};
const now = () => Date.now();

/* ---------------- Fallback plans (works even without DB) ---------------- */
const FALLBACK_PLANS = {
  topup: {
    image: [
      { id: 'img-300',   title: '₹300 • 600 Image Credits',  price: 300,  credits: 600,  category: 'image' },
      { id: 'img-900',   title: '₹900 • 1800 Image Credits', price: 900,  credits: 1800, category: 'image' },
      { id: 'img-1800',  title: '₹1800 • 3700 Image Credits',price: 1800, credits: 3700, category: 'image' }
    ],
    video: [
      { id: 'vid-500',   title: '₹500 • 500 Video Credits',  price: 500,  credits: 500,  category: 'video' },
      { id: 'vid-900',   title: '₹900 • 1000 Video Credits', price: 900,  credits: 1000, category: 'video' },
      { id: 'vid-1800',  title: '₹1800 • 2100 Video Credits',price: 1800, credits: 2100, category: 'video' }
    ]
  },
  subscription: [
    {
      id: 'sub-starter',
      title: 'Starter',
      price: 99,
      features: ['200 Image Credits', '8 Video Credits', 'All AI Tools Access', 'Basic Support']
    },
    {
      id: 'sub-pro',
      title: 'Pro',
      price: 999,
      features: ['2,500 Image Credits', '100 Video Credits', 'Priority Support', 'Unlimited Project Save']
    },
    {
      id: 'sub-ultra',
      title: 'Ultra',
      price: 1999,
      features: ['6,000 Image Credits', '300 Video Credits', 'Dedicated Support', 'All Features Unlocked']
    }
  ]
};

/* --------- Optional external source: utils/plans.js (if you have one) --------- */
// If ../utils/plans exports either:
//   - getPlans({ type, category }) -> Promise<Array>
//   - or an object with keys { topup: { image:[], video:[] }, subscription:[] }
let externalPlans = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  externalPlans = require('../utils/plans'); // optional; ok if not present
} catch (_) {
  externalPlans = null;
}

/* ---------------- Helpers ---------------- */
async function loadFromExternal(type, category) {
  if (!externalPlans) return null;

  // Function shape
  if (typeof externalPlans.getPlans === 'function') {
    try {
      const arr = await externalPlans.getPlans({ type, category });
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }

  // Object shape
  try {
    if (type === 'subscription' && Array.isArray(externalPlans.subscription)) {
      return externalPlans.subscription;
    }
    if (
      type === 'topup' &&
      externalPlans.topup &&
      Array.isArray(externalPlans.topup[category])
    ) {
      return externalPlans.topup[category];
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function getPlans(type = 'topup', category = 'image') {
  type = String(type || 'topup').toLowerCase();
  category = String(category || 'image').toLowerCase();

  // Cache check
  if (type === 'topup') {
    const slot = cache.topup[category];
    if (slot && slot.t && now() - slot.t < TTL && Array.isArray(slot.data) && slot.data.length) {
      return slot.data;
    }
  } else if (type === 'subscription') {
    const slot = cache.subscription;
    if (slot.t && now() - slot.t < TTL && Array.isArray(slot.data) && slot.data.length) {
      return slot.data;
    }
  }

  // 1) Try external utils/plans.js (if present)
  let data = await loadFromExternal(type, category);

  // 2) Fallback to local constants
  if (!Array.isArray(data) || data.length === 0) {
    if (type === 'subscription') data = FALLBACK_PLANS.subscription;
    else data = FALLBACK_PLANS.topup[category] || [];
  }

  // Cache & return
  if (type === 'topup') {
    cache.topup[category] = { t: now(), data };
  } else {
    cache.subscription = { t: now(), data };
  }
  return data;
}

/* ---------------- Route ---------------- */
router.get('/', async (req, res) => {
  try {
    const type = (req.query.type || 'topup').toLowerCase();
    const category = (req.query.category || 'image').toLowerCase();

    const plans = await getPlans(type, category);

    // Uniform response shape
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ plans });
  } catch (err) {
    // Never crash; always return safe fallback
    return res.status(200).json({ plans: [] });
  }
});

module.exports = router;
