const express = require('express');
const router = express.Router();
const axios = require('axios');
require('dotenv').config();

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

const DEFAULTS = {
  resolution: '1024x1024',
  aspect_ratio: '1:1',
};

const RESOLUTION_MAP = {
  'Standard': '1024x1024',
  'HD': '2048x2048',
  'Wide 16:9': '2048x1152',
  'Portrait 2:3': '1024x1536',
  'Landscape 3:2': '1536x1024',
  'Mobile 9:16': '1024x1820',
};
const ASPECT_RATIO_MAP = {
  'Square 1:1': '1:1',
  'Portrait 2:3': '2:3',
  'Landscape 3:2': '3:2',
  'Mobile 9:16': '9:16',
  'Wide 16:9': '16:9',
};

router.post('/kling-txt2img', async (req, res) => {
  const {
    prompt,
    negative_prompt = '',
    generation_mode,
    image_size,
    resolution,
    aspect_ratio,
    n = 1
  } = req.body;

  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  let finalResolution = resolution;
  let finalAspect = aspect_ratio;
  if (!finalResolution && generation_mode && image_size) {
    if (generation_mode === 'HD' && image_size in RESOLUTION_MAP) {
      finalResolution = RESOLUTION_MAP[image_size] || RESOLUTION_MAP['HD'];
      finalAspect = ASPECT_RATIO_MAP[image_size] || DEFAULTS.aspect_ratio;
    } else if (generation_mode === 'Standard' && image_size in RESOLUTION_MAP) {
      finalResolution = RESOLUTION_MAP[image_size] || RESOLUTION_MAP['Standard'];
      finalAspect = ASPECT_RATIO_MAP[image_size] || DEFAULTS.aspect_ratio;
    }
  }
  if (!finalResolution) finalResolution = DEFAULTS.resolution;
  if (!finalAspect) finalAspect = DEFAULTS.aspect_ratio;

  console.log('Kling API Request:', {
    prompt,
    negative_prompt,
    finalResolution,
    finalAspect,
    n,
    apiKeyExists: Boolean(process.env.KLING_API_KEY),
    apiSecretExists: Boolean(process.env.KLING_API_SECRET),
  });

  try {
    const response = await axios.post(
      `${KLING_API_BASE}/generate-image`,
      {
        prompt,
        negative_prompt,
        resolution: finalResolution,
        n,
        aspect_ratio: finalAspect,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.KLING_API_KEY,
          'x-api-secret': process.env.KLING_API_SECRET,
        },
        timeout: 20000,
      }
    );
    return res.json(response.data);
  } catch (e) {
    console.error('Kling AI error:', e.response?.data || e.message, e.response?.status);
    return res.status(500).json({ error: 'Kling request failed', details: e.response?.data || e.message });
  }
});

module.exports = router;
