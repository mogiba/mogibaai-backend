const express = require('express');
const router = express.Router();

router.post('/echo', express.json(), async (req, res) => {
    try {
        const headers = req.headers || {};
        const body = req.body || {};
        const out = { headers: {}, body };
        Object.keys(headers).forEach(k => { try { out.headers[k] = String(headers[k]).slice(0, 200); } catch { } });
        // attempt to decode bearer token
        const auth = (req.headers['authorization'] || '').toString();
        if (auth.toLowerCase().startsWith('bearer ')) {
            try {
                const admin = require('firebase-admin');
                const token = auth.split(' ')[1];
                const decoded = await admin.auth().verifyIdToken(token).catch(() => null);
                if (decoded) out.token = { uid: decoded.uid, email: decoded.email || null }; else out.token = { error: 'invalid_token' };
            } catch (e) {
                out.token = { error: 'firebase_admin_not_available', message: String(e.message || e) };
            }
        }
        res.json({ ok: true, debug: out });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
    }
});

module.exports = router;
