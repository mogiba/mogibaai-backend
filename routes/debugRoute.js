const express = require('express');
const router = express.Router();
const { getReplicateAgent } = require('../lib/proxy');
const axios = require('axios');

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

// Additional debug endpoint to inspect proxy wiring (Replicate-only)
router.get('/proxy-info', (req, res) => {
    try {
        const usingProxy = !!getReplicateAgent();
        res.json({
            ok: true,
            proxy: {
                usingProxy,
                FIXIE_URL: !!process.env.FIXIE_URL,
                HTTP_PROXY: !!process.env.HTTP_PROXY,
                HTTPS_PROXY: !!process.env.HTTPS_PROXY,
                note: 'Proxy (if present) is applied only to Replicate egress.'
            }
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
    }
});

router.get('/probe', async (req, res) => {
    const started = Date.now();
    const out = { ok: true, results: {} };
    try {
        const agent = getReplicateAgent();
        const t0 = Date.now();
        const rep = await axios.get('https://api.replicate.com', {
            timeout: 5000,
            validateStatus: () => true,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            headers: { 'User-Agent': 'mogibaai-probe' }
        }).catch(e => ({ status: 0, error: String(e.message || e) }));
        out.results.replicate = { status: rep.status || 0, dt: Date.now() - t0 };
    } catch (e) {
        out.results.replicate = { status: 0, error: String(e.message || e) };
    }
    try {
        const t1 = Date.now();
        const g = await axios.get('https://www.googleapis.com/discovery/v1/apis', {
            timeout: 5000,
            validateStatus: () => true,
            proxy: false,
            headers: { 'User-Agent': 'mogibaai-probe' }
        }).catch(e => ({ status: 0, error: String(e.message || e) }));
        out.results.googleapis = { status: g.status || 0, dt: Date.now() - t1 };
    } catch (e) {
        out.results.googleapis = { status: 0, error: String(e.message || e) };
    }
    out.ts = new Date().toISOString();
    out.dt = Date.now() - started;
    res.json(out);
});
