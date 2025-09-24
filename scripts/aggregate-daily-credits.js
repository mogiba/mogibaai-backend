#!/usr/bin/env node
// Aggregate previous day's credits ledger into daily_credits_summary/{YYYY-MM-DD}
// Usage: node scripts/aggregate-daily-credits.js [--date=YYYY-MM-DD]

const { db, admin } = require('../utils/firebaseUtils');

(async function main() {
    const argDate = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
    const targetDay = argDate ? new Date(argDate + 'T00:00:00.000Z') : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yyyy = targetDay.getUTCFullYear();
    const mm = String(targetDay.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(targetDay.getUTCDate()).padStart(2, '0');
    const dayId = `${yyyy}-${mm}-${dd}`;
    const start = new Date(`${dayId}T00:00:00.000Z`);
    const end = new Date(`${dayId}T23:59:59.999Z`);
    console.log('[daily-credits] aggregating', dayId, start.toISOString(), '->', end.toISOString());

    let cursor = null; let page = 0; const limit = 1000; const totals = { image: { debit: 0, credit: 0 }, video: { debit: 0, credit: 0 } }; const bySource = {}; const blocked = { negative: 0 };
    while (page < 200) { // safety up to 200k entries/day
        let q = db.collection('credits_ledger').where('createdAt', '>=', start).where('createdAt', '<=', end).orderBy('createdAt', 'asc').limit(limit);
        if (cursor) q = q.startAfter(cursor);
        const snap = await q.get();
        if (snap.empty) break;
        for (const doc of snap.docs) {
            const d = doc.data();
            const type = d.type === 'video' ? 'video' : 'image';
            const dir = d.direction === 'debit' ? 'debit' : 'credit';
            totals[type][dir] += Number(d.amount || 0);
            const src = d.source || 'unknown';
            bySource[src] = (bySource[src] || 0) + Number(d.amount || 0);
        }
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < limit) break;
        page++;
    }
    const ref = db.collection('daily_credits_summary').doc(dayId);
    await ref.set({ day: dayId, totals, bySource, generatedAt: new Date() }, { merge: true });
    console.log('[daily-credits] wrote summary', dayId, totals, bySource);
    process.exit(0);
})().catch(e => { console.error('[daily-credits] failed', e); process.exit(1); });
