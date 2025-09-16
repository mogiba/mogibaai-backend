// index.js – stable (webhook-first, storage bucket auto-resolve, routes wired)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { FEATURE_REPLICATE_IMG2IMG } = require('./config/replicateModels');

// --- Razorpay debug (safe) ---
const kId = (process.env.RAZORPAY_KEY_ID || "").trim();
const kSec = (process.env.RAZORPAY_KEY_SECRET || "").trim();
console.log(
  "🔑 RZP KEY_ID ..",
  kId ? kId.slice(-6) : "missing",
  "| SECRET loaded:",
  !!kSec,
);

// --- Resolve Google SA key (REQUIRED) ---
const CANDIDATE_SA_ETC = "/etc/secrets/sa-key.json";
const LOCAL_SA = path.join(__dirname, "secrets", "sa-key.json");
const saKeyPath = fs.existsSync(CANDIDATE_SA_ETC) ? CANDIDATE_SA_ETC : LOCAL_SA;

if (!fs.existsSync(saKeyPath)) {
  console.error("❌ Google Service Account key file NOT found at", saKeyPath);
  throw new Error("Google Service Account key file not found");
}
console.log(`✅ SA key found at ${saKeyPath}`);
process.env.GOOGLE_APPLICATION_CREDENTIALS = saKeyPath;

// --- Resolve Storage key (OPTIONAL) ---
const CANDIDATE_STORAGE_ETC = "/etc/secrets/mogibaa-storage-key.json";
const LOCAL_STORAGE = path.join(
  __dirname,
  "secrets",
  "mogibaa-storage-key.json",
);

let storageKeyPath = "";
if (fs.existsSync(CANDIDATE_STORAGE_ETC))
  storageKeyPath = CANDIDATE_STORAGE_ETC;
else if (fs.existsSync(LOCAL_STORAGE)) storageKeyPath = LOCAL_STORAGE;

if (storageKeyPath) {
  console.log(`✅ Storage key found at ${storageKeyPath}`);
  process.env.GOOGLE_STORAGE_KEY = storageKeyPath;
} else {
  console.warn(
    "⚠️  Storage key file NOT found (OK). Will infer bucket from env or service account.",
  );
}

// --- Ensure FIREBASE_STORAGE_BUCKET env ---
(function ensureBucketEnv() {
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    if (process.env.REACT_APP_FIREBASE_STORAGE_BUCKET) {
      process.env.FIREBASE_STORAGE_BUCKET =
        process.env.REACT_APP_FIREBASE_STORAGE_BUCKET;
    } else if (storageKeyPath) {
      try {
        const j = JSON.parse(fs.readFileSync(storageKeyPath, "utf8"));
        const b = j.bucket || j.bucket_name || j.storageBucket;
        if (b) process.env.FIREBASE_STORAGE_BUCKET = b;
      } catch { }
    }
  }
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    try {
      const sa = JSON.parse(fs.readFileSync(saKeyPath, "utf8"));
      if (sa.project_id)
        process.env.FIREBASE_STORAGE_BUCKET = `${sa.project_id}.appspot.com`;
    } catch { }
  }
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    console.log("🪣 Storage bucket =", process.env.FIREBASE_STORAGE_BUCKET);
  } else {
    console.warn(
      "⚠️  FIREBASE_STORAGE_BUCKET not resolved yet; utils/firebaseUtils handles this gracefully.",
    );
  }
})();

// --- Early bootstrap firebase-admin via our helper ---
require("./utils/firebaseUtils");
const { bucket: __storageBucket } = require('./utils/firebaseUtils');

const app = express();

/* === CRITICAL: Razorpay webhook must get RAW body BEFORE json parser === */
app.use(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json" }),
);

// Global middleware for the rest
app.use(express.json({ limit: "20mb" }));

// CORS: allow dev localhost and production frontend, permit Authorization and X-Uid
const allowedOrigins = ["http://localhost:3000", "https://mogibaai.com", "https://www.mogibaai.com"];
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (e.g. curl, server-to-server)
      if (!origin) return callback(null, true);
      // exact match list
      if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
      // allow any subdomain of mogibaai.com
      try {
        const u = new URL(origin);
        if (u.hostname && (u.hostname === 'mogibaai.com' || u.hostname.endsWith('.mogibaai.com'))) return callback(null, true);
      } catch (_) { }
      const msg = "The CORS policy for this site does not allow access from the specified Origin.";
      return callback(new Error(msg), false);
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Uid", "X-Forwarded-Authorization", "X-Email"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
console.log("CORS: allowed origins ->", allowedOrigins.join(", "), ' + *.mogibaai.com');

