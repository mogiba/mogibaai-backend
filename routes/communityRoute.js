const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const { db, admin } = require('../utils/firebaseUtils');

const router = express.Router();

async function isAdminUid(uid) {
    if (!uid) return false;
    try {
        const user = await admin.auth().getUser(uid);
        const email = (user && user.email) || '';
        if (email && email.toLowerCase() === 'mogibaaiofficial@gmail.com') return true;
    } catch (e) {
        // ignore
    }
    return false;
}

router.post('/admin/approve', requireAuth, async (req, res) => {
    try {
        const { postId } = req.body || {};
        if (!postId) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
        if (!(await isAdminUid(req.uid))) return res.status(403).json({ ok: false, error: 'forbidden' });
        const ref = db.collection('communityPosts').doc(postId);
        await ref.update({ status: 'approved', approved: true, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
        try {
            const snap = await ref.get();
            const data = snap.data() || {};
            if (data.userId && data.uniqueId) {
                await db.collection('users').doc(data.userId).collection('images').doc(data.uniqueId)
                    .update({ communityStatus: 'approved', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
        } catch (_) { }
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'APPROVE_FAILED', message: e?.message });
    }
});

router.post('/admin/reject', requireAuth, async (req, res) => {
    try {
        const { postId } = req.body || {};
        if (!postId) return res.status(400).json({ ok: false, error: 'INVALID_INPUT' });
        if (!(await isAdminUid(req.uid))) return res.status(403).json({ ok: false, error: 'forbidden' });
        const ref = db.collection('communityPosts').doc(postId);
        await ref.update({ status: 'rejected', approved: false, reviewedAt: admin.firestore.FieldValue.serverTimestamp() });
        try {
            const snap = await ref.get();
            const data = snap.data() || {};
            if (data.userId && data.uniqueId) {
                await db.collection('users').doc(data.userId).collection('images').doc(data.uniqueId)
                    .update({ communityStatus: 'rejected', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
        } catch (_) { }
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'REJECT_FAILED', message: e?.message });
    }
});

module.exports = router;
