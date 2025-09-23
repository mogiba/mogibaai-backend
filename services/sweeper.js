const { db } = require('../utils/firebaseUtils');
const { deleteObject } = require('../utils/firebaseUtils');
const rpl = require('./replicateService');
const jobs = require('./jobService');

function logJSON(event, data) { try { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })); } catch { } }

async function sweepOnce({ cutoffMs = 30 * 60 * 1000 } = {}) {
    const cutoff = new Date(Date.now() - cutoffMs);
    const statuses = ['pending', 'running'];
    let processed = 0;
    for (const st of statuses) {
        try {
            const snap = await db
                .collection('jobs')
                .where('status', '==', st)
                .where('updatedAt', '<', cutoff)
                .limit(200)
                .get();
            if (snap.empty) continue;
            for (const doc of snap.docs) {
                const j = doc.data();
                processed += 1;
                const reason = 'TIMEOUT_30M';
                try {
                    if (j.provider === 'replicate' && j.providerPredictionId) {
                        await rpl.cancelPrediction(j.providerPredictionId).catch(() => null);
                    }
                    await jobs.updateJob(j._id, { status: 'failed', error: reason, timeoutAt: new Date() });
                    await jobs.finalizeHold(j._id, 'released_timeout').catch(() => null);
                    try {
                        await db.collection('jobEvents').add({ jobId: j._id, uid: j.userId, type: 'timeout', statusFrom: st, reason, at: new Date() });
                    } catch { }
                    logJSON('sweeper.timeout', { jobId: j._id, provider: j.provider || null, st, reason });
                } catch (e) {
                    logJSON('sweeper.error', { jobId: j._id, msg: e?.message });
                }
            }
        } catch (e) {
            logJSON('sweeper.query.error', { status: st, msg: e?.message });
        }
    }
    // Cleanup user-uploaded inputs scheduled for deletion
    try {
        const now = new Date();
        const snap = await db.collection('cleanupQueue').where('runAfter', '<=', now).limit(50).get();
        if (!snap.empty) {
            for (const d of snap.docs) {
                const item = d.data();
                if (item.kind === 'delete_storage' && item.storagePath) {
                    try {
                        await deleteObject(item.storagePath);
                        await d.ref.delete();
                        processed += 1;
                        logJSON('sweeper.cleanup.deleted', { storagePath: item.storagePath });
                    } catch (e) {
                        logJSON('sweeper.cleanup.error', { storagePath: item.storagePath, msg: e?.message });
                    }
                } else {
                    // Unknown task, drop to avoid pile-up
                    await d.ref.delete().catch(() => null);
                }
            }
        }
    } catch (e) {
        logJSON('sweeper.cleanup.query.error', { msg: e?.message });
    }
    return { processed };
}

function startSweeper() {
    const intervalMs = Number(process.env.SWEEPER_INTERVAL_MS || 10 * 60 * 1000);
    logJSON('sweeper.start', { intervalMs });
    const run = async () => {
        try {
            const r = await sweepOnce();
            logJSON('sweeper.run.done', { processed: r.processed });
        } catch (e) {
            logJSON('sweeper.run.error', { msg: e?.message });
        }
    };
    // initial delay to avoid stampede on boot
    setTimeout(run, 15 * 1000);
    setInterval(run, intervalMs);
}

module.exports = { startSweeper, sweepOnce };
