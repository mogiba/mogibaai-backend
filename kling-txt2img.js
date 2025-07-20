const express = require('express');
const router = express.Router();
const axios = require('axios');
const { generateKlingJwt } = require('./utils/klingJwt');

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

// --- 1. Fire-and-Get-TaskID (Non-blocking, client must poll GET with task_id) ---
router.post('/kling-txt2img', async (req, res) => {
  try {
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const jwtToken = generateKlingJwt();

    const response = await axios.post(
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

    const task_id = response.data?.data?.task_id || response.data?.task_id;
    if (!task_id) {
      return res.status(500).json({ error: 'Kling API: No task_id', raw: response.data });
    }

    return res.json({ task_id, status: 'submitted' });

  } catch (err) {
    try { console.error('Kling API error:', JSON.stringify(err, null, 2)); }
    catch (e) { console.error('Kling API error:', err); }
    return res.status(500).json({ error: 'Internal error: ' + (err.message || ''), raw: err });
  }
});

// --- 2. GET poll by taskId ---
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

// --- 3. Fire-and-Wait (blocking, backend polls until done or timeout) ---
router.post('/kling-txt2img/auto', async (req, res) => {
  try {
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const jwtToken = generateKlingJwt();

    // Step 1: Request image generation (get task_id)
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

    const task_id = generationRes.data?.data?.task_id || generationRes.data?.task_id;
    if (!task_id) {
      return res.status(500).json({ error: 'Kling API: No task_id', raw: generationRes.data });
    }

    // Step 2: Poll until done or timeout (fire-and-wait)
    let tries = 0, maxTries = 60, result = [], done = false;
    while (tries < maxTries) {
      await new Promise(resolve => setTimeout(resolve, 6000));
      tries++;
      const pollRes = await axios.get(
        `${KLING_API_BASE}/images/generations/${task_id}`,
        { headers: { Authorization: `Bearer ${jwtToken}` } }
      );
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
    }
    if (!done) return res.status(504).json({ error: 'Timed out waiting for Kling image' });

    return res.json({ imageUrl: result, status: 'succeeded', task_id });

  } catch (err) {
    try { console.error('Kling API error:', JSON.stringify(err, null, 2)); }
    catch (e) { console.error('Kling API error:', err); }
    return res.status(500).json({ error: 'Internal error: ' + (err.message || ''), raw: err });
  }
});

module.exports = router;
