// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { generateKlingJwt } = require('./utils/klingJwt');

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

router.post('/kling-txt2img', async (req, res) => {
  console.log('=== Kling API request body:', req.body);

  try {
    // Input validation
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // JWT
    const jwtToken = generateKlingJwt();
    console.log('=== Generated JWT:', jwtToken.substring(0, 30) + '...');

    // Start generation
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

    // Get task_id
    const task_id = generationRes.data?.data?.task_id || generationRes.data?.task_id;
    if (!task_id) {
      console.error('No task_id from Kling', generationRes.data);
      return res.status(500).json({ error: 'Kling API: No task_id', raw: generationRes.data });
    }
    console.log('=== Received task_id:', task_id);

    // Wait before polling (minimum 2-4 seconds recommended by Kling)
    await new Promise(resolve => setTimeout(resolve, 4000));

    // Poll for result
    let tries = 0, maxTries = 75, result = [];
    let done = false;

    while (tries < maxTries) {
      tries++;
      // Optionally: New JWT each poll, Kling sometimes expects fresh
      const pollJwt = generateKlingJwt();
      try {
        const pollRes = await axios.get(
          `${KLING_API_BASE}/images/generations/${task_id}`,
          { headers: { Authorization: `Bearer ${pollJwt}` } }
        );
        const images = pollRes.data?.data?.task_result?.images || pollRes.data?.images;
        const status = pollRes.data?.data?.task_status || pollRes.data?.status;
        console.log(`[Kling][${task_id}] Poll #${tries}: Status:`, status);

        if (status === 'succeeded' && Array.isArray(images)) {
          result = images.map(img => img.url);
          done = true;
          break;
        }
        if (status === 'failed') {
          return res.status(500).json({ error: 'Kling API failed: ' + (pollRes.data.message || ''), raw: pollRes.data });
        }
      } catch (pollErr) {
        // log only
        console.error(`[Kling][${task_id}] poll #${tries} error:`, pollErr.response?.data || pollErr.message);
      }
      await new Promise(resolve => setTimeout(resolve, 4500)); // 4.5s wait
    }

    if (!done) {
      return res.status(504).json({ error: 'Timed out waiting for Kling image' });
    }

    // Success
    return res.json({ imageUrl: result, status: 'succeeded' });

  } catch (err) {
    try {
      console.error('Kling API error:', JSON.stringify(err, null, 2));
    } catch (e) {
      console.error('Kling API error:', err);
    }
    return res.status(500).json({ error: 'Internal error: ' + (err.message || ''), raw: err });
  }
});

module.exports = router;
