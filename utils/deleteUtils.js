// utils/deleteUtils.js (SAFE, lazy bucket)
// Private-by-default media deletion workflow.
// Uses utils/firebaseUtils.getBucket() so server won't crash at require-time.

'use strict';

const { db, getBucket } = require('./firebaseUtils');
const BATCH_MAX = 500;

function nowISO() {
  return new Date().toISOString();
}

/** Firestore subcollection list helper */
async function listSubcollectionDocs(parentColl, parentDocId, subcollection) {
  const ref = db.collection(parentColl).doc(parentDocId).collection(subcollection);
  const snap = await ref.get();
  return snap.docs || [];
}

/**
 * Step 1: Mark user's media docs as pending_deletion and make storage objects private.
 * opts.fileCollections?: [{ parentCollection, subcollection }]
 */
async function requestUserMediaDeletion(uid, opts = {}) {
  if (!uid) throw new Error('uid required');

  const bucket = getBucket(); // lazy: throws a clear error if bucket not configured
  const filesTouched = [];

  const targets = opts.fileCollections || [
    { parentCollection: 'userGallery', subcollection: 'images' },
    { parentCollection: 'userVideos',  subcollection: 'videos' },
  ];

  const requestedAt = new Date();

  for (const t of targets) {
    const docs = await listSubcollectionDocs(t.parentCollection, uid, t.subcollection);

    for (const dsnap of docs) {
      const data = dsnap.data() || {};
      const owner = data.uid || data.ownerUid || uid;
      if (String(owner) !== String(uid)) continue;

      if (data.status === 'pending_deletion' || data.status === 'deleted') continue;

      const storagePath = data.storagePath || data.path || data.filePath;

      if (!storagePath) {
        await dsnap.ref.update({
          status: 'pending_deletion',
          requestedAt,
          requestedBy: uid,
        });
        filesTouched.push({ docId: dsnap.id, storagePath: null });
        continue;
      }

      const file = bucket.file(storagePath);
      try {
        // add metadata flag (best-effort)
        await file.setMetadata({
          metadata: {
            pendingDeletion: 'true',
            pendingRequestedAt: requestedAt.toISOString(),
          },
        }).catch(() => {});

        // ensure object is private (best-effort)
        await file.makePrivate().catch(() => {});

        await dsnap.ref.update({
          status: 'pending_deletion',
          requestedAt,
          requestedBy: uid,
          storagePath,
        });

        filesTouched.push({ docId: dsnap.id, storagePath });
      } catch (err) {
        console.warn('requestUserMediaDeletion:', storagePath, err.message || err);
      }
    }
  }

  // audit
  try {
    await db.collection('deletionRequests').add({
      uid,
      type: 'media_request',
      targetsCount: filesTouched.length,
      requestedAt,
      status: 'pending',
    });
  } catch (e) {
    console.warn('requestUserMediaDeletion: audit log failed', e.message || e);
  }

  return { ok: true, requestedAt, filesTouchedCount: filesTouched.length, filesTouched };
}

/**
 * Step 2: Permanently delete (ADMIN).
 * opts.fileIds?: restrict to those doc IDs.
 */
async function approveUserMediaDeletion(uid, adminActionBy = 'system', opts = {}) {
  if (!uid) throw new Error('uid required');

  const bucket = getBucket();
  const fileIds = Array.isArray(opts.fileIds) && opts.fileIds.length ? opts.fileIds : null;
  const approvedAt = new Date();

  const rowsToDelete = [];

  // userGallery
  {
    const ref = db.collection('userGallery').doc(uid).collection('images');
    const q = ref.where('status', '==', 'pending_deletion');
    const snap = await q.get();
    snap.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToDelete.push({ ref: d.ref, data: d.data() });
    });
  }

  // userVideos
  {
    const ref = db.collection('userVideos').doc(uid).collection('videos');
    const q = ref.where('status', '==', 'pending_deletion');
    const snap = await q.get();
    snap.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToDelete.push({ ref: d.ref, data: d.data() });
    });
  }

  // optional avatar cleanup (flagged on users doc)
  try {
    const uSnap = await db.collection('users').doc(uid).get();
    const u = uSnap.exists ? uSnap.data() : null;
    if (u && u.avatarPendingDeletion) {
      rowsToDelete.push({
        ref: db.collection('users').doc(uid),
        data: { storagePath: u.avatarPath || null, avatar: true },
      });
    }
  } catch {}

  const deletionResults = [];
  for (const row of rowsToDelete) {
    const d = row.data || {};
    const storagePath =
      d.storagePath || d.filePath || d.path || (d.avatar ? d.avatarPath || null : null);

    if (storagePath) {
      try {
        await bucket.file(storagePath).delete();
        deletionResults.push({ storagePath, deleted: true });
      } catch (err) {
        deletionResults.push({ storagePath, deleted: false, error: err.message || err });
      }
    }

    try {
      await row.ref.delete();
    } catch (err) {
      console.warn('approveUserMediaDeletion: delete doc failed', row.ref.path, err.message || err);
    }
  }

  // audit
  try {
    await db.collection('deletionApprovals').add({
      uid,
      approvedBy: adminActionBy,
      approvedAt,
      itemsCount: rowsToDelete.length,
      results: deletionResults,
      action: 'approved',
    });
  } catch (e) {
    console.warn('approveUserMediaDeletion: audit log failed', e.message || e);
  }

  return { ok: true, deletedCount: rowsToDelete.length, details: deletionResults };
}

