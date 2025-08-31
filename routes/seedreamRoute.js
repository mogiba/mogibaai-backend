const express = require("express");
const Replicate = require("replicate");
require("dotenv").config();

const router = express.Router();

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// === POST API for Seedream-3 ===
router.post("/seedream", async (req, res) => {
  try {
    const { prompt } = req.body;

    const output = await replicate.run(
      "bytedance/seedream-3", // ✅ Model version ID
      { input: { prompt } }
    );

    res.json({ image: output });
  } catch (err) {
    console.error("❌ Seedream error:", err);
    res.status(500).json({ error: "Image generation failed" });
  }
});

module.exports = router;
