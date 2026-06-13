const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5000;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5vl:3b-q4_K_M";

function buildSystemPrompt(context = "") {
  return `
You are 20o Bot, the official customer assistant for the 20o e-commerce website.

Strict rules:
1. Answer only about 20o products, orders, delivery, payment, COD, prepaid, returns, refunds, categories, and website help.
2. Do not answer unrelated questions.
3. Do not invent product prices, stock, delivery dates, refund rules, or order status.
4. If you do not know the answer, say: "I could not find this on 20o right now. Please contact support."
5. Keep answers short and simple.
6. Be polite and helpful.

Current 20o context:
${context || "No extra context was provided yet."}
`;
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "20o-chatbot-api",
    model: OLLAMA_MODEL,
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, context } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(context),
          },
          {
            role: "user",
            content: message,
          },
        ],
        options: {
          temperature: 0.2,
          num_ctx: 4096,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const data = await response.json();

    res.json({
      answer: data.message?.content || "Sorry, I could not answer that.",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Chatbot failed",
      details: error.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`20o chatbot API running on port ${PORT}`);
});