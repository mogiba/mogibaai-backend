// utils/klingJwt.js
const jwt = require("jsonwebtoken");

/**
 * Generate Kling AI JWT token
 * @param {string} accessKey - Kling API access key
 * @param {string} secretKey - Kling API secret key
 * @returns {string} JWT token
 */
function getKlingJwt(accessKey, secretKey) {
  // JWT header
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  // Current time in seconds
  const now = Math.floor(Date.now() / 1000);

  // JWT payload
  const payload = {
    iss: accessKey,
    exp: now + 1800,      // valid for 30min
    nbf: now - 5,         // valid 5 sec before now
  };

  // Generate JWT (no need to set header explicitly, jsonwebtoken does it)
  return jwt.sign(payload, secretKey, { algorithm: "HS256", header });
}

module.exports = { getKlingJwt };
