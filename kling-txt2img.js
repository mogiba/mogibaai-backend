const express = require('express');
const router = express.Router();
const axios = require('axios');
require('dotenv').config();
const { generateKlingJwt } = require('./utils/klingJwt'); // Path as per your project

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

// --- POST: Create image generation task ---
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

  const jwtToken = generateKlingJwt();

  try {
    const response = await axios.post(
      `${KLING_API_BASE}/images/generations`,
      {
        model_name: "kling-v2",
        prompt,
        negative_prompt,
        resolution: finalResolution,
        n,
        aspect_ratio: finalAspect,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwtToken}`,
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

// --- GET: Poll for image result by taskId ---
router.get('/kling-txt2img/:taskId', async (req, res) => {
  const { taskId } = req.params;
  if (!taskId) return res.status(400).json({ error: 'Missing taskId.' });

  const jwtToken = generateKlingJwt();

  try {
    const response = await axios.get(
      `${KLING_API_BASE}/images/generations/${taskId}`,
      {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
        },
        timeout: 15000,
      }
    );
    return res.json(response.data);
  } catch (e) {
    console.error('Kling polling error:', e.response?.data || e.message, e.response?.status);
    return res.status(500).json({ error: 'Kling polling failed', details: e.response?.data || e.message });
  }
});

// --- Polling helper ---
async function pollKlingResult(taskId, jwt, maxTries = 15, interval = 2000) {
  for (let i = 0; i < maxTries; i++) {
    try {
      const resp = await axios.get(
        `${KLING_API_BASE}/images/generations/${taskId}`,
        { headers: { 'Authorization': `Bearer ${jwt}` } }
      );
      const status = resp.data?.data?.task_status;
      if (status === 'completed') {
        return resp.data?.data?.task_result?.images || [];
      } else if (status === 'failed') {
        throw new Error("Kling task failed.");
      }
      // Else, keep polling
    } catch (err) {
      if (i === maxTries - 1) throw err;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Kling polling timed out');
}

// --- POST: Auto-wait for image result (server-side polling) ---
router.post('/kling-txt2img/auto', async (req, res) => {
  const {
    prompt,
    negative_prompt = '',
    generation_mode,
    image_size,
    resolution,
    aspect_ratio,
    n = 1
  } = req.body;

  let finalResolution = resolution || '1024x1024';
  let finalAspect = aspect_ratio || '1:1';

  const jwtToken = generateKlingJwt();

  try {
    // Step 1: Request image generation (get task_id)
    const resp = await axios.post(
      `${KLING_API_BASE}/images/generations`,
      {
        model_name: "kling-v2",
        prompt,
        negative_prompt,
        resolution: finalResolution,
        n,
        aspect_ratio: finalAspect,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwtToken}`,
        }
      }
    );
    const taskId = resp.data?.data?.task_id;
    if (!taskId) return res.status(500).json({ error: 'No task_id from Kling.' });

    // Step 2: Poll until complete
    const images = await pollKlingResult(taskId, jwtToken);
    if (!images.length) return res.status(500).json({ error: 'No images returned from Kling.' });

    // Step 3: Done!
    return res.json({ task_id: taskId, images });
  } catch (err) {
    console.error("Kling auto-wait error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Kling polling failed", details: err.response?.data || err.message });
  }
});

module.exports = router;
