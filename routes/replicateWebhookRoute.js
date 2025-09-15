const express = require('express');
const { db } = require('../utils/firebaseUtils');
const rpl = require('../services/replicateService');
const jobs = require('../services/jobService');

const router = express.Router();

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['x-replicate-signature'] || '';
    const raw = req.body;
    if (!rpl.verifyWebhookSignature(raw, sig)) return res.status(401).send('invalid signature');

    let evt = null;
    try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.status(200).send('ok'); }

    const pred = evt || {};
    const id = pred?.id || '';
    const status = pred?.status || '';
    const output = Array.isArray(pred?.output) ? pred.output : (pred?.output ? [pred.output] : []);
    const jobSnap = await db.collection('jobs').where('providerPredictionId', '==', id).limit(1).get();
    if (jobSnap.empty) return res.status(200).send('ok');
    const doc = jobSnap.docs[0];
    const job = doc.data();

    // idempotent state machine
    if (status === 'succeeded') {
        await jobs.updateJob(job._id, { status: 'succeeded', output, webhookReceivedAt: new Date() });
        await jobs.ensureDebitOnce({ jobId: job._id, userId: job.userId, category: 'image', cost: job.cost || 1 }).catch(() => null);
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
        await jobs.updateJob(job._id, { status, error: pred?.error || null, webhookReceivedAt: new Date() });
    }

    res.status(200).send('ok');
});

module.exports = router;
