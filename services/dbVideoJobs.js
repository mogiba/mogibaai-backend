// services/dbVideoJobs.js
const { db, admin } = require('../utils/firebaseUtils');

async function createVideoJob({ uid, gcsPath, modelKey, input, holdCredits }) {
    const ref = db.collection('videoGenerations').doc();
    const docId = ref.id;
    const payload = {
        id: docId,
        uid,
        modelKey,
        gcsPath,
        status: 'queued',
        input,
        cost: holdCredits || 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await ref.set(payload);
    return { id: docId, ref };
}

async function markProcessing(id, meta) {
    const ref = db.collection('videoGenerations').doc(id);
    await ref.set({ status: 'processing', ...meta, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function markSuccess(id, outputs, meta) {
    const ref = db.collection('videoGenerations').doc(id);
    await ref.set({ status: 'succeeded', outputs, ...meta, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function markFailed(id, error, meta) {
    const ref = db.collection('videoGenerations').doc(id);
    await ref.set({ status: 'failed', error: error || 'failed', ...meta, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}

async function getVideoJob(id) {
    const s = await db.collection('videoGenerations').doc(id).get();
    return s.exists ? { id, ...s.data() } : null;
}

module.exports = { createVideoJob, markProcessing, markSuccess, markFailed, getVideoJob };
