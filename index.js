const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { generateKlingJwt } = require("./utils/klingJwt");

// === GOOGLE SA KEY SETUP ===
const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : path.join(__dirname, "secrets", "sa-key.json");

const storageKeyPath = process.env.GOOGLE_STORAGE_KEY
  ? path.resolve(__dirname, process.env.GOOGLE_STORAGE_KEY)
  : path.join(__dirname, "secrets", "mogibaai-storage-key.json");

if (!fs.existsSync(saKeyPath)) {
  console.error(`❌ Google Service Account key file NOT found at ${saKeyPath}`);
  throw new Error(`Google Service Account key file not found`);
} else {
  console.log(`✅ SA key found at ${saKeyPath}`);
}
if (!fs.existsSync(storageKeyPath)) {
  console.error(`❌ Google Storage key file NOT found at ${storageKeyPath}`);
  throw new Error(`Google Storage key file not found`);
} else {
  console.log(`✅ Storage key found at ${storageKeyPath}`);
}

process.env.GOOGLE_APPLICATION_CREDENTIALS = saKeyPath;

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// === ROUTES IMPORTS ===
const vertexImageUltraRoute = require("./vertex-image-ultra-endpoint");
const vertexImageFastRoute = require("./vertex-imagen4fast-generate-endpoint");
const klingTxt2ImgRoute = require("./routes/klingRoutes");
const razorpayRoute = require("./razorpay");
const seedreamRoute = require("./routes/seedreamRoute"); // ✅ CommonJS import

// === ROOT + HEALTH ===
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});
app.get("/", (req, res) => {
  res.send("Mogibaai backend is running!");
});

// === ROUTE MOUNTING ===
app.use("/api", vertexImageUltraRoute);
app.use("/api", vertexImageFastRoute);
app.use("/api", klingTxt2ImgRoute);
app.use("/api/payments", razorpayRoute);
app.use("/api", seedreamRoute); // ✅ Mounted Seedream

// === KLING EXTRA ROUTES FOR TASK CREATE + POLL ===
const KLING_API_BASE = "https://api-singapore.klingai.com/v1";

app.post("/api/kling-txt2img", async (req, res) => {
  try {
    const { prompt, resolution, n, aspect_ratio } = req.body;

    const token = await generateKlingJwt();
    if (!token) return res.status(500).json({ error: "Failed to fetch JWT token" });

    const endpoint = `${KLING_API_BASE}/images/generations`;
    const body = {
      model_name: "kling-v2",
      prompt,
      negative_prompt: "",
      resolution,
      n,
      aspect_ratio,
    };

    const response = await axios.post(endpoint, body, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    res.json({
      ...response.data,
      task_id: response.data?.data?.task_id,
    });
  } catch (error) {
    console.error("❌ Error in create task:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.get("/api/kling-txt2img/:task_id", async (req, res) => {
  try {
    const { task_id } = req.params;
    const token = await generateKlingJwt();
    if (!token) return res.status(500).json({ error: "Failed to fetch JWT token" });

    const endpoint = `${KLING_API_BASE}/images/generations/${task_id}`;
    const response = await axios.get(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (
      response.data &&
      response.data.data &&
      response.data.data.task_status === "succeeded" &&
      response.data.data.task_result &&
      response.data.data.task_result.images
    ) {
      return res.json({
        status: "succeeded",
        images: response.data.data.task_result.images.map((img) => ({ url: img.url })),
      });
    } else {
      return res.json({
        status: response.data.data.task_status,
      });
    }
  } catch (error) {
    console.error("❌ Error in poll task:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

// === START SERVER ===
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  console.log(`Using Storage Key path: ${storageKeyPath}`);
});
