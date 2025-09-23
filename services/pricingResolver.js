const { db } = require('../utils/firebaseUtils');
let pricingService = null;
try { pricingService = require('./pricingService'); } catch (_) { pricingService = null; }

function toNumber(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}
function toInt(v, d = 0) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
}
function str(v) {
    return (v == null ? '' : String(v)).trim();
}
function nowMs() { return Date.now(); }

async function fetchConfigPricing() {
    try {
        const s = await db.collection('config').doc('pricing').get();
        const d = s.exists ? (s.data() || {}) : {};
        return {
            currency: str(d.currency || 'INR') || 'INR',
            taxRatePct: toNumber(d.taxRatePct, 18),
            defaultImageCost: toNumber(d.defaultImageCost, toNumber(d?.img2img?.defaultPerImage, 10) || 10),
            raw: d,
        };
    } catch {
        return { currency: 'INR', taxRatePct: 18, defaultImageCost: 10, raw: {} };
    }
}

async function fetchModel(modelKey) {
    modelKey = str(modelKey).toLowerCase();
    if (!modelKey) return null;
    try {
        const s = await db.collection('models').doc(modelKey).get();
        if (s.exists) {
            const d = s.data() || {};
            return {
                key: modelKey,
                label: str(d.label || modelKey),
                enabled: d.enabled !== false,
                type: str(d.type || ''),
                pricePerImage: toNumber(d.pricePerImage, NaN),
                minCost: toNumber(d.minCost, 1),
                maxCost: toNumber(d.maxCost, 200),
                raw: d,
            };
        }
    } catch { }
    return null;
}

function normalizeCouponDoc(d, id) {
    if (!d) return null;
    const code = str(d.code || id || '').toUpperCase();
    const type = str(d.type || d.discountType || '').toLowerCase();
    const value = toNumber(d.value != null ? d.value : d.amount, 0);
    const isActive = d.isActive != null ? !!d.isActive : (d.active !== false);
    const appliesTo = Array.isArray(d.appliesTo) ? d.appliesTo.map((x) => str(x).toLowerCase())
        : (Array.isArray(d.scopes) ? d.scopes.map((x) => str(x).toLowerCase()) : []);
    const restrictedPlans = Array.isArray(d.restrictedPlans) ? d.restrictedPlans.map(str) : [];
    const restrictedModels = Array.isArray(d.restrictedModels) ? d.restrictedModels.map((x) => str(x).toLowerCase()) : [];
    const maxRedemptions = toInt(d.maxRedemptions, null);
    const redeemed = toInt(d.redeemed, 0);
    const vf = d.validFrom || d.valid_from || d.validFromAt || null;
    const vt = d.validUntil || d.validTo || d.valid_until || null;
    const tsToMs = (t) => t ? (typeof t.toDate === 'function' ? t.toDate().getTime() : new Date(t).getTime()) : null;
    return {
        code, type: (type === 'percent' ? 'percent' : 'flat'), value,
        isActive, appliesTo, restrictedPlans, restrictedModels,
        maxRedemptions, redeemed,
        validFromMs: tsToMs(vf), validUntilMs: tsToMs(vt), raw: d,
    };
}

async function fetchCoupon(code) {
    const c = str(code).toUpperCase();
    if (!c) return null;
    try {
        const s = await db.collection('coupons').doc(c).get();
        if (!s.exists) return null;
        return normalizeCouponDoc(s.data(), s.id);
    } catch {
        return null;
    }
}

function isCouponApplicable(cpn, ctx) {
    if (!cpn || !cpn.isActive) return { ok: false, reason: 'INACTIVE' };
    const t = nowMs();
    if (cpn.validFromMs && t < cpn.validFromMs) return { ok: false, reason: 'NOT_STARTED' };
    if (cpn.validUntilMs && t > cpn.validUntilMs) return { ok: false, reason: 'EXPIRED' };
    if (cpn.maxRedemptions != null && cpn.redeemed >= cpn.maxRedemptions) return { ok: false, reason: 'MAX_REDEEMED' };
    const scopeOk = !cpn.appliesTo || cpn.appliesTo.length === 0 || cpn.appliesTo.includes(str(ctx.scope || '').toLowerCase());
    if (!scopeOk) return { ok: false, reason: 'OUT_OF_SCOPE' };
    if (Array.isArray(cpn.restrictedModels) && cpn.restrictedModels.length) {
        if (!cpn.restrictedModels.includes(str(ctx.modelKey || '').toLowerCase())) return { ok: false, reason: 'MODEL_NOT_ALLOWED' };
    }
    if (Array.isArray(cpn.restrictedPlans) && cpn.restrictedPlans.length) {
        if (!cpn.restrictedPlans.includes(str(ctx.planId || ''))) return { ok: false, reason: 'PLAN_NOT_ALLOWED' };
    }
    return { ok: true };
}

