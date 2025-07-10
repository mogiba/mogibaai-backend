// backend/routes/klingApi.js

const express = require("express");
const axios = require("axios");
const router = express.Router();
const { getKlingJwt } = require("./utils/klingJwt");

const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

// 1. VIDEO GENERATION: POST - create video task
router.post("/image-to-video", async (req, res) => {
  try {
    // Accept ONLY 'image' (public url) as required field for Kling
    const {
      prompt,
      image, // required: public image url
      model,
      mode,
      duration,
      resolution,
      negative_prompt,
    } = req.body;

    // Validate required fields
    if (!prompt || !image || !model || !mode || !duration || !resolution) {
      return res.status(400).json({ error: "Missing required parameters." });
    }
    if (!image.startsWith("http")) {
      return res.status(400).json({ error: "Image URL must be a public URL (http/https)." });
    }

    // JWT Auth for Kling
    const jwtToken = getKlingJwt(KLING_ACCESS_KEY, KLING_SECRET_KEY);
    const payload = {
      prompt,
      image, // <-- Kling API requires this field!
      model,
      mode,
      duration: String(duration),
      resolution,
    };
    if (negative_prompt) payload.negative_prompt = negative_prompt;

    const headers = {
      Authorization: `Bearer ${jwtToken}`,
      "Content-Type": "application/json",
    };

    const apiUrl = "https://api-singapore.klingai.com/v1/videos/image2video";
    const response = await axios.post(apiUrl, payload, { headers });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Kling API Error:", err.response?.data, err.message);
    res.status(500).json({
      error: err.response?.data?.error || err.response?.data || err.message || "Kling API error",
    });
  }
});

// 2. VIDEO STATUS/RESULT: GET - poll video status/result (by task id)
router.get("/image-to-video/:taskId", async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ error: "Missing taskId." });
    }
    const jwtToken = getKlingJwt(KLING_ACCESS_KEY, KLING_SECRET_KEY);
    const headers = {
      Authorization: `Bearer ${jwtToken}`,
      "Content-Type": "application/json",
    };
    const apiUrl = `https://api-singapore.klingai.com/v1/videos/image2video/${taskId}`;
    const response = await axios.get(apiUrl, { headers });
    res.json(response.data);
  } catch (err) {
    console.error("❌ Kling Status API Error:", err.response?.data, err.message);
    res.status(500).json({
      error: err.response?.data?.error || err.response?.data || err.message || "Kling status error",
    });
  }
});

module.exports = router;
