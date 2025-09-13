// services/creditsService.js
// Credits read/add/spend with Firestore (Firebase Admin).
//
// Collections:
//   users/{uid} -> { credits_image, credits_video, createdAt, updatedAt }
//   creditTransactions/{autoId} -> { uid, type: 'spend'|'topup'|'adjust',
//                                    category: 'image'|'video', qty, before, after,
//                                    meta?, createdAt }
//
// Exports:
//   getUserCredits(uid) -> { image, video }
//   addCredits(uid, category, qty, meta?) -> { image, video }
//   spendCredit(uid, category, qty) -> { image, video }  (throws if insufficient)

const path = require('path');
const admin = require('firebase-admin');

/* ---------------- Firebase Admin bootstrap (safe & idempotent) ---------------- */
function ensureAdmin() {
  if (admin.apps.length) return admin;

  // 1) Try service account json at ./secrets/serviceAccount.json (common layout)
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const sa = require(path.join(__dirname, '..', 'secrets', 'serviceAccount.json'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } catch (_) {
    // 2) Fall back to Application Default Credentials (ADC)
    // Works on GCP or when GOOGLE_APPLICATION_CREDENTIALS is set.
    admin.initializeApp();
  }
  return admin;
}

const appAdmin = ensureAdmin();
const db = appAdmin.firestore();
const { FieldValue } = appAdmin.firestore;

/* ---------------- Helpers ---------------- */
const CAT_IMG = 'image';
const CAT_VID = 'video';
const NOW = () => FieldValue.serverTimestamp();

function normCategory(c = CAT_IMG) {
  c = String(c || CAT_IMG).toLowerCase();
  return c === CAT_VID ? CAT_VID : CAT_IMG;
}
function normQty(q = 1) {
  q = Number.parseInt(q, 10);
  return Number.isFinite(q) && q > 0 ? q : 1;
}
function toShape(doc) {
  const d = doc || {};
  const image = Number.parseInt(d.credits_image ?? d.image ?? 0, 10) || 0;
  const video = Number.parseInt(d.credits_video ?? d.video ?? 0, 10) || 0;
  return { image, video };
}

async function ensureUserDoc(uid) {
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(
      { credits_image: 0, credits_video: 0, createdAt: NOW(), updatedAt: NOW() },
      { merge: true }
    );
    return { ref, data: { credits_image: 0, credits_video: 0 } };
  }
  return { ref, data: snap.data() || {} };
}

async function logTxn({ uid, type, category, qty, before, after, meta }) {
  const txRef = db.collection('creditTransactions').doc();
  const payload = {
    uid,
    type,
    category,
    qty,
    before,
    after,
    meta: meta || null,
    createdAt: NOW(),
  };
  await txRef.set(payload);
}

/* ---------------- Public API ---------------- */

/** Get user's current credits (creates user doc if missing) */
async function getUserCredits(uid) {
  if (!uid) throw new Error('Missing uid');
  const { data } = await ensureUserDoc(uid);
  return toShape(data);
}

/** Add credits (used after successful payments / admin adjustments) */
async function addCredits(uid, category, qty, meta) {
  if (!uid) throw new Error('Missing uid');
  const cat = normCategory(category);
  const add = normQty(qty);

  const out = await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const snap = await tx.get(userRef);

    const before = toShape(snap.exists ? snap.data() : {});
    const incField = cat === CAT_VID ? 'credits_video' : 'credits_image';

    tx.set(
      userRef,
      {
        [incField]: FieldValue.increment(add),
        updatedAt: NOW(),
      },
      { merge: true }
    );

    const after =
      cat === CAT_VID
        ? { image: before.image, video: before.video + add }
        : { image: before.image + add, video: before.video };

    await logTxn({
      uid,
      type: 'topup',
      category: cat,
      qty: add,
      before,
      after,
      meta,
    });

    return after;
  });

  return out;
}

/** Spend credits (throws on insufficient) */
async function spendCredit(uid, category, qty) {
  if (!uid) throw new Error('Missing uid');
  const cat = normCategory(category);
  const use = normQty(qty);

  const out = await db.runTransaction(async (tx) => {
    const userRef = db.collection('users').doc(uid);
    const snap = await tx.get(userRef);

    const before = toShape(snap.exists ? snap.data() : {});
    const have = cat === CAT_VID ? before.video : before.image;

    if (have < use) {
      const err = new Error(`Insufficient ${cat} credits`);
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }

    const decField = cat === CAT_VID ? 'credits_video' : 'credits_image';
    tx.set(
      userRef,
      {
        [decField]: FieldValue.increment(-use),
        updatedAt: NOW(),
      },
      { merge: true }
    );

    const after =
      cat === CAT_VID
        ? { image: before.image, video: before.video - use }
        : { image: before.image - use, video: before.video };

    await logTxn({
      uid,
      type: 'spend',
      category: cat,
      qty: use,
      before,
      after,
    });

    return after;
  });

  return out;
}

module.exports = {
  getUserCredits,
  addCredits,
  spendCredit,
};
