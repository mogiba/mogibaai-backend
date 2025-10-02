// services/replicateFiles.js
// Stream file uploads to Replicate Files API and create Kling predictions using replicate://<file_id>
// NOTE: Avoid buffering entire file; use form-data streams.

const axios = require('axios');
const FormData = require('form-data');
const { getReplicateAgent } = require('../lib/proxy');
const { resolveLatestVersion } = require('./replicateService');

// TODO: Inject via env or secrets manager in deployment
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '<PUT-REPLICATE-TOKEN>';
const API_BASE = 'https://api.replicate.com/v1';

function authHeaders(extra = {}) {
    return { Authorization: `Token ${REPLICATE_API_TOKEN}`, ...extra };
}

async function uploadFileToReplicate({ readable, filename, contentType }) {
    if (!readable) throw new Error('readable stream required');
    if (!filename) filename = 'upload.bin';
    const agent = getReplicateAgent();
    const form = new FormData();
    form.append('file', readable, { filename, contentType: contentType || 'application/octet-stream' });
    const headers = { ...form.getHeaders(), ...authHeaders() };
    const resp = await axios.post(`${API_BASE}/files`, form, {
        headers,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        validateStatus: (s) => s >= 200 && s < 300,
    });
    // Response: { id, name, size, content_type }
    return resp.data;
}

async function createKlingPrediction({ fileId, endFileId = null, mode = 'standard', prompt = '', negativePrompt = '', duration = 5, webhookUrl, webhookSecret }) {
    if (!fileId) throw new Error('fileId required');
    const agent = getReplicateAgent();
    // Resolve latest Kling v2.1 version id
    // Example owner/model: kwaivgi/kling-v2.1 (latest id resolved at runtime)
    const version = await resolveLatestVersion('kwaivgi/kling-v2.1', '');
    const body = {
        version, // latest version id
        input: {
            mode: String(mode || 'standard'),
            prompt: String(prompt || ''),
            negative_prompt: String(negativePrompt || ''),
            duration: Number(duration || 5),
            start_image: `replicate://${fileId}`,
        },
        webhook: webhookUrl,
        webhook_events_filter: ['completed', 'canceled'],
    };
    if (endFileId) {
        body.input.end_image = `replicate://${endFileId}`;
    }
    // NOTE: some models accept webhook_secret; Replicate may verify X-Replicate-Signature; we set separately on server if supported
    const resp = await axios.post(`${API_BASE}/predictions`, body, {
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        timeout: 60000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
    });
    return resp.data; // { id, status, urls, ... }
}

async function getPrediction(id) {
    const agent = getReplicateAgent();
    const resp = await axios.get(`${API_BASE}/predictions/${id}`, {
        headers: authHeaders(),
        timeout: 20000,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
    });
    return resp.data;
}

module.exports = { uploadFileToReplicate, createKlingPrediction, getPrediction };
