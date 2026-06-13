const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const EXCEL_FOLDER =
  process.env.EXCEL_FOLDER || path.join(process.cwd(), "excels");

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function rowToReadableText(row) {
  const parts = [];

  for (const [key, value] of Object.entries(row)) {
    const cleanedValue = clean(value);
    if (!cleanedValue) continue;

    parts.push(`${key}: ${cleanedValue}`);
  }

  return parts.join("\n");
}

function guessTitle(row, fallbackTitle) {
  return (
    clean(row["Product Name"]) ||
    clean(row.product_name) ||
    clean(row.Name) ||
    clean(row.Title) ||
    clean(row.title) ||
    clean(row.Category) ||
    clean(row.category) ||
    fallbackTitle
  );
}

function ensureConfig() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  if (!OLLAMA_BASE_URL) {
    throw new Error("OLLAMA_BASE_URL is required");
  }
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
    const errorText = await response.text();
    throw new Error(`Ollama embedding failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const embedding = data.embeddings?.[0] || data.embedding;

  if (!Array.isArray(embedding)) {
    throw new Error("No embedding returned from Ollama");
  }

  return embedding;
}

function toVectorSql(embedding) {
  return `[${embedding.join(",")}]`;
}

async function ensureSchema() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rag_documents (
      id SERIAL PRIMARY KEY,
      source_file TEXT,
      sheet_name TEXT,
      row_index INTEGER,
      title TEXT,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}',
      embedding vector(768),
      created_at TIMESTAMP DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
    ON rag_documents
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100)
  `);
}

async function insertDocument({
  sourceFile,
  sheetName,
  rowIndex,
  title,
  content,
  metadata,
  embedding,
}) {
  await pool.query(
    `
    INSERT INTO rag_documents
    (source_file, sheet_name, row_index, title, content, metadata, embedding)
    VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
    `,
    [
      sourceFile,
      sheetName,
      rowIndex,
      title,
      content,
      metadata,
      toVectorSql(embedding),
    ]
  );
}

async function importExcelFile(filePath) {
  const sourceFile = path.basename(filePath);
  const workbook = XLSX.readFile(filePath);
  let inserted = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const content = rowToReadableText(row);

      if (!content || content.length < 20) continue;

      const title = guessTitle(
        row,
        `${sourceFile} - ${sheetName} - Row ${index + 1}`
      );
      const finalTextForEmbedding = `
Source File: ${sourceFile}
Sheet: ${sheetName}
Title: ${title}

${content}
      `.trim();

      console.log(`Embedding: ${sourceFile} | ${sheetName} | row ${index + 1}`);

      const embedding = await createEmbedding(finalTextForEmbedding);

      await insertDocument({
        sourceFile,
        sheetName,
        rowIndex: index + 1,
        title,
        content: finalTextForEmbedding,
        metadata: row,
        embedding,
      });

      inserted++;
    }
  }

  console.log(`Imported ${inserted} rows from ${sourceFile}`);
}

async function main() {
  ensureConfig();

  if (!fs.existsSync(EXCEL_FOLDER)) {
    throw new Error(`Folder not found: ${EXCEL_FOLDER}`);
  }

  const files = fs
    .readdirSync(EXCEL_FOLDER)
    .filter((file) => file.endsWith(".xlsx") || file.endsWith(".xls"))
    .map((file) => path.join(EXCEL_FOLDER, file));

  if (files.length === 0) {
    throw new Error(`No Excel files found in ${EXCEL_FOLDER}`);
  }

  await ensureSchema();
  await pool.query("DELETE FROM rag_documents");

  for (const file of files) {
    await importExcelFile(file);
  }

  await pool.end();
  console.log("All Excel files imported into RAG database");
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
