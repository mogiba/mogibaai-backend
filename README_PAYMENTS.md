# Mogibaa Payments: Razorpay + Firebase

This document covers end-to-end setup for Top-Up and Subscription payments using Razorpay with secure server-side validation.

## Required Environment Variables

- `RAZORPAY_KEY_ID` (public key for checkout)
- `RAZORPAY_KEY_SECRET` (server secret)
- `RAZORPAY_WEBHOOK_SECRET` (server secret for webhook signature)
- `GOOGLE_APPLICATION_CREDENTIALS` or `FIREBASE_KEY` (path to service account JSON)
- `FIREBASE_STORAGE_BUCKET` (optional; inferred from service account if omitted)
- Frontend envs:
  - `REACT_APP_API_URL` or `REACT_APP_API_BASE` (backend URL)
  - `REACT_APP_RAZORPAY_KEY_ID` (same as `RAZORPAY_KEY_ID`)

## Webhook

- Configure Razorpay Dashboard → Webhooks:
  - URL: `https://<your-domain>/api/payments/razorpay/webhook`
  - Secret: must equal `RAZORPAY_WEBHOOK_SECRET`
  - Events: `payment.authorized`, `payment.captured`, `payment.failed`, and subscription events if used

## CORS / Proxy

- Backend enables `cors()` for `localhost:3000`, `mogibaai.com`, `*.mogibaai.com`, and echoes the `Origin` header when credentials are used.
- If behind a proxy (nginx/Cloudflare), ensure it does NOT replace `Access-Control-Allow-Origin` with `*` on credentialed requests.

## Server Trust Model

- Server trusts only `utils/plans.js` for pricing and credits. Clients submit only `planId`.
- Amounts are computed on server and sent to Razorpay. Credits are granted only after server verification (verify endpoint or webhook).

## Logging & Monitoring

- Set `DEBUG_RAZORPAY=1` to get detailed logs for create-order, verify, and webhook.
- Logs avoid sensitive values and include request headers (shortened), uid sources, and status transitions.

## QA / Test Plan

1. Use Razorpay Test Keys in `.env` and frontend envs.
2. Start backend and frontend locally.
3. Create an order via UI; confirm response headers include `Access-Control-Allow-Origin: http://localhost:3000` and `Access-Control-Allow-Credentials: true`.
4. Complete test payment in Razorpay checkout; verify `/api/payments/razorpay/verify` returns `ok: true` and user credits increased.
5. Re-send the verify request; ensure it remains idempotent (no double credits).
6. Simulate webhook events using curl (see below) and confirm Firestore `orders/{orderId}` updated and credits granted once.
7. Attempt unauthorized create-order (no Authorization header); backend must return 401.

### Webhook Simulation (Test)

Replace values accordingly:

```bash
# PowerShell example using curl.exe
$payload = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_123","order_id":"order_ABC","amount":10000,"currency":"INR","notes":{"uid":"test-user","type":"topup","planId":"img_baby_300","category":"image","credits":"600"}}}}}'
$secret = $env:RAZORPAY_WEBHOOK_SECRET
$signature = (echo -n $payload | openssl dgst -sha256 -hmac $secret | % { $_.split('=')[-1].Trim() })

curl.exe -X POST "http://localhost:4000/api/payments/razorpay/webhook" ^
  -H "Content-Type: application/json" ^
  -H "X-Razorpay-Signature: $signature" ^
  --data $payload
```

## One-click Script (Local E2E)

See `scripts/test-razorpay-flow.js` for a simple create→verify sequence using test keys. Run:

```powershell
node scripts/test-razorpay-flow.js
```

Note: This script mocks payment verification by computing the signature locally. Do not use in production.

---

For production deployment, confirm:
- Webhook URL is reachable and not blocked by firewalls
- Proxy preserves request body for `express.raw()` webhook route
- Env vars are set and not exposed to clients