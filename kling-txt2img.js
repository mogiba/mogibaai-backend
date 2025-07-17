// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:4001'; // Flask service URL

router.post('/kling-txt2img', async (req, res) => {
  try {
    // Node.js backend nundi Python Flask service ki request forward chesthunnam
    const response = await axios.post(`${PYTHON_SERVICE_URL}/kling-txt2img`, req.body);
    return res.json(response.data);
  } catch (err) {
    console.error('Error calling Python Kling AI service:', err.message);
    return res.status(500).json({ error: 'Failed to generate image via Kling AI service.' });
  }
});

module.exports = router;
