const express = require('express');
const { db, getSignedUrlForPath, admin } = require('../utils/firebaseUtils');
const rpl = require('../services/replicateService');
const jobs = require('../services/jobService');
const credits = require('../services/creditsService');
const { storeReplicateOutput } = require('../services/outputStore');
const { recordImageDoc } = require('../utils/firebaseUtils');

const router = express.Router();

async function handleReplicateWebhook(req, res) {
    const sig = req.headers['x-replicate-signature'] || '';
    const raw = req.body;
    if (!rpl.verifyWebhookSignature(raw, sig)) return res.status(401).send('invalid signature');

    let evt = null;
    try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.status(200).send('ok'); }

    const pred = evt || {};
    const id = pred?.id || '';
    const status = pred?.status || '';
    const output = Array.isArray(pred?.output) ? pred.output : (pred?.output ? [pred.output] : []);
    const queryUid = (req.query && req.query.uid) ? String(req.query.uid) : null;
    const queryJob = (req.query && req.query.jobId) ? String(req.query.jobId) : null;
    let jobSnap;
    if (queryJob) {
        jobSnap = await db.collection('jobs').where('_id', '==', queryJob).limit(1).get();
    } else {
        jobSnap = await db.collection('jobs').where('providerPredictionId', '==', id).limit(1).get();
    }
    if (jobSnap.empty) return res.status(200).send('ok');
    const doc = jobSnap.docs[0];
    const job = doc.data();

    // idempotent state machine
    if (status === 'succeeded') {
        // Persist output to our storage; replace with storage metadata
        const outs = Array.isArray(output) ? output : [];
        const storedOutputs = [];
        let storedAny = false;
        const galleryDocs = [];
        for (let i = 0; i < outs.length; i++) {
            const src = outs[i];
            const r = await storeReplicateOutput({ uid: job.userId, jobId: job._id, sourceUrl: src, index: i });
            if (r && r.ok && r.stored) {
                storedAny = true;
                storedOutputs.push({ storagePath: r.storagePath, filename: r.filename, contentType: r.contentType, bytes: r.bytes });
                // Signed URL for convenience (owner will also be able to call getDownloadURL client-side)
                let signed = null;
                try { signed = await getSignedUrlForPath(r.storagePath); } catch (_) { signed = null; }
                // Create/Upsert gallery doc under users/{uid}/images/{jobId}-{i}
                const gid = `${job._id}-${i}`;
                try {
                    // Write document as per requested schema
                    await db.collection('users').doc(job.userId).collection('images').doc(gid).set({
                        uid: job.userId,
                        jobId: job._id,
                        modelKey: job.modelKey || 'seedream4',
                        aspectRatio: job?.input?.aspect_ratio || 'match_input_image',
                        size: job?.input?.size || (job.pricePerImage === 48 ? '4K' : '2K'),
                        storagePath: r.storagePath,
                        downloadURL: signed?.url || null,
                        status: 'private',
                        tags: [],
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }, { merge: true });
                    galleryDocs.push(gid);
                } catch (_) { }
                // Optional: keep top-level images index (best-effort)
                try {
                    await recordImageDoc({
                        uid: job.userId,
                        jobId: job._id,
                        storagePath: r.storagePath,
                        modelKey: job.modelKey || 'seedream4',
                        size: job?.input?.size || (job.pricePerImage === 48 ? '4K' : '2K'),
                        aspect_ratio: job?.input?.aspect_ratio || null,
                        prompt: job?.input?.prompt || '',
                        width: job?.input?.width || null,
                        height: job?.input?.height || null,
                    });
                } catch (_) { /* non-fatal */ }
            } else {
                // best-effort: keep a placeholder with source URL but no public URL
                storedOutputs.push({ storagePath: null, filename: null, contentType: null, bytes: 0 });
            }
        }
        const billedImages = Array.isArray(storedOutputs) ? storedOutputs.length : 0;
        const hasPerImage = Number.isFinite(Number(job.pricePerImage));
        if (hasPerImage) {
            const ppi = Number(job.pricePerImage || 0);
            const totalDebited = Math.max(0, billedImages * ppi);
            await jobs.updateJob(job._id, { status: 'succeeded', output: storedOutputs, stored: storedAny, billedImages, totalDebited, webhookReceivedAt: new Date() });
            if (totalDebited > 0) {
                await jobs.ensureDebitOnce({ jobId: job._id, userId: job.userId, category: 'image', cost: totalDebited }).catch(() => null);
                let remaining = null;
                try { const have = await credits.getUserCredits(job.userId); remaining = have?.image ?? null; } catch { remaining = null; }
                await jobs.finalizeHold(job._id, 'captured', { pricePerImage: ppi, billedImages, totalDebited, remainingBalance: remaining }).catch(() => null);
            } else {
                await jobs.finalizeHold(job._id, 'released_nothing_to_bill').catch(() => null);
            }
        } else {
            await jobs.updateJob(job._id, { status: 'succeeded', output: storedOutputs, stored: storedAny, webhookReceivedAt: new Date() });
            await jobs.ensureDebitOnce({ jobId: job._id, userId: job.userId, category: 'image', cost: job.cost || 1 }).catch(() => null);
            let remaining = null;
            try { const have = await credits.getUserCredits(job.userId); remaining = have?.image ?? null; } catch { remaining = null; }
            await jobs.finalizeHold(job._id, 'captured', { price: job.cost || 1, remainingBalance: remaining }).catch(() => null);
        }
        // Update imageGenerations status and outputs (admin update)
        try {
            await db.collection('imageGenerations').doc(job._id).set({
                status: 'succeeded',
                outputsCount: Array.isArray(storedOutputs) ? storedOutputs.length : 0,
                outputs: storedOutputs,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (_) { }
        // Optional post-process chaining
        const parent = await jobs.getJob(job._id);
        const pp = parent?.postprocess || {};
        let head = output && output[0];
        if (pp && (pp.faceRestore || pp.upscale) && head) {
            // 1) GFPGAN
            if (pp.faceRestore && process.env.RPL_GFPGAN_ENABLED !== 'false') {
                const gfp = require('../config/replicateModels').MODELS['gfpgan'];
                if (gfp && gfp.enabled) {
                    const { data } = await require('../services/replicateService').createPrediction({
                        version: gfp.version,
                        input: { image: head },
                        webhook: (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '') + '/api/replicate/webhook',
                        webhook_events_filter: ['completed'],
                    });
                    await jobs.updateJob(job._id, { child_gfpgan: data.id });
                }
            }
            // 2) Real-ESRGAN
            if (pp.upscale && process.env.RPL_REAL_ESRGAN_ENABLED !== 'false') {
                const esr = require('../config/replicateModels').MODELS['real-esrgan'];
                if (esr && esr.enabled) {
                    const { data } = await require('../services/replicateService').createPrediction({
                        version: esr.version,
                        input: { image: head, scale: 2 },
                        webhook: (process.env.PUBLIC_API_BASE || '').replace(/\/$/, '') + '/api/replicate/webhook',
                        webhook_events_filter: ['completed'],
                    });
                    await jobs.updateJob(job._id, { child_esrgan: data.id });
                }
            }
        }
    } else if (status === 'failed' || status === 'canceled') {
        await jobs.updateJob(job._id, { status, output: [], error: pred?.error || null, webhookReceivedAt: new Date() });
        // release hold
        await jobs.finalizeHold(job._id, status === 'failed' ? 'released_failed' : 'released_canceled', { reason: pred?.error || null }).catch(() => null);
        try { await db.collection('imageGenerations').doc(job._id).set({ status, error: pred?.error || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch (_) { }
    }
    res.status(200).send('ok');
}

router.post('/webhook', express.raw({ type: 'application/json' }), handleReplicateWebhook);

module.exports = router;
module.exports.handleReplicateWebhook = handleReplicateWebhook;
