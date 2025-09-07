// src/utils/firebaseUtils.js (SECURE UPDATED)
// Robust firebase-admin initialization + helpers
// - Resolves service account key path from ENV or /etc/secrets or ./secrets
// - Sets storage bucket from ENV (GCS_BUCKET_NAME) or <project_id>.appspot.com
// - Provides short‑lived signed URL helper (TTL configurable)
// - saveToGallery writes storagePath and a short‑lived imageUrl (with expiresAt)

const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// ---------- Resolve Firebase service account key path ----------
function resolveFirebaseKeyPath() {
  const envCandidates = [
    process.env.FIREBASE_KEY, // can be a filename or absolute path
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ].filter(Boolean);

  for (const envVal of envCandidates) {
    try {
      if (path.isAbsolute(envVal) && fs.existsSync(envVal)) return envVal;
      const renderPath = path.join('/etc/secrets', envVal);
      if (fs.existsSync(renderPath)) return renderPath;
      const relativePath = path.resolve(__dirname, '..', envVal);
      if (fs.existsSync(relativePath)) return relativePath;
    } catch (_) {
      // ignore and continue
    }
  }

  const fallback = path.join(__dirname, '..', 'secrets', 'sa-key.json');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

const keyPath = resolveFirebaseKeyPath();
if (!keyPath) {
  throw new Error(
    'Firebase key file not found. Set FIREBASE_KEY or GOOGLE_APPLICATION_CREDENTIALS or place sa-key.json in ./secrets'
  );
}

// ---------- Load service account JSON ----------
let serviceAccount;
try {
  // allow require() when path is resolvable
  // eslint-disable-next-line import/no-dynamic-require, global-require
  serviceAccount = require(keyPath);
} catch (err) {
  try {
    const raw = fs.readFileSync(keyPath, 'utf8');
    serviceAccount = JSON.parse(raw);
  } catch (err2) {
    throw new Error('Failed to load Firebase service account JSON: ' + (err2.message || err2));
  }
}

// ---------- Determine storage bucket ----------
const inferredBucket = serviceAccount?.project_id ? `${serviceAccount.project_id}.appspot.com` : null;
const storageBucketName = process.env.GCS_BUCKET_NAME || inferredBucket || undefined;
if (!storageBucketName) {
  throw new Error('Storage bucket not configured. Set GCS_BUCKET_NAME or check serviceAccount.project_id');
}

// ---------- Initialize admin SDK (idempotent) ----------
if (!admin.apps || admin.apps.length === 0) {
  const initOpts = { credential: admin.credential.cert(serviceAccount) };
  if (storageBucketName) initOpts.storageBucket = storageBucketName;
  admin.initializeApp(initOpts);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// ---------- Signed URL helper (short‑lived) ----------
// TTL in hours via ENV SIGNED_URL_TTL_HOURS (default 24h)
function getSignedUrlTTLms() {
  const h = Number(process.env.SIGNED_URL_TTL_HOURS || 24);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
}

async function getSignedUrlForPath(storagePath, opts = {}) {
  if (!storagePath) throw new Error('storagePath required');
  const ttlMs = Number.isFinite(Number(opts.ttlMs)) ? Number(opts.ttlMs) : getSignedUrlTTLms();
  const file = bucket.file(storagePath);
  const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + ttlMs });
  return { url, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

// ---------- Helper: upload base64 image into user's gallery ----------
async function saveToGallery(userId, imageUrl, prompt, base64Data) {
  try {
    if (!userId) throw new Error('Missing userId');
    if (!base64Data) throw new Error('Missing base64 data');

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
