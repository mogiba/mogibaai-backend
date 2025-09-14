const express = require('express');
const rzpSvc = require('../services/razorpayService');

const router = express.Router();

// helper: prefer Authorization Bearer token, fallback to x-uid
const getUidFromRequest = async (req) => {
    const auth = (req.headers['authorization'] || '').toString();
    if (auth.toLowerCase().startsWith('bearer ')) {
        try {
            const admin = require('firebase-admin');
            const token = auth.split(' ')[1];
            const decoded = await admin.auth().verifyIdToken(token).catch(() => null);
            if (decoded && decoded.uid) return decoded.uid;
        } catch { }
    }
    const h = (req.headers['x-uid'] || '').toString().trim();
    const q = (req.query?.uid || '').toString().trim();
    const b = req.body?.uid ? String(req.body.uid).trim() : '';
    return h || q || b || '';
};

// POST /api/billing/create-order
router.post('/create-order', express.json(), async (req, res) => {
    try {
        const uid = await getUidFromRequest(req);
        if (!uid) return res.status(401).json({ message: 'Missing Authorization or x-uid' });
        // forward to existing paymentsRoute create-order handler by calling rzpSvc directly
        if (!rzpSvc.isConfigured()) return res.status(503).json({ message: 'Razorpay keys not configured' });

        // build a minimal order using same logic as paymentsRoute
        const amount = Number(req.body?.amount || req.body?.total || req.body?.amountINR || 0);
        if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount required' });

        const order = await rzpSvc.createOrder({ amount, currency: 'INR', notes: { uid, type: 'topup' } });
        return res.json({ id: order.id || order.order_id || order.orderId || order, order, keyId: rzpSvc.getPublicKey() });
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

module.exports = router;
