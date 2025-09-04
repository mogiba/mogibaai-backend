const express = require("express");
const Replicate = require("replicate");
const { getDimensions } = require("../utils/sizeMapper");

const router = express.Router();

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

/**
 * ============================
 * SDXL Route
 * ============================
 */
router.post("/sdxl", async (req, res) => {
  try {
    const { prompt, size = "1:1", quality = "standard", negativePrompt = "", seed = "" } = req.body;
    const { width, height } = getDimensions(size, quality);

    const prediction = await replicate.predictions.create({
      version: "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
      input: {
        prompt,
        width,
        height,
        refine: "no_refiner",
        scheduler: "K_EULER",
        num_outputs: 1,
        guidance_scale: 7.5,
        high_noise_frac: 0.8,
        negative_prompt: negativePrompt,
        seed: seed || undefined,
        prompt_strength: 0.8,
        num_inference_steps: 50,
      },
    });

    let output;
    while (prediction.status !== "succeeded" && prediction.status !== "failed") {
      await new Promise((r) => setTimeout(r, 2000));
      const latest = await replicate.predictions.get(prediction.id);
      prediction.status = latest.status;
      prediction.output = latest.output;
      output = latest.output;
    }

    res.json({ imageUrl: Array.isArray(output) && output.length > 0 ? output[0] : null });
  } catch (error) {
    console.error("❌ SDXL API Error:", error);
    res.status(500).json({ error: "SDXL failed" });
  }
});

/**
 * ============================
 * Wan 2.2 Route (Updated Schema)
 * ============================
 */
router.post("/wan-2.2", async (req, res) => {
  try {
    const { prompt, size = "1:1", megapixels = 1, juiced = false, output_format = "jpg", output_quality = 80, seed = "" } = req.body;

    console.log("🚀 Wan 2.2 request input:", { prompt, size, megapixels, juiced, output_format, output_quality, seed });

    const prediction = await replicate.predictions.create({
      version: "prunaai/wan-2.2-image",
      input: {
        prompt,
        aspect_ratio: size, // 👈 correctly use selected size
        megapixels,
        juiced,
        output_format,
        output_quality,
        seed: seed || undefined,
      },
    });

    let output;
    while (prediction.status !== "succeeded" && prediction.status !== "failed") {
      await new Promise((r) => setTimeout(r, 2000));
      const latest = await replicate.predictions.get(prediction.id);
      prediction.status = latest.status;
      prediction.output = latest.output;
      output = latest.output;
    }

    console.log("🔍 Replicate Output (Wan 2.2):", output);
    const finalUrl = Array.isArray(output)
      ? output[0]
      : (typeof output === "string" ? output : null);

    res.json({ imageUrl: finalUrl });
  } catch (error) {
    console.error("❌ Wan 2.2 API Error:", error);
    res.status(500).json({ error: "Wan 2.2 failed" });
  }
});

/**
 * ============================
 * Seedream 3 Route
 * ============================
 */
router.post("/seedream-3", async (req, res) => {
  try {
    const { prompt, size = "1:1", quality = "standard", seed = "" } = req.body;
    const { width, height } = getDimensions(size, quality);

    const prediction = await replicate.predictions.create({
      version: "bytedance/seedream-3",
      input: {
        prompt,
        width,
        height,
        aspect_ratio: size,
        seed: seed || undefined,
      },
    });

    let output;
    while (prediction.status !== "succeeded" && prediction.status !== "failed") {
      await new Promise((r) => setTimeout(r, 2000));
      const latest = await replicate.predictions.get(prediction.id);
      prediction.status = latest.status;
      prediction.output = latest.output;
      output = latest.output;
    }

    const finalUrl = Array.isArray(output)
      ? output[0]
      : (typeof output === "string" ? output : null);

    res.json({ imageUrl: finalUrl });
  } catch (error) {
    console.error("❌ Seedream 3 API Error:", error);
    res.status(500).json({ error: "Seedream 3 failed" });
  }
});

/**
 * ============================
 * Nano-Banana Route
 * ============================
 */
router.post("/nano-banana", async (req, res) => {
  try {
    const { prompt, size = "1:1", quality = "standard", seed = "" } = req.body;
    const { width, height } = getDimensions(size, quality);

    const prediction = await replicate.predictions.create({
      version: "google/nano-banana",
      input: {
        prompt,
        width,
        height,
        seed: seed || undefined,
      },
    });

    let output;
    while (prediction.status !== "succeeded" && prediction.status !== "failed") {
      await new Promise((r) => setTimeout(r, 2000));
      const latest = await replicate.predictions.get(prediction.id);
      prediction.status = latest.status;
      prediction.output = latest.output;
      output = latest.output;
    }

    const finalUrl = Array.isArray(output)
      ? output[0]
      : (typeof output === "string" ? output : null);

    res.json({ imageUrl: finalUrl });
  } catch (error) {
    console.error("❌ Nano-Banana API Error:", error);
    res.status(500).json({ error: "Nano-Banana failed" });
  }
});

module.exports = router;