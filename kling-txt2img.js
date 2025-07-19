// kling-txt2img.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
require('dotenv').config();

const KLING\_API\_BASE = '[https://api-singapore.klingai.com/v1](https://api-singapore.klingai.com/v1)';

// Utility: default values for supported image modes
const DEFAULTS = {
resolution: '1024x1024',   // fallback for Standard
aspect\_ratio: '1:1',
};

// Optionally map frontend modes (if you want)
const RESOLUTION\_MAP = {
'Standard': '1024x1024', // 1:1
'HD': '2048x2048',       // 1:1
'Wide 16:9': '2048x1152',
'Portrait 2:3': '1024x1536',
'Landscape 3:2': '1536x1024',
'Mobile 9:16': '1024x1820',
};
const ASPECT\_RATIO\_MAP = {
'Square 1:1': '1:1',
'Portrait 2:3': '2:3',
'Landscape 3:2': '3:2',
'Mobile 9:16': '9:16',
'Wide 16:9': '16:9',
};

router.post('/kling-txt2img', async (req, res) => {
const {
prompt,
negative\_prompt = '',
generation\_mode,    // 'Standard' or 'HD' (from frontend)
image\_size,         // e.g., 'Wide 16:9', 'Square 1:1' (from frontend)
resolution,         // fallback if present
aspect\_ratio,       // fallback if present
n = 1
} = req.body;

if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

// Decide resolution and aspect\_ratio from user selection if present
let finalResolution = resolution;
let finalAspect = aspect\_ratio;
if (!finalResolution && generation\_mode && image\_size) {
// Map both mode and size
if (generation\_mode === 'HD' && image\_size in RESOLUTION\_MAP) {
finalResolution = RESOLUTION\_MAP\[image\_size] || RESOLUTION\_MAP\['HD'];
finalAspect = ASPECT\_RATIO\_MAP\[image\_size] || DEFAULTS.aspect\_ratio;
} else if (generation\_mode === 'Standard' && image\_size in RESOLUTION\_MAP) {
finalResolution = RESOLUTION\_MAP\[image\_size] || RESOLUTION\_MAP\['Standard'];
finalAspect = ASPECT\_RATIO\_MAP\[image\_size] || DEFAULTS.aspect\_ratio;
}
}
// Default if still not set
if (!finalResolution) finalResolution = DEFAULTS.resolution;
if (!finalAspect) finalAspect = DEFAULTS.aspect\_ratio;

// Debug log: shows what's being sent
console.log('Kling API Request:', {
prompt,
negative\_prompt,
finalResolution,
finalAspect,
n,
apiKeyExists: Boolean(process.env.KLING\_API\_KEY),
apiSecretExists: Boolean(process.env.KLING\_API\_SECRET),
});

try {
const response = await axios.post(
`${KLING_API_BASE}/generate-image`,
{
prompt,
negative\_prompt,
resolution: finalResolution,
n,
aspect\_ratio: finalAspect,
},
{
headers: {
'Content-Type': 'application/json',
'x-api-key': process.env.KLING\_API\_KEY,
'x-api-secret': process.env.KLING\_API\_SECRET,
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
