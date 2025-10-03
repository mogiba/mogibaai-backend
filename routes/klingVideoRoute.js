const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { MODELS, getModel } = require('../config/replicateModels');
const { db, admin, getSignedUrlForPath, getPublicDownloadUrlForPath, bucket } = require('../utils/firebaseUtils');
const { uploadInputBufferToFirebase } = require('../services/outputStore');
const rpl = require('../services/replicateService');
const { resolveLatestVersion } = require('../services/replicateService');
const jobs = require('../services/jobService');
const credits = require('../services/creditsService');
let pricingService = null;
try { pricingService = require('../services/pricingService'); } catch (_) { pricingService = null; }

const router = express.Router();

// Simple in-memory rate limit per uid for video
const RATE = { windowMs: 60 * 60 * 1000, max: 20 };
const buckets = new Map();
function rateLimit(uid) {
    const now = Date.now();
    const rec = buckets.get(uid) || { start: now, count: 0 };
    if (now - rec.start >= RATE.windowMs) { rec.start = now; rec.count = 0; }
    rec.count += 1;
    buckets.set(uid, rec);
    return rec.count > RATE.max;
}

// Internal handler to avoid duplicating logic
async function handleKlingJobCreate(req, res) {
    try {
        if (rateLimit(req.uid)) return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });

        // Accept JSON body
        const { prompt = '', negative_prompt = '', start_image = '', end_image = '', mode = 'standard', duration = 5 } = req.body || {};

        // Validate inputs
        const promptStr = String(prompt || '').trim();
        if (!promptStr) return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'prompt is required' });

        let startUrl = String(start_image || '').trim();
        let endUrl = String(end_image || '').trim();
        // Users might upload base64 or file via data URL in future; for now expect storage paths or https URLs

        // If storage paths provided (firebase paths), convert to signed URLs for Replicate
        function parseStoragePathFromUrl(u) {
            try {
                const url = new URL(u);
                const host = (url.hostname || '').toLowerCase();
                // storage.googleapis.com/<bucket>/<path>
                if (host === 'storage.googleapis.com' && url.pathname) {
                    const parts = url.pathname.replace(/^\/+/, '').split('/');
                    if (parts.length >= 2) {
                        const p = parts.slice(1).join('/');
                        return decodeURIComponent(p);
                    }
                }
                // firebasestorage.googleapis.com/v0/b/<bucket>/o/<object>
                if (host === 'firebasestorage.googleapis.com') {
                    const segs = url.pathname.split('/').filter(Boolean);
                    const oIdx = segs.findIndex((s) => s === 'o');
                    if (oIdx !== -1 && segs[oIdx + 1]) {
                        return decodeURIComponent(segs[oIdx + 1]);
                    }
                }
            } catch (_) { }
            return null;
        }

        async function waitForExists(storagePath, { timeoutMs = 60_000, intervalMs = 1000 } = {}) {
            if (!storagePath || !bucket) return false;
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                try {
                    const [exists] = await bucket.file(storagePath).exists();
                    if (exists) return true;
                } catch (_) { /* ignore transient errors */ }
                await new Promise((r) => setTimeout(r, intervalMs));
            }
            return false;
        }

        async function toSigned(urlOrPath) {
            if (!urlOrPath) return null;
            if (/^https?:\/\//i.test(urlOrPath)) {
                // If this is a Firebase Storage URL to our bucket, ensure the object exists before using it.
                const p = parseStoragePathFromUrl(urlOrPath);
                if (p) {
                    const ok = await waitForExists(p, { timeoutMs: 60_000, intervalMs: 1000 });
                    if (!ok) {
                        // Let caller decide; respond with a retriable error rather than enqueueing a doomed job.
                        const err = new Error('START_IMAGE_NOT_READY');
                        err.status = 409;
                        throw err;
                    }
                }
                return urlOrPath;
            }
            // Support local tmp uploads served by express at /tmp-uploads
            if (urlOrPath.startsWith('/tmp-uploads/')) {
                const base = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '');
                const origin = base || `http://localhost:${process.env.PORT || 4000}`;
                return `${origin}${urlOrPath}`;
            }
            // Prefer token-based public URL compatible with external fetchers
            try {
                // Ensure object exists first; for freshly created paths, writes may lag.
                const ok = await waitForExists(urlOrPath, { timeoutMs: 60_000, intervalMs: 1000 });
                if (!ok) {
                    const err = new Error('START_IMAGE_NOT_READY');
                    err.status = 409;
                    throw err;
                }
                const pub = await getPublicDownloadUrlForPath(urlOrPath, { ensureToken: true, cacheControl: 'public,max-age=3600' });
                if (pub && pub.url) return pub.url;
            } catch (_) { }
            // Fallback to signed URL if token route fails
            try {
                const s = await getSignedUrlForPath(urlOrPath, { ttlMs: 60 * 60 * 1000 });
                return s?.url || null;
            } catch { return null; }
        }

        // Resolve/verify URLs; if not ready, return a retriable 409
        try { startUrl = await toSigned(startUrl); } catch (e) { if (e && e.status === 409) return res.status(409).json({ ok: false, error: 'START_IMAGE_NOT_READY' }); throw e; }
        try { endUrl = await toSigned(endUrl); } catch (e) { if (e && e.status === 409) endUrl = null; else throw e; }

        // Model config (hardcoded entry)
        const modelKey = 'kling-video';
        const model = getModel(modelKey, MODELS[modelKey]?.version || undefined);
        if (!model) return res.status(503).json({ ok: false, error: 'MODEL_DISABLED' });
        // Resolve version dynamically if not pinned in config
        let versionId = (model.version || '').trim();
        if (!versionId || /PUT_REPLICATE_VERSION_ID_HERE/i.test(versionId)) {
            try {
                versionId = await resolveLatestVersion(`${model.owner}/${model.name}`, '');
            } catch (e) {
                console.warn('[kling] failed to resolve latest version', e?.message);
            }
        }
        if (!versionId) return res.status(503).json({ ok: false, error: 'VERSION_UNAVAILABLE', message: 'Kling model version not available' });

        // Pricing: credits based on mode + duration via pricingService (fallback heuristic)
        const isHD = String(mode).toLowerCase() === 'hd' || String(mode).toLowerCase() === 'pro';
        const dur = Math.min(10, Math.max(5, Number(duration) || 5));
        let hold = 60; // default
        try {
            if (pricingService && typeof pricingService.getVideoPrice === 'function') {
                hold = await pricingService.getVideoPrice({ modelKey: 'kling-video', options: { resolution: isHD ? '1080p' : '720p', duration: dur } });
            } else {
                if (isHD && dur >= 10) hold = 120; else if (isHD && dur <= 5) hold = 90; else if (!isHD && dur >= 10) hold = 90; else hold = 60;
            }
        } catch (_) {
            if (isHD && dur >= 10) hold = 120; else if (isHD && dur <= 5) hold = 90; else if (!isHD && dur >= 10) hold = 90; else hold = 60;
        }

        // Check video credits
        try {
            const have = await credits.getUserCredits(req.uid);
            if ((have.video || 0) < hold) return res.status(402).json({ ok: false, error: 'LOW_CREDITS', message: 'Insufficient video credits' });
        } catch { return res.status(500).json({ ok: false, error: 'SERVICE_TEMPORARILY_UNAVAILABLE' }); }

        // Build Replicate input for Kling
        const input = {
            prompt: promptStr,
            negative_prompt: String(negative_prompt || ''),
            mode: isHD ? 'hd' : 'standard',
            duration: dur,
        };
        if (startUrl) input.start_image = startUrl;
        if (endUrl) input.end_image = endUrl;

        // Create job doc (status queued later)
        const job = await jobs.createJob({ userId: req.uid, modelKey, model: modelKey, version: versionId, input, cost: hold, pricePerImage: null, requestedImages: 1, watermark: false, category: 'video' });

        // Write a lightweight video job mirror (optional)
        try { await db.collection('videoGenerations').doc(job._id).set({ uid: req.uid, modelKey, status: 'pending', creditsSpent: hold, createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }); } catch { }

        // Placeholder gallery entry
        try {
            const ref = db.collection('users').doc(req.uid).collection('images').doc(`${job._id}`);
            await ref.set({ uid: req.uid, jobId: job._id, index: 0, type: 'video', modelKey, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch { }

        // Webhook URL
        const base = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '');
        const webhook = base && base.startsWith('https://') ? `${base}/api/webhooks/replicate?jobId=${encodeURIComponent(job._id)}&uid=${encodeURIComponent(req.uid)}` : undefined;

        // Call Replicate
        if (typeof rpl.setReplicateLogContext === 'function') rpl.setReplicateLogContext(() => ({ uid: req.uid, jobId: job._id, modelKey }));
        try {
            const { data } = await rpl.createPrediction({ version: versionId, input, webhook, webhook_events_filter: ['completed'] });
            await jobs.updateJob(job._id, { status: 'running', provider: 'replicate', providerPredictionId: data.id });
            return res.json({ ok: true, jobId: job._id, predId: data.id });
        } catch (e) {
            await jobs.updateJob(job._id, { status: 'failed', error: e?.message || 'create_failed' }).catch(() => null);
            await jobs.finalizeHold(job._id, 'released_failed', { reason: e?.message || 'create_failed' }).catch(() => null);
            return res.status(502).json({ ok: false, error: 'UPSTREAM', message: e?.message || 'Replicate request failed' });
        }
    } catch (e) {
        console.error('[kling] create error', e?.message);
        return res.status(500).json({ ok: false, error: 'INTERNAL', message: e?.message });
    }
}

// POST /api/jobs/kling
router.post('/jobs/kling', requireAuth, handleKlingJobCreate);
// Alias: POST /api/video/kling
router.post('/video/kling', requireAuth, handleKlingJobCreate);

// GET /api/jobs/:id – poll job status
router.get('/jobs/:id', requireAuth, async (req, res) => {
    try {
        const j = await jobs.getJob(req.params.id);
        if (!j || j.userId !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.json({ ok: true, job: j });
    } catch (e) { return res.status(500).json({ ok: false, error: 'INTERNAL' }); }
});

module.exports = router;
