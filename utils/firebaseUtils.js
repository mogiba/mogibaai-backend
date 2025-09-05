// src/utils/firebaseUtils.js
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const bucket = require('../storage'); // GCS bucket instance (confirm path)

// Resolve Firebase service account key path robustly
function resolveFirebaseKeyPath() {
  // Try common environment variables in order
  const envCandidates = [
    process.env.FIREBASE_KEY,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ].filter(Boolean);

  // If any env var provided, try to resolve it
  for (const envVal of envCandidates) {
    try {
      // If absolute path and exists
      if (path.isAbsolute(envVal) && fs.existsSync(envVal)) return envVal;

      // If it's a filename or relative path, check Render default mount location
      const renderPath = path.join('/etc/secrets', envVal);
      if (fs.existsSync(renderPath)) return renderPath;

      // Check relative to project root (useful for local dev)
      const relativePath = path.resolve(__dirname, '..', envVal);
      if (fs.existsSync(relativePath)) return relativePath;
    } catch (err) {
      // ignore and continue
    }
  }

  // Fallback: check ../secrets/sa-key.json (local fallback)
  const fallback = path.join(__dirname, '..', 'secrets', 'sa-key.json');
  if (fs.existsSync(fallback)) return fallback;

  return null;
}

const keyPath = resolveFirebaseKeyPath();

if (!keyPath) {
  throw new Error(
    'Firebase key file not found. Tried FIREBASE_KEY, GOOGLE_APPLICATION_CREDENTIALS, /etc/secrets/<file>, and ../secrets/sa-key.json'
  );
}

console.log('Using Firebase key from:', keyPath);

// Load service account JSON (try require first, otherwise read file)
let serviceAccount;
try {
  serviceAccount = require(keyPath);
} catch (err) {
  try {
    const raw = fs.readFileSync(keyPath, 'utf8');
    serviceAccount = JSON.parse(raw);
  } catch (err2) {
    throw new Error('Failed to load Firebase service account JSON: ' + err2.message);
  }
}

// Initialize admin if not already
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.GCS_BUCKET_NAME || 'mogibaai-b3500.appspot.com',
  });
}

const db = admin.firestore();

async function saveToGallery(userId, imageUrl, prompt, base64Data) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `images/${userId}/${uuidv4()}.jpg`;
    const file = bucket.file(filename);

    await file.save(buffer, {
      metadata: { contentType: 'image/jpeg' },
    });

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: '03-01-2030',
    });

    await db
      .collection('userGallery')
      .doc(userId)
      .collection('images')
      .add({
        imageUrl: url,
        prompt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        uid: userId,
      });

    console.log('✅ Saved image to GCS + Firestore');
  } catch (error) {
    console.error('❌ saveToGallery Error:', error);
  }
}

module.exports = { db, admin, saveToGallery };
