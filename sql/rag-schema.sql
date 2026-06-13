CREATE EXTENSION IF NOT EXISTS vector;

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
);

CREATE INDEX IF NOT EXISTS rag_documents_embedding_idx
ON rag_documents
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
