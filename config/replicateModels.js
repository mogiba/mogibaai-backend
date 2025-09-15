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
};

const FEATURE_REPLICATE_IMG2IMG = (process.env.FEATURE_REPLICATE_IMG2IMG || 'true') === 'true';

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
