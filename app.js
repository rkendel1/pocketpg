import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';

const state = {
  db: null,
};

const $ = (id) => document.getElementById(id);

const fileInput = $('fileInput');
const ingestBtn = $('ingestBtn');
const ingestStatus = $('ingestStatus');
const apiKeyInput = $('apiKey');
const questionInput = $('question');
const queryBtn = $('queryBtn');
const sqlPlan = $('sqlPlan');
const resultsEl = $('results');

async function initDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      source_path TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id SERIAL PRIMARY KEY,
      document_id INT REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id SERIAL PRIMARY KEY,
      document_id INT REFERENCES documents(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      from_document_id INT REFERENCES documents(id) ON DELETE CASCADE,
      to_ref TEXT NOT NULL,
      relation_type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id SERIAL PRIMARY KEY,
      chunk_id INT REFERENCES chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      embedding JSONB NOT NULL
    );
  `);
  return db;
}

function detectType(fileName) {
  const n = fileName.toLowerCase();
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.match(/\.(js|ts|tsx|py|go|rs|java|c|cpp|rb|php|json|yaml|yml)$/)) return 'code';
  return 'text';
}

function simpleExtractPdfText(buffer) {
  const text = new TextDecoder('latin1').decode(buffer);
  const candidates = text.match(/[\x20-\x7E]{4,}/g) || [];
  return candidates.join(' ').trim();
}

function chunkText(content, size = 1000) {
  const chunks = [];
  for (let i = 0; i < content.length; i += size) {
    chunks.push(content.slice(i, i + size));
  }
  return chunks;
}

function extractEntities(content) {
  const out = [];
  const dateMatches = content.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  for (const d of dateMatches) out.push({ type: 'date', value: d });

  const issueLike = content.match(/\b(TODO|FIXME|BUG|OPEN ISSUE)\b[:\- ]?([^\n]{0,120})/gi) || [];
  for (const i of issueLike) out.push({ type: 'issue', value: i.trim() });

  const fnMatches = content.match(/\bfunction\s+([a-zA-Z0-9_]+)|\bdef\s+([a-zA-Z0-9_]+)|\bconst\s+([a-zA-Z0-9_]+)\s*=\s*\(/g) || [];
  for (const f of fnMatches) out.push({ type: 'function', value: f.trim() });

  return out;
}

function extractLinks(content) {
  const out = [];
  const mdLinks = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
  for (const m of mdLinks) out.push({ ref: m[1], relation: 'citation' });

  const imports = [...content.matchAll(/import\s+[^\n]*?from\s+['"]([^'"]+)['"]/g)];
  for (const m of imports) out.push({ ref: m[1], relation: 'import' });

  return out;
}

async function ingestFiles(files) {
  if (!files.length) {
    ingestStatus.textContent = 'Select at least one file.';
    return;
  }

  let docs = 0;
  let chunks = 0;

  for (const file of files) {
    const type = detectType(file.name);
    let content = '';

    if (type === 'pdf') {
      content = simpleExtractPdfText(await file.arrayBuffer());
    } else {
      content = await file.text();
    }

    const insertDoc = await state.db.query(
      `INSERT INTO documents (source_path, type, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [file.name, type, content, JSON.stringify({ size: file.size, lastModified: file.lastModified })]
    );

    const documentId = insertDoc.rows[0].id;
    docs += 1;

    const chunked = chunkText(content);
    for (let i = 0; i < chunked.length; i += 1) {
      await state.db.query(
        `INSERT INTO chunks (document_id, chunk_index, content)
         VALUES ($1, $2, $3)`,
        [documentId, i, chunked[i]]
      );
      chunks += 1;
    }

    for (const e of extractEntities(content)) {
      await state.db.query(
        `INSERT INTO entities (document_id, entity_type, entity_value)
         VALUES ($1, $2, $3)`,
        [documentId, e.type, e.value]
      );
    }

    for (const l of extractLinks(content)) {
      await state.db.query(
        `INSERT INTO links (from_document_id, to_ref, relation_type)
         VALUES ($1, $2, $3)`,
        [documentId, l.ref, l.relation]
      );
    }
  }

  ingestStatus.textContent = `Ingested ${docs} documents and ${chunks} chunks.`;
}