// Important: when credentials:true is used, Access-Control-Allow-Origin must
// NOT be the wildcard '*' — some environments or proxies may rewrite headers
// and cause the browser to reject credentialed responses. Ensure we echo the
// incoming Origin for allowed origins to be explicit.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (allowedOrigins.indexOf(origin) !== -1 || host === 'mogibaai.com' || host.endsWith('.mogibaai.com') || host === 'localhost') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  } catch (e) { }
  return next();
});

// === Routes ===
const plansRoute = require("./routes/plansRoute");
const creditsRoute = require("./routes/creditsRoute");
const paymentsRoute = require("./routes/paymentsRoute"); // /api/payments/razorpay

// Keep other existing routes
const textToImageRoutes = require("./routes/textToImageRoutes");
let gptRoute = null;
try {
  gptRoute = require("./routes/gptRoute");
} catch (e) {
  console.warn("[WARN] gptRoute failed to load (OpenAI key may be missing). Skipping gpt routes.", e && e.message);
}
const userRoute = require("./routes/userRoute");
const adminRoute = require("./routes/adminRoute");

// Health
app.get("/health", (req, res) =>
  res.json({ status: "ok", message: "Backend is live!" }),
);
app.get("/", (req, res) => res.send("Mogibaa backend is running!"));

// Features discovery for frontend gating
app.get('/api/features', (req, res) => {
  const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'firebase';
  res.json({ ok: true, features: { FEATURE_REPLICATE_IMG2IMG, STORAGE_BACKEND } });
});

// Mount
app.use("/api/plans", plansRoute);
app.use("/api/credits", creditsRoute);
app.use("/api/payments/razorpay", paymentsRoute);
// Replicate webhook must be raw; mount before global json parser is fine since we already used raw for RZP.
const replicateWebhookRoute = require('./routes/replicateWebhookRoute');
app.use('/api/replicate', replicateWebhookRoute);
// New billing endpoints (minimal wrapper over payments/razorpay flows)
const billingRoute = require("./routes/billingRoute");
app.use("/api/billing", billingRoute);
// Img2Img routes (multipart + json) under /api
const img2imgRoute = require('./routes/img2imgRoute');
app.use('/api', img2imgRoute);
// Txt2Img routes (text inputs)
const txt2imgRoute = require('./routes/txt2imgRoute');
app.use('/api', txt2imgRoute);

// Debug echo endpoints (POST /api/debug/echo)
const debugRoute = require("./routes/debugRoute");
app.use("/api/debug", debugRoute);

app.use("/api/text2img", textToImageRoutes);
if (gptRoute) app.use("/api/gpt", gptRoute);
app.use("/api/user", userRoute);
app.use("/api/admin", adminRoute);

// Start
const PORT = process.env.PORT || 4000;
// Fail fast for Replicate secrets when feature is enabled
if (FEATURE_REPLICATE_IMG2IMG) {
  const tok = (process.env.REPLICATE_API_TOKEN || '').trim();
  const whs = (process.env.REPLICATE_WEBHOOK_SECRET || '').trim();
  if (!tok || !whs) {
    console.error('❌ Missing Replicate configuration:', {
      hasToken: !!tok,
      hasWebhookSecret: !!whs,
    });
    throw new Error('REPLICATE_API_TOKEN and REPLICATE_WEBHOOK_SECRET are required when FEATURE_REPLICATE_IMG2IMG is enabled');
  }
  // Ensure Firebase Storage bucket available when running img2img
  const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'firebase';
  if (STORAGE_BACKEND === 'firebase') {
    if (!__storageBucket) {
      console.error('❌ Firebase Storage bucket not configured. Set FIREBASE_STORAGE_BUCKET or ensure service account project_id is present.');
      throw new Error('Firebase Storage bucket required for img2img when STORAGE_BACKEND=firebase');
    }
  }
}

app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
  console.log(`Using SA Key path: ${saKeyPath}`);
  if (storageKeyPath) console.log(`Using Storage Key path: ${storageKeyPath}`);
  try {
    const { startSweeper } = require('./services/sweeper');
    startSweeper();
  } catch (e) {
    console.warn('Sweeper not started:', e && e.message);
  }
});
