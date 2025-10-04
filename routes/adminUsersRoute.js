const express = require('express');
const router = express.Router();
const { db, admin, bucket } = require('../utils/firebaseUtils');
const { getAuth } = require('firebase-admin/auth');

async function requireAdmin(req, res, next) {
    try {
        const authHeader = String(req.headers['authorization'] || '').trim();
        if (!authHeader.toLowerCase().startsWith('bearer ')) return res.status(401).json({ ok: false, error: 'MISSING_ID_TOKEN' });
        const idToken = authHeader.split(' ')[1];
        const decoded = await getAuth().verifyIdToken(idToken);
        const uid = decoded?.uid;
        if (!uid) return res.status(401).json({ ok: false, error: 'TOKEN_VERIFY_FAILED' });
        if (decoded.admin === true || (decoded.customClaims && decoded.customClaims.admin === true)) { req.adminUid = uid; return next(); }
        const cfgDoc = await db.collection('config').doc('admins').get().catch(() => null);
        if (cfgDoc && cfgDoc.exists) {
            const cfg = cfgDoc.data() || {};
            const uids = Array.isArray(cfg.uids) ? cfg.uids.map(String) : [];
            const emails = Array.isArray(cfg.emails) ? cfg.emails.map((e) => String(e).toLowerCase()) : [];
            if (uids.includes(uid) || (decoded.email && emails.includes(String(decoded.email).toLowerCase()))) { req.adminUid = uid; return next(); }
        }
        const envAdmins = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
        const envEmails = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (envAdmins.includes(uid) || (decoded.email && envEmails.includes(String(decoded.email).toLowerCase()))) { req.adminUid = uid; return next(); }
        return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    } catch (e) { return res.status(401).json({ ok: false, error: 'ADMIN_AUTH_FAILED' }); }
}

function sanitizeUser(doc) {
    const d = doc.data();
    return {
        id: doc.id,
        email: d.email || d.userEmail || '',
        name: d.displayName || d.name || '',
        avatar: d.photoURL || null,
        status: d.status || 'active',
        credits: {
            image: Number(d.imageCredits || d.credits?.image || d.credits_image || d.creditsBalance?.credits_image || 0) || 0,
            video: Number(d.videoCredits || d.credits?.video || d.credits_video || d.creditsBalance?.credits_video || 0) || 0,
        },
        plan: d.plan || d.subscription?.plan || null,
        subscriptionStatus: d.subscriptionStatus || d.subscription?.status || null,
        joinedAt: d.createdAt && typeof d.createdAt.toDate === 'function' ? d.createdAt.toDate().toISOString() : null,
        lastActive: d.lastActiveAt && typeof d.lastActiveAt.toDate === 'function' ? d.lastActiveAt.toDate().toISOString() : null,
    };
}

router.get('/', requireAdmin, async (req, res) => {
    try {
        const queryStr = (req.query.query || '').toString().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '25', 10)));

        // Load Firestore users map for enrichment
        const fsSnap = await db.collection('users').get().catch(() => ({ empty: true, forEach: () => { } }));
        const fsMap = new Map();
        if (!fsSnap.empty) fsSnap.forEach(d => fsMap.set(d.id, sanitizeUser(d)));

        // Fetch Auth users (up to page*limit + small buffer) then paginate client-side
        const targetCount = page * limit + 50;
        const users = [];
        let nextToken = undefined;
        while (users.length < targetCount) {
            const resp = await getAuth().listUsers(1000, nextToken);
            for (const u of resp.users) {
                const email = (u.email || '').toLowerCase();
                const name = (u.displayName || '').toLowerCase();
                if (!queryStr || email.includes(queryStr) || name.includes(queryStr)) {
                    const fsu = fsMap.get(u.uid) || {};
                    users.push({
                        id: u.uid,
                        email: u.email || '',
                        name: u.displayName || fsu.name || '',
                        avatar: u.photoURL || fsu.avatar || null,
                        status: fsu.status || 'active',
                        credits: fsu.credits || { image: 0, video: 0 },
                        plan: fsu.plan || null,
                        subscriptionStatus: fsu.subscriptionStatus || null,
                        joinedAt: (u.metadata && u.metadata.creationTime) ? new Date(u.metadata.creationTime).toISOString() : (fsu.joinedAt || null),
                        lastActive: (u.metadata && u.metadata.lastSignInTime) ? new Date(u.metadata.lastSignInTime).toISOString() : (fsu.lastActive || null),
                    });
                }
            }
            if (!resp.pageToken) break; nextToken = resp.pageToken;
            // safety: stop after ~5000
            if (users.length > 5000) break;
        }

        const total = users.length;
        const start = (page - 1) * limit;
        const pageItems = users.slice(start, start + limit);
        return res.json({ ok: true, items: pageItems, page, total, hasMore: start + limit < total });
    } catch (e) { return res.status(500).json({ ok: false, error: 'LIST_FAILED', message: e?.message }); }
});

