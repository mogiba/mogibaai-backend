const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// In-memory DB
const characters = new Map(); // id -> { fullPath, facePath, owner: 'demo-user' }
const jobs = new Map(); // id -> job
const userDailyCount = new Map(); // owner -> { yyyymmdd: count }

let nextId = 1;
function genId(prefix) { return `${prefix}_${Date.now()}_${nextId++}`; }

const TMP_DIR = path.join(__dirname, '..', 'tmp_uploads');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

async function saveBuffer(file, name) {
    const full = path.join(TMP_DIR, name);
    await fs.promises.writeFile(full, file.buffer);
    return full;
}

async function faceCrop(srcPath) {
    // very naive center crop square
    const img = await Jimp.read(srcPath);
    const size = Math.min(img.bitmap.width, img.bitmap.height);
    const x = Math.floor((img.bitmap.width - size) / 2);
    const y = Math.floor((img.bitmap.height - size) / 3); // bias upwards a bit
    const crop = img.clone().crop(x, Math.max(0, y), size, size).resize(256, 256);
    const out = srcPath.replace(/(\.[a-z]+)$/i, '_face$1');
    await crop.writeAsync(out);
    return out;
}

// POST /api/characters
router.post('/characters', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ ok: false, message: 'image required' });
        const ext = (path.extname(req.file.originalname) || '.jpg').toLowerCase();
        const charId = genId('char');
        const fullPath = await saveBuffer(req.file, `${charId}${ext}`);
        const facePath = await faceCrop(fullPath);
        // naive face pass (always true if image exists)
        const face_ok = true;
        characters.set(charId, { fullPath, facePath, owner: 'demo' });
        // redacted URLs: do not send to client; only keep server-side
        const hash = require('crypto').createHash('sha256').update(req.file.buffer).digest('hex');
        return res.json({ character_id: charId, ref_full_url: 'redacted', ref_face_url: 'redacted', hash, face_ok });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
});

async function watermark(srcPath, jobId, idx) {
    const img = await Jimp.read(srcPath);
    // scale max 1024
    const max = 1024;
    if (img.bitmap.width > max || img.bitmap.height > max) img.scaleToFit(max, max);
    // tile text watermark diagonally
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
    const tile = new Jimp(300, 100, 0x00000000);
    tile.print(font, 10, 40, 'MOGIBAAI', 280);
    tile.opacity(0.22);
    const stepX = 240, stepY = 120;
    for (let y = -50; y < img.bitmap.height; y += stepY) {
        for (let x = -50; x < img.bitmap.width; x += stepX) {
            img.composite(tile, x, y, { mode: Jimp.BLEND_SOURCE_OVER });
        }
    }
    const out = path.join(TMP_DIR, `image_${jobId}_${idx}_wm.jpg`);
    await img.quality(90).writeAsync(out);
    return out;
}

// POST /api/generate
router.post('/generate', express.json(), async (req, res) => {
    const { character_id, locked, prompt = '', negative_prompt = '', batch = 1, strength = 0.8, guidance = 7, seed = null, plan_type = 'free' } = req.body || {};
    if (locked && !character_id) return res.status(400).json({ ok: false, message: 'character_id required when locked' });

    // resolve references on server side
    let refs = null;
    if (locked) {
        const rec = characters.get(character_id);
        if (!rec) return res.status(422).json({ ok: false, message: 'Invalid character' });
        refs = rec;
    }

    // basic NSFW/safety filter
    const bad = [/\bnude\b/i, /nsfw/i, /sexual/i, /gore/i];
    if (bad.some((r) => r.test(String(prompt)))) {
        return res.status(422).json({ ok: false, message: 'Prompt blocked by safety filter' });
    }

    // rate-limit for free plan: 10/day, 1 concurrent
    const owner = 'demo';
    const today = new Date();
    const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    if (plan_type === 'free') {
        const byDay = userDailyCount.get(owner) || {};
        const count = Number(byDay[yyyymmdd] || 0);
        // count running/queued
        const concurrent = [...jobs.values()].filter((j) => j.meta && j.meta.owner === owner && (j.status === 'queued' || j.status === 'running')).length;
        if (concurrent >= 1) return res.status(429).json({ ok: false, message: 'One job at a time on Free plan' });
        if (count >= 10) return res.status(429).json({ ok: false, message: 'Daily free limit reached (10/day)' });
        byDay[yyyymmdd] = count + 1; userDailyCount.set(owner, byDay);
    }

    const jobId = genId('job');
    const route = locked ? 'sdxl-instantid' : 'nano-banana';
    const meta = { seed: seed ?? Math.floor(Math.random() * 1e6), model: route, watermarked: plan_type === 'free', locked: !!locked, owner };
    const job = { id: jobId, status: 'queued', outputs: [], meta };
    jobs.set(jobId, job);

    // async simulate
    setTimeout(async () => {
        try {
            job.status = 'running';
            const outputs = [];
            const src = refs?.fullPath || path.join(__dirname, '..', 'docs', 'placeholder.jpg');
            const count = Math.max(1, Math.min(6, Number(batch) || 1));
            for (let i = 0; i < count; i++) {
                const inPath = src;
                if (plan_type === 'free') {
                    const wm = await watermark(inPath, jobId, i);
                    outputs.push(`/tmp-uploads/${path.basename(wm)}`);
                } else {
                    // for paid plans return the same without watermark (simulation)
                    const out = path.join(TMP_DIR, `image_${jobId}_${i}.jpg`);
                    const img = await Jimp.read(inPath);
                    await img.quality(95).writeAsync(out);
                    outputs.push(`/tmp-uploads/${path.basename(out)}`);
                }
            }
            job.outputs = outputs;
            job.status = 'succeeded';
            jobs.set(jobId, job);
        } catch (e) {
            job.status = 'failed';
            jobs.set(jobId, job);
        }
    }, 800);

    return res.json(job);
});

// GET /api/jobs/:id
router.get('/jobs/:id', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) return res.status(404).json({ ok: false, message: 'not found' });
    // add headers for watermark policy demonstration
    if (j.meta?.watermarked) res.set('X-Watermarked', 'true');
    res.json(j);
});

module.exports = router;

