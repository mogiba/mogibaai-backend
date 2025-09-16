const axios = require('axios');
const { getReplicateAgent } = require('../lib/proxy');

const API = 'https://api.replicate.com/v1';
const TOKEN = process.env.REPLICATE_API_TOKEN || '';
const WEBHOOK_SECRET = process.env.REPLICATE_WEBHOOK_SECRET || '';

if (!TOKEN) console.warn('[replicate] REPLICATE_API_TOKEN missing');

let contextLogger = () => ({});
function setReplicateLogContext(fn) { contextLogger = typeof fn === 'function' ? fn : (() => ({})); }
function logJSON(event, data) { try { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data })); } catch { } }

async function withRetry(fn, { attempts = 3, baseMs = 500 } = {}) {
    let lastErr = null;
    let tries = 0;
    for (let i = 0; i < attempts; i += 1) {
        try { tries += 1; return { value: await fn(), attemptsUsed: tries }; } catch (e) {
            const status = e?.response?.status || 0;
            if (status >= 500 || status === 429) {
                lastErr = e;
                const delay = baseMs * Math.pow(2, i);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw e;
        }
    }
    const err = lastErr || new Error('replicate: retries exhausted');
    err.attemptsUsed = tries;
    throw err;
}

async function createPrediction({ version, input, webhook, webhook_events_filter }) {
    const t = Date.now();
    try {
        const agent = getReplicateAgent();
        const { value: resp, attemptsUsed } = await withRetry(() => axios.post(`${API}/predictions`, {
            version, input, webhook, webhook_events_filter,
        }, {
            headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
            timeout: 120000,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
        }));
        const latencyMs = Date.now() - t;
        logJSON('replicate.createPrediction.ok', { ...contextLogger(), version, latencyMs, attemptsUsed });
        return { data: resp.data, latencyMs, attemptsUsed };
    } catch (e) {
        const latencyMs = Date.now() - t;
        const status = e?.response?.status || e?.status || 0;
        const attemptsUsed = e?.attemptsUsed || 1;
        const body = e?.response?.data || e?.error || e?.message;
        const errorClass = status >= 500 ? 'Upstream5xx' : status === 429 ? 'RateLimited' : 'ClientOrNetwork';
        logJSON('replicate.createPrediction.err', { ...contextLogger(), version, latencyMs, status, errorClass, attemptsUsed, body });
        const err = new Error('UPSTREAM_VALIDATION');
        err.status = status === 422 ? 422 : (status || 500);
        err.body = body;
        throw err;
    }
}

async function cancelPrediction(id) {
    const t = Date.now();
    const agent = getReplicateAgent();
    const resp = await axios.post(`${API}/predictions/${id}/cancel`, {}, {
        headers: { Authorization: `Token ${TOKEN}` },
        timeout: 15000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
    }).catch((e) => {
        logJSON('replicate.cancel.err', { ...contextLogger(), id, dt: Date.now() - t, msg: e?.message });
        return null;
    });
    if (resp) logJSON('replicate.cancel.ok', { ...contextLogger(), id, dt: Date.now() - t });
    return resp ? resp.data : null;
}

async function getPrediction(id) {
    const t = Date.now();
    try {
        const agent = getReplicateAgent();
        const resp = await axios.get(`${API}/predictions/${id}`, {
            headers: { Authorization: `Token ${TOKEN}` },
            timeout: 20000,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
        });
        logJSON('replicate.get.ok', { ...contextLogger(), id, dt: Date.now() - t });
        return resp.data;
    } catch (e) {
        logJSON('replicate.get.err', { ...contextLogger(), id, dt: Date.now() - t, msg: e?.message, status: e?.response?.status || 0 });
        throw e;
    }
}

function verifyWebhookSignature(rawBody, signatureHeader) {
    // Replicate currently uses sha256 HMAC in X-Replicate-Signature (hex)
    try {
        const crypto = require('crypto');
        const h = crypto.createHmac('sha256', WEBHOOK_SECRET);
        h.update(rawBody);
        const digest = h.digest('hex');
        return digest === String(signatureHeader || '').toLowerCase();
    } catch { return false; }
}

module.exports = { createPrediction, cancelPrediction, getPrediction, verifyWebhookSignature, setReplicateLogContext };

/* ======== Runtime model version resolver with in-memory TTL cache ======== */
const versionCache = new Map(); // owner -> { id, ts }
const VERSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function resolveLatestVersion(owner, fallbackVersion = '') {
    const now = Date.now();
    const hit = versionCache.get(owner);
    if (hit && (now - hit.ts) < VERSION_TTL_MS) return hit.id;
    try {
        const agent = getReplicateAgent();
        const resp = await axios.get(`${API}/models/${owner}`, {
            headers: { Authorization: `Token ${TOKEN}` },
            timeout: 20000,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
        });
        const id = resp?.data?.latest_version?.id;
        if (!id) throw new Error('No latest_version.id');
        versionCache.set(owner, { id, ts: now });
        return id;
    } catch (e) {
        logJSON('replicate.resolveVersion.err', { owner, msg: e?.message, status: e?.response?.status || 0 });
        if (fallbackVersion) return fallbackVersion;
        throw e;
    }
}

module.exports.resolveLatestVersion = resolveLatestVersion;

/* ======== Seedream-4 input builder + validator ======== */
const { MODELS } = require('../config/replicateModels');

function buildSeedream4Input(payload = {}) {
    const cfg = MODELS.seedream4 || {};
    const limits = cfg.limits || { maxWidth: 4096, maxHeight: 4096, maxImages: 15 };
    const allowedSizes = cfg.allowedSizes || ['1K', '2K', '4K', 'custom'];
    const allowedAspect = cfg.allowedAspectRatios || ['match_input_image', '1:1', '4:3', '16:9', '9:16', '3:2', '2:3'];

    let { prompt, size, width, height, aspect_ratio, max_images, image_input, sequential_image_generation } = payload;
    prompt = (prompt || '').toString();
    size = (size || '').toString();
    aspect_ratio = (aspect_ratio || 'match_input_image').toString();
    sequential_image_generation = (sequential_image_generation || 'disabled').toString();
    max_images = Math.max(1, Math.min(15, Number(max_images || 1)));
    image_input = Array.isArray(image_input) ? image_input : [];

    const sUp = size.toUpperCase();
    if (!allowedSizes.includes(sUp) && sUp !== 'CUSTOM') {
        // normalize common legacy
        if (sUp.includes('2K') || sUp.includes('2048')) size = '2K';
        else if (sUp.includes('4K') || sUp.includes('4096')) size = '4K';
        else size = '2K';
    } else {
        size = (sUp === 'CUSTOM') ? 'custom' : sUp;
    }

    if (!allowedAspect.includes(aspect_ratio)) aspect_ratio = 'match_input_image';

    const input = { prompt, size, aspect_ratio, max_images, sequential_image_generation, image_input };
    if (size === 'custom') {
        const w = Math.min(limits.maxWidth, Math.max(1024, Number(width || 0)));
        const h = Math.min(limits.maxHeight, Math.max(1024, Number(height || 0)));
        if (!w || !h) {
            const err = new Error('custom size requires width and height (1024-4096)');
            err.status = 422;
            throw err;
        }
        input.width = w; input.height = h;
    } else {
        // Ensure width/height not present when not custom
        delete input.width; delete input.height;
    }
    return input;
}

module.exports.buildSeedream4Input = buildSeedream4Input;
