// utils/firebaseUtils.js (robust, old-style compatible)
// - Resolves service account from FIREBASE_KEY / GOOGLE_APPLICATION_CREDENTIALS / ./secrets/sa-key.json
// - Resolves Storage bucket from FIREBASE_STORAGE_BUCKET / GCS_BUCKET_NAME / GOOGLE_STORAGE_KEY(json) / <project_id>.appspot.com
// - Initializes firebase-admin idempotently
// - Exports: { admin, db, bucket, saveToGallery, getSignedUrlForPath }
//   (bucket is created only if we have a valid bucketName; else still exports null to avoid crash)

const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

/* ---------- Resolve Service Account key path ---------- */
function resolveFirebaseKeyPath() {
  const candidates = [
    process.env.FIREBASE_KEY, // filename or absolute path
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (path.isAbsolute(p) && fs.existsSync(p)) return p;
      const renderPath = path.join('/etc/secrets', p);
      if (fs.existsSync(renderPath)) return renderPath;
      const rel = path.resolve(__dirname, '..', p);
      if (fs.existsSync(rel)) return rel;
    } catch { /* ignore */ }
  }

  const fallback = path.join(__dirname, '..', 'secrets', 'sa-key.json');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

const keyPath = resolveFirebaseKeyPath();
if (!keyPath) {
  throw new Error('Firebase key file not found. Set FIREBASE_KEY or GOOGLE_APPLICATION_CREDENTIALS or place sa-key.json in ./secrets');
}

/* ---------- Load service account JSON ---------- */
let serviceAccount;
try {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  serviceAccount = require(keyPath);
} catch {
  const raw = fs.readFileSync(keyPath, 'utf8');
  serviceAccount = JSON.parse(raw);
}

/* ---------- Resolve Storage Bucket ---------- */
function resolveBucketName() {
  // Prefer explicit envs
  const envBucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    process.env.GCS_BUCKET_NAME ||                // kept for backward compatibility (your old code)
    process.env.GOOGLE_CLOUD_STORAGE_BUCKET ||    // alt name if someone used it
    '';

  if (envBucket) return envBucket;

  // If you set GOOGLE_STORAGE_KEY to a JSON (index.js already sets it), try read from it
  const storageKeyPath = process.env.GOOGLE_STORAGE_KEY;
  if (storageKeyPath && fs.existsSync(storageKeyPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(storageKeyPath, 'utf8'));
      const fromJson = json.bucket || json.bucket_name || json.storageBucket;
      if (fromJson && typeof fromJson === 'string') return fromJson;
    } catch { /* ignore */ }
  }

  // Infer from project_id in service account
  if (serviceAccount && serviceAccount.project_id) {
    return `${serviceAccount.project_id}.appspot.com`;
  }

  return ''; // unknown
}

const storageBucketName = resolveBucketName();

/* ---------- Initialize admin SDK (idempotent) ---------- */
if (!admin.apps || admin.apps.length === 0) {
  const initOpts = { credential: admin.credential.cert(serviceAccount) };
  if (storageBucketName) initOpts.storageBucket = storageBucketName;
  admin.initializeApp(initOpts);
}

const db = admin.firestore();
// IMPORTANT: don't crash if bucketName is still unavailable; export null and let callers handle gracefully.
const bucket = storageBucketName ? admin.storage().bucket(storageBucketName) : null;

/* ---------- Signed URL helper (short-lived) ---------- */
function getSignedUrlTTLms() {
  const h = Number(process.env.SIGNED_URL_TTL_HOURS || 24);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
}

async function getSignedUrlForPath(storagePath, opts = {}) {
  if (!storagePath) throw new Error('storagePath required');
  if (!bucket) throw new Error('Storage bucket not configured. Set FIREBASE_STORAGE_BUCKET or GCS_BUCKET_NAME or ensure serviceAccount.project_id is present.');
  const ttlMs = Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : getSignedUrlTTLms();
  const file = bucket.file(storagePath);
  const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + ttlMs });
  return { url, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

/* ---------- Helper: upload base64 image into user's gallery ---------- */
async function saveToGallery(userId, imageUrl, prompt, base64Data) {
  try {
    if (!userId) throw new Error('Missing userId');
    if (!base64Data) throw new Error('Missing base64 data');
    if (!bucket) throw new Error('Storage bucket not configured');

    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `images/${userId}/${uuidv4()}.jpg`;
    const file = bucket.file(filename);

    await file.save(buffer, {
      metadata: { contentType: 'image/jpeg' },
      resumable: false,
    });

    const { url, expiresAt } = await getSignedUrlForPath(filename);

    await db
      .collection('userGallery')
      .doc(userId)
      .collection('images')
      .add({
        imageUrl: url,
        imageUrlExpiresAt: expiresAt,
        prompt,
        storagePath: filename,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        uid: userId,
      });

    return { ok: true, url, storagePath: filename, expiresAt };
  } catch (error) {
    console.error('saveToGallery Error:', error);
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = { admin, db, bucket, saveToGallery, getSignedUrlForPath };
