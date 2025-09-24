// services/creditsLedgerService.js
// Unified credits ledger (image/video) with transactional balance updates + idempotency.
// Data model:
//  - credits_ledger/{autoId}
//  - users/{uid}/balances (doc: { image, video, updatedAt })
//  - idempotency_keys/{key} (doc: { createdAt, entryId, key, uid })
//
// Exposed API:
//  writeLedgerEntry(opts) -> { id, ...entry }
//  queryUserLedger({ uid, filters, limit, cursor }) -> { entries, nextCursor }
//  queryAdminLedger({ filters, limit, cursor }) -> { entries, nextCursor }
//  exportLedgerCSV({ scope:'user'|'admin', uid?, filters, pageSize, onChunk }) -> streams CSV rows batched
//  getUserBalances(uid) -> { image, video }
//  adjustCreditsAdmin -> wrapper for admin adjustments
//
// Firestore rules must ensure only server writes these collections.

const { db, admin } = require('../utils/firebaseUtils');
const { FieldValue } = admin.firestore;

const COLLECTION_LEDGER = 'credits_ledger';
const COLLECTION_IDEMP = 'idempotency_keys';

const VALID_TYPES = new Set(['image', 'video']);
const VALID_DIRECTIONS = new Set(['credit', 'debit']);
const VALID_SOURCES = new Set(['text2image', 'image2image', 'purchase', 'refund', 'admin_adjustment', 'bonus']);

function nowTs() { return FieldValue.serverTimestamp(); }

function normalizeInt(v) { v = Number(v); if (!Number.isFinite(v)) return 0; return Math.trunc(v); }

function buildIdempotencyKey({ direction, source, jobId, paymentId }) {
    if (jobId) return `${direction}:${source}:${jobId}`;
    if (paymentId) return `${direction}:${source}:${paymentId}`;
    return `${direction}:${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`; // fallback (should not normally happen)
}

async function getUserBalances(uid) {
    const ref = db.collection('users').doc(uid).collection('balances').doc('global');
    const snap = await ref.get();
    if (!snap.exists) return { image: 0, video: 0 };
    const d = snap.data() || {};
    return { image: normalizeInt(d.image), video: normalizeInt(d.video) };
}

/**
 * Core transactional writer.
 * opts = { uid, type, direction, amount, source, reason, jobId, paymentId, invoiceId, meta, idempotencyKey, createdBy }
 */
async function writeLedgerEntry(opts) {
    const {
        uid,
        type,
        direction,
        amount,
        source,
        reason = '',
        jobId = null,
        paymentId = null,
        invoiceId = null,
        meta = null,
        idempotencyKey: providedKey,
        createdBy = 'system',
    } = opts || {};

    if (!uid) throw new Error('uid required');
    if (!VALID_TYPES.has(type)) throw new Error('invalid type');
    if (!VALID_DIRECTIONS.has(direction)) throw new Error('invalid direction');
    if (!VALID_SOURCES.has(source)) throw new Error('invalid source');
    const amt = normalizeInt(amount);
    if (amt <= 0) throw new Error('amount must be > 0');

    const idempotencyKey = providedKey || buildIdempotencyKey({ direction, source, jobId, paymentId });

    const ledColl = db.collection(COLLECTION_LEDGER);
    const idemRef = db.collection(COLLECTION_IDEMP).doc(idempotencyKey);
    const balanceRef = db.collection('users').doc(uid).collection('balances').doc('global');

    let createdEntry = null;
    await db.runTransaction(async (tx) => {
        const idemSnap = await tx.get(idemRef);
        if (idemSnap.exists) {
            // Already processed; fetch existing ledger entry id
            const data = idemSnap.data();
            if (data && data.entryId) {
                const existing = await tx.get(ledColl.doc(data.entryId));
                if (existing.exists) {
                    createdEntry = { id: existing.id, reused: true, ...(existing.data() || {}) };
                    return; // early
                }
            }
            throw new Error('IDEMPOTENT_REPLAY_BUT_ENTRY_MISSING');
        }

        // Read current balance
        const balSnap = await tx.get(balanceRef);
        let cur = { image: 0, video: 0 };
        if (balSnap.exists) {
            const b = balSnap.data() || {};
            cur = { image: normalizeInt(b.image), video: normalizeInt(b.video) };
        }

        let newImage = cur.image;
        let newVideo = cur.video;
        if (type === 'image') {
            if (direction === 'debit') {
                if (cur.image < amt) {
                    const err = new Error('INSUFFICIENT_IMAGE_CREDITS');
                    err.code = 'NEGATIVE_BALANCE_BLOCKED';
                    throw err;
                }
                newImage = cur.image - amt;
            } else {
                newImage = cur.image + amt;
            }
        } else if (type === 'video') {
            if (direction === 'debit') {
                if (cur.video < amt) {
                    const err = new Error('INSUFFICIENT_VIDEO_CREDITS');
                    err.code = 'NEGATIVE_BALANCE_BLOCKED';
                    throw err;
                }
                newVideo = cur.video - amt;
            } else {
                newVideo = cur.video + amt;
            }
        }

        const ledgerRef = ledColl.doc();
        const entry = {
            uid,
            type,
            direction,
            amount: amt,
            balance_after: type === 'image' ? newImage : newVideo,
            source,
            reason,
            jobId: jobId || null,
            paymentId: paymentId || null,
            invoiceId: invoiceId || null,
            meta: meta || null,
            createdAt: nowTs(),
            createdBy,
            idempotencyKey,
        };

        tx.set(ledgerRef, entry);
        tx.set(balanceRef, { image: newImage, video: newVideo, updatedAt: nowTs() }, { merge: true });
        tx.set(idemRef, { key: idempotencyKey, entryId: ledgerRef.id, uid, createdAt: nowTs() });
        createdEntry = { id: ledgerRef.id, ...entry };
    });

    return createdEntry;
}

