const express = require("express");
const OpenAI = require("openai");

const router = express.Router();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ✅ User Input Prompt Generator
router.post("/generate", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input) {
      return res.status(400).json({ error: "Input is required" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // ✅ stable & cheap
      messages: [
        { role: "system", content: "You are an expert AI art prompt generator. Always reply with a single creative prompt suitable for AI image/video generation." },
        { role: "user", content: `Generate a detailed creative prompt for: ${input}` },
      ],
    });

    const prompt = response.choices[0].message.content;
    res.json({ prompt });
  } catch (err) {
    console.error("GPT error:", err);
    res.status(500).json({ error: "Failed to generate prompt" });
  }
});

module.exports = router;
