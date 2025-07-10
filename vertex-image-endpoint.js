const express = require("express");
const router = express.Router();
const { GoogleAuth } = require("google-auth-library");
require("dotenv").config();
const uploadImageToStorage = require("./upload"); // <-- This is your image upload helper

// Use Render.com secret file ABSOLUTE PATH
const saKeyPath = "/etc/secrets/mogibaai-storage-key.json";

router.post("/google-imagen", async (req, res) => {
  const { prompt, size = "1024x1024", userId = "public" } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  // Supported aspect ratios for Google Imagen 4
  const aspectRatioMap = {
    "1024x1024": "1:1",
    "1024x1536": "2:3",
    "1536x1024": "3:2",
    "576x1024": "9:16",
    "1024x576": "16:9"
  };

  if (!aspectRatioMap[size]) {
    return res.status(400).json({ error: "Selected size not supported for Imagen 4" });
  }

  try {
    const auth = new GoogleAuth({
      keyFilename: saKeyPath, // ALWAYS use absolute path for Render.com secrets
      scopes: "https://www.googleapis.com/auth/cloud-platform",
    });

    const client = await auth.getClient();
    const projectId = process.env.GOOGLE_PROJECT_ID;
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/imagen-4.0-generate-preview-06-06:predict`;

    const body = {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: aspectRatioMap[size]
      },
    };

    const response = await client.request({ url, method: "POST", data: body });

    // Debug log for troubleshooting
    console.log("Google Imagen response:", response.data);

    if (
      !response.data.predictions ||
      !Array.isArray(response.data.predictions) ||
      !response.data.predictions[0] ||
      !response.data.predictions[0].bytesBase64Encoded
    ) {
      console.error("❌ Google Imagen error: No predictions found", response.data);
      return res.status(500).json({ error: "Image generation failed (no predictions found)", details: response.data });
    }

    const imageBase64 = response.data.predictions[0].bytesBase64Encoded;
    const buffer = Buffer.from(imageBase64, "base64");
    const filename = `users/${userId}/img_${Date.now()}.jpg`;
    const publicUrl = await uploadImageToStorage(buffer, filename, "image/jpeg");

    res.json({ imageUrl: publicUrl });

  } catch (err) {
    console.error("❌ Google Imagen error:", err.response?.data || err.message);
    res.status(500).json({ error: "Image generation failed", details: err.message });
  }
});

module.exports = router;
