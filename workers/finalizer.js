const { db, getSignedUrlForPath, admin } = require('../utils/firebaseUtils');
const { /* storeReplicateOutput */ } = require('../services/outputStore');
const { getPrediction, setReplicateLogContext } = require('../services/replicateService');
// replicateUtils may be an ES module default export or a CJS export.
const _replicateUtils = require('../../lib/replicateUtils.cjs');
const normalizeOutputUrls = (_replicateUtils && (_replicateUtils.normalizeOutputUrls || _replicateUtils.default || _replicateUtils));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function finalizePrediction({ uid, jobId, predId }) {
    const started = Date.now();
    try {
        if (typeof setReplicateLogContext === 'function') setReplicateLogContext(() => ({ uid, jobId, predId }));

        const deadline = Date.now() + 2 * 60 * 1000; // 2 minutes
        let pred = null;
        while (Date.now() < deadline) {
            pred = await getPrediction(predId).catch(() => null);
            if (!pred) { await sleep(2000); continue; }
            const st = String(pred.status || '').toLowerCase();
            if (['succeeded', 'failed', 'canceled'].includes(st)) break;
            await sleep(2000);
        }

        if (!pred) {
            await db.collection('imageGenerations').doc(jobId).set({ status: 'failed', error: 'timeout', updatedAt: new Date() }, { merge: true });
            return { ok: false, reason: 'timeout' };
        }

        const status = String(pred.status || '').toLowerCase();
        if (status !== 'succeeded') {
            await db.collection('imageGenerations').doc(jobId).set({ status, error: pred.error || null, updatedAt: new Date() }, { merge: true });
            // Mark placeholders failed
            try {
                const q = await db.collection('users').doc(uid).collection('images').where('jobId', '==', jobId).get();
                const batch = db.batch();
                q.forEach((d) => batch.set(d.ref, { status: 'failed', updatedAt: new Date() }, { merge: true }));
                if (!q.empty) await batch.commit();
            } catch (_) { }
            return { ok: false, status };
        }

        // Normalize outputs into direct URLs (no Storage upload)
        const urls = (typeof normalizeOutputUrls === 'function') ? normalizeOutputUrls(pred) : (Array.isArray(pred.output) ? pred.output : (pred.output ? [pred.output] : []));
        if (!urls || !urls.length) {
            await db.collection('imageGenerations').doc(jobId).set({ status: 'failed', error: 'no_outputs', updatedAt: new Date() }, { merge: true });
            return { ok: false, reason: 'no_outputs' };
        }

        for (let i = 0; i < urls.length; i++) {
            await db.collection('users').doc(uid).collection('images').doc(`${jobId}-${i}`).set({
                uid, jobId, index: i, status: 'succeeded', visibility: 'private',
                storagePath: null, downloadURL: urls[i],
                updatedAt: new Date(),
            }, { merge: true });
        }

        // Update outputsCount once on first image doc and imageGenerations
        try { await db.collection('users').doc(uid).collection('images').doc(`${jobId}-0`).set({ outputsCount: urls.length, updatedAt: new Date() }, { merge: true }); } catch { }
        await db.collection('imageGenerations').doc(jobId).set({ status: 'succeeded', outputsCount: urls.length, updatedAt: new Date() }, { merge: true });

        console.log('[finalizer] stored', { uid, jobId, outputs: urls.length });
        console.log('[finalizer] wrote', { uid, jobId, count: urls.length });
        return { ok: true, outputs: urls.length };
    } catch (e) {
        await db.collection('imageGenerations').doc(jobId).set({ status: 'failed', error: e?.message || String(e), updatedAt: new Date() }, { merge: true });
        return { ok: false, error: e?.message || String(e) };
    } finally {
        const dt = Date.now() - started;
        if (dt > 0) console.log('[finalizer] done', { jobId, dt });
    }
}

module.exports = { finalizePrediction };
