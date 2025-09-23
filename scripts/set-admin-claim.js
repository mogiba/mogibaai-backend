#!/usr/bin/env node
/*
 * scripts/set-admin-claim.js
 * Usage:
 *   node scripts/set-admin-claim.js --email someone@example.com
 *
 * Looks up the user by email and sets a custom claim { admin: true }.
 * Idempotent: if already admin, prints a friendly message and exits 0.
 *
 * Requires Firebase Admin credentials:
 *  - Preferred: set env GOOGLE_APPLICATION_CREDENTIALS to a service account JSON path
 *  - Or place secrets/sa-key.json under mogibaai-backend-fresh/
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

function parseArgs(argv) {
    const out = { email: '', help: false };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '-h' || a === '--help') { out.help = true; i -= 1; continue; }
        if (a === '--email' || a === '-e') { out.email = argv[i + 1] || ''; i += 1; continue; }
        if (!out.email && a.includes('@')) { out.email = a; }
    }
    return out;
}

function resolveServiceAccountPath() {
    const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    const candidates = [];
    if (envPath) candidates.push(envPath);
    candidates.push(path.join(__dirname, '..', 'secrets', 'sa-key.json'));
    candidates.push(path.join(__dirname, '..', 'secrets', 'serviceAccount.json'));
    for (const p of candidates) {
        try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return '';
}

function ensureAdmin() {
    if (admin.apps.length) return admin;
    const saPath = resolveServiceAccountPath();
    try {
        if (saPath) {
            const json = JSON.parse(fs.readFileSync(saPath, 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(json) });
            console.log(`[init] Using service account at ${saPath}`);
        } else {
            admin.initializeApp({ credential: admin.credential.applicationDefault() });
            console.log('[init] Using application default credentials');
        }
    } catch (e) {
        console.error('❌ Failed to initialize firebase-admin:', e?.message || e);
        process.exit(1);
    }
    return admin;
}

async function main() {
    const { email, help } = parseArgs(process.argv);
    if (help || !email) {
        console.log('Usage: node scripts/set-admin-claim.js --email someone@example.com');
        process.exit(help ? 0 : 1);
    }
    const app = ensureAdmin();
    const auth = app.auth();
    try {
        const user = await auth.getUserByEmail(email);
        const uid = user.uid;
        const claims = user.customClaims || {};
        if (claims.admin === true) {
            console.log(`✅ User ${email} (uid=${uid}) already has admin: true`);
            console.log('ℹ️  Note: user may need to re-login to refresh claims.');
            process.exit(0);
        }
        const newClaims = { ...claims, admin: true };
        await auth.setCustomUserClaims(uid, newClaims);
        console.log(`✅ Set admin: true for ${email} (uid=${uid})`);
        console.log('ℹ️  Note: the user must sign out and sign in again to pick up the new claim.');
        process.exit(0);
    } catch (e) {
        if (e && e.code === 'auth/user-not-found') {
            console.error(`❌ No user found with email: ${email}`);
        } else {
            console.error('❌ Error setting admin claim:', e?.message || e);
        }
        process.exit(1);
    }
}

main();