router.post('/:id/block', requireAdmin, express.json(), async (req, res) => {
    try {
        const id = req.params.id; const reason = (req.body && req.body.reason) || null;
        const ref = db.collection('users').doc(id);
        await ref.set({ status: 'blocked', blockedAt: admin.firestore.FieldValue.serverTimestamp(), blockedReason: reason || null }, { merge: true });
        await db.collection('activities').add({ userId: id, action: 'admin.block', resource: 'user', meta: { reason }, timestamp: new Date(), adminId: req.adminUid });
        return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: 'BLOCK_FAILED' }); }
});

router.post('/:id/unblock', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id; const ref = db.collection('users').doc(id);
        await ref.set({ status: 'active', blockedAt: null, blockedReason: null }, { merge: true });
        await db.collection('activities').add({ userId: id, action: 'admin.unblock', resource: 'user', meta: null, timestamp: new Date(), adminId: req.adminUid });
        return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: 'UNBLOCK_FAILED' }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id; const wipe = String(req.query.wipeStorage || 'false') === 'true';
        // safety: unpaid invoices (simple check)
        try {
            const inv = await db.collection('invoices').where('uid', '==', id).where('status', '==', 'unpaid').limit(1).get();
            if (!inv.empty) return res.status(423).json({ ok: false, error: 'LOCKED_UNPAID' });
        } catch (_) { }
        // delete Firebase Auth user (best-effort)
        try { await getAuth().deleteUser(id); } catch (e) { if (e && e.code !== 'auth/user-not-found') { console.warn('deleteUser error', id, e.code || e.message); } }
        // wipe storage (best-effort, isolated)
        if (wipe && bucket) {
            try {
                const prefixes = [`user-uploads/${id}/`, `user-outputs/${id}/`];
                for (const pfx of prefixes) {
                    try {
                        const [files] = await bucket.getFiles({ prefix: pfx });
                        await Promise.all(files.map((f) => f.delete().catch(() => null)));
                    } catch (e) {
                        console.warn('storage wipe error', id, pfx, e?.message || e);
                    }
                }
            } catch (e) {
                console.warn('storage wipe outer error', id, e?.message || e);
            }
        }
        // remove related collections (best-effort, isolated per collection)
        try {
            const colls = [
                ['users', id, 'images'],
                ['imageGenerations'],
                ['jobs'],
                ['transactions'],
            ];
            for (const c of colls) {
                try {
                    const [root, subId, subColl] = c;
                    if (subId && subColl) {
                        const base = db.collection(root).doc(subId).collection(subColl);
                        const s = await base.where('uid', '==', id).get().catch(() => ({ empty: true, forEach: () => { } }));
                        const batch = db.batch(); let count = 0; s.forEach(d => { batch.delete(d.ref); count++; }); if (count > 0) await batch.commit();
                    } else {
                        const base = db.collection(root);
                        const s = await base.where('uid', '==', id).get().catch(() => ({ empty: true, forEach: () => { } }));
                        const batch = db.batch(); let count = 0; s.forEach(d => { batch.delete(d.ref); count++; }); if (count > 0) await batch.commit();
                    }
                } catch (e) {
                    console.warn('collection sweep error', c, id, e?.message || e);
                }
            }
        } catch (e) {
            console.warn('collections sweep outer error', id, e?.message || e);
        }
        // delete users doc (best-effort)
        await db.collection('users').doc(id).delete().catch(() => null);
        return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: 'DELETE_FAILED' }); }
});

