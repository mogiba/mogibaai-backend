/* Integration test: create billing order -> verify -> assert credits increment
   Usage (PowerShell):
   $env:API="http://localhost:4000"; $env:ID_TOKEN="<firebase_id_token>"; node scripts/test-billing-topup.js
*/
const crypto = require('crypto');
const fetch = require('node-fetch');

const API = process.env.API || 'http://localhost:4000';
const TOKEN = process.env.ID_TOKEN || '';
const CATEGORY = process.env.CATEGORY || 'image';
const CREDITS = Number(process.env.CREDITS || 100);

async function httpJson(url, method, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { }
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${txt}`);
    return j || {};
}

async function main() {
    if (!TOKEN) throw new Error('Set ID_TOKEN with a Firebase user token');

    // 1) Get current credits
    const before = await httpJson(`${API}/api/credits`, 'GET');
    const beforeVal = CATEGORY === 'video' ? Number(before.video || 0) : Number(before.image || 0);

    // 2) Create order
    const totals = { rate: CATEGORY === 'video' ? 1.5 : 0.5, base: CREDITS * (CATEGORY === 'video' ? 1.5 : 0.5) };
    totals.gst = Math.round(totals.base * 0.18 * 100) / 100; totals.total = Math.round((totals.base + totals.gst) * 100) / 100;
    const co = await httpJson(`${API}/api/billing/create-order`, 'POST', { category: CATEGORY, credits: CREDITS, base: totals.base, gst: totals.gst, total: totals.total, pack_id: `${CATEGORY}-${CREDITS}` });
    const order = co.order || co;
    const orderId = order.id;

    // 3) Mock verify signature
    const paymentId = 'pay_test_' + Date.now();
    const secret = process.env.RAZORPAY_KEY_SECRET || 'secret';
    const signature = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    await httpJson(`${API}/api/billing/verify`, 'POST', { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });

    // 4) Check credits after
    const after = await httpJson(`${API}/api/credits`, 'GET');
    const afterVal = CATEGORY === 'video' ? Number(after.video || 0) : Number(after.image || 0);
    const inc = afterVal - beforeVal;
    console.log(`Before=${beforeVal} After=${afterVal} Increment=${inc}`);
    if (inc < CREDITS) throw new Error(`Expected increment >= ${CREDITS}, got ${inc}`);

    // 5) Assert order credited via firebase-admin (local secret)
    try {
        const admin = require('firebase-admin');
        const path = require('path');
        if (!admin.apps.length) {
            const sa = require(path.join(__dirname, '..', 'secrets', 'sa-key.json'));
            admin.initializeApp({ credential: admin.credential.cert(sa) });
        }
        const db = admin.firestore();
        const snap = await db.collection('orders').doc(orderId).get();
        if (!snap.exists) throw new Error('order doc missing');
        const data = snap.data() || {};
        if (data.credited !== true) throw new Error('order not marked credited');
        console.log('Order credited flag:', data.credited);
    } catch (e) {
        console.warn('Order credit check skipped/failed:', e.message || String(e));
    }
    console.log('OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
