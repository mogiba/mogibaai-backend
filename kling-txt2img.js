const express = require("express");
const axios = require("axios");
const router = express.Router();

router.post("/kling-txt2img", async (req, res) => {
  const { prompt, width = 1024, height = 1024, steps = 28, seed = null, cfg_scale = 7 } = req.body;
  const apiKey = process.env.KLING_API_KEY;

  try {
    const response = await axios.post(
      "https://api.qingque.cn/v1/images/generations",
      {
        model: "qingque-v1.5-txt2img",
        prompt,
        negative_prompt: "",
        width,
        height,
        steps,
        seed,
        cfg_scale
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error("Kling API error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Kling image generation failed", details: err?.response?.data || err.message });
  }
});

module.exports = router;
