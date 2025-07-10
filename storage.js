// storage.js (server folder lo pettali)

const { Storage } = require('@google-cloud/storage');
const path = require('path');

// Mee .env lo GOOGLE_STORAGE_KEY_ path pettaru kada
const keyPath = process.env.GOOGLE_STORAGE_KEY_ || './mogibaai-storage-key.json'; // fallback

const storage = new Storage({
  keyFilename: path.resolve(keyPath),
  projectId: JSON.parse(require('fs').readFileSync(keyPath)).project_id
});

// Bucket name .json file lo undhi lekapote mee bucket name direct ga ivvachu
const BUCKET_NAME = 'mogibaai-user-images';

const bucket = storage.bucket(BUCKET_NAME);

module.exports = bucket;
