# Image-to-Image Pipeline (Replicate)

This document outlines environment variables, feature flags, local run steps, rollout/rollback, and operational guardrails for the Img2Img feature.

## Env Vars
- `FEATURE_REPLICATE_IMG2IMG`: `true|false` (default: `true`). Master gate for all img2img routes and UI. When `true`, server will require Replicate secrets at boot.
- `REPLICATE_API_TOKEN`: Required when feature enabled.
- `REPLICATE_WEBHOOK_SECRET`: Required when feature enabled.
- `PUBLIC_API_BASE`: Publicly reachable base URL for webhooks (e.g., `https://api.mogibaai.com`). Replicate posts to `${PUBLIC_API_BASE}/api/replicate/webhook`.
- `IMG2IMG_RATELIMIT_PER_HOUR`: Per-user requests per hour (default: 20).
- `IMG2IMG_RATELIMIT_PER_MIN_IP`: Per-IP requests per minute (default: 60).
- Storage:
  - `FIREBASE_STORAGE_BUCKET` or service account with project_id to infer `project_id.appspot.com`.
  - `STORAGE_BACKEND` defaults to `firebase`. AWS/S3 is not used.

## Feature Flags
- `FEATURE_REPLICATE_IMG2IMG` gate used on:
  - Server route `POST /api/img2img`, `GET /api/img2img/:id`, `DELETE /api/img2img/:id`
  - Frontend to hide the tool (call `/api/features`)
- Disable by setting `FEATURE_REPLICATE_IMG2IMG=false` and redeploy. Server will skip fail-fast checks.

## Local Run
1. Create `mogibaai-backend-fresh/.env` with:
```
FEATURE_REPLICATE_IMG2IMG=true
REPLICATE_API_TOKEN=... (from replicate.com)
REPLICATE_WEBHOOK_SECRET=... (your secret)
PUBLIC_API_BASE=http://localhost:4000
FIREBASE_KEY=secrets/sa-key.json
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
STORAGE_BACKEND=firebase
```
2. Start server:
```
npm install
node index.js
```
3. Expose webhook for local testing (optional):
```
# PowerShell: install and run ngrok or cloudflared
ngrok http 4000
# Set PUBLIC_API_BASE to the forwarded https URL and restart
```

## Rollout & Fallback
- Toggle: Set `FEATURE_REPLICATE_IMG2IMG=false` to hide API and UI (frontend reads `/api/features`).
- Rollback: Disable feature, revoke Replicate token if needed, and scale down the route.
- Alerts: Page if error rate > 5% for 10 minutes on `img2img.*` logs or webhook failures.

## Moderation & Safety
- Prompt and image metadata checks are enforced; violations return HTTP 422 and are logged to `moderationEvents`.
- SSRF protection on image URLs via DNS allowlist and HEAD probe.
- Rate limiting: per-user/hour and per-IP/minute. Returns 429 + `Retry-After`.

## Credits & Billing
- A pending hold (`creditsTransactions/hold_<jobId>`) is created on job create.
- On success, we capture the hold and debit once (idempotent) with remaining balance returned from the credits service.
- On cancel/fail/expire, we release the hold.

## Output Persistence
- On success, outputs are downloaded and stored to our storage with `Cache-Control: public, max-age=31536000, immutable`.
- A `files` record is written with owner, bytes, and hash. Job `output[]` is rewritten to our signed URL; if persistence fails, original Replicate URLs are kept with `stored=false`.

## Background Jobs
- Sweeper runs every 10 minutes and cancels predictions older than 30 minutes, marking jobs as `failed` with reason `TIMEOUT_30M` and releasing holds.

## Metrics
- Endpoint: `GET /api/admin/metrics` (admin auth required)
  - Counts in last 24h: created, succeeded, failed, canceled
  - Moderation rejects (from `moderationEvents`)
  - Low credit 402 and rate-limited 429 (from `apiEvents`)
  - p50/p95 `createLatencyMs` from job metrics
- Minimal server-rendered JSON at `/api/admin/metrics` (responds as JSON or HTML <pre> for quick viewing)

## Error Codes
- 400: INVALID_INPUT (missing fields, invalid model/version)
- 401: Unauthorized (missing/invalid ID token)
- 402: LOW_CREDITS (insufficient balance)
- 413: PAYLOAD_TOO_LARGE (image >10MB)
- 415: UNSUPPORTED_MEDIA_TYPE (require multipart/form-data or JSON with image URL)
- 422: MODERATION_BLOCKED (prompt/image violated policy)
- 429: RATE_LIMITED / RATE_LIMITED_IP (Retry-After set)
- 500: SERVICE_TEMPORARILY_UNAVAILABLE
- 503: feature_disabled

## Storage
- Firebase-only with three roots:
  - Inputs (owner uploads): `user-uploads/{uid}/...`
  - Outputs (owner files): `user-outputs/{uid}/{jobId}/{filename}`
  - Public shares (readable without auth): `public/{shortId}/{filename}`
- Owner outputs do not carry manual download tokens; clients must call `getDownloadURL(ref(storage, storagePath))` at render time.
- Public share flow: server copies owner output to `public/{shortId}/{filename}` and returns a direct media URL.

## Firebase-only Mode
- Kept envs: FEATURE_REPLICATE_IMG2IMG, REPLICATE_API_TOKEN, REPLICATE_WEBHOOK_SECRET, PUBLIC_API_BASE, FIREBASE_STORAGE_BUCKET, FIREBASE_KEY, STORAGE_BACKEND=firebase.
- Removed/ignored envs: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET.

## Quick cURL
GET features
```
curl -s http://localhost:4000/api/features
```

Create job (multipart)
```
curl -s -X POST http://localhost:4000/api/img2img \
  -H "Authorization: Bearer <ID_TOKEN>" \
  -F model=sd15 \
  -F version="<allowlisted-version>" \
  -F input='{"prompt":"a cat","image":"https://.../seed.jpg"}'
```

Poll
```
curl -s -H "Authorization: Bearer <ID_TOKEN>" http://localhost:4000/api/img2img/<jobId>
```

Metrics (HTML)
```
curl -s -H "Authorization: Bearer <ADMIN_ID_TOKEN>" -H "Accept: text/html" http://localhost:4000/api/admin/metrics
```

## Ops Runbook
- High failures: check `/api/admin/metrics` and logs `img2img.error` or `replicate.*.err`.
- Upstream issues: backoff and retry; consider disabling specific models via `/api/admin/replicate/models`.
- Rate spikes: adjust `IMG2IMG_RATELIMIT_PER_HOUR` and `IMG2IMG_RATELIMIT_PER_MIN_IP` and monitor 429.
- Rollback: set `FEATURE_REPLICATE_IMG2IMG=false` and redeploy.

