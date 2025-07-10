// index.js (Express backend main entry)

const express = require("express");
const cors = require("cors");
require("dotenv").config(); // Load .env variables

// --- GOOGLE SA KEY: Create sa-key.json at runtime from env var (must for Render/production) ---
const fs = require("fs");
const path = require("path");
if (process.env.GOOGLE_SA_KEY_B64) {
  const saPath = path.join(__dirname, "sa-key.json");
  fs.writeFileSync(
    saPath,
    Buffer.from(process.env.GOOGLE_SA_KEY_B64, "base64").toString("utf-8")
  );
}

const app = express();

// --- Middlewares ---
app.use(express.json());
app.use(cors());

// --- IMPORT ROUTES ---
const vertexImagenRoute = require("./vertex-image-endpoint");
const razorpayRoute = require("./razorpay");
const vertexImagen4FastRoute = require("./vertex-imagen4fast-generate-endpoint");
const klingApiRoute = require("./klingApi"); // Kling API Route

// --- HEALTH & ROOT ROUTES ---
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is live!" });
});

app.get("/", (req, res) => {
  res.send("Mogibaai backend is running!");
});

// --- USE ROUTES ---
app.use("/api", vertexImagenRoute);
app.use("/api", vertexImagen4FastRoute);
app.use("/api/payments", razorpayRoute);
app.use("/api/kling", klingApiRoute); // Kling AI API (supports POST + GET status)

// --- SERVER START ---
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
});
