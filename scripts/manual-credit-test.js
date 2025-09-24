#!/usr/bin/env node
/**
 * Manual test: add 10 image credits to a given UID and print:
 *  - New balance
 *  - Last 5 ledger entries for that user
 * Usage:
 *   node mogibaai-backend-fresh/scripts/manual-credit-test.js <uid>
 */
const { writeLedgerEntry, getUserBalances, queryUserLedger } = require('../services/creditsLedgerService');

async function main() {
    const uid = process.argv[2];
    if (!uid) {
        console.error('Usage: node mogibaai-backend-fresh/scripts/manual-credit-test.js <uid>');
        process.exit(1);
    }
    console.log('[manual-credit-test] Adding 10 image credits to', uid);
    try {
        const entry = await writeLedgerEntry({
            uid,
            type: 'image',
            direction: 'credit',
            amount: 10,
            source: 'admin_adjustment',
            reason: 'manual test credit',
            idempotencyKey: `manual_test_credit:${uid}:10`,
            createdBy: 'script:manual-credit-test'
        });
        console.log('Ledger entry created:', entry.id, entry.amount, entry.source, entry.balance_after);
        const bal = await getUserBalances(uid);
        console.log('Updated balances:', bal);
        const { entries } = await queryUserLedger({ uid, limit: 5 });
        console.log('Recent ledger entries:');
        entries.forEach(e => {
            console.log(` - ${e.id} | ${e.createdAt && e.createdAt.toDate ? e.createdAt.toDate().toISOString() : ''} | ${e.direction} ${e.amount} -> bal ${e.balance_after} | ${e.source} | ${e.reason}`);
        });
        console.log('\nSUCCESS');
    } catch (e) {
        console.error('FAILED', e.message);
        process.exit(2);
    }
}
main();
