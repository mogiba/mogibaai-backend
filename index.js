// index.js – stable (webhook-first, storage bucket auto-resolve, routes wired)
const path = require("path");
const fs = require("fs");
// Load .env from this folder explicitly (cwd may be repo root)
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_\-]*)\s*=\s*(.*)\s*$/);
      if (!m) return;
      const key = m[1];
      let val = m[2];
      // Strip optional quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    });
    try {
      const len = (process.env.REPLICATE_API_TOKEN || '').length;
      console.log('[env] REPLICATE_API_TOKEN length =', len);
    } catch { }
  }
} catch { }
try {
  const p = path.join(__dirname, ".env");
  const exists = require('fs').existsSync(p);
  console.log(`[env] dotenv path=${p} exists=${exists}`);
  if (exists) {
    const keys = [
      'REPLICATE_API_TOKEN',
      'REPLICATE_WEBHOOK_SECRET',
      'PUBLIC_API_BASE',
      'RAZORPAY_KEY_ID'
    ];
    const snapshot = keys.reduce((acc, k) => { const v = process.env[k] || ''; acc[k] = v ? `${v.slice(0, 3)}…(${v.length})` : 'missing'; return acc; }, {});
    console.log('[env] snapshot', snapshot);
  }
} catch { }
const express = require("express");
const cors = require("cors");
try {
  const tl = (process.env.REPLICATE_API_TOKEN || '').length;
  console.log('[env] before require(config/replicateModels) token length =', tl);
} catch { }
const { FEATURE_REPLICATE_IMG2IMG } = require('./config/replicateModels');
const multer = require('multer');
const upload = multer().any(); // Accept both image/file fields

// --- Razorpay debug (safe) ---
const kId = (process.env.RAZORPAY_KEY_ID || "").trim();
const kSec = (process.env.RAZORPAY_KEY_SECRET || "").trim();
console.log(
  "🔑 RZP KEY_ID ..",
  kId ? kId.slice(-6) : "missing",
  "| SECRET loaded:",
  !!kSec,
);

// Debug proxy scope (Replicate-only)
console.log('Proxy scope', {
  FIXIE_URL: !!process.env.FIXIE_URL,
  HTTP_PROXY: !!process.env.HTTP_PROXY,
  HTTPS_PROXY: !!process.env.HTTPS_PROXY,
  note: 'Proxy will be used only for Replicate via replicateFetch()/agent',
});

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

/* === CRITICAL: Webhooks need RAW body BEFORE json parser === */
app.use("/api/payments/razorpay/webhook", express.raw({ type: "application/json" }));
// Replicate webhooks (both canonical and alias) must also receive raw body
try {
  const { handleReplicateWebhook } = require('./routes/replicateWebhookRoute');
  app.post('/api/replicate/webhook', express.raw({ type: 'application/json' }), handleReplicateWebhook);
  app.post('/api/webhooks/replicate', express.raw({ type: 'application/json' }), handleReplicateWebhook);
} catch (_) { }

// CORS: allow dev localhost and production frontend, permit Authorization and X-Uid
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "https://mogibaai.com",
  "https://www.mogibaai.com",
];
const allowedOriginsLower = allowedOrigins.map((s) => s.toLowerCase());
const IS_DEV = (process.env.ENV_NAME || process.env.NODE_ENV || 'development') !== 'production';
const corsOptions = {
  origin: function (origin, callback) {
    if (IS_DEV) return callback(null, true);
    if (!origin) return callback(null, true);
    const o = String(origin).toLowerCase();
    if (allowedOriginsLower.indexOf(o) !== -1) return callback(null, true);
    try {
      const u = new URL(o);
      const host = (u.hostname || '').toLowerCase();
      const port = (u.port || '').toString();
      if (host === 'mogibaai.com' || host.endsWith('.mogibaai.com')) return callback(null, true);
      if (host === 'localhost' || host === '127.0.0.1') return callback(null, true);
    } catch (_) { }
    console.warn('[CORS] blocked origin', origin);
    const msg = "The CORS policy for this site does not allow access from the specified Origin.";
    return callback(new Error(msg), false);
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Uid", "X-Forwarded-Authorization", "X-Email"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};
app.use(
  cors({
    ...corsOptions,
  }),
);
console.log("CORS: allowed origins ->", allowedOrigins.join(", "), ' + *.mogibaai.com');
if (IS_DEV) console.log('[CORS] Development mode: allowing all origins');

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
    if (allowedOrigins.indexOf(origin) !== -1 || host === 'mogibaai.com' || host.endsWith('.mogibaai.com') || host === 'localhost' || host === '127.0.0.1') {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
  } catch (e) { }
  return next();
});

// Global middleware for the rest
app.use(express.json({ limit: "20mb" }));

// === Routes ===
const plansRoute = require("./routes/plansRoute");
const creditsRoute = require("./routes/creditsRoute");
const paymentsRoute = require("./routes/paymentsRoute"); // /api/payments/razorpay

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
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", message: "Backend is live! (api/health)" }),
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
// Replicate routes (non-webhook endpoints) can mount after JSON
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
// Images route (delete etc.)
const imagesRoute = require('./routes/imagesRoute');
app.use('/api/images', imagesRoute);
// Community admin actions
const communityRoute = require('./routes/communityRoute');
app.use('/api/community', communityRoute);

// Debug echo endpoints (POST /api/debug/echo)
const debugRoute = require("./routes/debugRoute");
app.use("/api/debug", debugRoute);

const debugSmokeTestRoute = require("./routes/debugSmokeTestRoute");
app.use("/api/debug", debugSmokeTestRoute);

if (gptRoute) app.use("/api/gpt", gptRoute);
app.use("/api/user", userRoute);
app.use("/api/admin", adminRoute);

// Start
const PORT = process.env.PORT || 4000;
// Validate storage bucket if img2img is enabled
if (FEATURE_REPLICATE_IMG2IMG) {
  const STORAGE_BACKEND = process.env.STORAGE_BACKEND || 'firebase';
  if (STORAGE_BACKEND === 'firebase') {
    if (!__storageBucket) {
      console.error('❌ Firebase Storage bucket not configured. Set FIREBASE_STORAGE_BUCKET or ensure service account project_id is present.');
      throw new Error('Firebase Storage bucket required for img2img when STORAGE_BACKEND=firebase');
    }
  }
}

// Global error handler: ensure JSON responses for all errors
app.use((err, req, res, next) => {
  try {
    const code = Number(err?.status || err?.statusCode || 500);
    const msg = err?.message || 'Internal Server Error';
    // Normalize CORS/body-parser errors
    const isCors = /CORS policy/i.test(msg);
    const out = isCors
      ? { ok: false, error: 'CORS', message: msg }
      : { ok: false, error: 'INTERNAL', message: msg };
    res.status(code >= 400 && code < 600 ? code : 500).json(out);
  } catch (_) {
    res.status(500).json({ ok: false, error: 'INTERNAL', message: 'unknown' });
  }
});

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
