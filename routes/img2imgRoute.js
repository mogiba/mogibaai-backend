const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const requireAuth = require('../middlewares/requireAuth');
const { MODELS, getModel, FEATURE_REPLICATE_IMG2IMG, ENV } = require('../config/replicateModels');
const { safeFetchHead } = require('../lib/safeUrl');
const { moderateInput, logModerationEvent } = require('../lib/moderation');
const rpl = require('../services/replicateService');
const { resolveLatestVersion } = require('../services/replicateService');
const jobs = require('../services/jobService');
const credits = require('../services/creditsService');
const { db, admin, getSignedUrlForPath } = require('../utils/firebaseUtils');
const { moderateImageBuffer } = require('../lib/moderation');
const { uploadInputBufferToFirebase } = require('../services/outputStore');

const router = express.Router();
// Only allow this model for Image-to-Image
const ALLOWED_IMG2IMG_MODELS = new Set(['nano-banana', 'nanobanana']);
// Route-level CORS (permissive) to avoid dev preflight issues
router.options('/img2img', cors({ origin: true, credentials: true }));
router.options('/img2img/:id', cors({ origin: true, credentials: true }));
router.options('/img2img/:id/file', cors({ origin: true, credentials: true }));
router.options('/img2img/:id/share', cors({ origin: true, credentials: true }));
router.options('/replicate/models', cors({ origin: true, credentials: true }));
// In-memory rate limiter (per-uid, 20 req/hour)
const RATE = { windowMs: 60 * 60 * 1000, max: Number(process.env.IMG2IMG_RATELIMIT_PER_HOUR || 20) };
const rateMap = new Map(); // uid -> { start, count }
function rateLimit(uid) {
    const now = Date.now();
    const rec = rateMap.get(uid) || { start: now, count: 0 };
    if (now - rec.start >= RATE.windowMs) { rec.start = now; rec.count = 0; }
    rec.count += 1;
    rateMap.set(uid, rec);
    const remaining = Math.max(RATE.max - rec.count, 0);
    const retryAfter = Math.ceil((rec.start + RATE.windowMs - now) / 1000);
    return { limited: rec.count > RATE.max, remaining, retryAfter };
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Per-IP limiter (sliding window naive)
const IP_RATE = { windowMs: 60 * 1000, max: Number(process.env.IMG2IMG_RATELIMIT_PER_MIN_IP || 60) };
const ipMap = new Map(); // ip -> { start, count }
function ipLimit(ip) {
    const now = Date.now();
    const rec = ipMap.get(ip) || { start: now, count: 0 };
    if (now - rec.start >= IP_RATE.windowMs) { rec.start = now; rec.count = 0; }
    rec.count += 1;
    ipMap.set(ip, rec);
    const remaining = Math.max(IP_RATE.max - rec.count, 0);
    const retryAfter = Math.ceil((rec.start + IP_RATE.windowMs - now) / 1000);
    return { limited: rec.count > IP_RATE.max, remaining, retryAfter };
}

function logJSON(event, data) {
    try { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })); } catch { }
}

router.get('/admin/replicate/models', requireAuth, async (req, res) => {
    // Basic admin gate: allow a specific admin email/uid via env
    const adminUid = process.env.ADMIN_UID || '';
    if (!req.uid || (adminUid && req.uid !== adminUid)) return res.status(403).json({ ok: false, error: 'not_admin' });
    res.json({ ok: true, env: ENV, models: MODELS });
});

// Public models for clients (enabled only)
router.get('/replicate/models', requireAuth, async (req, res) => {
    const list = Object.entries(MODELS)
        .filter(([key, v]) => v && v.enabled && ALLOWED_IMG2IMG_MODELS.has(key))
        .map(([key, v]) => ({ key, label: v.label, version: v.version, cost: v.cost }));
    res.json({ ok: true, env: ENV, models: list });
});

