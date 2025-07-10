// server.js

const express = require("express");
const cors = require("cors");
require("dotenv").config(); // .env nunchi variables load cheyyadam ki

const app = express();

// --- Middlewares ---
app.use(express.json());
app.use(cors());

// --- IMPORT ROUTES ---
const vertexImagenRoute = require("./vertex-image-endpoint");
const razorpayRoute = require("./razorpay");
const vertexImagen4FastRoute = require("./vertex-imagen4fast-generate-endpoint");
const klingApiRoute = require("./klingApi"); // (NEW) Kling API Route

// --- USE ROUTES ---
app.use("/api", vertexImagenRoute);
app.use("/api", vertexImagen4FastRoute);
app.use("/api/payments", razorpayRoute);
app.use("/api/kling", klingApiRoute); // NEW: Kling AI API (supports POST + GET status)

// --- SERVER START ---
app.listen(4000, () => {
  console.log("✅ Server started on http://localhost:4000");
});
