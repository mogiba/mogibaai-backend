const express = require('express');
const axios = require('axios');
const router = express.Router();
const { generateKlingJwt } = require('../utils/klingJwt');
const { saveToGallery } = require('../utils/firebaseUtils');

require('dotenv').config();

const KLING_API_BASE = 'https://api-singapore.klingai.com/v1';

// ========== POST: /kling-txt2img ==========
router.post('/kling-txt2img', async (req, res) => {
  try {
    const jwtToken = await generateKlingJwt();

    const {
      prompt,
      uid, // ✅ changed from userId → uid
      negative_prompt = '',
      resolution = '2k',
      n = 1,
      aspect_ratio = '1:1',
      model_name = 'kling-v2'
    } = req.body;

    if (!prompt || !uid) {
      return res.status(400).json({ error: 'Prompt and uid are required' });
    }

    // Step 1: Submit generation task
    const generationRes = await axios.post(
      `${KLING_API_BASE}/images/generations`,
      {
        model_name,
        prompt,
        negative_prompt,
        resolution,
        n,
        aspect_ratio
      },
      {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const taskId = generationRes.data?.data?.task_id;
    if (!taskId) {
      return res.status(500).json({ error: 'Task ID not found' });
    }

    // Step 2: Poll for result
    let outputUrl = null;
    let retries = 50;

    while (retries-- > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 sec

      const statusRes = await axios.get(`${KLING_API_BASE}/images/generations/${taskId}`, {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
        }
      });

      const taskStatus = statusRes.data?.data?.task_status;
      console.log('🌀 Task status:', taskStatus);

      if (taskStatus === 'succeed') {
        const images = statusRes.data?.data?.task_result?.images;
        if (images && images.length > 0) {
          outputUrl = images[0].url;
          break;
        }
      } else if (taskStatus === 'failed') {
        return res.status(500).json({ error: 'Image generation failed' });
      }
    }

    // Step 3: Save to Firebase if image is ready
    if (outputUrl) {
      const imageRes = await axios.get(outputUrl, { responseType: 'arraybuffer' });
      const base64Data = Buffer.from(imageRes.data, 'binary').toString('base64');

      await saveToGallery(uid, outputUrl, prompt, base64Data); // ✅ use uid

      return res.status(200).json({ imageUrl: outputUrl });
    } else {
      return res.status(202).json({
        message: 'Image is still being generated. Try again later.',
        taskId
      });
    }

  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