// One-time migration helper: if a user has legacy credits (users.credits_image / credits_video) but
// no entries in the unified ledger, seed an opening balance credit so history starts at a known point.
// This runs lazily on first ledger query. Idempotent via idempotencyKey.
// NOTE: After full migration/backfill of historical creditTransactions, this helper can be removed
// and legacy fields deprecated. Search for ensureOpeningLedgerEntry before removing.
async function ensureOpeningLedgerEntry(uid) {
    if (!uid) return;
    try {
        const ledSnap = await db.collection(COLLECTION_LEDGER).where('uid', '==', uid).limit(1).get();
        if (!ledSnap.empty) return; // already has entries
        const userSnap = await db.collection('users').doc(uid).get();
        if (!userSnap.exists) return;
        const d = userSnap.data() || {};
        const img = normalizeInt(d.credits_image || d.image || 0);
        const vid = normalizeInt(d.credits_video || d.video || 0);
        // Only seed if there is a non-zero legacy balance; write separate entries per category
        if (img > 0) {
            await writeLedgerEntry({
                uid,
                type: 'image',
                direction: 'credit',
                amount: img,
                source: 'admin_adjustment',
                reason: 'opening balance migration',
                idempotencyKey: `opening:image:${uid}`,
                meta: { migration: true },
            }).catch(() => { });
        }
        if (vid > 0) {
            await writeLedgerEntry({
                uid,
                type: 'video',
                direction: 'credit',
                amount: vid,
                source: 'admin_adjustment',
                reason: 'opening balance migration',
                idempotencyKey: `opening:video:${uid}`,
                meta: { migration: true },
            }).catch(() => { });
        }
    } catch (_) { /* silent */ }
}
function applyFilters(q, filters) {
    if (!filters) return q;
    const { uid, type, direction, source, from, to, jobId, paymentId } = filters;
    const isValidDate = (d) => d instanceof Date && !isNaN(d.getTime());
    if (uid) q = q.where('uid', '==', uid);
    if (type && VALID_TYPES.has(type)) q = q.where('type', '==', type);
    if (direction && VALID_DIRECTIONS.has(direction)) q = q.where('direction', '==', direction);
    if (source && VALID_SOURCES.has(source)) q = q.where('source', '==', source);
    if (jobId) q = q.where('jobId', '==', jobId);
    if (paymentId) q = q.where('paymentId', '==', paymentId);
    if (from && isValidDate(from)) q = q.where('createdAt', '>=', from);
    if (to && isValidDate(to)) q = q.where('createdAt', '<=', to);
    return q;
}

async function queryUserLedger({ uid, filters = {}, limit = 50, cursor = null }) {
    // Lazy migration seeding if needed
    await ensureOpeningLedgerEntry(uid).catch(() => { });
    let q = db.collection(COLLECTION_LEDGER).where('uid', '==', uid).orderBy('createdAt', 'desc').limit(limit);
    q = applyFilters(q, { ...filters, uid });
    if (cursor) {
        const curSnap = await db.collection(COLLECTION_LEDGER).doc(cursor).get();
        if (curSnap.exists) q = q.startAfter(curSnap);
    }
    const snap = await q.get();
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const nextCursor = snap.size === limit ? entries[entries.length - 1].id : null;
    return { entries, nextCursor };
}

async function queryAdminLedger({ filters = {}, limit = 100, cursor = null }) {
    let q = db.collection(COLLECTION_LEDGER).orderBy('createdAt', 'desc').limit(limit);
    q = applyFilters(q, filters);
    if (cursor) {
        const curSnap = await db.collection(COLLECTION_LEDGER).doc(cursor).get();
        if (curSnap.exists) q = q.startAfter(curSnap);
    }
    const snap = await q.get();
    const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const nextCursor = snap.size === limit ? entries[entries.length - 1].id : null;
    return { entries, nextCursor };
}

module.exports = {
    writeLedgerEntry,
    ensureOpeningLedgerEntry,
    getUserBalances,
    queryUserLedger,
    queryAdminLedger,
    VALID_SOURCES,
    VALID_TYPES,
    VALID_DIRECTIONS,
};
