const { db, getSignedUrlForPath, admin } = require('../utils/firebaseUtils');
const { storeReplicateOutput } = require('../services/outputStore');
const { getPrediction, setReplicateLogContext } = require('../services/replicateService');

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

        const outs = Array.isArray(pred.output) ? pred.output : (pred.output ? [pred.output] : []);
        const stored = [];
        for (let i = 0; i < outs.length; i++) {
            const r = await storeReplicateOutput({ uid, jobId, sourceUrl: outs[i], index: i });
            if (r && r.ok && r.stored) {
                let signed = null; try { signed = await getSignedUrlForPath(r.storagePath); } catch { signed = null; }
                await db.collection('users').doc(uid).collection('images').doc(`${jobId}-${i}`).set({
                    uid, jobId, index: i, status: 'succeeded', visibility: 'private',
                    storagePath: r.storagePath, downloadURL: signed?.url || null,
                    updatedAt: new Date(),
                }, { merge: true });
                stored.push({ storagePath: r.storagePath, filename: r.filename, contentType: r.contentType, bytes: r.bytes });
            } else {
                await db.collection('users').doc(uid).collection('images').doc(`${jobId}-${i}`).set({ status: 'failed', updatedAt: new Date() }, { merge: true });
            }
        }

        // Update outputsCount once on first image doc and imageGenerations
        try { await db.collection('users').doc(uid).collection('images').doc(`${jobId}-0`).set({ outputsCount: outs.length, updatedAt: new Date() }, { merge: true }); } catch { }
        await db.collection('imageGenerations').doc(jobId).set({ status: 'succeeded', outputsCount: outs.length, updatedAt: new Date() }, { merge: true });

        console.log('[finalizer] stored', { uid, jobId, outputs: outs.length });
        return { ok: true, outputs: outs.length };
    } catch (e) {
        await db.collection('imageGenerations').doc(jobId).set({ status: 'failed', error: e?.message || String(e), updatedAt: new Date() }, { merge: true });
        return { ok: false, error: e?.message || String(e) };
    } finally {
        const dt = Date.now() - started;
        if (dt > 0) console.log('[finalizer] done', { jobId, dt });
    }
}

module.exports = { finalizePrediction };
