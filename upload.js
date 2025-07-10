const { Storage } = require('@google-cloud/storage');
const path = require('path');
require('dotenv').config();

// Storage key path
const keyPath = path.join(__dirname, process.env.GOOGLE_STORAGE_KEY);
console.log("Storage Key Path:", keyPath);

const storage = new Storage({
  keyFilename: keyPath,
});

const bucketName = "mogibaai-user-images"; // change if needed

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

module.exports = uploadImageToStorage; // <--- SINGLE FUNCTION EXPORT (not object!)
