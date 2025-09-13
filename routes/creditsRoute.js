// routes/creditsRoute.js
// Credits API
//   GET    /api/credits                   -> { image, video }
//   POST   /api/credits/spend             -> { ok:true, credits:{ image, video } }
//   POST   /api/credits/add               -> { ok:true, credits:{ image, video } }   (used by payments/webhooks)
//
// Requirements:
//   - Header: x-uid  (Firebase UID; keep as-is for now)
//   - services/creditsService.js must export: getUserCredits(uid), spendCredit(uid, category, qty), addCredits(uid, category, qty, meta?)

const express = require('express');
const router = express.Router();

// Services (already present in your repo per earlier files)
const creditsService = require('../services/creditsService');

// Helpers
const noStore = (res) => res.set('Cache-Control', 'no-store');
const ok = (v) => typeof v !== 'undefined' && v !== null;

function readUid(req) {
  // prefer header; allow query fallback for internal tests
  const h = (req.headers['x-uid'] || req.headers['X-Uid'] || '').toString().trim();
  const q = (req.query.uid || '').toString().trim();
  return h || q || '';
}

function parseQty(v, def = 1) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function normalizeCategory(c, def = 'image') {
  c = (c || def).toString().toLowerCase();
  return c === 'video' ? 'video' : 'image';
}

function safeCreditsShape(obj) {
  const image = Number.parseInt(obj?.image ?? obj?.credits_image ?? 0, 10) || 0;
  const video = Number.parseInt(obj?.video ?? obj?.credits_video ?? 0, 10) || 0;
  return { image, video };
}

// -------- GET /api/credits --------
router.get('/', async (req, res) => {
  noStore(res);
  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: 'Missing x-uid' });

  try {
    const data = await creditsService.getUserCredits(uid);
    const credits = safeCreditsShape(data);
    return res.json(credits);
  } catch (err) {
    // Never crash; return zeros to keep UI alive
    return res.status(200).json({ image: 0, video: 0 });
  }
});

// -------- POST /api/credits/spend --------
router.post('/spend', express.json(), async (req, res) => {
  noStore(res);
  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: 'Missing x-uid' });

  const category = normalizeCategory(req.body?.category);
  const qty = parseQty(req.body?.qty, 1);

  try {
    // Many implementations return boolean; to be robust we always fetch fresh credits after spend.
    const result = await creditsService.spendCredit(uid, category, qty);
    // If service returns false / not enough, try to surface message:
    if (result === false) {
      return res.status(400).json({ message: `Not enough ${category} credits` });
    }
    const fresh = await creditsService.getUserCredits(uid);
    const credits = safeCreditsShape(fresh);
    return res.json({ ok: true, credits });
  } catch (err) {
    const msg = err?.message || 'Unable to spend credits';
    // If service throws insufficient error, prefer 400
    const code = /insufficient|not enough/i.test(msg) ? 400 : 500;
    return res.status(code).json({ message: msg });
  }
});

// -------- POST /api/credits/add --------
// Used by successful payment verification / webhooks to credit the user.
// body: { category: 'image'|'video', qty: number, meta?: object }
router.post('/add', express.json(), async (req, res) => {
  noStore(res);
  const uid = readUid(req);
  if (!uid) return res.status(401).json({ message: 'Missing x-uid' });

  const category = normalizeCategory(req.body?.category);
  const qty = parseQty(req.body?.qty, 0);
  const meta = ok(req.body?.meta) ? req.body.meta : undefined;

  if (qty <= 0) return res.status(400).json({ message: 'qty must be > 0' });

  try {
    await creditsService.addCredits(uid, category, qty, meta);
    const fresh = await creditsService.getUserCredits(uid);
    const credits = safeCreditsShape(fresh);
    return res.json({ ok: true, credits });
  } catch (err) {
    const msg = err?.message || 'Unable to add credits';
    return res.status(500).json({ message: msg });
  }
});

module.exports = router;
