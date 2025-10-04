const express = require('express');
const path = require('path');
const { bucket, admin, db } = require('../utils/firebaseUtils');
const { isAllowedImage } = require('../utils/mime');
const { httpError, toHttp } = require('../utils/errors');
const { uploadFileToReplicate, createKlingPrediction } = require('../services/replicateFiles');
const { createVideoJob, markProcessing, getVideoJob } = require('../services/dbVideoJobs');
const credits = require('../services/creditsService');
let pricingService = null; try { pricingService = require('../services/pricingService'); } catch { pricingService = null; }
const requireAuth = require('../middlewares/requireAuth');

const router = express.Router();

async function waitForFileExists(file, { tries = 10, delayMs = 800 } = {}) {
    for (let i = 0; i < Math.max(1, tries); i++) {
        try {
            const [exists] = await file.exists();
            if (exists) return true;
        } catch { }
        await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
}

// Helper: resolve hold credits using pricingService or fallback
async function resolveHold({ mode, duration, resolution }) {
    // Normalize mode (legacy 'hd' -> 'pro')
    const raw = String(mode || '').toLowerCase();
    const normMode = raw === 'hd' ? 'pro' : (raw === 'pro' ? 'pro' : 'standard');
    const dur = Math.min(10, Math.max(5, Number(duration) || 5));
    const res = String(resolution || '').toLowerCase();
    // Prefer explicit resolution if passed, else infer from mode
    let resKey = (res === '1080p' || res === '1080p_vertical') ? '1080p' : '720p';
    if (pricingService && typeof pricingService.getVideoPrice === 'function') {
        return await pricingService.getVideoPrice({ modelKey: 'kling-video', options: { resolution: resKey, duration: dur, mode: normMode } });
    }
    // Fallback pricing (example: standard 720p: 49(5s)/98(10s); pro 1080p: 79(5s)/158(10s))
    const isPro = normMode === 'pro';
    if (isPro) return dur >= 10 ? 158 : 79;
    return dur >= 10 ? 98 : 49;
}

// POST /api/img2vid/jobs
router.post('/img2vid/jobs', requireAuth, express.json(), async (req, res) => {
    try {
        const reqId = Math.random().toString(36).slice(2, 8);
        const startedAt = Date.now();
        const { gcsPath, endGcsPath = null, mode = 'standard', resolution = '720p', prompt = '', negativePrompt = '', duration = 5 } = req.body || {};
        console.log(`[img2vid:${reqId}] incoming`, { uid: req.uid, gcsPath, endGcsPath: !!endGcsPath, mode, resolution, duration, promptLen: (prompt || '').length });
        if (!gcsPath || typeof gcsPath !== 'string') throw httpError(422, 'gcsPath required');
        // Mode validation (allow legacy 'hd' but normalize)
        const modeLower = String(mode || '').toLowerCase();
        const normalizedMode = modeLower === 'hd' ? 'pro' : modeLower;
        if (normalizedMode !== 'standard' && normalizedMode !== 'pro') {
            throw httpError(422, 'mode must be one of: standard, pro');
        }
        // Basic resolution validation (optional). Accept portrait suffixes.
        const allowedRes = ['720p', '1080p', '720p_vertical', '1080p_vertical'];
        const resValid = typeof resolution === 'string' && allowedRes.includes(String(resolution).toLowerCase());
        if (!resValid) throw httpError(422, 'resolution invalid');
        const uid = req.uid;
        const parts = gcsPath.split('/');
        const allowedRoots = new Set(['users', 'user-uploads', 'user-outputs']);
        if (!allowedRoots.has(parts[0])) throw httpError(422, 'gcsPath must be under users/, user-uploads/, or user-outputs/');
        if (parts[1] !== uid) throw httpError(403, 'gcsPath must belong to the authenticated user');

        // Validate object exists and size/mime
        const file = bucket.file(gcsPath);
        let exists = await waitForFileExists(file, { tries: 12, delayMs: 750 });
        console.log(`[img2vid:${reqId}] start image exists?`, exists);
        if (!exists) return res.status(409).json({ ok: false, error: 'START_IMAGE_NOT_READY' });
        const [meta] = await file.getMetadata();
        const size = Number(meta?.size || 0);
        const contentType = String(meta?.contentType || '');
        console.log(`[img2vid:${reqId}] start image meta`, { size, contentType });
        if (!isAllowedImage(contentType)) throw httpError(415, `unsupported content type: ${contentType}`);
        if (size > 10 * 1024 * 1024) throw httpError(413, 'file too large (>10MB)');

        // Optional end image validation (if provided)
        let endFile = null; let endMeta = null; let endContentType = null;
        if (endGcsPath) {
            if (typeof endGcsPath !== 'string') throw httpError(422, 'endGcsPath invalid');
            const parts2 = endGcsPath.split('/');
            if (!allowedRoots.has(parts2[0])) throw httpError(422, 'endGcsPath must be under users/, user-uploads/, or user-outputs/');
            if (parts2[1] !== uid) throw httpError(403, 'endGcsPath must belong to the authenticated user');
            endFile = bucket.file(endGcsPath);
            const eExists = await waitForFileExists(endFile, { tries: 12, delayMs: 750 });
            console.log(`[img2vid:${reqId}] end image exists?`, eExists);
            if (!eExists) return res.status(409).json({ ok: false, error: 'END_IMAGE_NOT_READY' });
            const [eMeta] = await endFile.getMetadata(); endMeta = eMeta;
            const eSize = Number(eMeta?.size || 0);
            endContentType = String(eMeta?.contentType || '');
            console.log(`[img2vid:${reqId}] end image meta`, { size: eSize, contentType: endContentType });
            if (!isAllowedImage(endContentType)) throw httpError(415, `unsupported end content type: ${endContentType}`);
            if (eSize > 10 * 1024 * 1024) throw httpError(413, 'end file too large (>10MB)');
        }

        // Resolve hold credits and check balance
        const hold = await resolveHold({ mode: normalizedMode, duration, resolution });
        console.log(`[img2vid:${reqId}] hold credits`, { hold });
        try {
            const bal = await credits.getUserCredits(uid);
            console.log(`[img2vid:${reqId}] user credits`, { video: bal?.video, ok: (bal?.video || 0) >= hold });
            if ((bal.video || 0) < hold) throw httpError(402, 'Insufficient video credits');
        } catch (e) { if (e.status) throw e; throw httpError(503, 'Credits service unavailable'); }

        // Create job doc first
        const inputPaths = [gcsPath].concat(endGcsPath ? [endGcsPath] : []);
        const { id: jobId } = await createVideoJob({ uid, gcsPath, modelKey: 'kling-video', input: { mode: normalizedMode, resolution, prompt, negative_prompt: negativePrompt, duration }, holdCredits: hold });
        console.log(`[img2vid:${reqId}] job created`, { jobId });
        try { await db.collection('videoGenerations').doc(jobId).set({ inputPaths }, { merge: true }); } catch { }

        // Upload file to Replicate Files API (stream)
        const rs = file.createReadStream({ validation: false });
        const up = await uploadFileToReplicate({ readable: rs, filename: path.basename(gcsPath), contentType });
        console.log(`[img2vid:${reqId}] uploaded start to Replicate`, { fileId: up?.id });
        let upEnd = null;
        if (endFile) {
            const rs2 = endFile.createReadStream({ validation: false });
            upEnd = await uploadFileToReplicate({ readable: rs2, filename: path.basename(endGcsPath), contentType: endContentType });
            console.log(`[img2vid:${reqId}] uploaded end to Replicate`, { fileId: upEnd?.id });
        }

        // Compose webhook URL
        const base = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '') || `http://localhost:${process.env.PORT || 4000}`;
        const webhookUrl = `${base}/api/replicate/webhook/img2vid?jobId=${encodeURIComponent(jobId)}`;
        console.log(`[img2vid:${reqId}] webhook`, { webhookUrl });

        // Create prediction
        const pred = await createKlingPrediction({ fileId: up.id, endFileId: upEnd ? upEnd.id : null, mode: normalizedMode, prompt, negativePrompt, duration, webhookUrl, resolution });
        console.log(`[img2vid:${reqId}] prediction created`, { predictionId: pred?.id });
        await markProcessing(jobId, { provider: 'replicate', providerPredictionId: pred.id, fileId: up.id, endFileId: upEnd ? upEnd.id : null });

        // Placeholder gallery doc (optional)
        try {
            await db.collection('users').doc(uid).collection('images').doc(jobId).set({ uid, jobId, type: 'video', modelKey: 'kling-video', status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch { }

        // Read current pricing version (if present) so client can reconcile
        let pricingVersion = 1;
        try {
            const pvDoc = await db.collection('config').doc('pricing').get();
            if (pvDoc.exists) {
                const pvData = pvDoc.data() || {};
                if (typeof pvData.version === 'number') pricingVersion = pvData.version;
            }
        } catch { /* ignore */ }
        console.log(`[img2vid:${reqId}] responded`, { jobId, ms: Date.now() - startedAt, hold, pricingVersion });
        return res.json({ ok: true, jobId, providerPredictionId: pred.id, holdCredits: hold, pricingVersion });
    } catch (e) {
        console.warn('[img2vid:error]', e?.message);
        return toHttp(res, e);
    }
});

// GET /api/img2vid/jobs/:id
router.get('/img2vid/jobs/:id', requireAuth, async (req, res) => {
    try {
        const job = await getVideoJob(req.params.id);
        if (!job || job.uid !== req.uid) return res.status(404).json({ ok: false, error: 'not_found' });
        return res.json({ ok: true, job });
    } catch (e) { return toHttp(res, e); }
});

module.exports = router;
