const { db, getSignedUrlForPath, admin, bucket, buildOwnerOutputPath } = require('../utils/firebaseUtils');
const Jimp = require('jimp');
const axios = require('axios');
const { /* storeReplicateOutput */ } = require('../services/outputStore');
const { getPrediction, setReplicateLogContext } = require('../services/replicateService');
const jobs = require('../services/jobService');
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
        const outputEntries = [];
        // Load job to compute billing and to update status later
        let parentJob = null;
        try { parentJob = await jobs.getJob(jobId); } catch (_) { parentJob = null; }
        const watermarkEnabled = !!(parentJob && parentJob.watermark);
        for (let i = 0; i < urls.length; i++) {
            const sourceUrl = urls[i];
            const fileName = `${jobId}-${i}.png`;
            const storagePath = buildOwnerOutputPath(uid, jobId, fileName);
            const wmFileName = `${jobId}-${i}_wm.png`;
            const wmStoragePath = buildOwnerOutputPath(uid, jobId, wmFileName);
            const docId = `${jobId}-${i}`;
            let signed = null;
            let signedWm = null;
            try {
                console.log('[finalizer] downloading source image', { index: i, sourceUrl });
                const resp = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true });
                if (resp.status >= 400) throw new Error('download_failed_' + resp.status);
                const buf = Buffer.from(resp.data);
                if (!bucket) {
                    console.warn('[finalizer] bucket missing, skipping upload, will store raw url only');
                    // record output entry with direct URL only (no watermark possible)
                    outputEntries.push({ storagePath: null, filename: fileName, contentType: resp.headers['content-type'] || 'image/png', bytes: buf.length, downloadURL: sourceUrl, sourceUrl, wmStoragePath: null, wmDownloadURL: null });
                } else {
                    const file = bucket.file(storagePath);
                    await file.save(buf, { metadata: { contentType: resp.headers['content-type'] || 'image/png' }, resumable: false, public: false, validation: false });
                    try { const su = await getSignedUrlForPath(storagePath); signed = su?.url || null; } catch { signed = null; }
                    // If watermark required, render a WM variant and upload
                    if (watermarkEnabled) {
                        try {
                            const img = await Jimp.read(buf);
                            const w = img.bitmap.width;
                            const logoScale = Math.max(64, Math.floor(w * 0.18));
                            // Lightweight text watermark fallback (no asset dependency)
                            const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
                            // Draw semi-transparent box + text at bottom-right
                            const margin = 20;
                            const text = 'MOGIBAA.AI';
                            const textW = Jimp.measureText(font, text);
                            const textH = Jimp.measureTextHeight(font, text, textW);
                            const pad = 12;
                            const boxW = textW + pad * 2;
                            const boxH = textH + pad * 2;
                            const x = w - boxW - margin;
                            const y = img.bitmap.height - boxH - margin;
                            const overlay = new Jimp(boxW, boxH, 0x00000066);
                            img.composite(overlay, x, y);
                            img.print(font, x + pad, y + pad, { text, alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER, alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE }, textW, textH);
                            const wmBuf = await img.getBufferAsync(Jimp.MIME_PNG);
                            const wmFile = bucket.file(wmStoragePath);
                            await wmFile.save(wmBuf, { metadata: { contentType: 'image/png' }, resumable: false, public: false, validation: false });
                            try { const su2 = await getSignedUrlForPath(wmStoragePath); signedWm = su2?.url || null; } catch { signedWm = null; }
                        } catch (we) {
                            console.warn('[finalizer] watermark generation failed; proceeding with original only', we?.message || String(we));
                        }
                    }
                    outputEntries.push({ storagePath, filename: fileName, contentType: resp.headers['content-type'] || 'image/png', bytes: buf.length, downloadURL: signed || null, sourceUrl, wmStoragePath: watermarkEnabled ? wmStoragePath : null, wmDownloadURL: watermarkEnabled ? (signedWm || null) : null });
                }
                // For Free plan (watermarkEnabled), primary downloadURL should point to WM variant
                const primaryDownload = watermarkEnabled ? (signedWm || signed || sourceUrl) : (signed || sourceUrl);
                const primaryStoragePath = watermarkEnabled ? (bucket ? wmStoragePath : null) : (bucket ? storagePath : null);
                await db.collection('users').doc(uid).collection('images').doc(docId).set({
                    uid,
                    jobId,
                    index: i,
                    status: 'succeeded',
                    visibility: 'private',
                    storagePath: primaryStoragePath,
                    downloadURL: primaryDownload,
                    originalPath: bucket ? storagePath : null,
                    wmPath: watermarkEnabled && bucket ? wmStoragePath : null,
                    sourceUrl,
                    // Provide prompt & model metadata for UI (GalleryPanel reads prompt/modelKey/tool)
                    prompt: (pred?.input?.prompt) || '',
                    modelKey: (pred?.model || 'seedream4'),
                    // createdAt needed because GalleryPanel orders by createdAt; without it docs are excluded
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: new Date(),
                }, { merge: true });
                console.log('[finalizer] wrote user image doc', { docId, storagePath: bucket ? storagePath : null });
                // Also write to legacy userGallery collection (if front-end or other code still expects it)
                try {
                    await db.collection('userGallery').doc(uid).collection('images').doc(docId).set({
                        uid,
                        jobId,
                        status: 'succeeded',
                        storagePath: primaryStoragePath,
                        url: primaryDownload,
                        prompt: (pred?.input?.prompt) || '',
                        tool: (pred?.model || 'seedream4'),
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    }, { merge: true });
                } catch (e) { console.warn('[finalizer] failed writing legacy userGallery doc', { docId, error: e?.message || String(e) }); }
                // Index into global images collection with storagePath (or fallback to sourceUrl)
                try {
                    const { recordImageDoc } = require('../utils/firebaseUtils');
                    await recordImageDoc({ uid, jobId, storagePath: bucket ? (primaryStoragePath || storagePath) : sourceUrl, modelKey: 'seedream4', prompt: (pred?.input?.prompt) || '', size: null, aspect_ratio: null });
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
                        uid,
                        jobId,
                        index: i,
                        status: 'succeeded',
                        uploadError: msg,
                        storagePath: null,
                        downloadURL: sourceUrl,
                        originalPath: null,
                        wmPath: null,
                        sourceUrl,
                        prompt: (pred?.input?.prompt) || '',
                        modelKey: (pred?.model || 'seedream4'),
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        updatedAt: new Date()
                    }, { merge: true });
                    outputEntries.push({ storagePath: null, filename: fileName, contentType: null, bytes: 0, downloadURL: sourceUrl, sourceUrl, uploadError: msg, wmStoragePath: null, wmDownloadURL: null });
                    try {
                        await db.collection('userGallery').doc(uid).collection('images').doc(docId).set({
                            uid,
                            jobId,
                            status: 'succeeded',
                            storagePath: null,
                            url: sourceUrl,
                            prompt: (pred?.input?.prompt) || '',
                            tool: (pred?.model || 'seedream4'),
                            uploadError: msg,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        }, { merge: true });
                    } catch (e2) { console.warn('[finalizer] failed writing legacy userGallery doc (fallback)', { docId, error: e2?.message || String(e2) }); }
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

        // Update job status + capture credits hold + legacy credit spend
        try {
            const { writeLedgerEntry } = require('../services/creditsLedgerService');
            const { ensureDebitOnce } = require('../services/jobService');
            const billedImages = Array.isArray(outputEntries) ? outputEntries.length : 0;
            const hasPerImage = parentJob && Number.isFinite(Number(parentJob.pricePerImage));
            if (hasPerImage) {
                const ppi = Number(parentJob.pricePerImage || 0);
                const totalDebited = Math.max(0, billedImages * ppi);
                await jobs.updateJob(jobId, { status: 'succeeded', output: outputEntries, stored: true, billedImages, totalDebited });
                if (totalDebited > 0) {
                    // Spend from legacy counters exactly once (idempotent transaction marks job.debited)
                    try { await ensureDebitOnce({ jobId, userId: uid, category: 'image', cost: totalDebited }); } catch (e) { console.warn('[finalizer] ensureDebitOnce failed', e?.message); }
                    // Ledger debit (idempotent per job)
                    await writeLedgerEntry({
                        uid,
                        type: 'image',
                        direction: 'debit',
                        amount: totalDebited,
                        source: parentJob?.model === 'img2img' ? 'image2image' : 'text2image',
                        reason: `${parentJob?.model || 'model'} generation`,
                        jobId,
                        meta: { modelKey: parentJob?.model || null, resolution: parentJob?.input?.size || null },
                        idempotencyKey: `debit:${parentJob?.model === 'img2img' ? 'image2image' : 'text2image'}:${jobId}`,
                    }).catch((e) => { console.warn('[finalizer] ledger debit failed', e?.message); });
                }
            } else {
                await jobs.updateJob(jobId, { status: 'succeeded', output: outputEntries, stored: true });
                const cost = parentJob?.cost || 1;
                if (cost > 0) {
                    try { await ensureDebitOnce({ jobId, userId: uid, category: 'image', cost }); } catch (e) { console.warn('[finalizer] ensureDebitOnce (flat cost) failed', e?.message); }
                }
                await writeLedgerEntry({
                    uid,
                    type: 'image',
                    direction: 'debit',
                    amount: cost,
                    source: parentJob?.model === 'img2img' ? 'image2image' : 'text2image',
                    reason: `${parentJob?.model || 'model'} generation`,
                    jobId,
                    meta: { modelKey: parentJob?.model || null, resolution: parentJob?.input?.size || null },
                    idempotencyKey: `debit:${parentJob?.model === 'img2img' ? 'image2image' : 'text2image'}:${jobId}`,
                }).catch((e) => { console.warn('[finalizer] ledger debit failed', e?.message); });
            }
        } catch (e) { console.warn('[finalizer] failed updating job/billing (ledger)', e?.message || String(e)); }

        console.log('[finalizer] stored', { uid, jobId, outputs: urls.length });
        console.log('[finalizer] wrote', { uid, jobId, count: urls.length });

        // Schedule deletion of user-uploaded input images 1 hour after success (no-webhook path)
        try {
            const parent = await jobs.getJob(jobId);
            const inputs = Array.isArray(parent?.inputUploadedPaths) ? parent.inputUploadedPaths : [];
            if (inputs.length) {
                const when = new Date(Date.now() + 60 * 60 * 1000);
                const batch = db.batch();
                inputs.forEach((p) => {
                    const ref = db.collection('cleanupQueue').doc();
                    batch.set(ref, { kind: 'delete_storage', storagePath: p, reason: 'img2img_input_auto_delete_1h', runAfter: when, createdAt: new Date(), uid, jobId });
                });
                await batch.commit();
                console.log('[finalizer] scheduled input cleanup', { jobId, count: inputs.length });
            }
        } catch (e) { console.warn('[finalizer] schedule cleanup failed', e && e.message); }
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
