const express = require('express');
const router = express.Router();
const { db, admin } = require('../utils/firebaseUtils');
const { getPublicPricing, updatePricingModels, listCouponsPublic, upsertCoupon } = require('../services/pricingService');
const { getAuth } = require('firebase-admin/auth');
// Unified: GET /api/pricing  -> maps to schema described in spec
router.get('/', async (req, res) => {
    try {
        const pub = await getPublicPricing();
        // Read version from raw config doc if present
        let version = 1;
        try {
            const cfgDoc = await db.collection('config').doc('pricing').get();
            if (cfgDoc.exists) {
                const d = cfgDoc.data() || {};
                if (typeof d.version === 'number') version = d.version;
            }
        } catch (_) { }
        const models = {
            sdxl: {
                enabled: pub.models?.sdxl?.enabled !== false,
                t2i: {
                    std: Number(pub.models?.sdxl?.txt2img?.standard || pub.models?.sdxl?.txt2img?.default || 0) || 0,
                    hd: Number(pub.models?.sdxl?.txt2img?.hd || 0) || 0,
                },
            },
            'nano-banana': {
                enabled: pub.models?.['nano-banana']?.enabled !== false,
                t2i: {
                    std: Number(pub.models?.['nano-banana']?.txt2img?.standard || pub.models?.['nano-banana']?.txt2img?.default || 0) || 0,
                    hd: Number(pub.models?.['nano-banana']?.txt2img?.hd || 0) || 0,
                },
                i2i: Number((pub.models?.['nano-banana']?.i2i != null ? pub.models?.['nano-banana']?.i2i : (pub.models?.['nano-banana']?.img2img?.default))) || Number(pub.img2img?.defaultPerImage || 0) || 0,
            },
            seedream4: {
                enabled: pub.models?.seedream4?.enabled !== false,
                t2i: {
                    k2: Number(pub.models?.seedream4?.txt2img?.size2K || 0) || 0,
                    k4: Number(pub.models?.seedream4?.txt2img?.size4K || 0) || 0,
                },
            },
            'kling-video': {
                enabled: pub.models?.['kling-video']?.enabled !== false,
                video: {
                    '720p': {
                        s5: Number(pub.models?.['kling-video']?.video?.['720p']?.s5 || 0) || 0,
                        s10: Number(pub.models?.['kling-video']?.video?.['720p']?.s10 || 0) || 0,
                    },
                    '1080p': {
                        s5: Number(pub.models?.['kling-video']?.video?.['1080p']?.s5 || 0) || 0,
                        s10: Number(pub.models?.['kling-video']?.video?.['1080p']?.s10 || 0) || 0,
                    },
                },
            },
        };
        const out = { ok: true, version, models, plans: {}, coupons: {} };
        const noCache = (String(req.query.noCache || '') === '1') || (typeof req.query.ts !== 'undefined');
        if (noCache) res.set('Cache-Control', 'no-store, max-age=0'); else res.set('Cache-Control', 'public, max-age=60');
        return res.json(out);
    } catch (e) {
        return res.status(200).json({ ok: true, version: 1, models: {}, plans: {}, coupons: {} });
    }
});

async function requireAdmin(req, res, next) {
    try {
        const authHeader = String(req.headers['authorization'] || '').trim();
        if (!authHeader.toLowerCase().startsWith('bearer ')) {
            return res.status(401).json({ ok: false, error: 'MISSING_ID_TOKEN' });
        }
        const idToken = authHeader.split(' ')[1];
        const decoded = await getAuth().verifyIdToken(idToken);
        const uid = decoded?.uid;
        if (!uid) return res.status(401).json({ ok: false, error: 'TOKEN_VERIFY_FAILED' });
        if (decoded.admin === true || (decoded.customClaims && decoded.customClaims.admin === true)) { req.adminUid = uid; return next(); }
        const cfgDoc = await db.collection('config').doc('admins').get().catch(() => null);
        if (cfgDoc && cfgDoc.exists) {
            const cfg = cfgDoc.data() || {};
            const uids = Array.isArray(cfg.uids) ? cfg.uids.map(String) : [];
            const emails = Array.isArray(cfg.emails) ? cfg.emails.map((e) => String(e).toLowerCase()) : [];
            if (uids.includes(uid) || (decoded.email && emails.includes(String(decoded.email).toLowerCase()))) { req.adminUid = uid; return next(); }
        }
        const envAdmins = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
        const envEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (envAdmins.includes(uid) || (decoded.email && envEmails.includes(String(decoded.email).toLowerCase()))) { req.adminUid = uid; return next(); }
        return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    } catch (e) { return res.status(401).json({ ok: false, error: 'ADMIN_AUTH_FAILED' }); }
}

// Public: GET /api/pricing/public
router.get('/public', async (req, res) => {
    try {
        const data = await getPublicPricing();
        const noCache = (String(req.query.noCache || '') === '1') || (typeof req.query.ts !== 'undefined');
        if (noCache) {
            res.set('Cache-Control', 'no-store, max-age=0');
        } else {
            res.set('Cache-Control', 'public, max-age=60');
        }
        return res.json({ ok: true, pricing: data });
    } catch (e) {
        return res.status(200).json({ ok: true, pricing: await getPublicPricing().catch(() => ({ models: {}, img2img: { defaultPerImage: 20 } })) });
    }
});

// Public: GET /api/pricing/coupons
router.get('/coupons', async (req, res) => {
    try {
        const out = await listCouponsPublic();
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(out);
    } catch (e) {
        return res.json({ ok: true, items: [] });
    }
});

// Admin: GET /api/admin/pricing/models (same router, but protect)
router.get('/admin/models', requireAdmin, async (req, res) => {
    try {
        const data = await getPublicPricing();
        return res.json({ ok: true, pricing: data });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'LOAD_FAILED' });
    }
});

// Admin: PUT /api/admin/pricing/models  body: { models?, img2img? }
router.put('/admin/models', requireAdmin, express.json(), async (req, res) => {
    try {
        const { models, img2img } = req.body || {};
        const cfg = await updatePricingModels({ models, img2img, actor: req.adminUid });
        return res.json({ ok: true, pricing: cfg });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'SAVE_FAILED', message: e?.message });
    }
});

// Admin: PUT /api/admin/pricing/coupons  body: { code, discountType, amount, active, validFrom?, validTo?, scopes? }
router.put('/admin/coupons', requireAdmin, express.json(), async (req, res) => {
    try {
        const { code, discountType, amount, active, validFrom, validTo, scopes } = req.body || {};
        const payload = { code, discountType, amount, active, scopes };
        if (validFrom) payload.validFrom = validFrom;
        if (validTo) payload.validTo = validTo;
        const out = await upsertCoupon({ ...payload, actor: req.adminUid });
        return res.json(out);
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'COUPON_SAVE_FAILED', message: e?.message });
    }
});

module.exports = router;
