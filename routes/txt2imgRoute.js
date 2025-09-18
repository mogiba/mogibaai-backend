const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { MODELS, getModel, ENV } = require('../config/replicateModels');
const rpl = require('../services/replicateService');
const jobs = require('../services/jobService');
const credits = require('../services/creditsService');
const { db, admin } = require('../utils/firebaseUtils');
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
        // If client sends uid, it must match signer (defensive)
        const bodyUid = req.body && typeof req.body.uid !== 'undefined' ? String(req.body.uid) : null;
        if (bodyUid && bodyUid !== uid) {
            return res.status(403).json({ ok: false, error: 'UID_MISMATCH' });
        }
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

        // Create imageGenerations/{jobId} document with required fields (rules: uid must equal auth.uid)
        try {
            const genRef = db.collection('imageGenerations').doc(job._id);
            await genRef.set({
                uid,
                prompt: replicateInput.prompt || '',
                modelKey,
                size: (replicateInput.size === '4K') ? '4K' : '2K',
                aspectRatio: replicateInput.aspect_ratio || 'match_input_image',
                max_images: replicateInput.max_images || 1,
                creditsSpent: cost,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: false });
        } catch (e) {
            return res.status(403).json({ ok: false, error: 'IMAGE_GENERATION_DOC_CREATE_FAILED', message: e?.message });
        }

        // Placeholder docs in users/{uid}/images/{jobId}-{i} (status: pending)
        try {
            const numOutputs = Number(replicateInput.max_images || requestedImages || 1);
            const ar = replicateInput.aspect_ratio || 'match_input_image';
            const sz = (replicateInput.size === '4K') ? '4K' : '2K';
            const previewDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" fill="#1f2237"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#9aa4d6" font-size="14" font-family="Arial, Helvetica, sans-serif">Generating…</text></svg>`);
            const batch = db.batch();
            for (let i = 0; i < numOutputs; i++) {
                const ref = db.collection('users').doc(uid).collection('images').doc(`${job._id}-${i}`);
                batch.set(ref, {
                    uid,
                    jobId: job._id,
                    index: i,
                    tool: 'text2img',
                    modelKey,
                    aspectRatio: ar,
                    size: sz,
                    caption: '',
                    tags: [],
                    visibility: 'private',
                    status: 'pending',
                    downloadURL: null,
                    storagePath: null,
                    previewURL: previewDataUrl,
                    outputsCount: numOutputs,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });
            }
            await batch.commit();
            console.log('[txt2img] placeholders created', { uid, jobId: job._id, count: numOutputs });
        } catch (e) {
            // Do not fail the request on placeholder error; continue
            console.warn('[txt2img] placeholder creation failed', e && e.message);
        }
        const base = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '');
        let webhook = null;
        if (base && base.startsWith('https://')) {
            webhook = `${base}/api/webhooks/replicate?uid=${encodeURIComponent(uid)}&jobId=${encodeURIComponent(job._id)}`;
        }
        console.log('[txt2img] job created', { jobId: job._id, webhook });
        if (typeof rpl.setReplicateLogContext === 'function') rpl.setReplicateLogContext(() => ({ uid, jobId: job._id, modelKey, modelVersion: model.version }));
        // Use pinned version from config; do not resolve dynamically
        const useVersion = model.version;
        const { data, latencyMs, attemptsUsed } = await rpl.createPrediction({ version: useVersion, input: replicateInput, webhook, webhook_events_filter: ['completed'] });
        await jobs.updateJob(job._id, { status: 'running', provider: 'replicate', providerPredictionId: data.id, metrics: { createLatencyMs: latencyMs, replicateCreateAttempts: attemptsUsed }, modelResolvedVersion: useVersion });
        try { await db.collection('imageGenerations').doc(job._id).set({ replicatePredictionId: data.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch { }
        // Detach finalizer worker (polls replicate and stores outputs)
        try {
            const { finalizePrediction } = require('../workers/finalizer');
            setImmediate(() => finalizePrediction({ uid, jobId: job._id, predId: data.id }).catch(console.error));
            console.log('[txt2img] queued finalizer', { predId: data.id });
        } catch (e) {
            console.warn('[txt2img] finalizer enqueue failed', e && e.message);
        }
        logJSON('txt2img.queued', { uid, jobId: job._id, model: modelKey, version: useVersion });
        return res.json({ ok: true, jobId: job._id, predId: data.id, env: ENV });
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
    let out = Array.isArray(j.output) ? j.output : [];
    // Normalize: ensure each item is an object with storagePath/filename/contentType/bytes
    out = out.map((it) => {
        if (typeof it === 'string') return { storagePath: it, filename: it.split('/').pop(), contentType: null, bytes: null };
        const o = it || {};
        return { storagePath: o.storagePath || null, filename: o.filename || (o.storagePath ? String(o.storagePath).split('/').pop() : null), contentType: o.contentType || null, bytes: o.bytes || null };
    });
    return res.json({ ok: true, job: { ...j, output: out } });
});

router.delete('/txt2img/:id', requireAuth, async (req, res) => {
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    if (j.provider === 'replicate' && j.providerPredictionId) await rpl.cancelPrediction(j.providerPredictionId).catch(() => null);
    await jobs.updateJob(j._id, { status: 'canceled' });
    res.json({ ok: true });
});

module.exports = router;
