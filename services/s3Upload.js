// services/s3Upload.js
// Deprecated in Firebase-only mode. Kept as a stub for backward compatibility.
async function uploadToS3AndGetSignedUrl() {
    const err = new Error('S3 upload is disabled. STORAGE_BACKEND=firebase only.');
    err.code = 'S3_DISABLED';
    throw err;
}

module.exports = { uploadToS3AndGetSignedUrl };
