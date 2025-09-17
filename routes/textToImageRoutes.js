const express = require("express");
const axios = require("axios");
const { getReplicateAgent } = require('../lib/proxy');
const { storeReplicateOutput } = require('../services/outputStore');
const { recordImageDoc } = require('../utils/firebaseUtils');
const { getDimensions } = require("../utils/sizeMapper");

const router = express.Router();

// ===============================
// Replicate HTTP API (proxy-safe)
// ===============================
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_TOKEN) {
  console.warn("[Warn] REPLICATE_API_TOKEN not set – Replicate routes will fail.");
}

// Fixie / corporate proxy support (unified via getReplicateAgent -> supports FIXIE_URL/HTTPS_PROXY/HTTP_PROXY)
const proxyAgent = getReplicateAgent();

const replicateHttp = axios.create({
  baseURL: "https://api.replicate.com/v1",
  headers: {
    Authorization: `Token ${REPLICATE_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "mogibaai-backend/1.0",
  },
  httpAgent: proxyAgent,
  httpsAgent: proxyAgent,
  proxy: false,
  timeout: 300000, // 5 min safety
});

async function createAndPoll(payload) {
  // payload MUST have `version`, NOT `model` (Replicate /predictions API)
  const { data: created } = await replicateHttp.post("/predictions", payload);
  const id = created?.id;
  if (!id) throw new Error("Replicate: prediction id missing");

  // poll
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: pr } = await replicateHttp.get(`/predictions/${id}`);
    if (pr.status === "succeeded") return pr.output;
    if (pr.status === "failed") throw new Error(pr.error || "Replicate failed");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// =====================================
// Model identifiers
// =====================================
// If explicit VERSION env vars are set → use them. Otherwise we auto-resolve the
// latest version from the model slug you shared in screenshots.
const SDXL_VERSION =
  process.env.REPLICATE_SDXL_VERSION ||
  "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc"; // fallback (pin as needed)

const WAN22_SLUG = "prunaai/wan-2.2-image";
const SEEDREAM3_SLUG = "bytedance/seedream-3";
const NANOBANANA_SLUG = "google/nano-banana";

let WAN22_VERSION = process.env.REPLICATE_WAN22_VERSION || "";
let SEEDREAM3_VERSION = process.env.REPLICATE_SEEDREAM3_VERSION || "";
let NANOBANANA_VERSION = process.env.REPLICATE_NANOBANANA_VERSION || "";

async function resolveLatestVersion(slug) {
  try {
    // GET /v1/models/{owner}/{name} returns latest_version.id
    const { data } = await replicateHttp.get(`/models/${slug}`);
    return data?.latest_version?.id || data?.version?.id || null;
  } catch (e) {
    console.error(`[resolveLatestVersion] ${slug}`, e?.response?.data || e.message);
    return null;
  }
}

async function ensureVersion(name, current, slug) {
  if (current && !String(current).startsWith("PUT_")) return current; // explicit value provided
  const auto = await resolveLatestVersion(slug);
  if (!auto) throw new Error(`Server not configured: cannot resolve latest version for ${name} (${slug})`);
  return auto;
}

/**
 * ============================
 * SDXL Route
 * ============================
 */
router.post("/sdxl", async (req, res) => {
  try {
    const { prompt, size = "1:1", quality = "standard", negativePrompt = "", seed = "", uid = null } = req.body;
    const { width, height } = getDimensions(size, quality);

    const output = await createAndPoll({
      version: SDXL_VERSION,
      input: {
        prompt,
        width,
        height,
        refine: "no_refiner",
        scheduler: "K_EULER",
        num_outputs: 1,
        guidance_scale: 7.5,
        high_noise_frac: 0.8,
        negative_prompt: negativePrompt,
        seed: seed || undefined,
        prompt_strength: 0.8,
        num_inference_steps: 50,
      },
    });

    const imageUrl = Array.isArray(output) && output.length > 0 ? output[0] : null;
    // Persist to Storage + Firestore (legacy path)
    if (uid && imageUrl) {
      try {
        const jobId = `legacy_${Date.now()}`;
        const stored = await storeReplicateOutput({ uid, jobId, sourceUrl: imageUrl, index: 0 });
        if (stored && stored.ok && stored.stored) {
          await recordImageDoc({ uid, jobId, storagePath: stored.storagePath, modelKey: 'sdxl', size, aspect_ratio: size, prompt, width, height });
        }
      } catch (_) { /* best effort */ }
    }
    res.json({ imageUrl });
  } catch (error) {
    const detail = error?.response?.data || error.message || error;
    console.error("❌ SDXL API Error:", detail);
    res.status(500).json({ error: "SDXL failed", detail });
  }
});

/**
 * ============================
 * Wan 2.2 Route (version auto-resolve)
 * ============================
 */
router.post("/wan-2.2", async (req, res) => {
  try {
    const version = await ensureVersion("WAN22", WAN22_VERSION, WAN22_SLUG);
    const { prompt, size = "1:1", megapixels = 1, juiced = false, output_format = "jpg", output_quality = 80, seed = "", uid = null } = req.body;

    const output = await createAndPoll({
      version,
      input: {
        prompt,
        aspect_ratio: size,
        megapixels,
        juiced,
        output_format,
        output_quality,
        seed: seed || undefined,
      },
    });

    const finalUrl = Array.isArray(output) ? output[0] : typeof output === "string" ? output : null;
    if (uid && finalUrl) {
      try {
        const jobId = `legacy_${Date.now()}`;
        const stored = await storeReplicateOutput({ uid, jobId, sourceUrl: finalUrl, index: 0 });
        if (stored && stored.ok && stored.stored) {
          await recordImageDoc({ uid, jobId, storagePath: stored.storagePath, modelKey: 'wan-2.2', size, aspect_ratio: size, prompt });
        }
      } catch (_) { }
    }
    res.json({ imageUrl: finalUrl });
  } catch (error) {
    const detail = error?.response?.data || error.message || error;
    console.error("❌ Wan 2.2 API Error:", detail);
    res.status(500).json({ error: "Wan 2.2 failed", detail });
  }
});

/**
 * ============================
 * Seedream 3 Route (version auto-resolve)
 * ============================
 */
router.post("/seedream-3", async (req, res) => {
  try {
    const version = await ensureVersion("SEEDREAM3", SEEDREAM3_VERSION, SEEDREAM3_SLUG);
    const { prompt, size = "1:1", quality = "standard", seed = "", uid = null } = req.body;
    const { width, height } = getDimensions(size, quality);

    const output = await createAndPoll({
      version,
      input: {
        prompt,
        width,
        height,
        aspect_ratio: size,
        seed: seed || undefined,
      },
    });

    const finalUrl = Array.isArray(output) ? output[0] : typeof output === "string" ? output : null;
    if (uid && finalUrl) {
      try {
        const jobId = `legacy_${Date.now()}`;
        const stored = await storeReplicateOutput({ uid, jobId, sourceUrl: finalUrl, index: 0 });
        if (stored && stored.ok && stored.stored) {
          await recordImageDoc({ uid, jobId, storagePath: stored.storagePath, modelKey: 'seedream-3', size, aspect_ratio: size, prompt, width, height });
        }
      } catch (_) { }
    }
    res.json({ imageUrl: finalUrl });
  } catch (error) {
    const detail = error?.response?.data || error.message || error;
    console.error("❌ Seedream 3 API Error:", detail);
    res.status(500).json({ error: "Seedream 3 failed", detail });
  }
});

/**
 * ============================
 * Nano-Banana Route (version auto-resolve)
 * ============================
 */
router.post("/nano-banana", async (req, res) => {
  try {
    const version = await ensureVersion("NANOBANANA", NANOBANANA_VERSION, NANOBANANA_SLUG);
    const { prompt, size = "1:1", quality = "standard", seed = "", uid = null } = req.body;
    const { width, height } = getDimensions(size, quality);

    const output = await createAndPoll({
      version,
      input: {
        prompt,
        width,
        height,
        seed: seed || undefined,
      },
    });

    const finalUrl = Array.isArray(output) ? output[0] : typeof output === "string" ? output : null;
    if (uid && finalUrl) {
      try {
        const jobId = `legacy_${Date.now()}`;
        const stored = await storeReplicateOutput({ uid, jobId, sourceUrl: finalUrl, index: 0 });
        if (stored && stored.ok && stored.stored) {
          await recordImageDoc({ uid, jobId, storagePath: stored.storagePath, modelKey: 'nano-banana', size, aspect_ratio: size, prompt, width, height });
        }
      } catch (_) { }
    }
    res.json({ imageUrl: finalUrl });
  } catch (error) {
    const detail = error?.response?.data || error.message || error;
    console.error("❌ Nano-Banana API Error:", detail);
    res.status(500).json({ error: "Nano-Banana failed", detail });
  }
});

module.exports = router;
