// routes/userRoute.js (SECURE UPDATED v2 – short‑lived URLs)
// Drop-in replacement for Mogibaai backend
// Changes vs original:
//  - Strong auth via Firebase ID Token (Authorization: Bearer <idToken>)
//  - Removed insecure x-uid header auth
//  - Private-by-default media model (aligns with deleteUtils)
//  - Short‑lived signed URLs for avatar + helper to refresh file URLs

const express = require('express');
const { getAuth } = require('firebase-admin/auth');
const { db, getSignedUrlForPath } = require('../utils/firebaseUtils');
const {
  requestUserMediaDeletion,
  approveUserMediaDeletion, // (not used directly here; kept for parity)
  rejectUserMediaDeletion,
  deleteUserData,
  deleteAuthUser,
  getPendingDeletionItems,
} = require('../utils/deleteUtils');

const router = express.Router();

// ===== Strong auth middleware using Firebase ID token
// Requires header: Authorization: Bearer <idToken>
async function requireAuth(req, res, next) {
  try {
    const authHeader = String(req.headers['authorization'] || '').trim();
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return res.status(401).json({ error: 'MISSING_ID_TOKEN' });
    }
    const idToken = authHeader.split(' ')[1];
    if (!idToken) return res.status(401).json({ error: 'INVALID_AUTH_HEADER' });

    const decoded = await getAuth().verifyIdToken(idToken);
    if (!decoded || !decoded.uid) return res.status(401).json({ error: 'TOKEN_VERIFY_FAILED' });

    req.uid = decoded.uid;
    req.decodedToken = decoded; // optional downstream use
    return next();
  } catch (err) {
    console.warn('requireAuth verify error:', err?.message || err);
    return res.status(401).json({ error: 'INVALID_ID_TOKEN' });
  }
}

// -------------------------
// GET /api/user/profile
// -------------------------
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const userDoc = await db.collection('users').doc(uid).get();
    const user = userDoc.exists ? userDoc.data() : {};

    // compute spent credits (sum of paid orders' credits)
    const ordersSnap = await db
      .collection('razorpayOrders')
      .where('uid', '==', uid)
      .where('status', '==', 'paid')
      .get();

    let spentCredits = 0;
    ordersSnap.forEach((d) => {
      const c = Number(d.data().credits || 0);
      if (!isNaN(c)) spentCredits += c;
    });

    // pending deletion counts (optional)
    let pendingCount = 0;
    try {
      const pending = await getPendingDeletionItems(uid);
      pendingCount = Array.isArray(pending) ? pending.length : 0;
    } catch (_) {
      // ignore if helper fails
    }

    const profile = {
      uid,
      nickname: user.nickname || '',
      email: user.email || '',
      avatarUrl: user.avatarUrl || req.decodedToken.picture || null,
      avatarUrlExpiresAt: user.avatarUrlExpiresAt || null,
      subscription: user.subscription || { tier: 'Free' },
      creditsBalance: user.creditsBalance || 0,
      spentCredits,
      pendingDeletionCount: pendingCount,
    };

    return res.json({ ok: true, user: profile });
  } catch (e) {
    console.error('profile error', e);
    return res.status(500).json({ error: 'PROFILE_ERROR' });
  }
});

// -------------------------
// POST /api/user/update-profile
// body: { nickname?: string, avatarUrl?: string }
// -------------------------
router.post('/update-profile', requireAuth, express.json(), async (req, res) => {
  try {
    const uid = req.uid;
    const { nickname, avatarUrl } = req.body || {};
    const update = {};

    if (nickname !== undefined) update.nickname = String(nickname).slice(0, 100);
    if (avatarUrl !== undefined) update.avatarUrl = String(avatarUrl);

    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'NO_FIELDS' });

    await db.collection('users').doc(uid).set(update, { merge: true });
    return res.json({ ok: true, updated: update });
  } catch (e) {
    console.error('update-profile error', e);
    return res.status(500).json({ error: 'UPDATE_PROFILE_FAILED' });
  }
});

