// routes/creditRoutes.js
const express = require("express");
const router = express.Router();
const {
  getUserCredits,
  spendCredit,
  addCredits,
} = require("../services/creditsService");

// ──────────────────────────────────────────────────────────────
// Very simple header-based auth (x-uid). Replace with real auth later.
function requireAuth(req, res, next) {
  const uid = req.headers["x-uid"];
  if (!uid) return res.status(401).json({ error: "UNAUTH", message: "Missing x-uid header" });
  req.uid = uid;
  next();
}

// Small helpers
const isValidCategory = (v) => v === "image" || v === "video";
const parseQty = (v, def = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.floor(n);
};

// Disable caching for safety
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ──────────────────────────────────────────────────────────────
// GET /api/credits  → current balance
router.get("/", requireAuth, async (req, res) => {
  try {
    const { credits_image = 0, credits_video = 0 } = await getUserCredits(req.uid);
    return res.json({ credits_image, credits_video, uid: req.uid });
  } catch (e) {
    console.error("GET /api/credits error:", e);
    return res.status(500).json({ error: "SERVER_ERROR", message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/credits/spend  → debit before generation
// body: { category: "image"|"video", qty?: number }
router.post("/spend", requireAuth, async (req, res) => {
  try {
    const category = req.body?.category;
    const qty = parseQty(req.body?.qty, 1);

    if (!isValidCategory(category)) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid category" });
    }

    const remaining = await spendCredit(req.uid, category, qty);
    // success
    return res.json({ ok: true, remaining, category, qty });
  } catch (e) {
    // services/creditsService should throw a typed error for insufficient credits
    if (e && (e.code === "INSUFFICIENT_CREDITS" || e.message === "INSUFFICIENT_CREDITS")) {
      return res.status(402).json({ error: "INSUFFICIENT_CREDITS" });
    }
    console.error("POST /api/credits/spend error:", e);
    return res.status(500).json({ error: "SERVER_ERROR", message: e.message });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/credits/add  → credit (usually done after payment verify)
// body: { category: "image"|"video", qty: number, meta?: object }
router.post("/add", requireAuth, async (req, res) => {
  try {
    const category = req.body?.category;
    const qty = parseQty(req.body?.qty, 1);
    const meta = req.body?.meta || {};

    if (!isValidCategory(category)) {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Invalid category" });
    }

    await addCredits(req.uid, category, qty, meta);
    const { credits_image = 0, credits_video = 0 } = await getUserCredits(req.uid);

    return res.json({
      ok: true,
      category,
      qty,
      balance: { credits_image, credits_video },
    });
  } catch (e) {
    console.error("POST /api/credits/add error:", e);
    return res.status(500).json({ error: "SERVER_ERROR", message: e.message });
  }
});

module.exports = router;
