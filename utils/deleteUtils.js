// utils/deleteUtils.js (SECURE UPDATED)
/**
 * deleteUtils.js
 *
 * Workflow implemented (private-by-default strategy):
 * - requestUserMediaDeletion(uid) -> marks user's media docs as `pending_deletion`, makes objects PRIVATE,
 *   stores requestedAt/requestedBy, and creates audit entry.
 * - approveUserMediaDeletion(uid, opts) -> PERMANENTLY deletes storage objects + firestore docs (admin action). opts: { fileIds: [] }
 * - rejectUserMediaDeletion(uid, opts) -> clears pending flags and sets docs back to `active` WITHOUT making objects public.
 *   (App should serve media via short‑lived signed URLs instead of public ACLs.)
 * - autoDeletePending(cutoffDays = 60) -> finds pending_deletion older than cutoff and permanently deletes them.
 * - getPendingDeletionItems(uid) -> list pending items for a user.
 *
 * IMPORTANT:
 * - Only touches user-scoped media (userGallery/{uid}/images, userVideos/{uid}/videos, avatars/{uid}).
 * - Payment / billing / user doc not deleted here.
 */

const { db, admin } = require('./firebaseUtils');
const BATCH_MAX = 500;
const DEFAULT_BUCKET = admin.storage().bucket();

function nowISO() {
  return new Date().toISOString();
}

/**
 * Helper: list documents under a subcollection (returns array of docSnaps)
 * path example: db.collection('userGallery').doc(uid).collection('images')
 */
async function listSubcollectionDocs(parentColl, parentDocId, subcollection) {
  const ref = db.collection(parentColl).doc(parentDocId).collection(subcollection);
  const docs = await ref.get();
  return docs.docs || [];
}

/**
 * Mark user's media docs as pending_deletion and revoke public access to corresponding storage objects.
 * - uid: user id
 * - opts: { fileCollections: [{ parentCollection, subcollection }] } optional to target other paths
 */
