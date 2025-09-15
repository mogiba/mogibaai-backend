const AWS = require('aws-sdk');
const crypto = require('crypto');
let sharp = null;
try { sharp = require('sharp'); } catch { sharp = null; }

const S3_BUCKET = process.env.AWS_S3_BUCKET || '';
const SIGNED_URL_TTL_SEC = Number(process.env.S3_SIGNED_TTL_SEC || 600); // 10 min

if (S3_BUCKET) {
    AWS.config.update({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        region: process.env.AWS_REGION || 'ap-south-1',
    });
}

const s3 = S3_BUCKET ? new AWS.S3() : null;

const allowedMime = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

async function uploadToS3AndGetSignedUrl(file) {
    if (!S3_BUCKET || !s3) {
        const err = new Error('S3 not configured');
        err.code = 'S3_NOT_CONFIGURED';
        throw err;
    }
    if (!file) {
        const err = new Error('No file provided');
        err.code = 'NO_FILE';
        throw err;
    }
    if (file.size > MAX_BYTES) {
        const err = new Error('File too large');
        err.status = 413;
        throw err;
    }
    const mime = file.mimetype || 'application/octet-stream';
    if (!allowedMime.has(mime)) {
        const err = new Error('Unsupported file type');
        err.status = 415;
        throw err;
    }
    let body = file.buffer;
    let outMime = mime;
    if (sharp) {
        // Strip metadata and re-encode conservatively
        if (mime === 'image/jpeg') body = await sharp(file.buffer).jpeg({ quality: 95 }).withMetadata({ exif: false }).toBuffer();
        else if (mime === 'image/png') body = await sharp(file.buffer).png({ compressionLevel: 9 }).withMetadata({ exif: false }).toBuffer();
        else if (mime === 'image/webp') body = await sharp(file.buffer).webp({ quality: 95 }).withMetadata({ exif: false }).toBuffer();
    }

    const key = `img2img/uploads/${new Date().toISOString().slice(0, 10)}/${crypto.randomBytes(16).toString('hex')}` + (mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg');

    await s3.putObject({
        Bucket: S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: outMime,
        ACL: 'private',
        CacheControl: 'no-store',
        Metadata: {},
    }).promise();

    const signedUrl = s3.getSignedUrl('getObject', {
        Bucket: S3_BUCKET,
        Key: key,
        Expires: SIGNED_URL_TTL_SEC,
        ResponseContentType: outMime,
    });
    return { bucket: S3_BUCKET, key, url: signedUrl, contentType: outMime };
}

module.exports = { uploadToS3AndGetSignedUrl };
