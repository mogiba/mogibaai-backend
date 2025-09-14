/* Simple local test for create->verify flow (uses mock signature). */
const crypto = require('crypto');
const fetch = require('node-fetch');

const API = process.env.API || 'http://localhost:4000';
const TOKEN = process.env.ID_TOKEN || '';
const PLAN_ID = process.env.PLAN_ID || 'img_baby_300';

async function main() {
    if (!TOKEN) {
        console.error('Set ID_TOKEN with a Firebase user token to test.');
        process.exit(1);
    }
    console.log('Creating order for plan:', PLAN_ID);
    const res = await fetch(`${API}/api/payments/razorpay/create-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ planId: PLAN_ID }),
    });
    const out = await res.json();
    console.log('Create response:', out);
    const order = out.order || out;
    const orderId = order.id;
    const paymentId = 'pay_test_' + Date.now();
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'secret')
        .update(`${orderId}|${paymentId}`).digest('hex');

    const v = await fetch(`${API}/api/payments/razorpay/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
    });
    const vout = await v.json();
    console.log('Verify response:', vout);
}

main().catch((e) => { console.error(e); process.exit(1); });
