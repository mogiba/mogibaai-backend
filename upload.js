const { Storage } = require('@google-cloud/storage');
const fs = require('fs');

// Always use Render.com Secret File path
const keyPath = '/etc/secrets/mogibaai-storage-key.json';

// File exists check
if (!fs.existsSync(keyPath)) {
  throw new Error("Google Storage key file not found at " + keyPath);
}

// Read project_id from secret file (optional)
const { project_id } = JSON.parse(fs.readFileSync(keyPath, 'utf-8'));

const storage = new Storage({
  keyFilename: keyPath,
  projectId: project_id, // safe even if not required, but makes config explicit
});

const bucketName = "mogibaai-user-images"; // change only if your bucket name is different

// Function: Upload image buffer, return public URL
async function uploadImageToStorage(buffer, fileName, mimeType) {
  const file = storage.bucket(bucketName).file(fileName);
  await file.save(buffer, {
    metadata: { contentType: mimeType },
    resumable: false,
  });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}

module.exports = uploadImageToStorage;
