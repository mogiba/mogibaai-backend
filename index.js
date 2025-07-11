// index.js (Express backend main entry – Render.com Secret File version, multi-model support)

const express = require("express");
const cors = require("cors");
require("dotenv").config(); // Load .env variables

// --- GOOGLE SA KEY: Use Secret File on Render.com ---
const fs = require("fs");
const path = require("path");

// IMPORTANT: Render.com lo /etc/secrets/sa-key.json & mogibaai-storage-key.json renditini upload cheyyali
const saKeyPath = "/etc/secrets/sa-key.json"; // Main service account
const storageKeyPath = "/etc/secrets/mogibaai-storage-key.json"; // Storage access (if needed)

if (!fs.existsSync(saKeyPath)) {
  throw new Error("Google Service Account key file (sa-key.json) not found at /etc/secrets/sa-key.json. Please upload in Render.com Secret Files.");
}
if (!fs.existsSync(storageKeyPath)) {
  throw new Error("Google Storage key file (mogibaai-storage-key.json) not found at /etc/secrets/mogibaai-storage-key.json. Please upload in Render.com Secret Files.");
}

// Set as env for Google SDKs (in case)
process.env.GOOGLE_APPLICATION_CREDENTIALS = saKeyPath;

const app = express();

// --- Middlewares ---
app.use(express.json({ limit: "20mb" })); // Large images, bump up if needed
app.use(cors());

// --- IMPORT ROUTES (NEW MULTI-MODEL) ---
// ULTRA model
const vertexImageUltraRoute = require("./vertex-image-ultra-endpoint");
// FAST model
const vertexImageFastRoute = require("./vertex-imagen4fast-generate-endpoint");
// Kling AI txt2img
const klingTxt2ImgRoute = require("./kling-txt2img");
// Payments (Razorpay)
const razorpayRoute = require("./razorpay");

// --- HEALTH & ROOT ROUTES ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});

app.get("/", (req, res) => {
  res.send("Mogibaai backend is running!");
});

// --- USE ROUTES (PRODUCTION ENDPOINTS) ---
app.use("/api", vertexImageUltraRoute);         // /api/google-imagen-ultra
app.use("/api", vertexImageFastRoute);          // /api/google-imagen-fast
app.use("/api", klingTxt2ImgRoute);             // /api/kling-txt2img (Kling txt2img endpoint)
app.use("/api/payments", razorpayRoute);        // Razorpay payment

// --- SERVER START ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
});
