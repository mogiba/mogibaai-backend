const express = require('express');
const { writeLedgerEntry, queryAdminLedger } = require('../services/creditsLedgerService');
const { Parser } = require('json2csv');
const { db } = require('../utils/firebaseUtils');
const router = express.Router();

// Reuse admin auth middleware from adminRoute by importing it (duplicate minimal)
const { getAuth } = require('firebase-admin/auth');
const { admin } = require('../utils/firebaseUtils');

async function requireAdmin(req, res, next) {
    try {
        const authHeader = String(req.headers['authorization'] || '').trim();
        if (!authHeader.toLowerCase().startsWith('bearer ')) return res.status(401).json({ error: 'MISSING_ID_TOKEN' });
        const idToken = authHeader.split(' ')[1];
        const decoded = await getAuth().verifyIdToken(idToken);
        const uid = decoded?.uid;
        if (!uid) return res.status(401).json({ error: 'TOKEN_INVALID' });
        if (decoded.admin === true || (decoded.customClaims && decoded.customClaims.admin === true)) { req.adminUid = uid; return next(); }
        // Firestore allowlist
        try { const cfgDoc = await db.collection('config').doc('admins').get(); if (cfgDoc.exists) { const cfg = cfgDoc.data() || {}; if (Array.isArray(cfg.uids) && cfg.uids.map(String).includes(uid)) { req.adminUid = uid; return next(); } } } catch (_) { }
        const envAdmins = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean); if (envAdmins.includes(uid)) { req.adminUid = uid; return next(); }
        return res.status(403).json({ error: 'NOT_ADMIN' });
    } catch (e) { return res.status(401).json({ error: 'ADMIN_AUTH_FAILED' }); }
}

router.post('/credits/adjust', express.json(), requireAdmin, async (req, res) => {
    try {
        const { uid, type = 'image', direction, amount, reason } = req.body || {};
        if (!uid || !direction || !amount) return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
        if (!['credit', 'debit'].includes(direction)) return res.status(400).json({ ok: false, error: 'INVALID_DIRECTION' });
        const amt = Number(amount); if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' });
        const entry = await writeLedgerEntry({ uid, type: type === 'video' ? 'video' : 'image', direction, amount: amt, source: 'admin_adjustment', reason: reason || 'admin adjustment', createdBy: `admin:${req.adminUid}`, idempotencyKey: `admin:${req.adminUid}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
        return res.json({ ok: true, entry });
    } catch (e) {
        const code = e?.code === 'NEGATIVE_BALANCE_BLOCKED' ? 400 : 500;
        return res.status(code).json({ ok: false, error: e?.code || 'ADJUST_FAILED', message: e?.message });
    }
});

module.exports = router;

// Admin ledger query
router.get('/credits/ledger', requireAdmin, async (req, res) => {
    const { uid, type, direction, source, jobId, paymentId, from, to, cursor, limit, email } = req.query || {};
    try {
        const f = {};
        let resolvedUids = [];
        if (uid) {
            f.uid = String(uid);
        } else if (email) {
            // Exact email match lookup (case-sensitive first, then lowercase fallback)
            const emailTrim = String(email).trim();
            let userSnap = null;
            try {
                // Try primary field 'email'
                const q1 = await db.collection('users').where('email', '==', emailTrim).limit(5).get();
                if (!q1.empty) userSnap = q1; else {
                    // Try alternate field 'userEmail'
                    const q2 = await db.collection('users').where('userEmail', '==', emailTrim).limit(5).get();
                    if (!q2.empty) userSnap = q2; else {
                        // Lowercase variant attempts (common pattern storing lower-case)
                        const lower = emailTrim.toLowerCase();
                        const q3 = await db.collection('users').where('email', '==', lower).limit(5).get();
                        if (!q3.empty) userSnap = q3; else {
                            const q4 = await db.collection('users').where('userEmail', '==', lower).limit(5).get();
                            if (!q4.empty) userSnap = q4;
                        }
                    }
                }
            } catch (_) { /* ignore lookup errors */ }
            if (userSnap && !userSnap.empty) {
                resolvedUids = userSnap.docs.map(d => d.id);
                if (resolvedUids.length === 1) {
                    f.uid = resolvedUids[0];
                } else if (resolvedUids.length > 1) {
                    // If multiple users share the email (rare), for now return entries for FIRST only to keep query logic simple
                    f.uid = resolvedUids[0];
                }
            } else {
                // Email not found -> return empty result quickly
                return res.json({ ok: true, entries: [], nextCursor: null, emailNotFound: true });
            }
        }
        if (type) f.type = String(type).toLowerCase();
        if (direction) f.direction = String(direction).toLowerCase();
        if (source) f.source = String(source);
        if (jobId) f.jobId = String(jobId);
        if (paymentId) f.paymentId = String(paymentId);
        if (from) f.from = new Date(from);
        if (to) f.to = new Date(to);
        const lim = Math.min(500, Math.max(1, parseInt(limit || '100', 10)));
        const { entries, nextCursor } = await queryAdminLedger({ filters: f, limit: lim, cursor: cursor || null });
        // Enrich with user email (best-effort). Batch fetch distinct uids from users collection.
        try {
            const uids = [...new Set(entries.map(e => e.uid).filter(Boolean))];
            if (uids.length) {
                const refs = uids.map(u => db.collection('users').doc(u));
                const snaps = await db.getAll(...refs).catch(() => []);
                const emailMap = {};
                snaps.forEach((s, idx) => {
                    const data = s && s.exists ? (s.data() || {}) : {};
                    const em = data.email || data.userEmail || null;
                    if (em) emailMap[uids[idx]] = em;
                });
                entries.forEach(e => { if (emailMap[e.uid]) e.email = emailMap[e.uid]; });
            }
        } catch (_) { /* ignore enrichment failures */ }
        return res.json({ ok: true, entries, nextCursor, resolved: { email: email || null, uids: resolvedUids } });
    } catch (e) { return res.status(500).json({ ok: false, error: 'ADMIN_LEDGER_QUERY_FAILED', message: e?.message }); }
});

router.get('/credits/export.csv', requireAdmin, async (req, res) => {
    try {
        let cursor = null; const rows = []; let page = 0; const limit = 1000; // up to 100k
        while (page < 100) {
            const { entries, nextCursor } = await queryAdminLedger({ limit, cursor });
            rows.push(...entries); if (!nextCursor) break; cursor = nextCursor; page += 1;
        }
        const fields = ['uid', 'createdAt', 'type', 'direction', 'amount', 'balance_after', 'source', 'reason', 'jobId', 'paymentId', 'invoiceId', 'idempotencyKey'];
        const data = rows.map(r => ({ ...r, createdAt: r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : null }));
        const parser = new Parser({ fields });
        const csv = parser.parse(data);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="credits_ledger_admin.csv"');
        return res.send(csv);
    } catch (e) { return res.status(500).json({ ok: false, error: 'ADMIN_EXPORT_FAILED', message: e?.message }); }
});
