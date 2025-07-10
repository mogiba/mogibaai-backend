// index.js (Express backend main entry - Render.com Secret File version)

const express = require("express");
const cors = require("cors");
require("dotenv").config(); // Load .env variables

// --- GOOGLE SA KEY: Use Secret File on Render.com ---
const fs = require("fs");
const path = require("path");

const saKeyPath = "/etc/secrets/sa-key.json"; // Render.com Secret File path
if (!fs.existsSync(saKeyPath)) {
  throw new Error("Google Service Account key file (sa-key.json) not found at /etc/secrets/sa-key.json. Please upload in Render.com Secret Files.");
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
