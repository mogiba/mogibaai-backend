// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { generateKlingJwt } = require('./utils/klingJwt');

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

router.post('/kling-txt2img', async (req, res) => {
  console.log('=== Kling API request body:', req.body);

  try {
    // 1. Input validation
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // 2. JWT generate
    const jwtToken = generateKlingJwt();
    console.log('=== Generated JWT:', jwtToken.substring(0, 40) + '...');

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

    // *** task_id structure fix ***
    let task_id = generationRes.data?.data?.task_id || generationRes.data?.task_id;
    if (!task_id) {
      console.error('=== ERROR: No task_id', generationRes.data);
      return res.status(500).json({ error: 'Kling API: No task_id', raw: generationRes.data });
    }
    console.log('=== Received task_id:', task_id);

    // 4. Wait before polling (Kling API needs a second to initialize the task)
    await new Promise(resolve => setTimeout(resolve, 3000)); // 3 seconds

    // 5. Poll for result
    let tries = 0, maxTries = 60, result = [], done = false;
    while (tries < maxTries) {
      tries++;
      // Optionally: Generate fresh token for polling, if Kling API ever needs it.
      const pollJwt = generateKlingJwt();
      try {
        const pollRes = await axios.get(
          `${KLING_API_BASE}/images/generations/${task_id}`,
          { headers: { Authorization: `Bearer ${pollJwt}` } }
        );

        // LOG poll status every try
        console.log(`[Kling][${task_id}] poll #${tries}:`, JSON.stringify(pollRes.data));

        // *** images structure fix ***
        const images = pollRes.data?.data?.task_result?.images || pollRes.data?.images;
        const status = pollRes.data?.data?.task_status || pollRes.data?.status;

        if (status === 'succeeded' && Array.isArray(images)) {
          result = images.map(img => img.url);
          done = true;
          break;
        }
        if (status === 'failed') {
          return res.status(500).json({ error: 'Kling API failed: ' + (pollRes.data.message || ''), raw: pollRes.data });
        }
      } catch (pollErr) {
        // Kling poll endpoint is sometimes slow to respond if you poll too quickly after POST
        console.error(`[Kling][${task_id}] poll #${tries} error:`, pollErr.response?.data || pollErr.message);
      }
      // Wait between polls
      await new Promise(resolve => setTimeout(resolve, 4000)); // 4 seconds
    }
    if (!done) return res.status(504).json({ error: 'Timed out waiting for Kling image' });

    // 6. Success
    return res.json({ imageUrl: result, status: 'succeeded' });

  } catch (err) {
    // Print the entire error object for deep debugging
    try {
      console.error('Kling API error:', JSON.stringify(err, null, 2));
    } catch (e) {
      console.error('Kling API error:', err);
    }
    return res.status(500).json({ error: 'Internal error: ' + (err.message || ''), raw: err });
  }
});

module.exports = router;
