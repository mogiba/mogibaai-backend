// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { generateKlingJwt } = require('./utils/klingJwt');

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

// --- POST: Fire-and-get-taskid, NO waiting/blocking! ---
router.post('/kling-txt2img', async (req, res) => {
  try {
    const { prompt, negative_prompt = '', resolution = '2k', n = 2, aspect_ratio = '16:9' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const jwtToken = generateKlingJwt();
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
      return res.status(500).json({ error: 'Kling API: No task_id', raw: generationRes.data });
    }

    // Return only task_id for frontend to poll
    return res.json({ task_id });

  } catch (err) {
    try { console.error('Kling API error:', JSON.stringify(err, null, 2)); }
    catch (e) { console.error('Kling API error:', err); }
    return res.status(500).json({ error: 'Internal error: ' + (err.message || ''), raw: err });
  }
});

// --- GET: Poll by taskId (stateless, safe for polling from frontend) ---
router.get('/kling-txt2img/:taskId', async (req, res) => {
  const { taskId } = req.params;
  if (!taskId) return res.status(400).json({ error: 'Missing taskId.' });

  try {
    const jwtToken = generateKlingJwt();
    const pollRes = await axios.get(
      `${KLING_API_BASE}/images/generations/${taskId}`,
      { headers: { Authorization: `Bearer ${jwtToken}` }, timeout: 10000 }
    );
    return res.json(pollRes.data);
  } catch (err) {
    try { console.error('Kling polling error:', JSON.stringify(err, null, 2)); }
    catch (e) { console.error('Kling polling error:', err); }
    return res.status(500).json({ error: 'Polling failed: ' + (err.message || ''), raw: err });
  }
});

module.exports = router;
