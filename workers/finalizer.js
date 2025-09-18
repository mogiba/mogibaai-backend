const { db, getSignedUrlForPath, admin, bucket, buildOwnerOutputPath } = require('../utils/firebaseUtils');
const axios = require('axios');
const { /* storeReplicateOutput */ } = require('../services/outputStore');
const { getPrediction, setReplicateLogContext } = require('../services/replicateService');
// replicateUtils may be an ES module default export or a CJS export.
let normalizeOutputUrls = null;
const candidatePaths = [
    '../../lib/replicateUtils.cjs',
    '../../lib/replicateUtils.js',
    '../lib/replicateUtils.cjs',
    '../lib/replicateUtils.js',
    './replicateUtils.cjs',
    './replicateUtils.js'
];
for (const p of candidatePaths) {
    if (normalizeOutputUrls) break;
    try {
        const mod = require(p);
        const fn = (mod && (mod.normalizeOutputUrls || mod.default || mod));
        if (typeof fn === 'function') {
            normalizeOutputUrls = fn;
            console.log('[finalizer] loaded replicateUtils from', p);
            break;
        }
    } catch (_) { /* ignore */ }
}
if (!normalizeOutputUrls) {
    console.warn('[finalizer] replicateUtils not found in any candidate path; using fallback extraction');
}

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

        console.log('[finalizer] begin image download+upload pipeline', { uid, jobId, count: urls.length });
        for (let i = 0; i < urls.length; i++) {
            const sourceUrl = urls[i];
            const fileName = `${jobId}-${i}.png`;
            const storagePath = buildOwnerOutputPath(uid, jobId, fileName);
            const docId = `${jobId}-${i}`;
            let signed = null;
            try {
                console.log('[finalizer] downloading source image', { index: i, sourceUrl });
                const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
                if (resp.status >= 400) throw new Error('download_failed_' + resp.status);
                const buf = Buffer.from(resp.data);
                if (!bucket) {
                    console.warn('[finalizer] bucket missing, skipping upload, will store raw url only');
                } else {
                    const file = bucket.file(storagePath);
                    await file.save(buf, { metadata: { contentType: resp.headers['content-type'] || 'image/png' }, resumable: false, public: false, validation: false });
                    try { const su = await getSignedUrlForPath(storagePath); signed = su?.url || null; } catch { signed = null; }
                }
                await db.collection('users').doc(uid).collection('images').doc(docId).set({
                    uid, jobId, index: i, status: 'succeeded', visibility: 'private',
                    storagePath: bucket ? storagePath : null, downloadURL: signed || sourceUrl,
                    sourceUrl,
                    updatedAt: new Date(),
                }, { merge: true });
                console.log('[finalizer] wrote user image doc', { docId, storagePath: bucket ? storagePath : null });
                // Index into global images collection with storagePath (or fallback to sourceUrl)
                try {
                    const { recordImageDoc } = require('../utils/firebaseUtils');
                    await recordImageDoc({ uid, jobId, storagePath: bucket ? storagePath : sourceUrl, modelKey: 'seedream4', prompt: (pred?.input?.prompt) || '', size: null, aspect_ratio: null });
                    console.log('[finalizer] recordImageDoc ok', { docId });
                } catch (e) {
                    console.warn('[finalizer] recordImageDoc failed', { docId, error: e?.message || String(e) });
                }
            } catch (e) {
                const msg = e?.message || String(e);
                const bucketMissing = /The specified bucket does not exist|No such bucket/i.test(msg);
                console.warn('[finalizer] pipeline failed for image', { docId, error: msg, bucketMissing });
                // Graceful fallback: keep generation succeeded for this image but note uploadError; retain sourceUrl
                try {
                    await db.collection('users').doc(uid).collection('images').doc(docId).set({
                        uid, jobId, index: i, status: 'succeeded', uploadError: msg, storagePath: null,
                        downloadURL: sourceUrl, sourceUrl, updatedAt: new Date()
                    }, { merge: true });
                } catch (_) { }
            }
        }

        // Update outputsCount once on first image doc and imageGenerations
        try {
            console.log('[finalizer] setting outputsCount on first image doc', { jobId, outputs: urls.length });
            await db.collection('users').doc(uid).collection('images').doc(`${jobId}-0`).set({ outputsCount: urls.length, updatedAt: new Date() }, { merge: true });
        } catch (e) { console.warn('[finalizer] failed setting outputsCount on first image doc', e?.message || String(e)); }
        try {
            console.log('[finalizer] updating imageGenerations doc', { jobId, outputs: urls.length });
            await db.collection('imageGenerations').doc(jobId).set({ status: 'succeeded', outputsCount: urls.length, updatedAt: new Date() }, { merge: true });
        } catch (e) { console.warn('[finalizer] failed updating imageGenerations doc', e?.message || String(e)); }

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
