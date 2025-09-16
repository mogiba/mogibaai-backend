const crypto = require('crypto');
const axios = require('axios');
const { bucket, db, buildOwnerOutputPath, buildOwnerInputPath } = require('../utils/firebaseUtils');

async function sha256(buf) {
    const h = crypto.createHash('sha256');
    h.update(buf);
    return h.digest('hex');
}

function buildFirebaseDownloadUrl(bucketName, storagePath, token) {
    const encPath = encodeURIComponent(storagePath);
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encPath}?alt=media${token ? `&token=${encodeURIComponent(token)}` : ''}`;
}

async function storeReplicateOutput({ uid, jobId, url, contentTypeHint }) {
    try {
        if (!url) throw new Error('missing url');
        // Download file
        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
        const buf = Buffer.from(resp.data);
        const ct = contentTypeHint || resp.headers['content-type'] || 'image/jpeg';
        const bytes = buf.length;
        const hash = await sha256(buf);

        if (!bucket) {
            return { ok: true, stored: false, url, bytes, hash, reason: 'no_bucket' };
        }

        const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
        const fileName = `${hash}${ext}`;
        const filePath = buildOwnerOutputPath(uid, jobId, fileName);
        const file = bucket.file(filePath);
        await file.save(buf, {
            metadata: {
                contentType: ct,
                cacheControl: 'public, max-age=31536000, immutable',
                metadata: {},
            },
            resumable: false,
            public: false,
            validation: false,
        });
        // No manual public tokens on owner outputs; client should call getDownloadURL at render time.

        // Record file document
        try {
            const ref = db.collection('files').doc();
            await ref.set({
                uid,
                jobId,
                storagePath: filePath,
                bytes,
                checksum: hash,
                contentType: ct,
                source: 'replicate',
                createdAt: new Date(),
            });
        } catch { /* non-fatal */ }

        return { ok: true, stored: true, url: filePath, bytes, hash, storagePath: filePath };
    } catch (e) {
        return { ok: false, stored: false, url, error: e?.message || String(e) };
    }
}

async function uploadInputBufferToFirebase({ uid, buffer, contentType }) {
    if (!bucket) throw new Error('storage_bucket_unavailable');
    const ct = contentType || 'application/octet-stream';
    const ext = ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : '';
    const name = ((crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex')) + ext;
    const filePath = buildOwnerInputPath(uid, name);
    const file = bucket.file(filePath);
    await file.save(buffer, {
        metadata: {
            contentType: ct,
            cacheControl: 'public, max-age=3600',
            metadata: {},
        },
        resumable: false,
        public: false,
        validation: false,
    });
    return { ok: true, url: filePath, storagePath: filePath };
}

module.exports = { storeReplicateOutput, buildFirebaseDownloadUrl, uploadInputBufferToFirebase };
