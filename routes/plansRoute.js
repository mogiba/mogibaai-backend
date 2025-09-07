// routes/plansRoute.js
const express = require('express');
const router = express.Router();
const { db } = require('../utils/firebaseUtils');

let FALLBACK_PLANS = [];
try {
  FALLBACK_PLANS = require('../utils/plans');
} catch (e) {
  console.warn('plansRoute: utils/plans not found or failed to load. Fallback empty.');
}

router.get('/plans', async (req, res) => {
  try {
    // prefer Firestore collection 'plans'
    const coll = db.collection('plans');
    const snap = await coll.get();
    if (!snap.empty) {
      const list = [];
      snap.forEach(doc => {
        const d = doc.data();
        if (!d.planId) d.planId = doc.id;
        list.push(d);
      });
      return res.json({ ok: true, source: 'firestore', plans: list });
    }

    // fallback
    if (Array.isArray(FALLBACK_PLANS)) {
      return res.json({ ok: true, source: 'fallback', plans: FALLBACK_PLANS });
    } else if (FALLBACK_PLANS && typeof FALLBACK_PLANS === 'object') {
      const arr = Object.keys(FALLBACK_PLANS).map(k => Object.assign({ planId: k }, FALLBACK_PLANS[k]));
      return res.json({ ok: true, source: 'fallback', plans: arr });
    }

    return res.json({ ok: true, source: 'empty', plans: [] });
  } catch (err) {
    console.error('plansRoute error:', err);
    if (Array.isArray(FALLBACK_PLANS)) return res.json({ ok: true, source: 'fallback', plans: FALLBACK_PLANS });
    return res.status(500).json({ ok: false, error: 'PLANS_FETCH_FAILED' });
  }
});

module.exports = router;
