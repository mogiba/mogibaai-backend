const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { }
const fs = require('fs');
// Fallback: if REPLICATE_API_TOKEN still missing, try parse .env manually
try {
    if (!process.env.REPLICATE_API_TOKEN) {
        const envPath = path.join(__dirname, '..', '.env');
        if (fs.existsSync(envPath)) {
            const raw = fs.readFileSync(envPath, 'utf8');
            const m = raw.match(/^REPLICATE_API_TOKEN=(.+)$/m);
            if (m && m[1]) process.env.REPLICATE_API_TOKEN = m[1].trim();
        }
    }
} catch { }
/**
 * Allowlisted Replicate models with pinned versions, costs, and enable flags.
 * Keep IDs per env distinct via process.env. Fallbacks included for dev.
 */

const ENV = process.env.ENV_NAME || process.env.NODE_ENV || 'development';

// Helper to read env override or default
function envOr(name, def) {
    return process.env[name] || def;
}

const MODELS = {
    // Text-to-Image unified keys (sdxl, nano-banana, seedream4)
    'sdxl': {
        slug: envOr('RPL_SDXL_TTI_SLUG', 'stability-ai/sdxl'),
        version: envOr('RPL_SDXL_TTI_VERSION', ''),
        category: 'image',
        cost: 6,
        // Enabled by default; can be disabled via env
        enabled: envOr('RPL_SDXL_TTI_ENABLED', 'true') === 'true',
        label: 'SDXL Text-to-Image',
    },
    'nano-banana': {
        slug: envOr('RPL_NANOBANANA_SLUG', 'google/nano-banana'),
        // Prefer REPLICATE_NANOBANANA_VERSION if provided, fallback to legacy env var
        version: process.env.REPLICATE_NANOBANANA_VERSION || envOr('RPL_NANOBANANA_VERSION', ''),
        category: 'image',
        cost: 12,
        // Enabled by default; can be disabled via env
        enabled: envOr('RPL_NANOBANANA_ENABLED', 'true') === 'true',
        label: 'Nano-Banana (Google)',
    },
    'sdxl-img2img': {
        slug: 'stability-ai/sdxl',
        version: envOr('RPL_SDXL_IMG2IMG_VERSION', 'f0b8f398e8374918bcf2f3f1b792585c'),
        category: 'image',
        cost: 1,
        enabled: envOr('RPL_SDXL_IMG2IMG_ENABLED', 'true') === 'true',
        label: 'SDXL Image-to-Image',
    },
    'sd15-img2img': {
        slug: 'stability-ai/stable-diffusion',
        version: envOr('RPL_SD15_IMG2IMG_VERSION', 'a9758cbf1af865b5f49b'),
        category: 'image',
        cost: 1,
        enabled: envOr('RPL_SD15_IMG2IMG_ENABLED', 'true') === 'true',
        label: 'Stable Diffusion 1.5 Img2Img',
    },
    'instruct-pix2pix': {
        slug: 'timothybrooks/instruct-pix2pix',
        version: envOr('RPL_IP2P_VERSION', 'fac8b5e28bdfdbf2f75c'),
        category: 'image',
        cost: 1,
        enabled: envOr('RPL_IP2P_ENABLED', 'true') === 'true',
        label: 'Instruct-Pix2Pix',
    },
    'controlnet-sdxl-canny': {
        slug: 'monster-labs/controlnet-sdxl',
        version: envOr('RPL_CONTROLNET_SDXL_CANNY_VERSION', '0d4bcf4a92a9af6bcf7a'),
        category: 'image',
        cost: 1,
        enabled: envOr('RPL_CONTROLNET_SDXL_CANNY_ENABLED', 'true') === 'true',
        label: 'ControlNet SDXL (Canny)',
    },
    'ip-adapter': {
        slug: 'jingyunliang/ip-adapter',
        version: envOr('RPL_IP_ADAPTER_VERSION', '2dfbc1b2711e4ce08c2b'),
        category: 'image',
        cost: 1,
        enabled: envOr('RPL_IP_ADAPTER_ENABLED', 'true') === 'true',
        label: 'IP-Adapter',
    },
    'real-esrgan': {
        slug: 'nightmareai/real-esrgan',
        version: envOr('RPL_REAL_ESRGAN_VERSION', '53f2d2a518e1ee86a859'),
        category: 'image',
        cost: 0,
        enabled: envOr('RPL_REAL_ESRGAN_ENABLED', 'true') === 'true',
        label: 'Real-ESRGAN',
    },
    'gfpgan': {
        slug: 'tencentarc/gfpgan',
        version: envOr('RPL_GFPGAN_VERSION', '6c93b795ac3e488680ed'),
        category: 'image',
        cost: 0,
        enabled: envOr('RPL_GFPGAN_ENABLED', 'true') === 'true',
        label: 'GFPGAN',
    },
    // Text-to-Image: ByteDance SeeDream-4
    'seedream4': {
        slug: 'bytedance/seedream-4',
        // Pinned version (do not pull from env; do not auto-resolve)
        version: 'be069276b45ac0143746a5f46deba0478ec0333a3bb0e1fb0227cc4a7b5bc910',
        category: 'image',
        cost: 1,
        enabled: envOr('RPL_SEEDREAM4_ENABLED', 'true') === 'true',
        label: 'ByteDance SeeDream-4 (4K)',
        // Allowed inputs from client
        allowedSizes: ['1K', '2K', '4K', 'custom'],
        allowedAspectRatios: ['match_input_image', '1:1', '4:3', '16:9', '9:16', '3:2', '2:3'],
        limits: { maxWidth: 4096, maxHeight: 4096, maxImages: 15 },
    },
    // Video: Kling v2.1 (Replicate) – keep separate from image models
    'kling-video': {
        // Use owner/name format for slug so helpers can resolve latest if needed
        slug: 'kwaivgi/kling-v2.1',
        owner: 'kwaivgi',
        name: 'kling-v2.1',
        // Version: leave blank to auto-resolve latest at runtime via Replicate API
        // You can pin this to a specific version ID once known (e.g., '1234abcd...')
        version: '',
        category: 'video',
        type: 'video',
        // Baseline cost hint (actual hold computed per mode/duration)
        cost: 60,
        enabled: true,
        label: 'Kling v2.1',
    },
};

