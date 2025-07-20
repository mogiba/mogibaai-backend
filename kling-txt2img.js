// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { generateKlingJwt } = require('./utils/klingJwt');

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

// --- POST: Blocking (fire-and-wait) version ---
router.post('/kling-txt2img', async (req, res) => {
  console.log('=== Kling API request body:', req.body);

  try {
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const jwtToken = generateKlingJwt();
    console.log('=== Generated JWT:', jwtToken.substring(0, 40) + '...');

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

    let task_id = generationRes.data?.data?.task_id || generationRes.data?.task_id;
    if (!task_id) {
      console.error('=== ERROR: No task_id', generationRes.data);
      return res.status(500).json({ error: 'Kling API: No task_id', raw: generationRes.data });
    }
    console.log('=== Received task_id:', task_id);

    // Initial wait before polling
    await new Promise(resolve => setTimeout(resolve, 2500)); // 2.5 seconds

    // Dynamic Polling
    let tries = 0, maxTries = 40, result = [], done = false;
    while (tries < maxTries) {
      tries++;
      const pollJwt = generateKlingJwt();
      try {
        const pollRes = await axios.get(
          `${KLING_API_BASE}/images/generations/${task_id}`,
          { headers: { Authorization: `Bearer ${pollJwt}` } }
        );
        console.log(`[Kling][${task_id}] poll #${tries}:`, JSON.stringify(pollRes.data));
        const images = pollRes.data?.data?.task_result?.images || pollRes.data?.images;
        const status = pollRes.data?.data?.task_status || pollRes.data?.status;
        if ((status === 'succeeded' || status === 'completed') && Array.isArray(images)) {
          result = images.map(img => img.url);
          done = true;
          break;
        }
        if (status === 'failed') {
          return res.status(500).json({ error: 'Kling API failed: ' + (pollRes.data.message || ''), raw: pollRes.data });
        }
      } catch (pollErr) {
        console.error(`[Kling][${task_id}] poll #${tries} error:`, pollErr.response?.data || pollErr.message);
      }

      // Dynamic interval: Slow at first, then speed up
      if (tries < 5) {
        await new Promise(resolve => setTimeout(resolve, 3500)); // 3.5 sec for first 5 tries
      } else if (tries < 10) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 sec next 5 tries
      } else {
        await new Promise(resolve => setTimeout(resolve, 1100)); // 1.1 sec for rest
      }
    }
    if (!done) return res.status(504).json({ error: 'Timed out waiting for Kling image', task_id });

    return res.json({ imageUrl: result, status: 'succeeded', task_id });

  } catch (err) {
    try { console.error('Kling API error:', JSON.stringify(err, null, 2)); }
    catch (e) { console.error('Kling API error:', err); }
    return res.status(500).json({ error: 'Internal error: ' + (err.message || ''), raw: err });
  }
});

// --- GET: Poll by taskId (stateless, frontend polling) ---
router.get('/kling-txt2img/:taskId', async (req, res) => {
  const { taskId } = req.params;
  if (!taskId) return res.status(400).json({ error: 'Missing taskId.' });

  try {
    const jwtToken = generateKlingJwt();
    const pollRes = await axios.get(
      `${KLING_API_BASE}/images/generations/${taskId}`,
      { headers: { Authorization: `Bearer ${jwtToken}` } }
    );
    return res.json(pollRes.data);
  } catch (err) {
    try { console.error('Kling polling error:', JSON.stringify(err, null, 2)); }
    catch (e) { console.error('Kling polling error:', err); }
    return res.status(500).json({ error: 'Polling failed: ' + (err.message || ''), raw: err });
  }
});

module.exports = router;
