const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// --- Razorpay keys debug (optional) ---
const kId = (process.env.RAZORPAY_KEY_ID || "").trim();
const kSec = (process.env.RAZORPAY_KEY_SECRET || "").trim();
console.log("🔑 RZP KEY_ID ..", kId ? kId.slice(-6) : "missing", "| SECRET loaded:", !!kSec);

// --- Google SA key setup (Render secrets first, else local) ---
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

process.env.GOOGLE_APPLICATION_CREDENTIALS = saKeyPath;
process.env.GOOGLE_STORAGE_KEY = storageKeyPath;

const app = express();
app.use(cors());

// ⚠️ Razorpay webhook కి raw body కావాలి (signature verify కోసం).
// ఈ మిడిల్‌వేర్ **express.json** కంటే ముందే ఉండాలి.
app.use("/api/payments/razorpay/webhook", express.raw({ type: "application/json" }));

// మిగతా అన్ని రూట్స్ కోసం JSON parser
app.use(express.json({ limit: "20mb" }));

// --- Routes ---
const razorpayRoute = require("./routes/razorpayRoute");
const textToImageRoutes = require("./routes/textToImageRoutes");
const gptRoute = require("./routes/gptRoute");
const creditRoutes = require("./routes/creditRoutes");

// --- Health / Root ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});
app.get("/", (_req, res) => {
  res.send("Mogibaai backend is running!");
});

// --- Mount routes ---
app.use("/api/payments", razorpayRoute);
app.use("/api/text2img", textToImageRoutes);
app.use("/api/gpt", gptRoute);
app.use("/api/credits", creditRoutes);

// --- Start server ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  console.log(`Using Storage Key path: ${storageKeyPath}`);
});