/**
 * Step 3: Reject deletion (ADMIN) – set status back to 'active'.
 * Objects remain PRIVATE (no makePublic).
 */
async function rejectUserMediaDeletion(uid, adminActionBy = 'system', opts = {}) {
  if (!uid) throw new Error('uid required');

  const bucket = getBucket();
  const fileIds = Array.isArray(opts.fileIds) && opts.fileIds.length ? opts.fileIds : null;
  const rejectedAt = new Date();

  const rowsToRestore = [];

  // userGallery
  {
    const ref = db.collection('userGallery').doc(uid).collection('images');
    const q = ref.where('status', '==', 'pending_deletion');
    const snap = await q.get();
    snap.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToRestore.push({ ref: d.ref, data: d.data() });
    });
  }

  // userVideos
  {
    const ref = db.collection('userVideos').doc(uid).collection('videos');
    const q = ref.where('status', '==', 'pending_deletion');
    const snap = await q.get();
    snap.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToRestore.push({ ref: d.ref, data: d.data() });
    });
  }

  const restoreResults = [];
  for (const row of rowsToRestore) {
    const data = row.data || {};
    const storagePath = data.storagePath || data.filePath || data.path;

    if (storagePath) {
      try {
        await bucket.file(storagePath).setMetadata({
          metadata: { pendingDeletion: 'false' },
        }).catch(() => {});
        // keep private
        restoreResults.push({ storagePath, restored: true });
      } catch (err) {
        restoreResults.push({ storagePath, restored: false, error: err.message || err });
      }
    }

    try {
      await row.ref.update({
        status: 'active',
        rejectedAt,
        rejectedBy: adminActionBy,
      });
    } catch (err) {
      console.warn('rejectUserMediaDeletion: update failed', row.ref.path, err.message || err);
    }
  }

  try {
    await db.collection('deletionApprovals').add({
      uid,
      action: 'rejected',
      rejectedBy: adminActionBy,
      rejectedAt,
      itemsCount: rowsToRestore.length,
      results: restoreResults,
    });
  } catch (e) {
    console.warn('rejectUserMediaDeletion: audit log failed', e.message || e);
  }

  return { ok: true, restoredCount: rowsToRestore.length, details: restoreResults };
}

/**
 * Cron: auto delete pending items older than cutoffDays (default 60).
 */
async function autoDeletePending(cutoffDays = 60) {
  const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000);
  const bucket = getBucket();
  const deletionSummary = [];

  async function processSnapshot(snapshot) {
    if (!snapshot || snapshot.empty) return;
    for (const doc of snapshot.docs) {
      try {
        const d = doc.data() || {};
        const reqAt = d.requestedAt?.toDate ? d.requestedAt.toDate() : (d.requestedAt ? new Date(d.requestedAt) : null);
        if (!reqAt || reqAt > cutoff) continue;

        const storagePath = d.storagePath || d.filePath || d.path;
        if (storagePath) {
          try {
            await bucket.file(storagePath).delete();
            deletionSummary.push({ docPath: doc.ref.path, storagePath, deleted: true });
          } catch (err) {
            deletionSummary.push({ docPath: doc.ref.path, storagePath, deleted: false, error: err.message || err });
          }
        }

        await doc.ref.delete().catch(() => {});
      } catch (e) {
        console.warn('autoDeletePending: processing failed', e.message || e);
      }
    }
  }

  // userGallery/*/images
  const galleryUsers = await db.collection('userGallery').listDocuments();
  for (const userRef of galleryUsers) {
    const q = userRef.collection('images')
      .where('status', '==', 'pending_deletion')
      .where('requestedAt', '<=', cutoff);
    const snap = await q.get();
    await processSnapshot(snap);
  }

  // userVideos/*/videos
  const videoUsers = await db.collection('userVideos').listDocuments();
  for (const userRef of videoUsers) {
    const q = userRef.collection('videos')
      .where('status', '==', 'pending_deletion')
      .where('requestedAt', '<=', cutoff);
    const snap = await q.get();
    await processSnapshot(snap);
  }

  try {
    await db.collection('deletionApprovals').add({
      action: 'auto_purge',
      cutoffDays,
      runAt: new Date(),
      summaryCount: deletionSummary.length,
      detailsSample: deletionSummary.slice(0, 50),
    });
  } catch (e) {
    console.warn('autoDeletePending: audit log failed', e.message || e);
  }

  return { ok: true, deletedCount: deletionSummary.length, details: deletionSummary };
}

/** Admin UI helper: list pending items for a user */
async function getPendingDeletionItems(uid) {
  if (!uid) throw new Error('uid required');

  const items = [];

  const gRef = db.collection('userGallery').doc(uid).collection('images');
  const gSnap = await gRef.where('status', '==', 'pending_deletion').get();
  gSnap.forEach((d) => items.push({ docId: d.id, collection: gRef.path, data: d.data() }));

  const vRef = db.collection('userVideos').doc(uid).collection('videos');
  const vSnap = await vRef.where('status', '==', 'pending_deletion').get();
  vSnap.forEach((d) => items.push({ docId: d.id, collection: vRef.path, data: d.data() }));

  return items;
}

module.exports = {
  requestUserMediaDeletion,
  approveUserMediaDeletion,
  rejectUserMediaDeletion,
  autoDeletePending,
  getPendingDeletionItems,
};
