Temporary debug endpoint
========================

This backend includes a temporary debug endpoint used during payment troubleshooting.

- Endpoint: `GET /api/payments/razorpay/debug/headers`
- Response: JSON with `headers` (truncated) and `tokenInfo` if an Authorization Bearer token is present and firebase-admin is available.

Security: This endpoint is intended only for debugging. Remove it before leaving the server in production.
