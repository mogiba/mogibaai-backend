const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// --- GOOGLE SA KEY: Use Secret File on Render.com ---
const saKeyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, "./secrets/sa-key.json");
const storageKeyPath = process.env.GOOGLE_STORAGE_KEY || path.join(__dirname, "./secrets/mogibaai-storage-key.json");

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

app.use(express.json({ limit: "20mb" }));
app.use(cors());

// Import routes
const vertexImageUltraRoute = require("./vertex-image-ultra-endpoint");
const vertexImageFastRoute = require("./vertex-imagen4fast-generate-endpoint");
const klingTxt2ImgRoute = require("./kling-txt2img");
const razorpayRoute = require("./razorpay");

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});

app.get("/", (req, res) => {
  res.send("Mogibaai backend is running!");
});

// Use routes
app.use("/api", vertexImageUltraRoute);
app.use("/api", vertexImageFastRoute);
app.use("/api", klingTxt2ImgRoute);
app.use("/api/payments", razorpayRoute);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  console.log(`Using Storage Key path: ${storageKeyPath}`);
});
