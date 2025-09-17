const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { db, deleteObject, getSignedUrlForPath, admin, bucket } = require('../utils/firebaseUtils');
const crypto = require('crypto');

const router = express.Router();

// GET /api/images -> lists current user's images with short-lived signed URLs
router.get('/', requireAuth, async (req, res) => {
    const limit = Math.min(100, Number.parseInt(req.query.limit || '50', 10));
    try {
        // Primary source per spec: users/{uid}/images
        const col = db.collection('users').doc(req.uid).collection('images');
        let snap;
        try {
            snap = await col.orderBy('createdAt', 'desc').limit(limit).get();
        } catch (e) { snap = await col.limit(limit).get(); }

        const items = [];
        for (const d of snap.docs) {
            const data = d.data() || {};
            let url = data.downloadURL || null;
            if (!url && data.storagePath) {
                try { const signed = await getSignedUrlForPath(data.storagePath); url = signed?.url || null; } catch { }
            }
            items.push({
                id: d.id,
                storagePath: data.storagePath || null,
                url,
                prompt: data.caption || data.prompt || '',
                modelKey: data.tool || data.modelKey || null,
                size: data.size || null,
                aspect_ratio: data.aspect_ratio || null,
                status: data.status || null,
                createdAt: data.createdAt && typeof data.createdAt.toDate === 'function' ? data.createdAt.toDate().toISOString() : null,
            });
        }
        return res.json({ ok: true, items });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'LIST_FAILED', message: e?.message });
    }
});

// POST /api/images/backfill -> create missing image docs from prior jobs' outputs for current user
router.post('/backfill', requireAuth, async (req, res) => {
    const uid = req.uid;
    const limit = Math.min(1000, Number.parseInt(req.body?.limit || req.query?.limit || '500', 10));
    try {
        // Fetch recent succeeded jobs for the user
        let snap;
        try {
            snap = await db.collection('jobs')
                .where('userId', '==', uid)
                .where('status', '==', 'succeeded')
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get();
        } catch (e) {
            snap = await db.collection('jobs')
                .where('userId', '==', uid)
                .where('status', '==', 'succeeded')
                .limit(limit)
                .get();
        }

        let created = 0; let scanned = 0;
        for (const d of snap.docs) {
            const j = d.data() || {};
            const outs = Array.isArray(j.output) ? j.output : [];
            for (const it of outs) {
                scanned += 1;
                const storagePath = typeof it === 'string' ? it : (it && it.storagePath);
                if (!storagePath || !String(storagePath).startsWith('user-outputs/')) continue;
                const sig = crypto.createHash('sha1').update(`${uid}|${storagePath}`).digest('hex');
                const gid = `img_${sig}`;
                const userRef = db.collection('users').doc(uid).collection('images').doc(gid);
                const exist = await userRef.get();
                if (exist.exists) continue;
                let signed = null;
                try { signed = await getSignedUrlForPath(storagePath); } catch { }
                const data = {
                    uid,
                    jobId: j._id || d.id,
                    tool: j.modelKey || j.model || 'seedream4',
                    storagePath,
                    downloadURL: signed?.url || null,
                    caption: '',
                    tags: [],
                    visibility: 'private',
                    status: 'approved',
                    size: j?.input?.size || null,
                    aspect_ratio: j?.input?.aspect_ratio || null,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                await userRef.set(data, { merge: true });
                created += 1;
            }
        }

        // Additionally, scan legacy storage folder: users/{uid}/text2img/*
        if (bucket) {
            const legacyPrefix = `users/${uid}/text2img/`;
            try {
                let pageToken = undefined; let iter = 0; const maxIter = 20; // up to ~20 pages
                while (iter < maxIter) {
                    iter += 1;
                    const [files, nextQuery] = await bucket.getFiles({ prefix: legacyPrefix, autoPaginate: false, maxResults: 200, pageToken });
                    for (const f of files) {
                        const storagePath = f.name;
                        if (!storagePath || !storagePath.startsWith(legacyPrefix)) continue;
                        // Only images
                        const ct = (f.metadata && f.metadata.contentType) || '';
                        if (ct && !ct.startsWith('image/')) continue;
                        const sig = crypto.createHash('sha1').update(`${uid}|${storagePath}`).digest('hex');
                        const gid = `img_${sig}`;
                        const ref = db.collection('users').doc(uid).collection('images').doc(gid);
                        const exist = await ref.get();
                        if (exist.exists) continue;
                        let signed = null;
                        try { signed = await getSignedUrlForPath(storagePath); } catch { }
                        await ref.set({
                            uid,
                            jobId: null,
                            tool: 'seedream4',
                            storagePath,
                            downloadURL: signed?.url || null,
                            caption: '', tags: [], visibility: 'private', status: 'approved',
                            size: null, aspect_ratio: null,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        }, { merge: true });
                        created += 1;
                        scanned += 1;
                        if (created >= limit) break;
                    }
                    if (!nextQuery || !nextQuery.pageToken) break;
                    pageToken = nextQuery.pageToken;
                }
            } catch (e) {
                // ignore storage listing errors
            }
        }

        return res.json({ ok: true, scanned, created });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'BACKFILL_FAILED', message: e?.message });
    }
});

// DELETE /api/images/:id -> deletes Firestore doc (images/{id}) and its Storage file
router.delete('/:id', requireAuth, async (req, res) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
    try {
        const ref = db.collection('images').doc(id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ ok: false, error: 'not_found' });
        const data = snap.data();
        if (!data || data.uid !== req.uid) return res.status(403).json({ ok: false, error: 'forbidden' });
        const storagePath = data.storagePath;
        if (storagePath) {
            try { await deleteObject(storagePath); } catch (_) { /* ignore */ }
        }
        await ref.delete();
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'DELETE_FAILED', message: e?.message });
    }
});

module.exports = router;
