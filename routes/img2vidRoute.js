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

// Helper: resolve hold credits using pricingService or fallback
async function resolveHold({ mode, duration }) {
    const isHD = String(mode).toLowerCase() === 'hd' || String(mode).toLowerCase() === 'pro';
    const dur = Math.min(10, Math.max(5, Number(duration) || 5));
    if (pricingService && typeof pricingService.getVideoPrice === 'function') {
        return await pricingService.getVideoPrice({ modelKey: 'kling-video', options: { resolution: isHD ? '1080p' : '720p', duration: dur } });
    }
    // fallback
    if (isHD && dur >= 10) return 120; if (isHD && dur <= 5) return 90; if (!isHD && dur >= 10) return 90; return 60;
}

// POST /api/img2vid/jobs
router.post('/img2vid/jobs', requireAuth, express.json(), async (req, res) => {
    try {
        const { gcsPath, endGcsPath = null, mode = 'standard', prompt = '', negativePrompt = '', duration = 5 } = req.body || {};
        if (!gcsPath || typeof gcsPath !== 'string') throw httpError(422, 'gcsPath required');
        const uid = req.uid;
        const parts = gcsPath.split('/');
        const allowedRoots = new Set(['users', 'user-uploads', 'user-outputs']);
        if (!allowedRoots.has(parts[0])) throw httpError(422, 'gcsPath must be under users/, user-uploads/, or user-outputs/');
        if (parts[1] !== uid) throw httpError(403, 'gcsPath must belong to the authenticated user');

        // Validate object exists and size/mime
        const file = bucket.file(gcsPath);
        const [exists] = await file.exists();
        if (!exists) throw httpError(404, 'input file not found');
        const [meta] = await file.getMetadata();
        const size = Number(meta?.size || 0);
        const contentType = String(meta?.contentType || '');
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
            const [eExists] = await endFile.exists();
            if (!eExists) throw httpError(404, 'end input file not found');
            const [eMeta] = await endFile.getMetadata(); endMeta = eMeta;
            const eSize = Number(eMeta?.size || 0);
            endContentType = String(eMeta?.contentType || '');
            if (!isAllowedImage(endContentType)) throw httpError(415, `unsupported end content type: ${endContentType}`);
            if (eSize > 10 * 1024 * 1024) throw httpError(413, 'end file too large (>10MB)');
        }

        // Resolve hold credits and check balance
        const hold = await resolveHold({ mode, duration });
        try {
            const bal = await credits.getUserCredits(uid);
            if ((bal.video || 0) < hold) throw httpError(402, 'Insufficient video credits');
        } catch (e) { if (e.status) throw e; throw httpError(503, 'Credits service unavailable'); }

        // Create job doc first
        const inputPaths = [gcsPath].concat(endGcsPath ? [endGcsPath] : []);
        const { id: jobId } = await createVideoJob({ uid, gcsPath, modelKey: 'kling-video', input: { mode, prompt, negative_prompt: negativePrompt, duration }, holdCredits: hold });
        try { await db.collection('videoGenerations').doc(jobId).set({ inputPaths }, { merge: true }); } catch { }

        // Upload file to Replicate Files API (stream)
        const rs = file.createReadStream({ validation: false });
        const up = await uploadFileToReplicate({ readable: rs, filename: path.basename(gcsPath), contentType });
        let upEnd = null;
        if (endFile) {
            const rs2 = endFile.createReadStream({ validation: false });
            upEnd = await uploadFileToReplicate({ readable: rs2, filename: path.basename(endGcsPath), contentType: endContentType });
        }

        // Compose webhook URL
        const base = (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '') || `http://localhost:${process.env.PORT || 4000}`;
        const webhookUrl = `${base}/api/replicate/webhook/img2vid?jobId=${encodeURIComponent(jobId)}`;

        // Create prediction
        const pred = await createKlingPrediction({ fileId: up.id, endFileId: upEnd ? upEnd.id : null, mode, prompt, negativePrompt, duration, webhookUrl });
        await markProcessing(jobId, { provider: 'replicate', providerPredictionId: pred.id, fileId: up.id, endFileId: upEnd ? upEnd.id : null });

        // Placeholder gallery doc (optional)
        try {
            await db.collection('users').doc(uid).collection('images').doc(jobId).set({ uid, jobId, type: 'video', modelKey: 'kling-video', status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch { }

        return res.json({ ok: true, jobId, providerPredictionId: pred.id });
    } catch (e) { return toHttp(res, e); }
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