// Feature flag: enabled only if explicitly allowed AND required secrets exist
const WANT_IMG2IMG = (process.env.FEATURE_REPLICATE_IMG2IMG || 'true') === 'true';
const HAS_RPL_TOKEN = !!(process.env.REPLICATE_API_TOKEN || '').trim();
const HAS_RPL_WEBHOOK_SECRET = !!(process.env.REPLICATE_WEBHOOK_SECRET || '').trim();
// Enable when token exists; webhook secret only needed when using webhooks in prod
const IS_PROD = (ENV === 'production');
const FEATURE_REPLICATE_IMG2IMG = WANT_IMG2IMG && (HAS_RPL_TOKEN || !IS_PROD);
if (WANT_IMG2IMG && !HAS_RPL_TOKEN) {
    if (IS_PROD) {
        console.warn('[feature] Img2Img disabled: missing REPLICATE_API_TOKEN');
    } else {
        console.warn('[feature] Img2Img enabled for development without REPLICATE_API_TOKEN');
    }
} else if (WANT_IMG2IMG && HAS_RPL_TOKEN && !HAS_RPL_WEBHOOK_SECRET) {
    console.warn('[feature] Img2Img enabled without webhook signature verification; set REPLICATE_WEBHOOK_SECRET for production.');
}

module.exports = {
    ENV,
    FEATURE_REPLICATE_IMG2IMG,
    MODELS,
    getModel(key, version) {
        const m = MODELS[key];
        if (!m) return null;
        if (version && version !== m.version) return null;
        if (!m.enabled) return null;
        return m;
    },
};
