const express = require('express');
const rzpSvc = require('../services/razorpayService');
const { admin, db } = require('../utils/firebaseUtils');

const router = express.Router();

// helper: prefer Authorization Bearer token, fallback to x-uid (accept X-Forwarded-Authorization)
const getUidFromRequest = async (req) => {
    const auth = (req.headers['authorization'] || req.headers['x-forwarded-authorization'] || '').toString();
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
        try {
            const admin = require('../utils/firebaseUtils').admin || require('firebase-admin');
            const token = auth.split(' ')[1];
            const decoded = await admin.auth().verifyIdToken(token).catch(() => null);
            if (decoded && decoded.uid) return decoded.uid;
        } catch (e) { /* ignore */ }
    }
    const h = (req.headers['x-uid'] || req.headers['X-Uid'] || '').toString().trim();
    const q = (req.query?.uid || '').toString().trim();
    const b = req.body?.uid ? String(req.body.uid).trim() : '';
    return h || q || b || '';
};

// helpers
const normalizeCategory = (c) => (String(c || 'image').toLowerCase() === 'video' ? 'video' : 'image');
const parseIntSafe = (v, d = 0) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
};

// POST /api/billing/create-order
router.post('/create-order', express.json(), async (req, res) => {
    try {
        const uid = await getUidFromRequest(req);
        if (!uid) return res.status(401).json({ message: 'Missing Authorization or x-uid' });
        if (!rzpSvc.isConfigured()) return res.status(503).json({ message: 'Razorpay keys not configured' });

        const category = normalizeCategory(req.body?.category);
        const credits = parseIntSafe(req.body?.credits, 0);
        const pack_id = (req.body?.pack_id || '').toString();
        const amountINR = Number(req.body?.total || 0) || (Number(req.body?.base || 0) + Number(req.body?.gst || 0));

        if (!credits || credits <= 0) return res.status(400).json({ message: 'credits must be > 0' });
        if (!amountINR || amountINR <= 0) return res.status(400).json({ message: 'total amount is required' });

        const notes = { uid, type: 'topup', category, credits: String(credits), pack_id };
        const order = await rzpSvc.createOrder({ amount: amountINR, currency: 'INR', notes });

        // Persist order metadata
        await db.collection('orders').doc(order.id).set({
            uid,
            status: 'created',
            category,
            credits,
            amountPaise: order.amount,
            currency: order.currency || 'INR',
            pack_id: pack_id || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return res.json({ order, keyId: rzpSvc.getPublicKey() });
    } catch (e) {
        return res.status(500).json({ message: e?.message || 'Failed to create order' });
    }
});

// POST /api/billing/create-subscription
router.post('/create-subscription', express.json(), async (req, res) => {
    try {
        const uid = await getUidFromRequest(req);
        if (!uid) return res.status(401).json({ message: 'Missing Authorization or x-uid' });
        if (!rzpSvc.isConfigured()) return res.status(503).json({ message: 'Razorpay keys not configured' });

        const rzpPlanId = String(req.body?.rzpPlanId || req.body?.planId || '');
        if (!rzpPlanId) return res.status(400).json({ message: 'rzpPlanId required' });

        const sub = await rzpSvc.createSubscription({ rzpPlanId, totalCount: Number(req.body?.totalCount) || 12, notes: { uid, type: 'subscription' }, customerNotify: 1 });
        return res.json({ id: sub.id || sub.subscriptionId || sub, subscription: sub, keyId: rzpSvc.getPublicKey() });
    } catch (e) {
        return res.status(500).json({ message: e?.message || 'Failed to create subscription' });
    }
});

// POST /api/billing/verify
// body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/verify', express.json(), async (req, res) => {
    try {
        const uid = await getUidFromRequest(req);
        if (!uid) return res.status(401).json({ message: 'Missing Authorization or x-uid' });
        if (!rzpSvc.isConfigured()) return res.status(503).json({ message: 'Razorpay keys not configured' });

        const orderId = req.body.orderId || req.body.razorpay_order_id;
        const paymentId = req.body.paymentId || req.body.razorpay_payment_id;
        const signature = req.body.signature || req.body.razorpay_signature;
        if (!orderId || !paymentId || !signature) return res.status(400).json({ message: 'Missing verification fields' });

        const ok = rzpSvc.verifyPaymentSignature({ order_id: orderId, payment_id: paymentId, signature });
        if (!ok) return res.status(400).json({ message: 'Invalid signature' });

        // load order from Firestore, fallback to Razorpay to populate notes
        const orderRef = db.collection('orders').doc(orderId);
        let ordSnap = await orderRef.get();
        if (!ordSnap.exists) {
            const fetched = await rzpSvc.fetchOrder(orderId).catch(() => null);
            const notes = fetched?.notes || {};
            await orderRef.set({
                uid: notes.uid || uid,
                category: normalizeCategory(notes.category),
                credits: parseIntSafe(notes.credits, 0),
                amountPaise: fetched?.amount || null,
                currency: fetched?.currency || 'INR',
                status: 'created',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            ordSnap = await orderRef.get();
        }

        const order = ordSnap.data() || {};
        if (order.uid && order.uid !== uid) return res.status(403).json({ message: 'UID mismatch' });

        const category = normalizeCategory(order.category);
        const credits = parseIntSafe(order.credits, 0);
        if (!credits) return res.status(400).json({ message: 'Order has zero credits' });

        // Structured log pre
        console.log('[VERIFY][topup] start', { uid, orderId, category, credits });

        const { FieldValue } = admin.firestore;

        // Transaction: increment credits, log txn, mark order paid+credited
        const result = await db.runTransaction(async (tx) => {
            const uref = db.collection('users').doc(uid);
            const usnap = await tx.get(uref);
            const before = {
                image: parseInt(usnap.data()?.credits_image || 0, 10) || 0,
                video: parseInt(usnap.data()?.credits_video || 0, 10) || 0,
            };

            const osnap = await tx.get(orderRef);
            const odata = osnap.exists ? osnap.data() : {};
            if (odata.credited === true) return { alreadyCredited: true, before, after: before };

            const incField = category === 'video' ? 'credits_video' : 'credits_image';
            tx.set(uref, { [incField]: FieldValue.increment(credits), updatedAt: FieldValue.serverTimestamp() }, { merge: true });

            const after = incField === 'credits_video' ? { image: before.image, video: before.video + credits } : { image: before.image + credits, video: before.video };

            const txRef = db.collection('creditTransactions').doc();
            tx.set(txRef, {
                uid,
                type: 'topup',
                category,
                qty: credits,
                before,
                after,
                meta: { source: 'razorpay', orderId, paymentId },
                createdAt: FieldValue.serverTimestamp(),
            });

            tx.set(orderRef, { status: 'paid', paymentId, verifiedAt: FieldValue.serverTimestamp(), credited: true }, { merge: true });

            return { alreadyCredited: false, before, after };
        });

        console.log('[VERIFY][topup] done', { uid, orderId, category, credits, before: result.before, after: result.after, skipped: result.alreadyCredited });
        return res.json({ ok: true, credited: !result.alreadyCredited, orderId });
    } catch (e) {
        console.error('[VERIFY][topup] error', e && e.message ? e.message : e);
        return res.status(500).json({ message: e?.message || 'Verification failed' });
    }
});

module.exports = router;
