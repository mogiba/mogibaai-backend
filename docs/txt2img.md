# Text-to-Image: SeeDream-4

This backend integrates Replicate's bytedance/seedream-4 for text-to-image with Firebase-only storage.

- Storage backend: firebase
- Inputs saved under: `user-uploads/{uid}/...`
- Outputs saved under: `user-outputs/{uid}/{jobId}/{filename}`
- Public shares (copy-only): `public/{shortId}/{filename}`

## Env

- REPLICATE_API_TOKEN: required
- REPLICATE_WEBHOOK_SECRET: required
- Model version is resolved dynamically from Replicate (cached ~6h); no env needed.

## API

Create job:

curl -X POST http://localhost:4000/api/txt2img \
  -H "Authorization: Bearer <ID_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "modelKey":"seedream4", "inputs": { "prompt":"a serene sunrise over Himalayas", "resolution":"2k", "max_images":1 } }'

Poll:

GET /api/txt2img/:id

On completion, the webhook persists outputs to Firebase Storage and the job document includes storage paths under `output[]`.

Moderation may return 422; insufficient credits 402; rate limit 429 with Retry-After.

## SeeDream-4 Sizes and Pricing

- Allowed sizes: only `2048x2048` (2K) or `4096x4096` (4K)
- Price per image:
  - 2K: 24 image credits per image
  - 4K: 48 image credits per image
- `max_images` may be 1..15. On create, the server places a credits hold equal to `pricePerImage × max_images`.
- On webhook success, the server captures exactly `output.length × pricePerImage` and releases the remainder.
- On failure/cancel, the server releases the full hold.
