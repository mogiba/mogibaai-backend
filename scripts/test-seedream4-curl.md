# Quick test: SeeDream-4 txt2img

Replace `<ID_TOKEN>` with a Firebase ID token from your logged-in user.

```
curl -X POST "http://localhost:4000/api/txt2img" \
  -H "Authorization: Bearer <ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
        "modelKey":"seedream4",
        "prompt":"a photo of a store front called \"Seedream 4\" with a poster in the window",
        "size":"2K",
        "aspect_ratio":"4:3",
        "max_images":1
      }'
```

Expected: `200` with `{ ok: true, jobId: "..." }`. Then poll:

```
curl -H "Authorization: Bearer <ID_TOKEN>" http://localhost:4000/api/txt2img/<jobId>
```
