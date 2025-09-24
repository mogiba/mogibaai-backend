// services/pricingService.js
// Centralized pricing + coupons with Firestore-backed config and safe defaults.
// Public can read; only admins should write via routes.

const { db, admin } = require('../utils/firebaseUtils');

// Default pricing (kept in sync with routes for non-breaking changes)
const DEFAULTS = Object.freeze({
    // Safe default per-image for Img2Img when config is missing
    img2img: { defaultPerImage: 30 },
    models: {
        // SDXL: standard=30, HD=60
        sdxl: { txt2img: { default: 30, standard: 30, hd: 60 }, enabled: true },
        // Nano-Banana: standard=20, HD=40; Img2Img default=30 (legacy key retained)
        'nano-banana': { txt2img: { default: 20, standard: 20, hd: 40 }, i2i: 30, img2img: { default: 30 }, enabled: true },
        // SeeDream-4: keep 2K/4K defaults
        seedream4: { txt2img: { size2K: 24, size4K: 48 }, enabled: true },
    },
});

let __cache = { at: 0, data: null };
const TTL_MS = 60 * 1000; // 60s cache

function now() { return Date.now(); }

function deepMerge(base, over) {
    if (!over || typeof over !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k of Object.keys(over)) {
        const bv = base ? base[k] : undefined;
        const ov = over[k];
        if (ov && typeof ov === 'object' && !Array.isArray(ov)) out[k] = deepMerge(bv || {}, ov);
        else out[k] = ov;
    }
    return out;
}

async function loadConfig(force = false) {
    if (!force && __cache.data && now() - __cache.at < TTL_MS) return __cache.data;
    let data = DEFAULTS;
    try {
        const doc = await db.collection('config').doc('pricing').get();
        if (doc.exists) {
            const d = doc.data() || {};
            data = deepMerge(DEFAULTS, d);
        }
    } catch (_) { /* keep defaults */ }
    __cache = { at: now(), data };
    return data;
}

function cacheInfo() {
    const ageMs = __cache && __cache.at ? (now() - __cache.at) : null;
    const ttlMs = TTL_MS;
    const stale = ageMs == null ? true : ageMs > ttlMs;
    return { ageMs, ttlMs, stale };
}

