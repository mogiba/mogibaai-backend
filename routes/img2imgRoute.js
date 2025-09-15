const express = require('express');
const multer = require('multer');
const path = require('path');
const requireAuth = require('../middlewares/requireAuth');
const { MODELS, getModel, FEATURE_REPLICATE_IMG2IMG, ENV } = require('../config/replicateModels');
const { safeFetchHead } = require('../lib/safeUrl');
const { moderateInput } = require('../lib/moderation');
const { uploadToS3AndGetSignedUrl } = require('../services/s3Upload');
const rpl = require('../services/replicateService');
const jobs = require('../services/jobService');
const credits = require('../services/creditsService');

const router = express.Router();
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

function logJSON(event, data) {
    try { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })); } catch { }
}

router.get('/admin/replicate/models', requireAuth, async (req, res) => {
    // Basic admin gate: allow a specific admin email/uid via env
    const adminUid = process.env.ADMIN_UID || '';
    if (!req.uid || (adminUid && req.uid !== adminUid)) return res.status(403).json({ ok: false, error: 'not_admin' });
    res.json({ ok: true, env: ENV, models: MODELS });
});

router.post('/img2img', requireAuth, upload.single('file'), async (req, res) => {
    if (!FEATURE_REPLICATE_IMG2IMG) return res.status(503).json({ ok: false, error: 'feature_disabled' });
    const started = Date.now();
    try {
        const uid = req.uid;
        // Rate limit
        const rl = rateLimit(uid);
        if (rl.limited) {
            res.setHeader('Retry-After', String(rl.retryAfter));
            return res.status(429).json({ ok: false, error: 'RATE_LIMITED', retryAfter: rl.retryAfter });
        }
        const contentType = req.headers['content-type'] || '';
        const isMultipart = contentType.startsWith('multipart/form-data');
        let body = {};
        if (isMultipart) {
            // multipart: expecting fields model, version, input JSON (optional), and file
            body.model = req.body.model;
            body.version = req.body.version;
            try { body.input = req.body.input ? JSON.parse(req.body.input) : {}; } catch { body.input = {}; }
        } else {
            body = req.body || {};
        }

        const modelKey = String(body.model || '').trim();
        const version = String(body.version || '').trim();
        const input = body.input || {};
        const postprocess = body.postprocess || {};

        if (!modelKey || !version) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'model and version required' });
        const model = getModel(modelKey, version);
        if (!model) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'model/version not allowed' });

        // Input.image handling: either via URL (validate) or file upload -> S3 signed URL
        let imageUrl = input.image || '';
        if (req.file) {
            const uploaded = await uploadToS3AndGetSignedUrl(req.file);
            imageUrl = uploaded.url;
        }
        if (!imageUrl) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'input.image required' });

        const head = await safeFetchHead(imageUrl);
        if (!head.contentType.startsWith('image/')) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'input.image must be an image URL' });
        const inputSizeKB = Math.round((head.contentLength || 0) / 1024);

        // Moderation
        const verdict = moderateInput({ prompt: input.prompt || '', negative_prompt: input.negative_prompt || '', width: input.width, height: input.height, imageMeta: {} });
        if (!verdict.ok) {
            logJSON('moderation.block', { uid, model: modelKey, code: verdict.code, reason: verdict.reason });
            return res.status(422).json({ ok: false, error: 'MODERATION_BLOCKED', reason: verdict.reason });
        }

        // Credits check (1 per job by default, allow model override)
        const cost = Number(model.cost || 1);
        try {
            const have = await credits.getUserCredits(uid);
            const haveImg = Number(have.image || 0);
            if (haveImg < cost) return res.status(402).json({ ok: false, error: 'LOW_CREDITS', message: 'Insufficient image credits' });
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'SERVICE_TEMPORARILY_UNAVAILABLE' });
        }

        // Create job
        const job = await jobs.createJob({ userId: uid, modelKey, model, version, input: { ...input, image: imageUrl }, cost, postprocess });

        // Create Replicate prediction with webhook
        const webhookUrl = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '') + '/api/replicate/webhook';
        const { data, latencyMs } = await rpl.createPrediction({
            version: model.version,
            input: { ...input, image: imageUrl },
            webhook: webhookUrl,
            webhook_events_filter: ['completed'],
        });

        await jobs.updateJob(job._id, { status: 'running', provider: 'replicate', providerPredictionId: data.id, metrics: { createLatencyMs: latencyMs, inputSizeKB } });
        logJSON('img2img.queued', { uid, jobId: job._id, model: modelKey, version: model.version, latencyMs, inputSizeKB });
        return res.json({ ok: true, jobId: job._id, env: ENV });
    } catch (e) {
        const code = e?.status || (e?.response?.status) || 500;
        const userCode = code === 413 ? 'PAYLOAD_TOO_LARGE' : code === 400 ? 'INVALID_INPUT' : 'SERVICE_TEMPORARILY_UNAVAILABLE';
        logJSON('img2img.error', { err: e?.message, stack: e?.stack?.slice(0, 200), code });
        return res.status(code).json({ ok: false, error: userCode, message: e?.message });
    } finally {
        const dt = Date.now() - started;
        logJSON('img2img.request.done', { latencyMs: dt });
    }
});

router.get('/img2img/:id', requireAuth, async (req, res) => {
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, job: j });
});

router.delete('/img2img/:id', requireAuth, async (req, res) => {
    const j = await jobs.getJob(req.params.id);
    if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
    if (j.provider === 'replicate' && j.providerPredictionId) await rpl.cancelPrediction(j.providerPredictionId).catch(() => null);
    await jobs.updateJob(j._id, { status: 'canceled' });
    res.json({ ok: true });
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
