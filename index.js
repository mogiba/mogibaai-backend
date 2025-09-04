const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// at the top of index.js (after require('dotenv').config())
const kId = (process.env.RAZORPAY_KEY_ID || '').trim();
const kSec = (process.env.RAZORPAY_KEY_SECRET || '').trim();
console.log('🔑 RZP KEY_ID ..', kId.slice(-6), '| SECRET loaded:', !!kSec);

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

// === ROUTES IMPORTS ===
const webhookRoute = require("./routes/webhookRoute");
const razorpayRoute = require("./routes/razorpayRoute");
const textToImageRoutes = require("./routes/textToImageRoutes");
const gptRoute = require("./routes/gptRoute");
const creditRoutes = require("./routes/creditRoutes");

// === WEBHOOK ROUTE (must be before express.json) ===
app.use("/api/payments", webhookRoute);

// === JSON body parser for other routes ===
app.use(express.json({ limit: "20mb" }));

// === ROOT + HEALTH ===
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});
app.get("/", (req, res) => {
  res.send("Mogibaai backend is running!");
});

// === ROUTE MOUNTING ===
app.use("/api/payments", razorpayRoute);
app.use("/api/text2img", textToImageRoutes);
app.use("/api/gpt", gptRoute);
app.use("/api/credits", creditRoutes); // ✅ Credits route mounted correctly

// === START SERVER ===
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  console.log(`Using Storage Key path: ${storageKeyPath}`);
});