function coerceInt(v, def = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

// Compute price for txt2img based on model + options
async function getTxt2ImgPrice({ modelKey, options = {} } = {}) {
    const cfg = await loadConfig();
    const m = cfg.models[modelKey] || {};
    // seedream4 special case by size bucket
    if (modelKey === 'seedream4') {
        const size = String(options.size || '').toUpperCase();
        const twoK = coerceInt(m?.txt2img?.size2K ?? m?.t2i?.k2, DEFAULTS.models.seedream4.txt2img.size2K);
        const fourK = coerceInt(m?.txt2img?.size4K ?? m?.t2i?.k4, DEFAULTS.models.seedream4.txt2img.size4K);
        return size === '4K' ? fourK : twoK; // treat non-4K as 2K pricing
    }
    // quality-specific pricing: prefer explicit standard/hd, fallback to default/double
    const std = coerceInt(m?.txt2img?.standard ?? m?.t2i?.std ?? m?.txt2img?.default, DEFAULTS.models[modelKey]?.txt2img?.standard ?? DEFAULTS.models[modelKey]?.txt2img?.default ?? 1);
    const hd = coerceInt(m?.txt2img?.hd ?? m?.t2i?.hd, (std > 0 ? std * 2 : DEFAULTS.models[modelKey]?.txt2img?.hd ?? 2));
    const q = String(options.quality || '').toLowerCase() === 'hd' ? 'hd' : 'standard';
    const chosen = q === 'hd' ? hd : std;
    return chosen > 0 ? chosen : 1;
}

// Compute price for img2img per image
async function getImg2ImgPrice({ modelKey, options = {} } = {}) {
    const cfg = await loadConfig();
    const m = (modelKey && cfg.models[modelKey]) ? cfg.models[modelKey] : null;
    if (modelKey === 'seedream4') {
        const size = String(options.size || '').toUpperCase();
        const twoK = coerceInt(m?.i2i?.size2K, 20);
        const fourK = coerceInt(m?.i2i?.size4K, 40);
        return size === '4K' ? fourK : twoK;
    }
    // Prefer new schema: numeric i2i at model level
    if (m && typeof m.i2i !== 'undefined') {
        const v = Number(m.i2i);
        if (Number.isFinite(v) && v >= 0) return v;
    }
    // Back-compat: older schema kept img2img.default
    if (m && m.img2img && Number.isFinite(Number(m.img2img.default))) {
        const v = Number(m.img2img.default);
        if (v > 0) return v;
    }
    return coerceInt(cfg.img2img?.defaultPerImage, DEFAULTS.img2img.defaultPerImage);
}

// Public surface for UI
async function getPublicPricing() {
    const cfg = await loadConfig();
    return {
        img2img: { defaultPerImage: coerceInt(cfg.img2img?.defaultPerImage, DEFAULTS.img2img.defaultPerImage) },
        models: {
            sdxl: {
                txt2img: {
                    default: coerceInt(cfg.models?.sdxl?.txt2img?.default ?? cfg.models?.sdxl?.t2i?.std, DEFAULTS.models.sdxl.txt2img.default),
                    standard: coerceInt(cfg.models?.sdxl?.txt2img?.standard ?? cfg.models?.sdxl?.t2i?.std, DEFAULTS.models.sdxl.txt2img.standard),
                    hd: coerceInt(cfg.models?.sdxl?.txt2img?.hd ?? cfg.models?.sdxl?.t2i?.hd, DEFAULTS.models.sdxl.txt2img.hd),
                }, enabled: cfg.models?.sdxl?.enabled !== false
            },
            'nano-banana': {
                txt2img: {
                    default: coerceInt(cfg.models?.['nano-banana']?.txt2img?.default ?? cfg.models?.['nano-banana']?.t2i?.std, DEFAULTS.models['nano-banana'].txt2img.default),
                    standard: coerceInt(cfg.models?.['nano-banana']?.txt2img?.standard ?? cfg.models?.['nano-banana']?.t2i?.std, DEFAULTS.models['nano-banana'].txt2img.standard),
                    hd: coerceInt(cfg.models?.['nano-banana']?.txt2img?.hd ?? cfg.models?.['nano-banana']?.t2i?.hd, DEFAULTS.models['nano-banana'].txt2img.hd),
                },
                // Expose both for compatibility; primary is i2i (number)
                i2i: Number.isFinite(Number(cfg.models?.['nano-banana']?.i2i)) ? Number(cfg.models?.['nano-banana']?.i2i) : coerceInt(cfg.models?.['nano-banana']?.img2img?.default, DEFAULTS.models['nano-banana'].img2img.default),
                img2img: { default: coerceInt(cfg.models?.['nano-banana']?.img2img?.default, DEFAULTS.models['nano-banana'].img2img.default) },
                enabled: cfg.models?.['nano-banana']?.enabled !== false,
            },
            seedream4: {
                txt2img: {
                    size2K: coerceInt(cfg.models?.seedream4?.txt2img?.size2K ?? cfg.models?.seedream4?.t2i?.k2, DEFAULTS.models.seedream4.txt2img.size2K),
                    size4K: coerceInt(cfg.models?.seedream4?.txt2img?.size4K ?? cfg.models?.seedream4?.t2i?.k4, DEFAULTS.models.seedream4.txt2img.size4K),
                },
                i2i: {
                    size2K: coerceInt(cfg.models?.seedream4?.i2i?.size2K, 20),
                    size4K: coerceInt(cfg.models?.seedream4?.i2i?.size4K, 40),
                },
                enabled: cfg.models?.seedream4?.enabled !== false,
            },
        },
        updatedAt: cfg.updatedAt || null,
    };
}

// Admin writes
async function updatePricingModels({ models, img2img, actor } = {}) {
    const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (models && typeof models === 'object') patch.models = models;
    if (img2img && typeof img2img === 'object') patch.img2img = img2img;
    if (actor) patch.updatedBy = actor;
    await db.collection('config').doc('pricing').set(patch, { merge: true });
    __cache = { at: 0, data: null }; // bust cache
    return loadConfig(true);
}

// Coupons (public list + admin upsert)
function isCouponActive(doc) {
    if (!doc || doc.active === false) return false;
    const nowMs = Date.now();
    const vf = doc.validFrom ? (doc.validFrom.toDate ? doc.validFrom.toDate().getTime() : new Date(doc.validFrom).getTime()) : null;
    const vt = doc.validTo ? (doc.validTo.toDate ? doc.validTo.toDate().getTime() : new Date(doc.validTo).getTime()) : null;
    if (vf && nowMs < vf) return false;
    if (vt && nowMs > vt) return false;
    return true;
}

async function listCouponsPublic() {
    const snap = await db.collection('coupons').where('active', '==', true).limit(200).get().catch(() => ({ empty: true, forEach: () => { } }));
    const items = [];
    if (!snap.empty) snap.forEach((d) => {
        const x = d.data() || {};
        const pub = {
            code: String(x.code || d.id).toUpperCase(),
            discountType: x.discountType === 'percent' ? 'percent' : 'flat',
            amount: Number(x.amount || 0) || 0,
            scopes: x.scopes || null,
            validFrom: x.validFrom || null,
            validTo: x.validTo || null,
            active: x.active !== false,
        };
        if (isCouponActive(x)) items.push(pub);
    });
    return { ok: true, items };
}

async function upsertCoupon({ code, discountType, amount, active = true, validFrom, validTo, scopes, actor }) {
    code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('code required');
    const ref = db.collection('coupons').doc(code);
    const payload = {
        code,
        discountType: discountType === 'percent' ? 'percent' : 'flat',
        amount: Number(amount || 0) || 0,
        active: Boolean(active),
        scopes: scopes || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: actor || null,
    };
    if (validFrom) payload.validFrom = validFrom;
    if (validTo) payload.validTo = validTo;
    await ref.set(payload, { merge: true });
    return { ok: true };
}

module.exports = {
    DEFAULTS,
    loadConfig,
    cacheInfo,
    getTxt2ImgPrice,
    getImg2ImgPrice,
    getPublicPricing,
    updatePricingModels,
    listCouponsPublic,
    upsertCoupon,
};
