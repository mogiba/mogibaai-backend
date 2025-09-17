// routes/adminRoute.js (SECURE UPDATED)
// Hardened admin APIs — ID token only, strict admin allowlist
// - Accepts only Firebase ID Token via Authorization: Bearer <idToken>
// - Admin check order: custom claim (decoded.admin === true) -> Firestore config allowlist -> ENV ADMIN_UIDS
// - Removed legacy x-uid and users.role fallbacks (avoid spoofing in prod)

const express = require('express');
const router = express.Router();
const { db, bucket, getSignedUrlForPath, admin } = require('../utils/firebaseUtils');
const { getAuth } = require('firebase-admin/auth');
const {
  getPendingDeletionItems,
  approveUserMediaDeletion,
  rejectUserMediaDeletion,
  autoDeletePending,
} = require('../utils/deleteUtils');

// ===== Strict admin guard (ID token required)
async function requireAdmin(req, res, next) {
  try {
    const authHeader = String(req.headers['authorization'] || '').trim();
    if (!authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'MISSING_ID_TOKEN' });
    }
    const idToken = authHeader.split(' ')[1];
    if (!idToken) return res.status(401).json({ error: 'INVALID_AUTH_HEADER' });

    const decoded = await getAuth().verifyIdToken(idToken);
    const uid = decoded && decoded.uid;
    if (!uid) return res.status(401).json({ error: 'TOKEN_VERIFY_FAILED' });

    // 1) Custom claim preferred
    if (decoded.admin === true || (decoded.customClaims && decoded.customClaims.admin === true)) {
      req.adminUid = uid;
      req.decodedToken = decoded;
      return next();
    }

    // 2) Firestore config allowlist: /config/admins { uids: ["uid1", ...] }
    try {
      const cfgDoc = await db.collection('config').doc('admins').get();
      if (cfgDoc.exists) {
        const cfg = cfgDoc.data() || {};
        const cfgUids = Array.isArray(cfg.uids) ? cfg.uids.map(String) : [];
        if (cfgUids.includes(uid)) {
          req.adminUid = uid;
          req.decodedToken = decoded;
          return next();
        }
      }
    } catch (e) {
      // continue to env allowlist
    }

    // 3) ENV allowlist (comma-separated) — optional
    const envAdmins = (process.env.ADMIN_UIDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (envAdmins.includes(uid)) {
      req.adminUid = uid;
      req.decodedToken = decoded;
      return next();
    }

    return res.status(403).json({ error: 'NOT_ADMIN' });
  } catch (e) {
    return res.status(401).json({ error: 'ADMIN_AUTH_FAILED' });
  }
}

/**
 * GET /api/admin/pending-requests
 * Return recent deletionRequests docs (status 'pending')
 */
router.get('/pending-requests', requireAdmin, async (req, res) => {
  try {
    const q = db
      .collection('deletionRequests')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'desc')
      .limit(100);
    const snap = await q.get();
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: 'PENDING_REQUESTS_FAILED' });
  }
});

/**
 * GET /api/admin/pending-items/:uid
 * Return the pending_deletion items for a specific user (for admin review UI)
 */
router.get('/pending-items/:uid', requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    if (!targetUid) return res.status(400).json({ error: 'MISSING_UID' });

    const items = await getPendingDeletionItems(targetUid);
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: 'PENDING_ITEMS_FAILED', message: e.message });
  }
});

/**
 * POST /api/admin/approve-deletion
 * body: { uid: string, fileIds?: string[] }
 * Approves deletion for user's pending items (or subset)
 */