// Legacy admin credits adjustment (now routed through unified ledger). Kept path stable for UI.
router.post('/:id/credits', requireAdmin, express.json(), async (req, res) => {
    try {
        const id = req.params.id; const { type, category, amount, note } = req.body || {};
        const delta = Number(amount);
        if (!['image', 'video'].includes(category) || !['add', 'remove'].includes(type) || !Number.isFinite(delta) || delta <= 0) {
            return res.status(422).json({ ok: false, error: 'INVALID_INPUT' });
        }
        const direction = type === 'add' ? 'credit' : 'debit';
        const { writeLedgerEntry, getUserBalances } = require('../services/creditsLedgerService');
        // Write ledger entry transactionally (will block negative debit)
        let entry;
        try {
            entry = await writeLedgerEntry({
                uid: id,
                type: category,
                direction,
                amount: delta,
                source: 'admin_adjustment',
                reason: note || 'admin adjustment',
                createdBy: `admin:${req.adminUid}`,
                idempotencyKey: `adminUsersRoute:${req.adminUid}:${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            });
            console.log('[adminUsersRoute] ledger entry created', { user: id, entryId: entry.id, type: category, direction, amount: delta, balance_after: entry.balance_after });
        } catch (err) {
            const code = err?.code === 'NEGATIVE_BALANCE_BLOCKED' ? 400 : 500;
            console.warn('[adminUsersRoute] ledger entry failed', { user: id, error: err?.message, code: err?.code });
            return res.status(code).json({ ok: false, error: err?.code || 'LEDGER_WRITE_FAILED', message: err?.message });
        }
        // Mirror balances back into users doc legacy fields for existing UI pieces
        let balances = await getUserBalances(id).catch(() => ({ image: 0, video: 0 }));
        try {
            await db.collection('users').doc(id).set({
                imageCredits: balances.image,
                videoCredits: balances.video,
                credits_image: balances.image,
                credits_video: balances.video,
                creditsBalance: { credits_image: balances.image, credits_video: balances.video },
                credits: { image: balances.image, video: balances.video },
                creditsSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch { /* best effort */ }
        return res.json({ ok: true, entry, balances });
    } catch (e) { return res.status(500).json({ ok: false, error: 'CREDITS_FAILED', message: e?.message }); }
});

router.put('/:id/subscription', requireAdmin, express.json(), async (req, res) => {
    try {
        const id = req.params.id; const { plan } = req.body || {};
        if (!['Starter', 'Pro', 'Ultra', 'Cancel'].includes(plan)) return res.status(422).json({ ok: false, error: 'INVALID_PLAN' });
        const ref = db.collection('users').doc(id);
        if (plan === 'Cancel') {
            await ref.set({ subscriptionStatus: 'inactive', cancellationDate: new Date() }, { merge: true });
        } else {
            await ref.set({ plan, subscriptionStatus: 'active' }, { merge: true });
        }
        await db.collection('activities').add({ userId: id, action: 'admin.subscription.update', resource: 'user', meta: { plan }, timestamp: new Date(), adminId: req.adminUid });
        return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: 'SUBSCRIPTION_FAILED' }); }
});

router.get('/:id/activity', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id; const days = Math.max(1, parseInt(req.query.days || '30', 10));
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const s = await db.collection('activities').where('userId', '==', id).where('timestamp', '>=', since).orderBy('timestamp', 'desc').limit(500).get().catch(async () => {
            const s2 = await db.collection('activities').where('userId', '==', id).get();
            return s2;
        });
        const items = []; s.forEach(d => items.push({ id: d.id, ...(d.data() || {}) }));
        return res.json({ ok: true, items });
    } catch (e) { return res.status(500).json({ ok: false, error: 'ACTIVITY_FAILED' }); }
});

router.post('/bulk', requireAdmin, express.json(), async (req, res) => {
    try {
        const { action, userIds, amount, wipeStorage, type, category } = req.body || {};
        const ids = Array.isArray(userIds) ? userIds.slice(0, 200) : [];
        if (ids.length === 0) return res.status(422).json({ ok: false, error: 'NO_IDS' });
        const results = [];
        for (const id of ids) {
            try {
                if (action === 'block') {
                    await db.collection('users').doc(id).set({ status: 'blocked' }, { merge: true });
                    results.push({ id, status: 'ok' });
                } else if (action === 'unblock') {
                    await db.collection('users').doc(id).set({ status: 'active' }, { merge: true });
                    results.push({ id, status: 'ok' });
                } else if (action === 'delete') {
                    // Unpaid invoices guard
                    try {
                        const inv = await db.collection('invoices').where('uid', '==', id).where('status', '==', 'unpaid').limit(1).get();
                        if (!inv.empty) { results.push({ id, status: 'failed', error: 'LOCKED_UNPAID' }); continue; }
                    } catch (_) { }
                    // Delete Auth user (best-effort)
                    try { await getAuth().deleteUser(id); } catch (e) { if (e && e.code !== 'auth/user-not-found') { results.push({ id, status: 'failed', error: e.code || 'AUTH_DELETE_FAILED' }); continue; } }
                    await db.collection('users').doc(id).delete().catch(() => null);
                    if (wipeStorage && bucket) {
                        const prefixes = [`user-uploads/${id}/`, `user-outputs/${id}/`];
                        for (const pfx of prefixes) {
                            const [files] = await bucket.getFiles({ prefix: pfx });
                            await Promise.all(files.map((f) => f.delete().catch(() => null)));
                        }
                    }
                    results.push({ id, status: 'ok' });
                } else if (action === 'credits' && ['image', 'video'].includes(category) && Number.isFinite(Number(amount))) {
                    const ref = db.collection('users').doc(id);
                    await db.runTransaction(async (tx) => {
                        const d = (await tx.get(ref)).data() || {};
                        const curImage = Number(d.imageCredits || d.credits?.image || d.credits_image || d.creditsBalance?.credits_image || 0) || 0;
                        const curVideo = Number(d.videoCredits || d.credits?.video || d.credits_video || d.creditsBalance?.credits_video || 0) || 0;
                        let afterImage = curImage, afterVideo = curVideo;
                        if (category === 'image') afterImage = curImage + Number(amount);
                        else afterVideo = curVideo + Number(amount);
                        tx.set(ref, {
                            imageCredits: afterImage,
                            videoCredits: afterVideo,
                            credits_image: afterImage,
                            credits_video: afterVideo,
                            creditsBalance: { credits_image: afterImage, credits_video: afterVideo },
                            credits: { ...(d.credits || {}), image: afterImage, video: afterVideo }
                        }, { merge: true });
                    });
                    results.push({ id, status: 'ok' });
                } else {
                    results.push({ id, status: 'failed', error: 'INVALID_ACTION' });
                }
            } catch (e) { results.push({ id, status: 'failed', error: e?.message || 'ERR' }); }
        }
        const succeeded = results.filter(r => r.status === 'ok').length; const failed = results.length - succeeded;
        return res.json({ ok: true, results, succeeded, failed });
    } catch (e) { return res.status(500).json({ ok: false, error: 'BULK_FAILED' }); }
});

// Lightweight metrics with short cache to avoid repeatedly scanning all Auth users
let __metricsCache = { at: 0, totalAuthUsers: 0 };
router.get('/metrics', requireAdmin, async (req, res) => {
    try {
        const force = String(req.query.force || 'false') === 'true';
        const now = Date.now();
        const maxAgeMs = 60 * 1000; // 60s cache
        if (!force && now - __metricsCache.at < maxAgeMs) {
            return res.json({ ok: true, totalAuthUsers: __metricsCache.totalAuthUsers, cached: true, ageMs: now - __metricsCache.at });
        }
        let count = 0; let pageToken = undefined; let rounds = 0;
        while (true) {
            const resp = await getAuth().listUsers(1000, pageToken);
            count += resp.users.length; rounds += 1;
            if (!resp.pageToken) break;
            pageToken = resp.pageToken;
            if (rounds > 1000) break; // absolute safety cap
        }
        __metricsCache = { at: now, totalAuthUsers: count };
        return res.json({ ok: true, totalAuthUsers: count, cached: false, ageMs: 0 });
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'METRICS_FAILED', message: e?.message });
    }
});

module.exports = router;

// Moderator role management
router.post('/:id/promote-moderator', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const user = await getAuth().getUser(id);
        const claims = user.customClaims || {};
        if (claims.moderator === true) return res.json({ ok: true, already: true });
        const nextClaims = { ...claims, moderator: true };
        await getAuth().setCustomUserClaims(id, nextClaims);
        await db.collection('activities').add({ userId: id, action: 'admin.promote.moderator', resource: 'user', meta: { promotedBy: req.adminUid }, timestamp: new Date(), adminId: req.adminUid });
        return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: 'PROMOTE_FAILED' }); }
});

router.post('/:id/demote-moderator', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const user = await getAuth().getUser(id);
        const claims = user.customClaims || {};
        if (!claims.moderator) return res.json({ ok: true, already: true });
        const nextClaims = { ...claims }; delete nextClaims.moderator;
        await getAuth().setCustomUserClaims(id, nextClaims);
        await db.collection('activities').add({ userId: id, action: 'admin.demote.moderator', resource: 'user', meta: { demotedBy: req.adminUid }, timestamp: new Date(), adminId: req.adminUid });
        return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: 'DEMOTE_FAILED' }); }
});
