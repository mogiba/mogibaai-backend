const { admin, db } = require('../utils/firebaseUtils');
const credits = require('./creditsService');

const NOW = () => admin.firestore.FieldValue.serverTimestamp();

async function createJob({ userId, modelKey, model, version, input, cost, pricePerImage, requestedImages, watermark }) {
    const ref = db.collection('jobs').doc();
    const job = {
        _id: ref.id,
        userId,
        model: modelKey,
        version,
        input,
        status: 'pending',
        createdAt: NOW(),
        updatedAt: NOW(),
        output: [],
        error: null,
        cost: cost || 1,
        pricePerImage: pricePerImage || null,
        requestedImages: requestedImages || null,
        watermark: Boolean(watermark) || false,
    };
    await ref.set(job);
    // Create a pending credits hold transaction
    try {
        const txRef = db.collection('creditsTransactions').doc(`hold_${ref.id}`);
        await txRef.set({
            kind: 'hold',
            jobId: ref.id,
            uid: userId,
            category: 'image',
            amount: job.cost,
            status: 'pending',
            createdAt: NOW(),
            updatedAt: NOW(),
            meta: {
                pricePerImage: pricePerImage || null,
                requestedImages: requestedImages || null,
            }
        });
    } catch { }
    return job;
}

async function updateJob(id, patch) {
    const ref = db.collection('jobs').doc(id);
    await ref.set({ ...patch, updatedAt: NOW() }, { merge: true });
    return (await ref.get()).data();
}

async function getJob(id) {
    const snap = await db.collection('jobs').doc(id).get();
    return snap.exists ? snap.data() : null;
}

async function ensureDebitOnce({ jobId, userId, category, cost }) {
    const ref = db.collection('jobs').doc(jobId);
    const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('JOB_NOT_FOUND');
        const j = snap.data();
        if (j.debited === true) return { skipped: true };
        // spend credit
        await credits.spendCredit(userId, category, cost);
        tx.set(ref, { debited: true, updatedAt: NOW() }, { merge: true });
        // finalize hold transaction
        const txRef = db.collection('creditsTransactions').doc(`hold_${jobId}`);
        tx.set(txRef, { status: 'captured', updatedAt: NOW() }, { merge: true });
        return { skipped: false };
    });
    return out;
}

async function finalizeHold(jobId, status, meta = {}) {
    const txRef = db.collection('creditsTransactions').doc(`hold_${jobId}`);
    await txRef.set({ status, updatedAt: NOW(), ...meta }, { merge: true });
}

module.exports = { createJob, updateJob, getJob, ensureDebitOnce, finalizeHold };
