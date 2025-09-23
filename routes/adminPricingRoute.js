// routes/adminPricingRoute.js
// Admin-only pricing management endpoints with auditing

const express = require('express');
const router = express.Router();
const { db, admin } = require('../utils/firebaseUtils');
const { getAuth } = require('firebase-admin/auth');
const pricingService = require('../services/pricingService');

// --- Strict admin guard (ID token via Authorization: Bearer <idToken>)
async function requireAdmin(req, res, next) {
    try {
        // Optional internal secret for CI/testing
        try {
            const s = String(process.env.ADMIN_INTERNAL_SECRET || '');
            const p = String(req.headers['x-internal-admin-secret'] || req.headers['x-internal-secret'] || '');
            if (s && p && s === p) {
                const uid = String(req.headers['x-uid'] || req.query?.uid || req.body?.uid || 'internal-admin');
                req.adminUid = uid;
                return next();
            }
        } catch (_) { }

        const hdr = String(req.headers['authorization'] || '').trim();
        if (!hdr.toLowerCase().startsWith('bearer ')) return res.status(401).json({ ok: false, error: 'MISSING_ID_TOKEN' });
        const idToken = hdr.split(' ')[1];
        const decoded = await getAuth().verifyIdToken(idToken);
        const uid = decoded?.uid;
        if (!uid) return res.status(401).json({ ok: false, error: 'TOKEN_VERIFY_FAILED' });
        if (decoded.admin === true || (decoded.customClaims && decoded.customClaims.admin === true)) { req.adminUid = uid; return next(); }
        // Firestore allowlist
        try {
            const cfg = await db.collection('config').doc('admins').get();
            if (cfg.exists) {
                const d = cfg.data() || {};
                const uids = Array.isArray(d.uids) ? d.uids.map(String) : [];
                const emails = Array.isArray(d.emails) ? d.emails.map((e) => String(e).toLowerCase()) : [];
                if (uids.includes(uid) || (decoded.email && emails.includes(String(decoded.email).toLowerCase()))) { req.adminUid = uid; return next(); }
            }
        } catch { }
        // ENV allowlist
        const envUids = (process.env.ADMIN_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
        const envEmails = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (envUids.includes(uid) || (decoded.email && envEmails.includes(String(decoded.email).toLowerCase()))) { req.adminUid = uid; return next(); }
        return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    } catch (e) {
        return res.status(401).json({ ok: false, error: 'ADMIN_AUTH_FAILED' });
    }
}

// --- Helpers
function nonEmptyStr(v) { return typeof v === 'string' && v.trim().length > 0; }
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }
function lower(v) { return (v == null ? '' : String(v)).trim().toLowerCase(); }
async function audit(action, actor, before, after, meta = {}) {
    try {
        await db.collection('pricingAudits').add({
            action, actor, before: before || null, after: after || null, meta: meta || null,
            at: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (_) { }
}

// GET /api/admin/pricing/summary
router.get('/pricing/summary', requireAdmin, async (req, res) => {
    try {
        const cfg = await pricingService.getPublicPricing();
        // Also include plans and coupons raw-ish snapshot for admin convenience
        const plansSnap = await db.collection('plans').limit(500).get().catch(() => ({ empty: true, forEach: () => { } }));
        const plans = [];
        if (!plansSnap.empty) plansSnap.forEach((d) => plans.push({ id: d.id, ...d.data() }));
        const couponsSnap = await db.collection('coupons').limit(500).get().catch(() => ({ empty: true, forEach: () => { } }));
        const coupons = [];
        if (!couponsSnap.empty) couponsSnap.forEach((d) => coupons.push({ code: d.id, ...d.data() }));
        const rawCfgDoc = await db.collection('config').doc('pricing').get().catch(() => null);
        const rawConfig = rawCfgDoc && rawCfgDoc.exists ? rawCfgDoc.data() : {};
        return res.json({ ok: true, models: cfg.models, img2img: cfg.img2img, plans, coupons, config: rawConfig });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'LOAD_FAILED', message: e?.message });
    }
});

// POST /api/admin/models/:key  body: {label?, enabled?, type?, pricePerImage?, minCost?, maxCost?}
router.post('/models/:key', requireAdmin, express.json(), async (req, res) => {
    try {
        const key = lower(req.params.key);
        if (!key) return res.status(400).json({ ok: false, error: 'MISSING_MODEL_KEY' });
        const ref = db.collection('models').doc(key);
        const before = await ref.get().then(s => (s.exists ? s.data() : null)).catch(() => null);
        const p = req.body || {};
        const patch = {};
        if (nonEmptyStr(p.label)) patch.label = String(p.label).trim();
        if (typeof p.enabled !== 'undefined') patch.enabled = Boolean(p.enabled);
        if (nonEmptyStr(p.type)) patch.type = lower(p.type);
        if (p.pricePerImage != null && Number.isFinite(toNum(p.pricePerImage))) patch.pricePerImage = toNum(p.pricePerImage);
        if (p.minCost != null && Number.isFinite(toNum(p.minCost))) patch.minCost = toNum(p.minCost);
        if (p.maxCost != null && Number.isFinite(toNum(p.maxCost))) patch.maxCost = toNum(p.maxCost);
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        patch.updatedBy = req.adminUid;
        if (Object.keys(patch).length <= 2) return res.status(400).json({ ok: false, error: 'NO_FIELDS' });
        await ref.set(patch, { merge: true });
        await audit('model_upsert', req.adminUid, { id: key, ...before }, { id: key, ...patch });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'MODEL_SAVE_FAILED', message: e?.message });
    }
});

