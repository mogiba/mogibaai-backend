// services/outputStore.js
const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');                   // ⬅ add uuid for download tokens
const path = require('path');
const fs = require('fs');
const {
    bucket,
    db,
    buildOwnerOutputPath,
    buildOwnerInputPath,
} = require('../utils/firebaseUtils');
const { getReplicateAgent } = require('../lib/proxy');

/* ---------- helpers ---------- */
async function sha256(buf) {
    const h = crypto.createHash('sha256');
    h.update(buf);
    return h.digest('hex');
}

function buildFirebaseDownloadUrl(bucketName, storagePath, token) {
    const encPath = encodeURIComponent(storagePath);
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encPath}?alt=media${token ? `&token=${encodeURIComponent(token)}` : ''
        }`;
}

/* ---------- store a Replicate output into Firebase Storage ---------- */
async function storeReplicateOutput({
    uid,
    jobId,
    sourceUrl,
    index = 0,
    filename,
    contentTypeHint,
}) {
    try {
        if (!sourceUrl) throw new Error('missing url');

        // Download file via Replicate-only proxy agent
        const agent = getReplicateAgent();
        const resp = await axios.get(sourceUrl, {
            responseType: 'arraybuffer',
            timeout: 60_000,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            validateStatus: () => true,
        });
        if (resp.status >= 400 || !resp.data) {
            return {
                ok: false,
                stored: false,
                error: `download_failed_${resp.status}`,
                sourceUrl,
            };
        }

        const buf = Buffer.from(resp.data);
        const ct = contentTypeHint || resp.headers['content-type'] || 'image/jpeg';
        const bytes = buf.length;
        const hash = await sha256(buf);

        if (!bucket) {
            return { ok: true, stored: false, sourceUrl, bytes, hash, reason: 'no_bucket' };
        }

        const ext = ct.includes('png')
            ? '.png'
            : ct.includes('webp')
                ? '.webp'
                : ct.includes('jpeg') || ct.includes('jpg')
                    ? '.jpg'
                    : '.bin';

        const fileName = filename || `${jobId}_${index}${ext}`;
        const filePath = buildOwnerOutputPath(uid, jobId, fileName);
        const file = bucket.file(filePath);

        // IMPORTANT: add firebaseStorageDownloadTokens so client getDownloadURL works
        await file.save(buf, {
            metadata: {
                contentType: ct,
                cacheControl: 'public, max-age=31536000, immutable',
                metadata: {
                    firebaseStorageDownloadTokens: uuidv4(),        // ← token for getDownloadURL
                },
            },
            resumable: false,
            public: false,
            validation: false,
        });

        // Record file document (best-effort)
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
        } catch {
            /* non-fatal */
        }

        console.log(`[finalize] stored ${filePath} (${bytes} bytes)`);
        return {
            ok: true,
            stored: true,
            storagePath: filePath,
            bytes,
            contentType: ct,
            filename: fileName,
        };
    } catch (e) {
        return { ok: false, stored: false, sourceUrl, error: e?.message || String(e) };
    }
}

/* ---------- upload an input buffer (for img2img etc.) ---------- */
async function uploadInputBufferToFirebase({ uid, buffer, contentType }) {
    if (!bucket) {
        // Fallback: save to local tmp_uploads and return a public URL
        const dir = path.join(__dirname, '..', 'tmp_uploads');
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { }
        const ext = (contentType && contentType.includes('png')) ? '.png' : (contentType && contentType.includes('webp')) ? '.webp' : '.jpg';
        const name = `${(crypto.randomUUID && crypto.randomUUID()) || uuidv4()}${ext}`;
        const filePath = path.join(dir, name);
        fs.writeFileSync(filePath, buffer);
        // Public URL served by express static at /tmp-uploads
        const urlPath = `/tmp-uploads/${name}`;
        return { ok: true, url: urlPath, storagePath: urlPath };
    }
    const ct = contentType || 'application/octet-stream';
    const ext = ct.includes('png')
        ? '.png'
        : ct.includes('webp')
            ? '.webp'
            : ct.includes('jpeg') || ct.includes('jpg')
                ? '.jpg'
                : '';
    const name =
        (crypto.randomUUID && crypto.randomUUID()) ||
        crypto.randomBytes(16).toString('hex');
    const filename = `${name}${ext}`;
    const filePath = buildOwnerInputPath(uid, filename);
    const file = bucket.file(filePath);

    try {
        // Also include a token here (useful for client-side previews of inputs)
        await file.save(buffer, {
            metadata: {
                contentType: ct,
                cacheControl: 'public, max-age=3600',
                metadata: {
                    firebaseStorageDownloadTokens: uuidv4(),
                },
            },
            resumable: false,
            public: false,
            validation: false,
        });
        return { ok: true, url: filePath, storagePath: filePath };
    } catch (e) {
        // Fallback to tmp-uploads if bucket write fails
        const dir = path.join(__dirname, '..', 'tmp_uploads');
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { }
        const localPath = path.join(dir, filename);
        fs.writeFileSync(localPath, buffer);
        const urlPath = `/tmp-uploads/${filename}`;
        return { ok: true, url: urlPath, storagePath: urlPath };
    }
}

module.exports = {
    storeReplicateOutput,
    buildFirebaseDownloadUrl,
    uploadInputBufferToFirebase,
};