router.post('/approve-deletion', requireAdmin, express.json(), async (req, res) => {
  try {
    const adminUid = req.adminUid;
    const { uid, fileIds } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'MISSING_UID' });

    const result = await approveUserMediaDeletion(uid, adminUid, { fileIds });

    // Mark deletionRequests approved
    try {
      const reqs = await db
        .collection('deletionRequests')
        .where('uid', '==', uid)
        .where('status', '==', 'pending')
        .get();
      const batch = db.batch();
      reqs.forEach((d) => batch.update(d.ref, { status: 'approved', reviewedBy: adminUid, reviewedAt: new Date() }));
      if (!reqs.empty) await batch.commit();
    } catch (_) { }

    // Audit
    try {
      await db.collection('adminActions').add({
        action: 'approve_deletion',
        admin: adminUid,
        uid,
        fileIds: fileIds || null,
        result,
        time: new Date(),
      });
    } catch (_) { }

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: 'APPROVE_FAILED', message: e.message });
  }
});

/**
 * POST /api/admin/reject-deletion
 * body: { uid: string, fileIds?: string[], reason?: string }
 * Rejects deletion (restores items)
 */
router.post('/reject-deletion', requireAdmin, express.json(), async (req, res) => {
  try {
    const adminUid = req.adminUid;
    const { uid, fileIds, reason } = req.body || {};
    if (!uid) return res.status(400).json({ error: 'MISSING_UID' });

    const result = await rejectUserMediaDeletion(uid, adminUid, { fileIds });

    // Mark deletionRequests rejected
    try {
      const reqs = await db
        .collection('deletionRequests')
        .where('uid', '==', uid)
        .where('status', '==', 'pending')
        .get();
      const batch = db.batch();
      reqs.forEach((d) =>
        batch.update(d.ref, {
          status: 'rejected',
          reviewedBy: adminUid,
          reviewedAt: new Date(),
          reason: reason || null,
        })
      );
      if (!reqs.empty) await batch.commit();
    } catch (_) { }

    // Audit
    try {
      await db.collection('adminActions').add({
        action: 'reject_deletion',
        admin: adminUid,
        uid,
        fileIds: fileIds || null,
        reason: reason || null,
        result,
        time: new Date(),
      });
    } catch (_) { }

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: 'REJECT_FAILED', message: e.message });
  }
});

/**
 * POST /api/admin/auto-purge
 * body: { cutoffDays?: number } (default 60)
 */
router.post('/auto-purge', requireAdmin, express.json(), async (req, res) => {
  try {
    const { cutoffDays } = req.body || {};
    const days = Number.isFinite(Number(cutoffDays)) ? Number(cutoffDays) : 60;
    const result = await autoDeletePending(days);

    // Audit
    try {
      await db.collection('adminActions').add({
        action: 'auto_purge_run',
        admin: req.adminUid,
        cutoffDays: days,
        resultSummary: { deletedCount: result.deletedCount || 0 },
        time: new Date(),
      });
    } catch (_) { }

    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: 'AUTO_PURGE_FAILED', message: e.message });
  }
});

/**
 * GET /api/admin/user/:uid/requests
 * Fetch all deletionRequests for a user (history)
 */
router.get('/user/:uid/requests', requireAdmin, async (req, res) => {
  try {
    const targetUid = req.params.uid;
    if (!targetUid) return res.status(400).json({ error: 'MISSING_UID' });

    const snap = await db
      .collection('deletionRequests')
      .where('uid', '==', targetUid)
      .orderBy('requestedAt', 'desc')
      .limit(200)
      .get();
    const items = [];
    snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: 'USER_REQUESTS_FAILED', message: e.message });
  }
});

