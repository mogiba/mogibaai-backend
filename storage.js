const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

// ✅ Dynamic key path (local or Render)
const keyPath = process.env.GOOGLE_STORAGE_KEY
  ? path.resolve(__dirname, process.env.GOOGLE_STORAGE_KEY)
  : path.join(__dirname, 'secrets', 'mogibaai-storage-key.json');

// Check file exists
if (!fs.existsSync(keyPath)) {
  throw new Error("Google Storage key file not found at " + keyPath);
}

// Read project ID
const { project_id } = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

// Initialize storage
const storage = new Storage({
  keyFilename: keyPath,
  projectId: project_id,
});

// Bucket name
const BUCKET_NAME = 'mogibaai-b3500.firebasestorage.app';
const bucket = storage.bucket(BUCKET_NAME);

module.exports = bucket;