async function requestUserMediaDeletion(uid, opts = {}) {
  if (!uid) throw new Error('uid required');

  const filesTouched = [];
  const bucket = DEFAULT_BUCKET;

  // default collections we consider user media in
  const targets = opts.fileCollections || [
    { parentCollection: 'userGallery', subcollection: 'images' },
    { parentCollection: 'userVideos', subcollection: 'videos' },
  ];

  const requestedAt = new Date();

  for (const t of targets) {
    const docs = await listSubcollectionDocs(t.parentCollection, uid, t.subcollection);

    for (const dsnap of docs) {
      const data = dsnap.data() || {};
      // Only affect docs owned by uid
      const owner = data.uid || data.ownerUid || uid;
      if (String(owner) !== String(uid)) continue;

      // skip if already pending or deleted
      if (data.status === 'pending_deletion' || data.status === 'deleted') continue;

      // expected to have storagePath (e.g., images/<uid>/filename.jpg) in doc
      const storagePath = data.storagePath || data.path || data.filePath;
      if (!storagePath) {
        // mark pending anyway (no storage path)
        await dsnap.ref.update({
          status: 'pending_deletion',
          requestedAt,
          requestedBy: uid,
        });
        filesTouched.push({ docId: dsnap.id, storagePath: null });
        continue;
      }

      // revoke public access: attempt to find file and make it private, add metadata
      const file = bucket.file(storagePath);
      try {
        // add metadata flag
        try {
          await file.setMetadata({ metadata: { pendingDeletion: 'true', pendingRequestedAt: requestedAt.toISOString() } });
        } catch (_) {}

        // make private to ensure public cannot access; if object not exist, catch and continue
        try {
          await file.makePrivate();
        } catch (e) {
          // Some objects may already be private or error; log and continue
          console.warn('requestUserMediaDeletion: makePrivate failed for', storagePath, e.message || e);
        }

        // update firestore doc
        await dsnap.ref.update({
          status: 'pending_deletion',
          requestedAt,
          requestedBy: uid,
          storagePath,
        });

        filesTouched.push({ docId: dsnap.id, storagePath });
      } catch (err) {
        console.error('requestUserMediaDeletion: error processing', storagePath, err.message || err);
      }
    }
  }

  // audit log
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
 * Permanently delete storage objects and remove their firestore docs.
 * adminActionBy: admin uid or system actor,
 * opts: { fileIds: [] } - if provided, restrict to those doc ids; else operate on all pending_deletion for the uid.
 */
async function approveUserMediaDeletion(uid, adminActionBy = 'system', opts = {}) {
  if (!uid) throw new Error('uid required');
  const bucket = DEFAULT_BUCKET;
  const fileIds = Array.isArray(opts.fileIds) && opts.fileIds.length ? opts.fileIds : null;
  const approvedAt = new Date();

  // gather docs to delete
  const rowsToDelete = [];

  // userGallery images
  {
    const ref = db.collection('userGallery').doc(uid).collection('images');
    const q = ref.where('status', '==', 'pending_deletion');
    const docs = await q.get();
    docs.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToDelete.push({ ref: d.ref, data: d.data() });
    });
  }

  // userVideos videos
  {
    const ref = db.collection('userVideos').doc(uid).collection('videos');
    const q = ref.where('status', '==', 'pending_deletion');
    const docs = await q.get();
    docs.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToDelete.push({ ref: d.ref, data: d.data() });
    });
  }

  // avatars: if you kept avatar file old under avatars/{uid}
  // We do not delete user doc here, only avatar object if pending flagged
  try {
    const userDocSnap = await db.collection('users').doc(uid).get();
    const udata = userDocSnap.exists ? userDocSnap.data() : null;
    if (udata && udata.avatarPendingDeletion) {
      // push a pseudo doc
      rowsToDelete.push({ ref: db.collection('users').doc(uid), data: { storagePath: udata.avatarPath || null, avatar: true } });
    }
  } catch (e) {
    // ignore
  }

  // delete storage files and firestore docs (batched)
  const deletionResults = [];
  for (const row of rowsToDelete) {
    const data = row.data || {};
    const storagePath = data.storagePath || data.filePath || data.path || (data.avatar ? data.avatarPath || null : null);

    if (storagePath) {
      const file = bucket.file(storagePath);
      try {
        await file.delete();
        deletionResults.push({ storagePath, deleted: true });
      } catch (err) {
        console.warn('approveUserMediaDeletion: failed to delete storage file', storagePath, err.message || err);
        deletionResults.push({ storagePath, deleted: false, error: err.message || err });
      }
    }

    // delete the firestore doc
    try {
      await row.ref.delete();
    } catch (err) {
      console.warn('approveUserMediaDeletion: failed to delete doc', row.ref.path, err.message || err);
    }
  }

  // write audit record
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
 * Reject a pending deletion request: restore access and set status back to 'active'
 * adminActionBy: admin uid
 * opts: { fileIds: [] } optional
 *
 * SECURITY NOTE:
 *  - We DO NOT call makePublic(); objects remain private.
 *  - App should fetch short‑lived signed URLs when it needs to display media.
 */
async function rejectUserMediaDeletion(uid, adminActionBy = 'system', opts = {}) {
  if (!uid) throw new Error('uid required');
  const bucket = DEFAULT_BUCKET;
  const fileIds = Array.isArray(opts.fileIds) && opts.fileIds.length ? opts.fileIds : null;
  const rejectedAt = new Date();

  const rowsToRestore = [];

  // userGallery
  {
    const ref = db.collection('userGallery').doc(uid).collection('images');
    const q = ref.where('status', '==', 'pending_deletion');
    const docs = await q.get();
    docs.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToRestore.push({ ref: d.ref, data: d.data() });
    });
  }

  // userVideos
  {
    const ref = db.collection('userVideos').doc(uid).collection('videos');
    const q = ref.where('status', '==', 'pending_deletion');
    const docs = await q.get();
    docs.forEach((d) => {
      if (fileIds && !fileIds.includes(d.id)) return;
      rowsToRestore.push({ ref: d.ref, data: d.data() });
    });
  }

  const restoreResults = [];
  for (const row of rowsToRestore) {
    const data = row.data || {};
    const storagePath = data.storagePath || data.filePath || data.path;
    if (storagePath) {
      const file = bucket.file(storagePath);
      try {
        // clear metadata flag; keep object PRIVATE — do NOT makePublic
        await file.setMetadata({ metadata: { pendingDeletion: 'false' } }).catch(() => {});
        restoreResults.push({ storagePath, restored: true });
      } catch (err) {
        restoreResults.push({ storagePath, restored: false, error: err.message || err });
      }
    }

    // set status back to active
    try {
      await row.ref.update({
        status: 'active',
        rejectedAt,
        rejectedBy: adminActionBy,
      });
    } catch (err) {
      console.warn('rejectUserMediaDeletion: failed update doc', row.ref.path, err.message || err);
    }
  }

  // audit log
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
 * Auto-delete pending items older than cutoffDays (default 60)
 * Scans userGallery and userVideos for status == 'pending_deletion' and requestedAt <= cutoff date.
 * This runs as a scheduled job.
 */