// -------------------------
// POST /api/user/refresh-file-url
// body: { storagePath: string, ttlMs?: number }
// returns short‑lived signed URL for a private file path you own
// -------------------------
router.post('/refresh-file-url', requireAuth, express.json(), async (req, res) => {
  try {
    const uid = req.uid;
    const { storagePath, ttlMs } = req.body || {};
    if (!storagePath) return res.status(400).json({ error: 'MISSING_STORAGE_PATH' });

    // Simple ownership check for common prefixes
    const allowedPrefixes = [
      `images/${uid}/`,
      `avatars/${uid}`,
      `videos/${uid}/`,
    ];
    const okPrefix = allowedPrefixes.some((p) => String(storagePath).startsWith(p));
    if (!okPrefix) return res.status(403).json({ error: 'FORBIDDEN_PATH' });

    const { url, expiresAt } = await getSignedUrlForPath(storagePath, { ttlMs });
    return res.json({ ok: true, url, expiresAt });
  } catch (e) {
    console.error('refresh-file-url error', e);
    return res.status(500).json({ error: 'REFRESH_URL_FAILED', message: e.message });
  }
});

// -------------------------
// POST /api/user/request-media-deletion
// body: { confirm: true }  (user must confirm)
// - Marks media docs as pending_deletion and revokes public access
// -------------------------
router.post('/request-media-deletion', requireAuth, express.json(), async (req, res) => {
  try {
    const uid = req.uid;
    const { confirm } = req.body || {};
    if (!confirm) return res.status(400).json({ error: 'CONFIRM_REQUIRED' });

    const result = await requestUserMediaDeletion(uid);
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('request-media-deletion error', e);
    return res.status(500).json({ error: 'REQUEST_MEDIA_DELETION_FAILED', message: e.message });
  }
});

// -------------------------
// POST /api/user/cancel-media-deletion
// body: { }  (user cancels their own pending deletion requests)
// - This will attempt to restore items in pending_deletion back to active for this user.
// -------------------------
router.post('/cancel-media-deletion', requireAuth, express.json(), async (req, res) => {
  try {
    const uid = req.uid;
    const result = await rejectUserMediaDeletion(uid, `user_cancel_${uid}`, {});
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('cancel-media-deletion error', e);
    return res.status(500).json({ error: 'CANCEL_MEDIA_DELETION_FAILED', message: e.message });
  }
});

// -------------------------
// GET /api/user/pending-deletions
// returns items pending deletion for this user (for user dashboard)
// -------------------------
router.get('/pending-deletions', requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const items = await getPendingDeletionItems(uid);
    return res.json({ ok: true, items });
  } catch (e) {
    console.error('pending-deletions error', e);
    return res.status(500).json({ error: 'PENDING_FETCH_FAILED', message: e.message });
  }
});

// -------------------------
// POST /api/user/delete-account
// body: { confirm: true, confirmText?: 'DELETE', removeAuth?: boolean }
// WARNING: destructive. This deletes user's media + user doc and (optionally) auth account.
// Payment records are preserved as per policy.
// -------------------------
router.post('/delete-account', requireAuth, express.json(), async (req, res) => {
  try {
    const uid = req.uid;
    const { confirm, confirmText, removeAuth } = req.body || {};

    if (!confirm) return res.status(400).json({ error: 'CONFIRM_REQUIRED' });
    if (confirmText && String(confirmText).trim() !== 'DELETE') {
      return res.status(400).json({ error: 'CONFIRM_TEXT_MISMATCH' });
    }

    await db.collection('users').doc(uid).set({ deleting: true }, { merge: true });

    try {
      await deleteUserData(uid);
    } catch (err) {
      console.warn('delete-account: deleteUserData failed', err.message || err);
    }

    if (removeAuth) {
      try {
        await deleteAuthUser(uid);
      } catch (err) {
        console.warn('delete-account: deleteAuthUser failed', err.message || err);
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('delete-account failed', e);
    return res.status(500).json({ error: 'DELETE_FAILED', message: e.message });
  }
});

module.exports = router;
