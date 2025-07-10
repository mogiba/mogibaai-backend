const express = require("express");
const router = express.Router();
require("dotenv").config();

const Replicate = require("replicate");
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const streamToString = async (stream) => {
  const reader = stream.getReader();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += new TextDecoder().decode(value);
  }
  return result;
};

router.post("/seedream-generate", async (req, res) => {
  try {
    const { prompt, size, seed, guidance_scale } = req.body;

    if (!prompt || !size) {
      return res.status(400).json({ error: "Prompt and size are required" });
    }

    const [width, height] = size.split("x").map(Number);

    const input = {
      prompt,
      width,
      height,
      guidance_scale: guidance_scale || 2.5,
    };
    if (seed) input.seed = Number(seed);

    let result = await replicate.run("bytedance/seedream-3", { input });

    // ✅ If result is a ReadableStream, convert it to string
    if (typeof result?.getReader === "function") {
      const jsonString = await streamToString(result);
      result = JSON.parse(jsonString);
    }

    if (result && result.error) {
      throw new Error(result.error);
    }

    let imageUrl = null;

    if (typeof result === "string") {
      imageUrl = result;
    } else if (Array.isArray(result)) {
      imageUrl = result[0];
    } else if (typeof result === "object") {
      if (typeof result.output === "string") {
        imageUrl = result.output;
      } else if (Array.isArray(result.output)) {
        imageUrl = result.output[0];
      } else if (typeof result.output === "object" && typeof result.output.output === "string") {
        imageUrl = result.output.output;
      }
    }

    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.startsWith("http")) {
      console.error("Unexpected Seedream API result format", result);
      return res.status(500).json({ error: "Seedream API did not return valid image URL." });
    }

    return res.json({ imageUrl });
  } catch (err) {
    console.error("Seedream Model Error:", err);
    return res.status(500).json({
      error: "Seedream model error",
      details: err.message,
    });
  }
});

module.exports = router;