function heuristicSqlFromQuestion(question) {
  const q = question.toLowerCase();

  if (q.includes('open issue') || q.includes('issues')) {
    return `
      SELECT d.source_path, e.entity_value
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'issue'
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('authentication') || q.includes('auth')) {
    return `
      SELECT d.source_path, e.entity_value
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'function'
        AND (LOWER(e.entity_value) LIKE '%auth%' OR LOWER(d.content) LIKE '%auth%')
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('themes') || q.includes('summary') || q.includes('summarize')) {
    return `
      SELECT d.type, COUNT(*) AS document_count
      FROM documents d
      GROUP BY d.type
      ORDER BY document_count DESC
    `;
  }

  return `
    SELECT source_path, type, LEFT(content, 280) AS excerpt
    FROM documents
    ORDER BY id DESC
    LIMIT 20
  `;
}

async function openAiSqlSuggestion(question, apiKey) {
  const prompt = `
You generate PostgreSQL SQL for a PGlite schema with tables:
- documents(id, source_path, type, content, metadata, created_at)
- chunks(id, document_id, chunk_index, content)
- entities(id, document_id, entity_type, entity_value)
- links(id, from_document_id, to_ref, relation_type)

Return only SQL.
Question: ${question}
`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: ['Bearer', apiKey].join(' '),
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim();
}

function ensureReadOnlySql(sql) {
  const cleaned = sql.trim().replace(/;+\s*$/, '');
  const lower = cleaned.toLowerCase();
  if (!(lower.startsWith('select') || lower.startsWith('with'))) {
    throw new Error('Only read-only SELECT/WITH queries are allowed.');
  }
  if (cleaned.includes(';')) {
    throw new Error('Multiple SQL statements are not allowed.');
  }
  return cleaned;
}

function renderRows(rows) {
  resultsEl.innerHTML = '';
  if (!rows.length) {
    resultsEl.innerHTML = '<div class="card">No rows returned.</div>';
    return;
  }

  for (const row of rows) {
    const card = document.createElement('article');
    card.className = 'card';
    const heading = document.createElement('h3');
    heading.textContent = String(row.source_path || row.type || 'Result');
    card.appendChild(heading);

    for (const [k, v] of Object.entries(row)) {
      const line = document.createElement('div');
      const key = document.createElement('span');
      key.className = 'meta';
      key.textContent = k;
      line.appendChild(key);
      line.append(`: ${String(v)}`);
      card.appendChild(line);
    }

    const followUp = document.createElement('p');
    followUp.className = 'meta';
    followUp.textContent = 'Follow-up: ask for deeper joins, contradictions, or related files.';
    card.appendChild(followUp);
    resultsEl.appendChild(card);
  }
}

async function runQuery() {
  const question = questionInput.value.trim();
  if (!question) return;

  let sql = heuristicSqlFromQuestion(question);
  const apiKey = apiKeyInput.value.trim();

  if (apiKey) {
    try {
      const aiSql = await openAiSqlSuggestion(question, apiKey);
      if (aiSql) sql = aiSql;
    } catch (err) {
      console.warn(err);
    }
  }

  sql = ensureReadOnlySql(sql);
  sqlPlan.textContent = `SQL plan:\n${sql}`;

  try {
    const result = await state.db.query(sql);
    renderRows(result.rows || []);
  } catch (err) {
    resultsEl.innerHTML = `<div class="card">Query failed: ${String(err.message || err)}</div>`;
  }
}

async function main() {
  state.db = await initDb();
  ingestBtn.addEventListener('click', () => ingestFiles(Array.from(fileInput.files || [])));
  queryBtn.addEventListener('click', runQuery);
  ingestStatus.textContent = 'LensAI ready. Ingest files to begin.';
}

main().catch((err) => {
  ingestStatus.textContent = `Initialization failed: ${String(err.message || err)}`;
});