function applyCouponIfAny(amount, code, ctx = {}) {
    const base = toNumber(amount, 0);
    const out = { baseAmount: base, finalAmount: base, discountAmount: 0, applied: false, coupon: null, reason: null };
    if (!code) return out;
    const cpn = ctx.couponNorm || null;
    if (!cpn) return { ...out, reason: 'NOT_FOUND' };
    const chk = isCouponApplicable(cpn, ctx);
    if (!chk.ok) return { ...out, reason: chk.reason };
    let disc = 0;
    if (cpn.type === 'percent') disc = Math.max(0, Math.round((base * cpn.value) / 100));
    else disc = Math.max(0, Math.round(cpn.value));
    const final = Math.max(0, base - disc);
    return { baseAmount: base, finalAmount: final, discountAmount: disc, applied: disc > 0, coupon: cpn, reason: null };
}

async function resolvePrice({ modelKey, operation, userPlanId, couponCode, context = {} } = {}) {
    const cfg = await fetchConfigPricing();
    const model = await fetchModel(modelKey);
    const op = str(operation || (model?.type || 'txt2img')).toLowerCase();
    // 1) Prefer explicit base supplied by caller (e.g., pre-resolved per-quality/size price)
    let base = toNumber(context.base, NaN);
    // 2) Else prefer admin-configured pricing from config/pricing via pricingService
    if (!Number.isFinite(base)) {
        try {
            if (pricingService) {
                if (op === 'txt2img') {
                    base = await pricingService.getTxt2ImgPrice({ modelKey, options: { size: context.size, quality: context.quality } });
                } else if (op === 'img2img') {
                    base = await pricingService.getImg2ImgPrice({ modelKey });
                }
            }
        } catch (_) { /* fall through */ }
    }
    // 3) Else fall back to legacy models collection or global defaults
    if (!Number.isFinite(base)) {
        const legacy = toNumber(model?.pricePerImage, NaN);
        if (Number.isFinite(legacy)) base = legacy;
        else base = (op === 'img2img') ? toNumber(cfg.raw?.img2img?.defaultPerImage, 20) : cfg.defaultImageCost;
    }
    // Clamp if model defines bounds
    const minC = Number.isFinite(toNumber(model?.minCost, NaN)) ? toNumber(model?.minCost, NaN) : null;
    const maxC = Number.isFinite(toNumber(model?.maxCost, NaN)) ? toNumber(model?.maxCost, NaN) : null;
    if (Number.isFinite(minC)) base = Math.max(minC, base);
    if (Number.isFinite(maxC)) base = Math.min(maxC, base);
    const notes = [];
    if (model && model.enabled === false) notes.push('MODEL_DISABLED');
    const scope = op === 'txt2img' ? 'models' : (op === 'img2img' ? 'models' : op);
    let couponApplied = null;
    let final = base;
    if (couponCode) {
        const coupon = await fetchCoupon(couponCode);
        const applied = applyCouponIfAny(base, couponCode, { couponNorm: coupon, scope, modelKey, planId: userPlanId, ...context });
        final = applied.finalAmount;
        if (applied.applied) {
            couponApplied = { code: coupon.code, type: coupon.type, value: coupon.value, discount: applied.discountAmount };
        } else if (applied.reason) {
            notes.push(`COUPON_${applied.reason}`);
        }
    }
    return { pricePerImageFinal: final, base, couponApplied, notes, currency: cfg.currency };
}

async function markCouponRedeemed(code, inc = 1) {
    const id = str(code).toUpperCase();
    if (!id) return { ok: false };
    const ref = db.collection('coupons').doc(id);
    await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) throw new Error('NOT_FOUND');
        const d = s.data() || {};
        const max = d.maxRedemptions != null ? toInt(d.maxRedemptions, 0) : null;
        const cur = toInt(d.redeemed, 0);
        if (max != null && cur >= max) throw new Error('MAX_REDEEMED');
        tx.set(ref, { redeemed: cur + Math.max(1, inc) }, { merge: true });
    });
    return { ok: true };
}

module.exports = {
    resolvePrice,
    applyCouponIfAny,
    fetchCoupon,
    markCouponRedeemed,
};
