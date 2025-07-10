// storage.js (server folder lo pettali)

const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

// Secret File path - Render.com Secret File version
const keyPath = '/etc/secrets/mogibaai-storage-key.json';

// File exists check
if (!fs.existsSync(keyPath)) {
  throw new Error("Google Storage key file not found at " + keyPath);
}

// Read project_id from secret file
const { project_id } = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

const storage = new Storage({
  keyFilename: keyPath,
  projectId: project_id
});

// Bucket name (should match with your GCS bucket name)
const BUCKET_NAME = 'mogibaai-user-images';

const bucket = storage.bucket(BUCKET_NAME);

module.exports = bucket;
