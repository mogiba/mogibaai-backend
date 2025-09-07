// index.js - final (UPDATED)
// Main server entry for Mogibaai backend
// - supports Razorpay orders + webhook (raw body)
// - picks up Google SA keys either from Render secret mount (/etc/secrets) or local ./secrets
// - mounts routes

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// --- Debug Razorpay keys (safe: only show tail of key) ---
const kId = (process.env.RAZORPAY_KEY_ID || "").trim();
const kSec = (process.env.RAZORPAY_KEY_SECRET || "").trim();
console.log("🔑 RZP KEY_ID ..", kId ? kId.slice(-6) : "missing", "| SECRET loaded:", !!kSec);

// --- Google service-account / storage key resolution ---
// Render.com exposes secret files at /etc/secrets/<filename> if you add them in dashboard.
const RENDER_SA = "/etc/secrets/sa-key.json";
const RENDER_STORAGE = "/etc/secrets/mogibaai-storage-key.json";

const localSa = path.join(__dirname, "secrets", "sa-key.json");
const localStorage = path.join(__dirname, "secrets", "mogibaai-storage-key.json");

const saKeyPath = fs.existsSync(RENDER_SA) ? RENDER_SA : localSa;
const storageKeyPath = fs.existsSync(RENDER_STORAGE) ? RENDER_STORAGE : localStorage;

if (!fs.existsSync(saKeyPath)) {
  console.error("❌ Google Service Account key file NOT found at", saKeyPath);
  throw new Error("Google Service Account key file not found");
} else {
  console.log(`✅ SA key found at ${saKeyPath}`);
}

if (!fs.existsSync(storageKeyPath)) {
  console.error("❌ Google Storage key file NOT found at", storageKeyPath);
  throw new Error("Google Storage key file not found");
} else {
  console.log(`✅ Storage key found at ${storageKeyPath}`);
}

// Ensure environment variables point to resolved paths for libs that rely on them
process.env.GOOGLE_APPLICATION_CREDENTIALS = saKeyPath;
process.env.GOOGLE_STORAGE_KEY = storageKeyPath;

const app = express();

// === IMPORTANT: Razorpay webhooks must verify signature over raw body.
// Register a raw body parser for the exact webhook path BEFORE express.json() so
// the webhook handler receives the Buffer it needs for signature verification.
app.use(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json" })
);

// JSON parser + CORS for all other endpoints
app.use(express.json({ limit: "20mb" }));
app.use(cors());

// === Import routes (do this after middleware registration)
const razorpayRoute = require("./routes/razorpayRoute");
const textToImageRoutes = require("./routes/textToImageRoutes");
const gptRoute = require("./routes/gptRoute");
const creditRoutes = require("./routes/creditRoutes");
const userRoute = require('./routes/userRoute'); // <-- mounted user routes
const adminRoute = require('./routes/adminRoute'); // <-- ADD THIS

// Optional: debug that route file was loaded
try {
  console.log('userRoute module loaded');
} catch (err) {
  // ignore
}

// === Health and root
app.get("/health", (req, res) => res.json({ status: "ok", message: "Backend is live!" }));
app.get("/", (req, res) => res.send("Mogibaai backend is running!"));

// === Mount routes
// razorpayRoute contains: /razorpay/create-order, /razorpay/verify, and /razorpay/webhook
app.use("/api/payments", razorpayRoute);
app.use("/api/text2img", textToImageRoutes);
app.use("/api/gpt", gptRoute);
app.use("/api/credits", creditRoutes);
app.use('/api/user', userRoute); // <-- ensure user routes are mounted
app.use('/api/admin', adminRoute); // <-- ADD THIS

// === Start server ===
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  console.log(`Using Storage Key path: ${storageKeyPath}`);
});
