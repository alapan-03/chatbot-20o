const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5000;
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const OLLAMA_CHAT_MODEL =
  process.env.OLLAMA_CHAT_MODEL ||
  process.env.OLLAMA_MODEL ||
  "qwen2.5vl:3b-q4_K_M";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const RAG_SEARCH_LIMIT = Number(process.env.RAG_SEARCH_LIMIT || 8);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function ensureConfig() {
  if (!OLLAMA_BASE_URL) {
    throw new Error("OLLAMA_BASE_URL is required");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
}

function toVectorSql(embedding) {
  return `[${embedding.join(",")}]`;
}

async function createEmbedding(text) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_EMBED_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    const textError = await response.text();
    throw new Error(`Embedding failed: ${response.status} ${textError}`);
  }

  const data = await response.json();
  const embedding = data.embeddings?.[0] || data.embedding;

  if (!Array.isArray(embedding)) {
    throw new Error("No embedding returned");
  }

  return embedding;
}

async function semanticSearch(query, limit = RAG_SEARCH_LIMIT) {
  const embedding = await createEmbedding(query);

  const result = await pool.query(
    `
    SELECT
      id,
      title,
      content,
      source_file,
      sheet_name,
      row_index,
      1 - (embedding <=> $1::vector) AS similarity
    FROM rag_documents
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
    `,
    [toVectorSql(embedding), limit]
  );

  return result.rows;
}

function buildContext(results) {
  return results
    .map((item, index) => {
      return `
Result ${index + 1}
Title: ${item.title}
Source: ${item.source_file}, ${item.sheet_name}, row ${item.row_index}
Similarity: ${Number(item.similarity).toFixed(3)}
Content:
${item.content}
      `.trim();
    })
    .join("\n\n---\n\n");
}

function buildSystemPrompt(context = "") {
  return `
You are 20o Bot, the official customer assistant for the 20o e-commerce website.

Strict rules:
1. Answer only about 20o products, orders, delivery, payment, COD, prepaid, returns, refunds, categories, and website help.
2. Use only the provided context.
3. Do not answer unrelated questions.
4. Do not invent product prices, stock, delivery dates, variant availability, refund rules, or order status.
5. If the context does not contain the answer, say: "I could not find this on 20o right now. Please contact support."
6. Keep answers short and simple.
7. Be polite and helpful.

Current 20o context:
${context || "No relevant 20o context found."}
`;
}

async function askOllama(message, context) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_CHAT_MODEL,
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
    throw new Error(`Ollama chat failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.message?.content || "Sorry, I could not answer that.";
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "20o-chatbot-api",
    chatModel: OLLAMA_CHAT_MODEL,
    embedModel: OLLAMA_EMBED_MODEL,
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    ensureConfig();

    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    const results = await semanticSearch(message);
    const context = buildContext(results);
    const answer = await askOllama(message, context);

    res.json({
      answer,
      sources: results.map((item) => ({
        title: item.title,
        source_file: item.source_file,
        sheet_name: item.sheet_name,
        row_index: item.row_index,
        similarity: item.similarity,
      })),
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
