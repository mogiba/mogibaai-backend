// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { generateKlingJwt } = require('./utils/klingJwt');

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

router.post('/api/kling-txt2img', async (req, res) => {
  try {
    // 1. Input validation
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // 2. JWT generate
    const jwtToken = generateKlingJwt();

    // 3. POST: Start Image Generation
    const generationRes = await axios.post(
      `${KLING_API_BASE}/images/generations`,
      {
        model_name: 'kling-v2',
        prompt,
        negative_prompt,
        resolution,
        n,
        aspect_ratio
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtToken}`,
        }
      }
    );
    const { task_id } = generationRes.data;
    if (!task_id) return res.status(500).json({ error: 'Kling API: No task_id' });

    // 4. Poll for result
    let tries = 0, maxTries = 50, result, done = false;
    while (tries < maxTries) {
      await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3 seconds
      tries++;
      const pollRes = await axios.get(
        `${KLING_API_BASE}/images/generations/${task_id}`,
        { headers: { Authorization: `Bearer ${jwtToken}` } }
      );
      if (pollRes.data?.status === 'succeeded' && Array.isArray(pollRes.data.images)) {
        result = pollRes.data.images.map(img => img.url);
        done = true;
        break;
      }
      if (pollRes.data?.status === 'failed') {
        return res.status(500).json({ error: 'Kling API failed: ' + (pollRes.data.message || '') });
      }
    }
    if (!done) return res.status(504).json({ error: 'Timed out waiting for Kling image' });

    // 5. Success
    return res.json({ imageUrls: result, status: 'succeeded' });
  } catch (err) {
    console.error('Kling API error:', err.message, err?.response?.data || '');
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
});

module.exports = router;
