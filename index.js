const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// --- GOOGLE SA KEY: Use Secret File on Render.com ---
// Resolve key paths: prefer env var, else use local secrets folder
const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : path.join(__dirname, "secrets", "sa-key.json");
const storageKeyPath = process.env.GOOGLE_STORAGE_KEY
  ? path.resolve(__dirname, process.env.GOOGLE_STORAGE_KEY)
  : path.join(__dirname, "secrets", "mogibaai-storage-key.json");

// Check if secret files exist & log
if (!fs.existsSync(saKeyPath)) {
  console.error(`❌ Google Service Account key file NOT found at ${saKeyPath}`);
  throw new Error(`Google Service Account key file not found at ${saKeyPath}. Please upload in Render.com Secret Files.`);
} else {
  console.log(`✅ Google Service Account key file found at ${saKeyPath}`);
}
if (!fs.existsSync(storageKeyPath)) {
  console.error(`❌ Google Storage key file NOT found at ${storageKeyPath}`);
  throw new Error(`Google Storage key file not found at ${storageKeyPath}. Please upload in Render.com Secret Files.`);
} else {
  console.log(`✅ Google Storage key file found at ${storageKeyPath}`);
}

// Set environment variable for Google SDKs
process.env.GOOGLE_APPLICATION_CREDENTIALS = saKeyPath;

const app = express();

// Middlewares
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// Import routes
const vertexImageUltraRoute = require("./vertex-image-ultra-endpoint");
const vertexImageFastRoute = require("./vertex-imagen4fast-generate-endpoint");
const klingTxt2ImgRoute = require("./kling-txt2img");
const razorpayRoute = require("./razorpay");

// Health check & root
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});
app.get("/", (req, res) => {
  res.send("Mogibaai backend is running!");
});

// Mount routes under /api
app.use("/api", vertexImageUltraRoute);       // /api/google-imagen-ultra
app.use("/api", vertexImageFastRoute);        // /api/google-imagen-fast
app.use("/api", klingTxt2ImgRoute);           // /api/kling-txt2img
app.use("/api/payments", razorpayRoute);      // /api/payments/*

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  console.log(`Using Storage Key path: ${storageKeyPath}`);
});
