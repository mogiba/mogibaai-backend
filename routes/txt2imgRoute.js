const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { MODELS, getModel, ENV } = require('../config/replicateModels');
const rpl = require('../services/replicateService');
const jobs = require('../services/jobService');
const credits = require('../services/creditsService');
const { db } = require('../utils/firebaseUtils');
const { moderateInput, logModerationEvent } = require('../lib/moderation');

const router = express.Router();

// Per-uid and per-IP throttles
const RATE = { windowMs: 60 * 60 * 1000, max: Number(process.env.TXT2IMG_RATELIMIT_PER_HOUR || 20) };
const rateMap = new Map();
function rateLimit(uid) {
    const now = Date.now();
    const rec = rateMap.get(uid) || { start: now, count: 0 };
    if (now - rec.start >= RATE.windowMs) { rec.start = now; rec.count = 0; }
    rec.count += 1; rateMap.set(uid, rec);
    const retryAfter = Math.ceil((rec.start + RATE.windowMs - now) / 1000);
    return { limited: rec.count > RATE.max, retryAfter };
}
const IP_RATE = { windowMs: 60 * 1000, max: Number(process.env.TXT2IMG_RATELIMIT_PER_MIN_IP || 60) };
const ipMap = new Map();
function ipLimit(ip) {
    const now = Date.now();
    const rec = ipMap.get(ip) || { start: now, count: 0 };
    if (now - rec.start >= IP_RATE.windowMs) { rec.start = now; rec.count = 0; }
    rec.count += 1; ipMap.set(ip, rec);
    const retryAfter = Math.ceil((rec.start + IP_RATE.windowMs - now) / 1000);
    return { limited: rec.count > IP_RATE.max, retryAfter };
}

function logJSON(event, data) { try { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })); } catch { } }

