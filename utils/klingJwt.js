const axios = require('axios');

async function generateKlingJwt() {
  try {
    const res = await axios.get('http://127.0.0.1:8000/kling-jwt');
    return res.data.token;
  } catch (err) {
    console.error("JWT fetch error:", err.message);
    return null;
  }
}

module.exports = { generateKlingJwt };
