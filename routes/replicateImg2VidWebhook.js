const express = require('express');
const { db, admin } = require('../utils/firebaseUtils');
const { storeReplicateOutput } = require('../services/outputStore');
const { markSuccess, markFailed, getVideoJob } = require('../services/dbVideoJobs');
const { toHttp } = require('../utils/errors');
const credits = require('../services/creditsService');

const router = express.Router();

router.post('/replicate/webhook/img2vid', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const reqId = Math.random().toString(36).slice(2, 8);
        const jobId = String(req.query.jobId || '').trim();
        if (!jobId) { console.warn(`[img2vid.webhook:${reqId}] missing jobId`); res.status(400).send('jobId required'); return; }
        let evt = null; try { evt = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))); } catch { evt = null; }
        const status = String(evt?.status || '').toLowerCase();
        const outputs = Array.isArray(evt?.output) ? evt.output : (evt?.output ? [evt.output] : []);
        const predId = evt?.id || null;
        console.log(`[img2vid.webhook:${reqId}] received`, { jobId, predId, status, outputs: outputs.length });

        // Load job and verify prediction id if present
        const job = await getVideoJob(jobId);
        if (!job) { console.warn(`[img2vid.webhook:${reqId}] job not found`, { jobId, predId }); res.status(200).send('ok'); return; }
        if (predId && job.providerPredictionId && predId !== job.providerPredictionId) {
            console.warn(`[img2vid.webhook:${reqId}] prediction id mismatch`, { jobId, predId, stored: job.providerPredictionId });
        }

        if (status === 'succeeded') {
            const stored = [];
            for (let i = 0; i < outputs.length; i++) {
                const src = outputs[i];
                try {
                    const r = await storeReplicateOutput({ uid: job.uid, jobId, sourceUrl: src, index: i });
                    if (r && r.ok && r.stored) {
                        stored.push({ storagePath: r.storagePath, filename: r.filename, contentType: r.contentType, bytes: r.bytes });
                    } else {
                        stored.push({ storagePath: null, sourceUrl: src || null });
                    }
                } catch (e) {
                    stored.push({ storagePath: null, sourceUrl: src || null, error: e?.message });
                }
            }
            await markSuccess(jobId, stored, { webhookReceivedAt: admin.firestore.FieldValue.serverTimestamp(), providerPredictionId: predId, metrics: evt?.metrics || null });
            console.log(`[img2vid.webhook:${reqId}] stored outputs`, { jobId, count: stored.length });

            // Debit credits once (video)
            try {
                const debit = Number(job.cost || 0) || 0;
                if (debit > 0) {
                    if (typeof credits.debitOnce === 'function') {
                        await credits.debitOnce({ jobId, uid: job.uid, category: 'video', amount: debit });
                    } else {
                        // fallback: get/update balances via creditsService
                        await credits.spendCredit(job.uid, 'video', debit);
                    }
                }
            } catch (e) { console.warn(`[img2vid.webhook:${reqId}] debit failed`, e?.message); }

            // Flip placeholder gallery doc to ready
            try {
                await db.collection('users').doc(job.uid).collection('images').doc(jobId).set({ status: 'ready', type: 'video', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            } catch { }

            // Schedule cleanup of input image(s) after 1 hour
            try {
                const inputs = Array.isArray(job.inputPaths) ? job.inputPaths : (job.gcsPath ? [job.gcsPath] : []);
                const toCleanup = (inputs || []).filter(p => typeof p === 'string' && p.startsWith('users/') && p.includes('/img2vid/inputs/'));
                if (toCleanup.length > 0) {
                    const when = new Date(Date.now() + 60 * 60 * 1000);
                    const batch = db.batch();
                    toCleanup.forEach((p) => {
                        const ref = db.collection('cleanupQueue').doc();
                        batch.set(ref, { kind: 'delete_storage', storagePath: p, reason: 'img2vid_input_auto_delete_1h', runAfter: when, createdAt: new Date(), uid: job.uid, jobId });
                    });
                    await batch.commit();
                    console.log('[img2vid.webhook] scheduled input cleanup', { jobId, count: toCleanup.length });
                }
            } catch (e) { console.warn(`[img2vid.webhook:${reqId}] schedule cleanup failed`, e && e.message); }

            res.status(200).send('ok');
            return;
        }
        if (status === 'failed' || status === 'canceled') {
            await markFailed(jobId, evt?.error || status, { webhookReceivedAt: admin.firestore.FieldValue.serverTimestamp(), providerPredictionId: predId });
            try { await db.collection('users').doc(job.uid).collection('images').doc(jobId).set({ status, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); } catch { }
            console.warn(`[img2vid.webhook:${reqId}] job marked ${status}`, { jobId, error: evt?.error || null });
            res.status(200).send('ok');
            return;
        }

        // Any other status – acknowledge to avoid retries
        res.status(200).send('ok');
    } catch (e) { return toHttp(res, e); }
});

module.exports = router;