// Admin mutate models (toggle, version) – persisted later; for now, in-memory
router.post('/admin/replicate/models', requireAuth, async (req, res) => {
    const adminUid = process.env.ADMIN_UID || '';
    if (!req.uid || (adminUid && req.uid !== adminUid)) return res.status(403).json({ ok: false, error: 'not_admin' });
    const { key, enabled, version } = req.body || {};
    if (!key || !MODELS[key]) return res.status(404).json({ ok: false, error: 'model_not_found' });
    if (typeof enabled !== 'undefined') MODELS[key].enabled = Boolean(enabled);
    if (typeof version === 'string' && version.trim()) MODELS[key].version = version.trim();
    // persist snapshot to Firestore config
    try { await db.collection('config').doc('replicateModels').set({ updatedAt: new Date(), models: MODELS }, { merge: true }); } catch { }
    res.json({ ok: true, model: MODELS[key] });
});

router.post('/img2img', requireAuth, upload.any(), async (req, res) => {
    try {
        const ct0 = (req.headers['content-type'] || '').toLowerCase();
        const files0 = Array.isArray(req.files) ? req.files.map(f => ({ field: f.fieldname, type: f.mimetype, bytes: (typeof f.size === 'number' ? f.size : (f.buffer ? f.buffer.length : null)), name: f.originalname })) : [];
        const bodyKeys0 = Object.keys(req.body || {});
        const inputStr0 = req.body && typeof req.body.input === 'string' ? req.body.input : '';
        const promptFlat0 = req.body && req.body.prompt ? String(req.body.prompt).slice(0, 140) : null;
        logJSON('img2img.rx', { uid: req.uid || null, featureFlag: FEATURE_REPLICATE_IMG2IMG, ct: ct0, bodyKeys: bodyKeys0, inputLen: inputStr0 ? inputStr0.length : 0, promptFlat: promptFlat0, files: files0 });
    } catch (_) { }
    if (!FEATURE_REPLICATE_IMG2IMG) return res.status(503).json({ ok: false, error: 'feature_disabled' });
    const started = Date.now();
    try {
        const uid = req.uid;
        const requestId = req.headers['x-request-id'] || Math.random().toString(36).slice(2);
        // Per-IP throttle first
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';
        const ipr = ipLimit(ip);
        if (ipr.limited) {
            res.setHeader('Retry-After', String(ipr.retryAfter));
            try { await db.collection('apiEvents').add({ type: 'RATE_LIMITED_IP', uid, ip, retryAfter: ipr.retryAfter, createdAt: new Date() }); } catch { }
            return res.status(429).json({ ok: false, error: 'RATE_LIMITED_IP', retryAfter: ipr.retryAfter });
        }
        // Rate limit
        const rl = rateLimit(uid);
        if (rl.limited) {
            res.setHeader('Retry-After', String(rl.retryAfter));
            try { await db.collection('apiEvents').add({ type: 'RATE_LIMITED', uid, retryAfter: rl.retryAfter, createdAt: new Date() }); } catch { }
            return res.status(429).json({ ok: false, error: 'RATE_LIMITED', retryAfter: rl.retryAfter });
        }
        const contentType = (req.headers['content-type'] || '').toLowerCase();
        logJSON('img2img.request.start', { uid: req.uid, ct: contentType, fields: Object.keys(req.body || {}), filesCount: Array.isArray(req.files) ? req.files.length : (req.file ? 1 : 0) });
        const isMultipart = contentType.startsWith('multipart/form-data');
        const isJSON = contentType.startsWith('application/json');
        if (!isMultipart && !isJSON) {
            return res.status(415).json({ ok: false, error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use multipart/form-data for uploads or application/json with input.image URL' });
        }
        let body = {};
        if (isMultipart) {
            // Accept fields: model or modelKey, version, prompt, strength, width, height, and optional JSON 'input'
            body.model = req.body.model || req.body.modelKey;
            body.version = req.body.version;
            // Optional flat fields
            const promptStrFlat = String(req.body.prompt || '').trim();
            const strengthFlat = req.body.strength != null ? Number(req.body.strength) : undefined;
            const widthFlat = req.body.width != null ? Number(req.body.width) : undefined;
            const heightFlat = req.body.height != null ? Number(req.body.height) : undefined;
            // Optional nested JSON 'input'
            let inputJson = {};
            try { if (req.body.input) inputJson = JSON.parse(req.body.input); } catch { inputJson = {}; }
            body.input = {
                ...inputJson,
                prompt: (promptStrFlat || inputJson.prompt || '').toString(),
                strength: (typeof strengthFlat === 'number' ? strengthFlat : inputJson.strength),
                width: (typeof widthFlat === 'number' ? widthFlat : inputJson.width),
                height: (typeof heightFlat === 'number' ? heightFlat : inputJson.height),
            };
            try { body.postprocess = req.body.postprocess ? JSON.parse(req.body.postprocess) : {}; } catch { body.postprocess = {}; }
        } else {
            body = req.body || {};
        }

        try {
            const mk0 = String(body.model || body.modelKey || '').trim();
            const v0 = String(body.version || '').trim();
            const inp0 = body.input || {};
            const summ = { modelKey: mk0, version: v0, input: { prompt: (inp0.prompt ? String(inp0.prompt).slice(0, 140) : ''), strength: inp0.strength, width: inp0.width, height: inp0.height } };
            const filesSumm = Array.isArray(req.files) ? req.files.map(f => ({ field: f.fieldname, type: f.mimetype, bytes: (typeof f.size === 'number' ? f.size : (f.buffer ? f.buffer.length : null)) })) : [];
            logJSON('img2img.parsed', { ...summ, files: filesSumm });
        } catch (_) { }

        let modelKey = String(body.model || body.modelKey || '').trim();
        if (!ALLOWED_IMG2IMG_MODELS.has(modelKey)) {
            logJSON('img2img.invalid', { reason: 'model_not_allowed', modelKey });
            return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'model not allowed' });
        }
        if (modelKey === 'nanobanana') modelKey = 'nano-banana';
        let version = String(body.version || '').trim();
        const input = body.input || {};
        const postprocess = body.postprocess || {};

        if (!modelKey) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'model required' });
        // Default to allowlisted version if omitted
        if (!version && MODELS[modelKey]) version = MODELS[modelKey].version;
        const model = getModel(modelKey, version);
        if (!model) {
            logJSON('img2img.invalid', { reason: 'model_version_not_allowed', modelKey, version });
            return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'model/version not allowed' });
        }
        // Validate prompt mandatory
        const promptStr = String(input.prompt || '').trim();
        if (!promptStr) {
            logJSON('img2img.invalid', { reason: 'prompt_required' });
            return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'prompt required' });
        }

        // Resolve input image
        let storagePath = String(body.storagePath || input.storagePath || '').trim();
        let fileBuf = null; let fileType = null;
        // Accept either multipart file (field name `image` primary, fallback to `file`) or JSON storagePath
        let uf = null;
        if (req.file) uf = req.file;
        if (!uf && Array.isArray(req.files)) {
            uf = req.files.find(f => f.fieldname === 'image') || req.files.find(f => f.fieldname === 'file') || null;
        }
        if (uf && Buffer.isBuffer(uf.buffer)) { fileBuf = uf.buffer; fileType = uf.mimetype || 'image/jpeg'; }
        if (!storagePath && fileBuf) {
            try { const up = await uploadInputBufferToFirebase({ uid, buffer: fileBuf, contentType: fileType }); storagePath = up.storagePath; } catch { return res.status(503).json({ ok: false, error: 'SERVICE_TEMPORARILY_UNAVAILABLE', message: 'Failed to prepare input image' }); }
        }
        if (!storagePath) {
            logJSON('img2img.invalid', { reason: 'no_image', hasFile: !!uf, files: (req.files || []).map(f => f.fieldname) });
            return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'image file or storagePath required' });
        }

        // Signed URL for Replicate
        let signedUrlObj;
        try { signedUrlObj = await getSignedUrlForPath(storagePath, { ttlMs: 60 * 60 * 1000 }); } catch (e) { return res.status(500).json({ ok: false, error: 'SIGNED_URL_FAILED', message: e?.message }); }

        // HEAD validation via safe fetch
        const head = await safeFetchHead(signedUrlObj.url);
        if (!head.contentType.startsWith('image/')) return res.status(415).json({ ok: false, error: 'UNSUPPORTED_MEDIA_TYPE', message: 'input.image must be an image URL' });
        if (head.contentLength > 10 * 1024 * 1024) {
            return res.status(413).json({ ok: false, error: 'PAYLOAD_TOO_LARGE', message: 'Image larger than 10MB' });
        }
        const inputSizeKB = Math.round((head.contentLength || 0) / 1024);

        // Moderation
        const verdict = moderateInput({ prompt: input.prompt || '', negative_prompt: input.negative_prompt || '', width: input.width, height: input.height, imageMeta: {}, imageUrl: null });
        if (!verdict.ok) {
            logJSON('moderation.block', { uid, model: modelKey, code: verdict.code, reason: verdict.reason });
            await logModerationEvent({ uid, jobId: null, code: verdict.code, reason: verdict.reason, prompt: input.prompt || '', imageUrl: null });
            return res.status(422).json({ ok: false, error: 'MODERATION_BLOCKED', reason: verdict.reason });
        }
        // If a file was uploaded, optionally run image moderation hook (currently disabled)
        if (req.file && Buffer.isBuffer(req.file.buffer)) {
            try {
                const imgVerdict = await moderateImageBuffer(req.file.buffer);
                if (imgVerdict && imgVerdict.ok === false) {
                    await logModerationEvent({ uid, jobId: null, code: imgVerdict.code || 'IMAGE_BLOCKED', reason: imgVerdict.reason || 'Image moderation blocked', imageUrl: 'upload' });
                    return res.status(422).json({ ok: false, error: 'MODERATION_BLOCKED', reason: imgVerdict.reason || 'Image blocked' });
                }
            } catch (_) { /* soft-fail moderation */ }
        }

        // Credits: fixed 20 per single image for img2img nano-banana
        const pricePerImage = 20;
        const requestedImages = 1;
        const cost = pricePerImage * requestedImages;
        try {
            const have = await credits.getUserCredits(uid);
            const haveImg = Number(have.image || 0);
            if (cost > 0 && haveImg < cost) {
                try { await db.collection('apiEvents').add({ type: 'LOW_CREDITS', uid, createdAt: new Date() }); } catch { }
                return res.status(402).json({ ok: false, error: 'LOW_CREDITS', message: 'Insufficient image credits' });
            }
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
        }

        // Build replicate input (strict keys): prompt, image, strength (0..1), optional width/height
        let strength = Number.isFinite(Number(input.strength)) ? Number(input.strength) : 0.65;
        if (!Number.isFinite(strength)) strength = 0.65;
        strength = Math.min(1, Math.max(0, strength));
        let width = Number.isFinite(Number(input.width)) ? Number(input.width) : undefined;
        let height = Number.isFinite(Number(input.height)) ? Number(input.height) : undefined;
        if (Number.isFinite(width)) width = Math.max(64, Math.min(4096, Math.floor(width)));
        else width = undefined;
        if (Number.isFinite(height)) height = Math.max(64, Math.min(4096, Math.floor(height)));
        else height = undefined;
        const replicateInput = { prompt: promptStr, image: signedUrlObj.url, strength };
        if (width) replicateInput.width = width;
        if (height) replicateInput.height = height;

        // Create job with pricing metadata
        const job = await jobs.createJob({ userId: uid, modelKey, model, version, input: replicateInput, cost, pricePerImage, requestedImages });

        // imageGenerations doc
        try {
            await db.collection('imageGenerations').doc(job._id).set({
                uid,
                prompt: promptStr,
                modelKey,
                size: (width && height) ? `${width}x${height}` : 'match_input_image',
                aspectRatio: 'match_input_image',
                max_images: 1,
                creditsSpent: cost,
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: false });
        } catch (e) {
            return res.status(403).json({ ok: false, error: 'IMAGE_GENERATION_DOC_CREATE_FAILED', message: e?.message });
        }

        // Placeholder under users/{uid}/images/{jobId}-0
        try {
            const previewDataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" fill="#1f2237"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#9aa4d6" font-size="14" font-family="Arial, Helvetica, sans-serif">Transforming…</text></svg>`);
            const ref = db.collection('users').doc(uid).collection('images').doc(`${job._id}-0`);
            await ref.set({
                uid,
                jobId: job._id,
                index: 0,
                tool: 'img2img',
                modelKey,
                aspectRatio: 'match_input_image',
                size: (width && height) ? `${width}x${height}` : 'match_input_image',
                caption: '',
                tags: [],
                visibility: 'private',
                status: 'pending',
                downloadURL: null,
                storagePath: null,
                previewURL: previewDataUrl,
                outputsCount: 1,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (_) { }

        // Create Replicate prediction with webhook
        const base = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '');
        const webhookUrl = (base && base.startsWith('https://')) ? `${base}/api/webhooks/replicate?uid=${encodeURIComponent(uid)}&jobId=${encodeURIComponent(job._id)}` : null;
        // attach logging context for Replicate calls
        if (typeof rpl.setReplicateLogContext === 'function') {
            rpl.setReplicateLogContext(() => ({ requestId, uid, jobId: job._id, modelKey, modelVersion: model.version }));
        }
        // Resolve version if empty via helper
        let useVersion = model.version;
        if (!useVersion || String(useVersion).length < 8) {
            try { useVersion = await resolveLatestVersion(model.slug, model.version || ''); }
            catch (e) { return res.status(500).json({ ok: false, error: 'MODEL_VERSION_RESOLVE_FAILED', message: e?.message }); }
        }
        const { data, latencyMs, attemptsUsed } = await rpl.createPrediction({ version: useVersion, input: replicateInput, webhook: webhookUrl || undefined, webhook_events_filter: ['completed'] });

        await jobs.updateJob(job._id, { status: 'running', provider: 'replicate', providerPredictionId: data.id, metrics: { createLatencyMs: latencyMs, inputSizeKB, replicateCreateAttempts: attemptsUsed }, modelResolvedVersion: useVersion });
        try { await db.collection('imageGenerations').doc(job._id).set({ replicatePredictionId: data.id, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch { }
        // If no webhook configured (e.g., local dev), enqueue finalizer worker to poll and store outputs
        try {
            if (!webhookUrl) {
                const { finalizePrediction } = require('../workers/finalizer');
                setImmediate(() => finalizePrediction({ uid, jobId: job._id, predId: data.id }).catch(console.error));
            }
        } catch (_) { /* ignore */ }
        logJSON('img2img.queued', { uid, jobId: job._id, model: modelKey, version: model.version, latencyMs, inputSizeKB, requestId });
        return res.json({ ok: true, jobId: job._id, predId: data.id, env: ENV });
    } catch (e) {
        const code = e?.status || (e?.response?.status) || 500;
        let userCode = 'SERVICE_TEMPORARILY_UNAVAILABLE';
        if (code === 413) userCode = 'PAYLOAD_TOO_LARGE';
        else if (code === 415) userCode = 'UNSUPPORTED_MEDIA_TYPE';
        else if (code === 400) userCode = 'INVALID_INPUT';
        logJSON('img2img.error', { err: e?.message, stack: e?.stack?.slice(0, 200), code });
        return res.status(code).json({ ok: false, error: userCode, message: e?.message });
    } finally {
        const dt = Date.now() - started;
        logJSON('img2img.request.done', { latencyMs: dt });
    }
});

router.get('/img2img/:id', requireAuth, async (req, res) => {
    if (!FEATURE_REPLICATE_IMG2IMG) return res.status(503).json({ ok: false, error: 'feature_disabled' });
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    let out = Array.isArray(j.output) ? j.output : [];
    out = out.map((it) => {
        if (typeof it === 'string') return { storagePath: it, filename: it.split('/').pop(), contentType: null, bytes: null };
        const o = it || {};
        return { storagePath: o.storagePath || null, filename: o.filename || (o.storagePath ? String(o.storagePath).split('/').pop() : null), contentType: o.contentType || null, bytes: o.bytes || null };
    });
    res.json({ ok: true, job: { ...j, output: out } });
});

router.delete('/img2img/:id', requireAuth, async (req, res) => {
    if (!FEATURE_REPLICATE_IMG2IMG) return res.status(503).json({ ok: false, error: 'feature_disabled' });
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    if (j.provider === 'replicate' && j.providerPredictionId) await rpl.cancelPrediction(j.providerPredictionId).catch(() => null);
    await jobs.updateJob(j._id, { status: 'canceled' });
    res.json({ ok: true });
});

// Create a public share for a specific output file of a job
router.post('/img2img/:id/share', requireAuth, async (req, res) => {
    if (!FEATURE_REPLICATE_IMG2IMG) return res.status(503).json({ ok: false, error: 'feature_disabled' });
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    const { fileIndex = 0 } = req.body || {};
    const outputs = Array.isArray(j.output) ? j.output : [];
    if (!outputs[fileIndex]) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'output index missing' });
    const outputItem = outputs[fileIndex];
    const storagePath = typeof outputItem === 'string' ? outputItem : outputItem.storagePath;
    if (!storagePath) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'storagePath missing from output' });

    // filename from storagePath
    const parts = String(storagePath).split('/');
    const filename = parts[parts.length - 1];
    const { buildPublicPath, copyObject } = require('../utils/firebaseUtils');
    const shortId = Math.random().toString(36).slice(2, 10);
    const publicPath = buildPublicPath(shortId, filename);
    try {
        await copyObject(storagePath, publicPath, { metadata: { cacheControl: 'public, max-age=31536000, immutable' } });
        // Return a public media URL
        const { bucket } = require('../utils/firebaseUtils');
        const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(publicPath)}?alt=media`;
        // Optionally record share doc
        try { await db.collection('shares').add({ uid: req.uid, jobId: j._id, fileIndex, publicPath, createdAt: new Date() }); } catch { }
        return res.json({ ok: true, url, publicPath, shortId });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'SHARE_FAILED', message: e?.message });
    }
});

// Delete owner output file
router.delete('/img2img/:id/file', requireAuth, async (req, res) => {
    if (!FEATURE_REPLICATE_IMG2IMG) return res.status(503).json({ ok: false, error: 'feature_disabled' });
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    const { fileIndex = 0 } = req.query || {};
    const idx = Number(fileIndex || 0);
    const outputs = Array.isArray(j.output) ? j.output : [];
    if (!outputs[idx]) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
    const item = outputs[idx];
    const storagePath = typeof item === 'string' ? item : (item && item.storagePath);
    if (!storagePath) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'storagePath missing' });
    const { deleteObject } = require('../utils/firebaseUtils');
    try {
        await deleteObject(storagePath);
        outputs.splice(idx, 1);
        await jobs.updateJob(j._id, { output: outputs });
        try {
            const q = await db.collection('files').where('jobId', '==', j._id).where('storagePath', '==', storagePath).limit(1).get();
            if (!q.empty) await q.docs[0].ref.delete();
        } catch { }
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'DELETE_FAILED', message: e?.message });
    }
});

// Delete a public link
router.delete('/public', requireAuth, async (req, res) => {
    const { publicPath } = req.body || {};
    if (!publicPath || !String(publicPath).startsWith('public/')) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
    const { deleteObject } = require('../utils/firebaseUtils');
    try { await deleteObject(publicPath); return res.json({ ok: true }); } catch (e) { return res.status(500).json({ ok: false, error: 'DELETE_PUBLIC_FAILED', message: e?.message }); }
});

// Admin: toggle model enabled flag at runtime
router.post('/admin/replicate/models/toggle', requireAuth, async (req, res) => {
    const adminUid = process.env.ADMIN_UID || '';
    if (!req.uid || (adminUid && req.uid !== adminUid)) return res.status(403).json({ ok: false, error: 'not_admin' });
    const key = String(req.body?.key || '');
    const enabled = String(req.body?.enabled || 'true') === 'true';
    if (!MODELS[key]) return res.status(404).json({ ok: false, error: 'model_not_found' });
    MODELS[key].enabled = enabled;
    res.json({ ok: true, key, enabled });
});

module.exports = router;