// POST /api/admin/plans/:id  body: arbitrary plan fields (validated basics)
router.post('/plans/:id', requireAdmin, express.json(), async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'MISSING_PLAN_ID' });
        const plan = req.body || {};
        if (plan.price != null && !Number.isFinite(toNum(plan.price))) return res.status(400).json({ ok: false, error: 'INVALID_PRICE' });
        if (plan.credits != null && !Number.isFinite(toNum(plan.credits))) return res.status(400).json({ ok: false, error: 'INVALID_CREDITS' });
        const ref = db.collection('plans').doc(id);
        const before = await ref.get().then(s => (s.exists ? s.data() : null)).catch(() => null);
        const patch = { ...plan, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.adminUid };
        await ref.set(patch, { merge: true });
        await audit('plan_upsert', req.adminUid, { id, ...before }, { id, ...patch });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'PLAN_SAVE_FAILED', message: e?.message });
    }
});

// POST /api/admin/coupons/:code  body: fields to create/update
router.post('/coupons/:code', requireAdmin, express.json(), async (req, res) => {
    try {
        const code = String(req.params.code || '').trim().toUpperCase();
        if (!code) return res.status(400).json({ ok: false, error: 'MISSING_CODE' });
        const body = req.body || {};
        const ref = db.collection('coupons').doc(code);
        const before = await ref.get().then(s => (s.exists ? s.data() : null)).catch(() => null);
        const patch = { ...body };
        if (patch.discountType) patch.discountType = patch.discountType === 'percent' ? 'percent' : 'flat';
        if (patch.amount != null) {
            const n = toNum(patch.amount);
            if (!Number.isFinite(n) || n < 0) return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' });
            patch.amount = n;
        }
        if (typeof patch.active !== 'undefined') patch.active = Boolean(patch.active);
        // Optional fields: validFrom, validTo, scopes[], restrictedModels[], restrictedPlans[], maxRedemptions
        if (patch.scopes && !Array.isArray(patch.scopes)) return res.status(400).json({ ok: false, error: 'INVALID_SCOPES' });
        if (patch.restrictedModels && !Array.isArray(patch.restrictedModels)) return res.status(400).json({ ok: false, error: 'INVALID_RESTRICTED_MODELS' });
        if (patch.restrictedPlans && !Array.isArray(patch.restrictedPlans)) return res.status(400).json({ ok: false, error: 'INVALID_RESTRICTED_PLANS' });
        if (patch.maxRedemptions != null) {
            const m = Number.parseInt(patch.maxRedemptions, 10);
            if (!Number.isFinite(m) || m < 0) return res.status(400).json({ ok: false, error: 'INVALID_MAX_REDEMPTIONS' });
            patch.maxRedemptions = m;
        }
        patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        patch.updatedBy = req.adminUid;
        await ref.set(patch, { merge: true });
        await audit('coupon_upsert', req.adminUid, { code, ...before }, { code, ...patch });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'COUPON_SAVE_FAILED', message: e?.message });
    }
});

// POST /api/admin/config/pricing  body: merged into config/pricing doc
router.post('/config/pricing', requireAdmin, express.json(), async (req, res) => {
    try {
        const ref = db.collection('config').doc('pricing');
        const before = await ref.get().then(s => (s.exists ? s.data() : null)).catch(() => null);
        const body = req.body || {};
        // Lightweight validation on common keys
        if (body.img2img && body.img2img.defaultPerImage != null) {
            const n = toNum(body.img2img.defaultPerImage);
            if (!Number.isFinite(n) || n < 0) return res.status(400).json({ ok: false, error: 'INVALID_DEFAULT_PER_IMAGE' });
        }
        const patch = { ...body, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.adminUid };
        await ref.set(patch, { merge: true });
        // Bust in-memory cache in pricingService
        try { await pricingService.loadConfig(true); } catch (_) { }
        await audit('config_pricing_update', req.adminUid, before, patch);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'CONFIG_SAVE_FAILED', message: e?.message });
    }
});

// POST /api/admin/pricing/refresh  -> invalidate server cache
router.post('/pricing/refresh', requireAdmin, async (req, res) => {
    try {
        // bump version in config/pricing to notify clients via usePricing()
        try {
            const { db, admin } = require('../utils/firebaseUtils');
            const ref = db.collection('config').doc('pricing');
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                const prev = snap.exists ? (snap.data() || {}) : {};
                const v = (typeof prev.version === 'number' ? prev.version : 0) + 1;
                tx.set(ref, { version: v, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            });
        } catch (_) { }
        await pricingService.loadConfig(true);
        await audit('pricing_cache_refresh', req.adminUid, null, { ok: true });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'REFRESH_FAILED', message: e?.message });
    }
});

// Alias per spec: POST /api/admin/pricing/flush
router.post('/pricing/flush', requireAdmin, async (req, res) => {
    try {
        const { db, admin } = require('../utils/firebaseUtils');
        const ref = db.collection('config').doc('pricing');
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const prev = snap.exists ? (snap.data() || {}) : {};
            const v = (typeof prev.version === 'number' ? prev.version : 0) + 1;
            tx.set(ref, { version: v, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        });
        try { await pricingService.loadConfig(true); } catch { }
        await audit('pricing_cache_flush', req.adminUid, null, { ok: true });
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'FLUSH_FAILED', message: e?.message });
    }
});

module.exports = router;
