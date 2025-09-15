const axios = require('axios');

const API = 'https://api.replicate.com/v1';
const TOKEN = process.env.REPLICATE_API_TOKEN || '';
const WEBHOOK_SECRET = process.env.REPLICATE_WEBHOOK_SECRET || '';

if (!TOKEN) console.warn('[replicate] REPLICATE_API_TOKEN missing');

async function withRetry(fn, { attempts = 3, baseMs = 500 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i += 1) {
        try { return await fn(); } catch (e) {
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
    throw lastErr || new Error('replicate: retries exhausted');
}

async function createPrediction({ version, input, webhook, webhook_events_filter }) {
    const t = Date.now();
    const resp = await withRetry(() => axios.post(`${API}/predictions`, {
        version, input, webhook, webhook_events_filter,
    }, {
        headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 120000,
    }));
    return { data: resp.data, latencyMs: Date.now() - t };
}

async function cancelPrediction(id) {
    const resp = await axios.post(`${API}/predictions/${id}/cancel`, {}, {
        headers: { Authorization: `Token ${TOKEN}` },
        timeout: 15000,
    }).catch(() => null);
    return resp ? resp.data : null;
}

async function getPrediction(id) {
    const resp = await axios.get(`${API}/predictions/${id}`, {
        headers: { Authorization: `Token ${TOKEN}` },
        timeout: 20000,
    });
    return resp.data;
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

module.exports = { createPrediction, cancelPrediction, getPrediction, verifyWebhookSignature };
