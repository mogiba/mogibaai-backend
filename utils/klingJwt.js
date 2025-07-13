// utils/klingJwt.js
const jwt = require('jsonwebtoken');

const KLING_API_KEY = process.env.KLING_API_KEY;
const KLING_API_SECRET = process.env.KLING_API_SECRET;

function generateKlingJwt() {
  if (!KLING_API_KEY || !KLING_API_SECRET) {
    throw new Error("Kling API key/secret missing in .env!");
  }
  const payload = {
    iss: KLING_API_KEY,
    exp: Math.floor(Date.now() / 1000) + 1800, // 30 min expiry
    nbf: Math.floor(Date.now() / 1000) - 5      // 5 sec before now
  };
  // Default HS256, same as your Postman/Python example
  return jwt.sign(payload, KLING_API_SECRET, { algorithm: 'HS256', header: { typ: 'JWT' } });
}

module.exports = { generateKlingJwt };