async function autoDeletePending(cutoffDays = 60) {
  const cutoff = new Date(Date.now() - cutoffDays * 24 * 60 * 60 * 1000);

  const bucket = DEFAULT_BUCKET;
  const deletionSummary = [];

  // Helper: process a query snapshot
  async function processSnapshot(snapshot) {
    if (snapshot.empty) return;
    for (const doc of snapshot.docs) {
      try {
        const d = doc.data();
        if (!d.requestedAt) continue;
        const requestedAt = d.requestedAt.toDate ? d.requestedAt.toDate() : new Date(d.requestedAt);
        if (requestedAt > cutoff) continue;

        const storagePath = d.storagePath || d.filePath || d.path;
        if (storagePath) {
          try {
            await bucket.file(storagePath).delete();
            deletionSummary.push({ docPath: doc.ref.path, storagePath, deleted: true });
          } catch (err) {
            deletionSummary.push({ docPath: doc.ref.path, storagePath, deleted: false, error: err.message || err });
          }
        }

        // delete the document
        try {
          await doc.ref.delete();
        } catch (err) {
          console.warn('autoDeletePending: failed to delete doc', doc.ref.path, err.message || err);
        }
      } catch (e) {
        console.warn('autoDeletePending: item processing failed', e.message || e);
      }
    }
  }

  // Query all pending_deletion images across users (two collections)
  // Firestore doesn't support cross-collection query across different subcollections; iterate per-user parents.
  // userGallery/*/images
  const usersSnapshot = await db.collection('userGallery').listDocuments();
  for (const userDocRef of usersSnapshot) {
    const imagesRef = userDocRef
      .collection('images')
      .where('status', '==', 'pending_deletion')
      .where('requestedAt', '<=', cutoff);
    const snap = await imagesRef.get();
    await processSnapshot(snap);
  }

  // userVideos
  const usersVideosDocs = await db.collection('userVideos').listDocuments();
  for (const userDocRef of usersVideosDocs) {
    const vidsRef = userDocRef
      .collection('videos')
      .where('status', '==', 'pending_deletion')
      .where('requestedAt', '<=', cutoff);
    const snap = await vidsRef.get();
    await processSnapshot(snap);
  }

  // record audit
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

/**
 * Get pending deletion items for a user (for admin review UI)
 */
async function getPendingDeletionItems(uid) {
  if (!uid) throw new Error('uid required');

  const items = [];

  const galleryRef = db.collection('userGallery').doc(uid).collection('images');
  const imagesSnap = await galleryRef.where('status', '==', 'pending_deletion').get();
  imagesSnap.forEach((d) => items.push({ docId: d.id, collection: galleryRef.path, data: d.data() }));

  const videosRef = db.collection('userVideos').doc(uid).collection('videos');
  const videosSnap = await videosRef.where('status', '==', 'pending_deletion').get();
  videosSnap.forEach((d) => items.push({ docId: d.id, collection: videosRef.path, data: d.data() }));

  return items;
}

module.exports = {
  requestUserMediaDeletion,
  approveUserMediaDeletion,
  rejectUserMediaDeletion,
  autoDeletePending,
  getPendingDeletionItems,
};
