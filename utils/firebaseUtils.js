const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const bucket = require('../storage'); // GCS bucket instance

// Dynamic key path
const keyPath = process.env.FIREBASE_KEY
  ? path.resolve(__dirname, '..', process.env.FIREBASE_KEY)
  : path.join(__dirname, '..', 'secrets', 'sa-key.json'); // fallback

// File check
if (!fs.existsSync(keyPath)) {
  throw new Error('Firebase key file not found at ' + keyPath);
}

const serviceAccount = require(keyPath);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'mogibaai-b3500.appspot.com',
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
    console.error('❌ saveToGallery Error:', error.message);
  }
}

module.exports = { db, admin, saveToGallery };