router.post('/txt2img', requireAuth, async (req, res) => {
    const uid = req.uid;
    const started = Date.now();
    try {
        // throttles
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
        const ipr = ipLimit(ip);
        if (ipr.limited) { res.setHeader('Retry-After', String(ipr.retryAfter)); return res.status(429).json({ ok: false, error: 'RATE_LIMITED_IP', retryAfter: ipr.retryAfter }); }
        const rl = rateLimit(uid);
        if (rl.limited) { res.setHeader('Retry-After', String(rl.retryAfter)); return res.status(429).json({ ok: false, error: 'RATE_LIMITED', retryAfter: rl.retryAfter }); }

        const body = req.body || {};
        const modelKey = String(body.modelKey || body.model || '').trim();
        // Always use pinned version from config (ignore client-provided version)
        let version = '';
        // Support multiple input shapes: inputs|input|options
        const inputs = body.inputs || body.input || body.options || {};
        const rootPrompt = String(body.prompt || '').trim();
        if (!modelKey) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'modelKey required' });
        // model allowlist check (version will be resolved dynamically for seedream4)
        if (MODELS[modelKey]) version = MODELS[modelKey].version;
        const model = getModel(modelKey, version || MODELS[modelKey]?.version);
        if (!model) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'model/version not allowed' });

        // Moderation on prompt
        const v = moderateInput({ prompt: (inputs.prompt || rootPrompt || ''), negative_prompt: '', width: inputs.width, height: inputs.height });
        if (!v.ok) { await logModerationEvent({ uid, jobId: null, code: v.code, reason: v.reason, prompt: inputs.prompt || '' }); return res.status(422).json({ ok: false, error: 'MODERATION_BLOCKED', reason: v.reason }); }

        // Pricing and holds: per-image pricing for SeeDream-4 with only 2K/4K allowed
        let pricePerImage = Number(model.cost || 1);
        let requestedImages = 1;
        let cost = pricePerImage; // fallback

        // Map inputs for seedream4 (others can be added later)
        let replicateInput = {};
        if (modelKey === 'seedream4') {
            if (Object.prototype.hasOwnProperty.call(body, 'aspect')) {
                return res.status(422).json({ ok: false, error: 'INVALID_INPUT', message: 'Use aspect_ratio, not aspect' });
            }
            // Strict builder + validation
            const { buildSeedream4Input } = require('../services/replicateService');
            try {
                const promptStr = String(inputs.prompt || rootPrompt || '').slice(0, 500);
                replicateInput = buildSeedream4Input({
                    prompt: promptStr,
                    size: body.size || inputs.size || inputs.resolution,
                    width: body.width || inputs.width,
                    height: body.height || inputs.height,
                    aspect_ratio: body.aspect_ratio || inputs.aspect_ratio,
                    max_images: body.max_images || body.numImages || inputs.max_images,
                    image_input: inputs.image_input,
                    sequential_image_generation: body.sequential_image_generation || inputs.sequential_image_generation || 'disabled',
                });
            } catch (ve) {
                return res.status(422).json({ ok: false, error: 'INVALID_INPUT', message: ve?.message });
            }
            // Pricing per image for 2K/4K/non-custom
            const finalSize = replicateInput.size;
            pricePerImage = (finalSize === '4K') ? 48 : 24; // treat anything not 4K as 2K pricing
            requestedImages = replicateInput.max_images;
            cost = pricePerImage * requestedImages;
        } else {
            return res.status(400).json({ ok: false, error: 'MODEL_NOT_SUPPORTED' });
        }

        // Verify credits sufficient to place hold
        try {
            const have = await credits.getUserCredits(uid);
            const haveImg = Number(have.image || 0);
            if (cost > 0 && haveImg < cost) {
                try { await db.collection('apiEvents').add({ type: 'LOW_CREDITS', uid, createdAt: new Date(), need: cost, have: haveImg }); } catch { }
                return res.status(402).json({ ok: false, error: 'LOW_CREDITS' });
            }
        } catch { return res.status(500).json({ ok: false, error: 'SERVICE_TEMPORARILY_UNAVAILABLE' }); }

        // Create job and enqueue prediction
        const job = await jobs.createJob({ userId: uid, modelKey, model, version, input: replicateInput, cost, pricePerImage, requestedImages });
        const webhook = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '') + '/api/replicate/webhook';
        if (typeof rpl.setReplicateLogContext === 'function') rpl.setReplicateLogContext(() => ({ uid, jobId: job._id, modelKey, modelVersion: model.version }));
        // Use pinned version from config; do not resolve dynamically
        const useVersion = model.version;
        const { data, latencyMs, attemptsUsed } = await rpl.createPrediction({ version: useVersion, input: replicateInput, webhook, webhook_events_filter: ['completed'] });
        await jobs.updateJob(job._id, { status: 'running', provider: 'replicate', providerPredictionId: data.id, metrics: { createLatencyMs: latencyMs, replicateCreateAttempts: attemptsUsed }, modelResolvedVersion: useVersion });
        logJSON('txt2img.queued', { uid, jobId: job._id, model: modelKey, version: useVersion });
        return res.json({ ok: true, jobId: job._id, env: ENV });
    } catch (e) {
        const code = e?.status || e?.response?.status || 500;
        const body = e?.body || e?.response?.data || e?.message;
        logJSON('txt2img.error', { code, body });
        return res.status(code).json({ ok: false, error: code === 422 ? 'UPSTREAM_VALIDATION' : 'SERVICE_TEMPORARILY_UNAVAILABLE', message: body });
    } finally {
        logJSON('txt2img.request.done', { dt: Date.now() - started });
    }
});

router.get('/txt2img/:id', requireAuth, async (req, res) => {
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, job: j });
});

router.delete('/txt2img/:id', requireAuth, async (req, res) => {
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    if (j.provider === 'replicate' && j.providerPredictionId) await rpl.cancelPrediction(j.providerPredictionId).catch(() => null);
    await jobs.updateJob(j._id, { status: 'canceled' });
    res.json({ ok: true });
});

module.exports = router;