// Metrics endpoint: GET /api/admin/metrics (server-rendered JSON acceptable)
router.get('/metrics', requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Jobs metrics
    const q = db.collection('jobs').where('updatedAt', '>=', since);
    const snap = await q.get();
    let created = 0, succeeded = 0, failed = 0, canceled = 0;
    const latencies = []; const attempts = [];
    snap.forEach((d) => {
      const j = d.data();
      created += 1;
      if (j.status === 'succeeded') succeeded += 1;
      else if (j.status === 'failed') failed += 1;
      else if (j.status === 'canceled') canceled += 1;
      const l = j?.metrics?.createLatencyMs;
      if (Number.isFinite(Number(l))) latencies.push(Number(l));
      const a = j?.metrics?.replicateCreateAttempts;
      if (Number.isFinite(Number(a))) attempts.push(Number(a));
    });
    latencies.sort((a, b) => a - b);
    const p = (arr, pct) => arr.length ? arr[Math.min(arr.length - 1, Math.floor((pct / 100) * arr.length))] : null;
    const p50 = p(latencies, 50);
    const p95 = p(latencies, 95);
    const avgAttempts = attempts.length ? (attempts.reduce((s, x) => s + x, 0) / attempts.length) : null;

    // Moderation rejects
    const modSnap = await db.collection('moderationEvents').where('createdAt', '>=', since).get();
    const moderationRejects = modSnap.size;

    // 402 / 429 events from apiEvents
    let lowCredits = 0, rateLimited = 0;
    try {
      const evSnap = await db.collection('apiEvents').where('createdAt', '>=', since).get();
      evSnap.forEach((d) => {
        const t = d.data().type;
        if (t === 'LOW_CREDITS') lowCredits += 1;
        else if (t === 'RATE_LIMITED' || t === 'RATE_LIMITED_IP') rateLimited += 1;
      });
    } catch (_) { }

    const data = { windowHours: 24, created, succeeded, failed, canceled, moderationRejects, lowCredits402: lowCredits, rateLimited429: rateLimited, p50CreateLatencyMs: p50, p95CreateLatencyMs: p95, avgCreateAttempts: avgAttempts };

    if ((req.headers['accept'] || '').includes('text/html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<pre>${JSON.stringify({ ok: true, metrics: data }, null, 2)}</pre>`);
    }
    return res.json({ ok: true, metrics: data });
  } catch (e) {
    return res.status(500).json({ error: 'METRICS_FAILED', message: e.message });
  }
});

module.exports = router;

/**
 * GET /api/admin/maintenance/backfill-gallery?uid=...
 * Admin-only backfill: scans Storage at user-outputs/${uid}/** and creates missing docs under users/${uid}/images
 */
router.get('/maintenance/backfill-gallery', requireAdmin, async (req, res) => {
  try {
    const targetUid = (req.query.uid || '').toString().trim();
    if (!targetUid) return res.status(400).json({ ok: false, error: 'MISSING_UID' });
    if (!bucket) return res.status(500).json({ ok: false, error: 'NO_BUCKET' });

    const prefix = `user-outputs/${targetUid}/`;
    let pageToken = undefined; let created = 0; let scanned = 0;
    const createdIds = [];
    do {
      const [files, nextQuery] = await bucket.getFiles({ prefix, autoPaginate: false, maxResults: 200, pageToken });
      for (const f of files) {
        scanned += 1;
        const storagePath = f.name;
        const ct = (f.metadata && f.metadata.contentType) || '';
        if (ct && !ct.startsWith('image/')) continue;
        const gid = storagePath.split('/').slice(-1)[0].replace(/\.[^.]+$/, '');
        const ref = db.collection('users').doc(targetUid).collection('images').doc(gid);
        const exist = await ref.get();
        if (exist.exists) continue;
        let signed = null; try { signed = await getSignedUrlForPath(storagePath); } catch { }
        const createdAt = f.metadata && f.metadata.timeCreated ? new Date(f.metadata.timeCreated) : new Date();
        await ref.set({
          uid: targetUid,
          jobId: null,
          tool: 'text2img',
          storagePath,
          downloadURL: signed?.url || null,
          caption: '', tags: [], visibility: 'private', status: 'approved',
          size: null, aspect_ratio: null,
          createdAt: admin.firestore.Timestamp.fromDate(createdAt),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        created += 1; createdIds.push(gid);
      }
      pageToken = nextQuery && nextQuery.pageToken;
    } while (pageToken);

    return res.json({ ok: true, scanned, created, createdIds });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'BACKFILL_FAILED', message: e?.message });
  }
});
