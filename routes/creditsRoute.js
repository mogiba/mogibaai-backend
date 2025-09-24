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

// firebase admin (to verify ID tokens when Authorization header provided)
const { admin } = require('../utils/firebaseUtils');

// Services (already present in your repo per earlier files)
const creditsService = require('../services/creditsService');
const { queryUserLedger, getUserBalances } = require('../services/creditsLedgerService');
const { Parser } = require('json2csv');

// Helpers
const noStore = (res) => res.set('Cache-Control', 'no-store');
const ok = (v) => typeof v !== 'undefined' && v !== null;

async function readUid(req) {
  // prefer header; allow query fallback for internal tests
  const h = (req.headers['x-uid'] || req.headers['X-Uid'] || '').toString().trim();
  if (h) return h;
  const q = (req.query.uid || '').toString().trim();
  if (q) return q;

  // Fallback: try Authorization: Bearer <idToken>
  try {
    const auth = (req.headers['authorization'] || req.headers['Authorization'] || '').toString();
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.split(' ')[1];
      if (token) {
        try {
          const decoded = await admin.auth().verifyIdToken(token);
          if (decoded && decoded.uid) return decoded.uid;
        } catch (e) {
          // token invalid or verification failed -> fallthrough to return empty
        }
      }
    }
  } catch (e) {
    // ignore any errors and return empty
  }

  return '';
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
  const uid = await readUid(req);
  if (!uid) return res.status(401).json({ message: 'Missing uid or Authorization' });

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
  const uid = await readUid(req);
  if (!uid) return res.status(401).json({ message: 'Missing uid or Authorization' });

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
  const uid = await readUid(req);
  if (!uid) return res.status(401).json({ message: 'Missing uid or Authorization' });

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

// -------- GET /api/credits/ledger --------
router.get('/ledger', async (req, res) => {
  const uid = await readUid(req);
  if (!uid) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  const { type, direction, source, from, to, cursor, limit } = req.query || {};
  try {
    const f = {};
    if (type) f.type = String(type).toLowerCase();
    if (direction) f.direction = String(direction).toLowerCase();
    if (source) f.source = String(source);
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) f.from = d; else console.warn('[ledger] ignoring invalid from date param', from);
    }
    if (to) {
      const d2 = new Date(to);
      if (!isNaN(d2.getTime())) f.to = d2; else console.warn('[ledger] ignoring invalid to date param', to);
    }
    const lim = Math.min(200, Math.max(1, parseInt(limit || '50', 10)));
    const { entries, nextCursor } = await queryUserLedger({ uid, filters: f, limit: lim, cursor: cursor || null });
    const balances = await getUserBalances(uid).catch(() => ({ image: 0, video: 0 }));
    return res.json({ ok: true, entries, nextCursor, balances });
  } catch (e) {
    console.error('[ledger] query failed', { uid, error: e?.message, stack: e?.stack });
    return res.status(500).json({ ok: false, error: 'LEDGER_QUERY_FAILED', message: e?.message });
  }
});

// -------- GET /api/credits/export.csv --------
router.get('/export.csv', async (req, res) => {
  const uid = await readUid(req);
  if (!uid) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  try {
    let cursor = null; const rows = []; let page = 0; const limit = 500; // export up to 10k
    while (page < 25) { // safety
      const { entries, nextCursor } = await queryUserLedger({ uid, limit, cursor });
      rows.push(...entries);
      if (!nextCursor) break; cursor = nextCursor; page += 1;
    }
    const fields = ['createdAt', 'type', 'direction', 'amount', 'balance_after', 'source', 'reason', 'jobId', 'paymentId', 'invoiceId', 'idempotencyKey'];
    const data = rows.map(r => ({ ...r, createdAt: r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : null }));
    const parser = new Parser({ fields });
    const csv = parser.parse(data);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="credits_ledger.csv"');
    return res.send(csv);
  } catch (e) { return res.status(500).json({ ok: false, error: 'EXPORT_FAILED', message: e?.message }); }
});
