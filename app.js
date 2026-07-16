import { PGlite } from 'https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js';

/* ==================== State ==================== */
const state = {
  db: null,
  ingestedPaths: new Set(),
  lastQuery: null,
  lastSql: null,
  stats: { docs: 0, chunks: 0, entities: 0, memoryKb: 0 },
  queryHistory: [],
};

/* ==================== DOM Helpers ==================== */
const $ = (id) => document.getElementById(id);

const fileInput = $('fileInput');
const ingestBtn = $('ingestBtn');
const ingestGithubBtn = $('ingestGithubBtn');
const githubUrlInput = $('githubUrl');
const ingestStatus = $('ingestStatus');
const progressContainer = $('progressContainer');
const progressFill = $('progressFill');
const progressText = $('progressText');
const statsPanel = $('statsPanel');
const statDocs = $('statDocs');
const statChunks = $('statChunks');
const statEntities = $('statEntities');
const statMemory = $('statMemory');
const suggestionsPanel = $('suggestionsPanel');
const suggestionsEl = $('suggestions');
const apiKeyInput = $('apiKey');
const questionInput = $('question');
const queryBtn = $('queryBtn');
const rawSqlInput = $('rawSqlInput');
const rawSqlBtn = $('rawSqlBtn');
const sqlPlan = $('sqlPlan');
const resultsEl = $('results');
const resetBtn = $('resetBtn');
const exportBtn = $('exportBtn');
const maxFileSizeInput = $('maxFileSize');
const chunkSizeInput = $('chunkSize');
const chunkOverlapInput = $('chunkOverlap');

/* ==================== Database Setup ==================== */
async function initDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      source_path TEXT NOT NULL UNIQUE,
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

async function createIndexes() {
  try {
    await state.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_docs_type ON documents(type);
      CREATE INDEX IF NOT EXISTS idx_docs_path ON documents(source_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entities_doc ON entities(document_id);
      CREATE INDEX IF NOT EXISTS idx_links_doc ON links(from_document_id);
    `);
  } catch (err) {
    console.warn('Index creation warning:', err);
  }
}

/* ==================== File Detection & Parsing ==================== */
function detectType(fileName) {
  const n = fileName.toLowerCase();
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown';
  if (n.endsWith('.csv')) return 'csv';
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.json')) return 'json';
  if (n.match(/\.(js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php|yaml|yml|sh|bash|swift|kt|scala|sql)$/)) return 'code';
  return 'text';
}

async function extractPdfText(buffer) {
  // Use pdf.js if available for better extraction
  if (window.pdfjsLib) {
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(' ') + '\n';
      }
      return text.trim();
    } catch (err) {
      console.warn('pdf.js extraction failed, using fallback:', err);
    }
  }
  // Fallback: simple text extraction
  const text = new TextDecoder('latin1').decode(buffer);
  const candidates = text.match(/[\x20-\x7E]{4,}/g) || [];
  return candidates.join(' ').trim();
}

function parseJsonContent(content) {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

function chunkText(content, size = 1000, overlap = 100) {
  const chunks = [];
  if (content.length <= size) {
    return [content];
  }
  const step = Math.max(1, size - overlap);
  for (let i = 0; i < content.length; i += step) {
    chunks.push(content.slice(i, i + size));
    if (i + size >= content.length) break;
  }
  return chunks;
}

/* ==================== Entity Extraction ==================== */
function extractEntities(content, type) {
  const out = [];
  
  // Dates (various formats)
  const dateMatches = content.match(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g) || [];
  for (const d of dateMatches) out.push({ type: 'date', value: d });

  // TODOs, FIXMEs, BUGs, etc.
  const issueLike = content.match(/\b(TODO|FIXME|BUG|HACK|NOTE|OPEN ISSUE|XXX)\b[:\- ]?([^\n]{0,120})/gi) || [];
  for (const i of issueLike) out.push({ type: 'issue', value: i.trim() });

  // Code-specific extractions
  if (type === 'code') {
    // Functions (multiple languages)
    const fnPatterns = [
      /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
      /\bfunc\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
      /\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
      /\bconst\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
      /\blet\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
    ];
    for (const pattern of fnPatterns) {
      for (const m of content.matchAll(pattern)) {
        out.push({ type: 'function', value: m[1] || m[0] });
      }
    }

    // Exports
    const exportMatches = content.match(/\bexport\s+(default\s+)?(function|const|class|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g) || [];
    for (const e of exportMatches) out.push({ type: 'export', value: e.trim() });

    // Classes
    const classMatches = content.match(/\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g) || [];
    for (const c of classMatches) out.push({ type: 'class', value: c.trim() });

    // Dependencies (package.json references, require statements)
    const requireMatches = content.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [];
    for (const r of requireMatches) out.push({ type: 'dependency', value: r });
  }

  // Markdown-specific extractions
  if (type === 'markdown') {
    // Headings with hierarchy
    const headingMatches = content.match(/^#{1,6}\s+.+$/gm) || [];
    for (const h of headingMatches) {
      const level = (h.match(/^#+/) || [''])[0].length;
      out.push({ type: 'heading', value: `L${level}: ${h.replace(/^#+\s+/, '')}` });
    }

    // Wikilinks [[link]]
    const wikilinks = content.match(/\[\[([^\]]+)\]\]/g) || [];
    for (const w of wikilinks) out.push({ type: 'wikilink', value: w });
  }

  return out;
}

/* ==================== Link Extraction ==================== */
function extractLinks(content, type) {
  const out = [];
  
  // Markdown links [text](url)
  const mdLinks = [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
  for (const m of mdLinks) out.push({ ref: m[1], relation: 'citation' });

  // ES6 imports
  const imports = [...content.matchAll(/import\s+[^\n]*?from\s+['"]([^'"]+)['"]/g)];
  for (const m of imports) out.push({ ref: m[1], relation: 'import' });

  // CommonJS requires
  const requires = [...content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
  for (const m of requires) out.push({ ref: m[1], relation: 'require' });

  // Python imports
  const pyImports = [...content.matchAll(/(?:from\s+(\S+)\s+)?import\s+(\S+)/g)];
  for (const m of pyImports) {
    const mod = m[1] || m[2];
    if (mod) out.push({ ref: mod, relation: 'import' });
  }

  // Wikilinks
  const wikilinks = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)];
  for (const m of wikilinks) out.push({ ref: m[1], relation: 'wikilink' });

  return out;
}

/* ==================== Progress & Stats ==================== */
function showProgress(pct, text) {
  progressContainer.style.display = 'block';
  progressFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  progressText.textContent = text;
}

function hideProgress() {
  progressContainer.style.display = 'none';
}

function updateStats() {
  statDocs.textContent = `${state.stats.docs} docs`;
  statChunks.textContent = `${state.stats.chunks} chunks`;
  statEntities.textContent = `${state.stats.entities} entities`;
  statMemory.textContent = `~${state.stats.memoryKb} KB`;
  statsPanel.style.display = 'flex';
}

/* ==================== File Ingestion ==================== */
async function ingestFiles(files) {
  if (!files.length) {
    ingestStatus.textContent = 'Select at least one file.';
    return;
  }

  const maxSizeMb = parseInt(maxFileSizeInput.value, 10) || 5;
  const maxSizeBytes = maxSizeMb * 1024 * 1024;
  const chunkSize = parseInt(chunkSizeInput.value, 10) || 1000;
  const chunkOverlap = parseInt(chunkOverlapInput.value, 10) || 100;

  let processed = 0;
  const total = files.length;
  const errors = [];

  for (const file of files) {
    try {
      // Skip duplicates
      if (state.ingestedPaths.has(file.name)) {
        processed++;
        showProgress((processed / total) * 100, `Skipping duplicate: ${file.name}`);
        continue;
      }

      // Size check
      if (file.size > maxSizeBytes) {
        errors.push(`${file.name}: exceeds ${maxSizeMb}MB limit`);
        processed++;
        showProgress((processed / total) * 100, `Skipping oversized: ${file.name}`);
        continue;
      }

      showProgress((processed / total) * 100, `Processing: ${file.name}`);

      const type = detectType(file.name);
      let content = '';

      if (type === 'pdf') {
        content = await extractPdfText(await file.arrayBuffer());
      } else if (type === 'json') {
        content = parseJsonContent(await file.text());
      } else {
        content = await file.text();
      }

      if (!content.trim()) {
        errors.push(`${file.name}: empty or unreadable`);
        processed++;
        continue;
      }

      const insertDoc = await state.db.query(
        `INSERT INTO documents (source_path, type, content, metadata)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (source_path) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [file.name, type, content, JSON.stringify({ size: file.size, lastModified: file.lastModified })]
      );

      const documentId = insertDoc.rows[0].id;
      state.stats.docs++;
      state.stats.memoryKb += Math.round(content.length / 1024);
      state.ingestedPaths.add(file.name);

      const chunked = chunkText(content, chunkSize, chunkOverlap);
      for (let i = 0; i < chunked.length; i++) {
        await state.db.query(
          `INSERT INTO chunks (document_id, chunk_index, content)
           VALUES ($1, $2, $3)`,
          [documentId, i, chunked[i]]
        );
        state.stats.chunks++;
      }

      const entities = extractEntities(content, type);
      for (const e of entities) {
        await state.db.query(
          `INSERT INTO entities (document_id, entity_type, entity_value)
           VALUES ($1, $2, $3)`,
          [documentId, e.type, e.value]
        );
        state.stats.entities++;
      }

      for (const l of extractLinks(content, type)) {
        await state.db.query(
          `INSERT INTO links (from_document_id, to_ref, relation_type)
           VALUES ($1, $2, $3)`,
          [documentId, l.ref, l.relation]
        );
      }

      processed++;
    } catch (err) {
      errors.push(`${file.name}: ${err.message || err}`);
      processed++;
    }
  }

  hideProgress();
  await createIndexes();
  updateStats();

  const statusMsg = `Ingested ${state.stats.docs} docs • ${state.stats.chunks} chunks • ${state.stats.entities} entities`;
  const errMsg = errors.length ? ` | Errors: ${errors.join('; ')}` : '';
  ingestStatus.textContent = statusMsg + errMsg;

  generateSuggestions();
}

/* ==================== GitHub Repo Ingestion ==================== */
async function ingestFromGitHub(url) {
  // Parse GitHub URL: https://github.com/owner/repo
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) {
    ingestStatus.textContent = 'Invalid GitHub URL. Use format: https://github.com/owner/repo';
    return;
  }

  const [, owner, repo] = match;
  const repoName = repo.replace(/\.git$/, '');

  showProgress(0, `Fetching repo structure: ${owner}/${repoName}...`);

  try {
    // Get default branch
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`);
    if (!repoRes.ok) throw new Error(`Repo not found or private (${repoRes.status})`);
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || 'main';

    // Get tree recursively
    const treeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/git/trees/${defaultBranch}?recursive=1`
    );
    if (!treeRes.ok) throw new Error(`Failed to fetch repo tree (${treeRes.status})`);
    const treeData = await treeRes.json();

    // Filter for supported file types
    const supportedExts = /\.(md|markdown|txt|csv|json|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|rb|php|yaml|yml|sh|bash|swift|kt|scala|sql)$/i;
    const files = treeData.tree.filter(
      (item) => item.type === 'blob' && supportedExts.test(item.path)
    );

    if (files.length === 0) {
      hideProgress();
      ingestStatus.textContent = 'No supported files found in repository.';
      return;
    }

    const maxSizeMb = parseInt(maxFileSizeInput.value, 10) || 5;
    const maxSizeBytes = maxSizeMb * 1024 * 1024;
    const chunkSize = parseInt(chunkSizeInput.value, 10) || 1000;
    const chunkOverlap = parseInt(chunkOverlapInput.value, 10) || 100;

    let processed = 0;
    const errors = [];

    for (const file of files) {
      try {
        // Skip duplicates
        const fullPath = `${owner}/${repoName}/${file.path}`;
        if (state.ingestedPaths.has(fullPath)) {
          processed++;
          showProgress((processed / files.length) * 100, `Skipping duplicate: ${file.path}`);
          continue;
        }

        // Size check (GitHub provides size in bytes)
        if (file.size > maxSizeBytes) {
          errors.push(`${file.path}: exceeds ${maxSizeMb}MB limit`);
          processed++;
          continue;
        }

        showProgress((processed / files.length) * 100, `Fetching: ${file.path}`);

        // Fetch raw content
        const rawRes = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repoName}/${defaultBranch}/${file.path}`
        );
        if (!rawRes.ok) {
          errors.push(`${file.path}: fetch failed`);
          processed++;
          continue;
        }

        const content = await rawRes.text();
        if (!content.trim()) {
          processed++;
          continue;
        }

        const type = detectType(file.path);

        const insertDoc = await state.db.query(
          `INSERT INTO documents (source_path, type, content, metadata)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (source_path) DO UPDATE SET content = EXCLUDED.content
           RETURNING id`,
          [fullPath, type, content, JSON.stringify({ size: file.size, source: 'github' })]
        );

        const documentId = insertDoc.rows[0].id;
        state.stats.docs++;
        state.stats.memoryKb += Math.round(content.length / 1024);
        state.ingestedPaths.add(fullPath);

        const chunked = chunkText(content, chunkSize, chunkOverlap);
        for (let i = 0; i < chunked.length; i++) {
          await state.db.query(
            `INSERT INTO chunks (document_id, chunk_index, content)
             VALUES ($1, $2, $3)`,
            [documentId, i, chunked[i]]
          );
          state.stats.chunks++;
        }

        const entities = extractEntities(content, type);
        for (const e of entities) {
          await state.db.query(
            `INSERT INTO entities (document_id, entity_type, entity_value)
             VALUES ($1, $2, $3)`,
            [documentId, e.type, e.value]
          );
          state.stats.entities++;
        }

        for (const l of extractLinks(content, type)) {
          await state.db.query(
            `INSERT INTO links (from_document_id, to_ref, relation_type)
             VALUES ($1, $2, $3)`,
            [documentId, l.ref, l.relation]
          );
        }

        processed++;
      } catch (err) {
        errors.push(`${file.path}: ${err.message || err}`);
        processed++;
      }
    }

    hideProgress();
    await createIndexes();
    updateStats();

    const statusMsg = `Ingested ${state.stats.docs} docs • ${state.stats.chunks} chunks • ${state.stats.entities} entities from ${owner}/${repoName}`;
    const errMsg = errors.length > 0 ? ` | ${errors.length} errors` : '';
    ingestStatus.textContent = statusMsg + errMsg;

    generateSuggestions();
  } catch (err) {
    hideProgress();
    ingestStatus.textContent = `GitHub fetch failed: ${err.message || err}`;
  }
}

/* ==================== Query Suggestions ==================== */
async function generateSuggestions() {
  const suggestions = [];

  try {
    // Check what types of content we have
    const typesRes = await state.db.query(`SELECT type, COUNT(*) AS cnt FROM documents GROUP BY type`);
    const types = typesRes.rows.map((r) => r.type);

    // Check what entities we have
    const entitiesRes = await state.db.query(
      `SELECT entity_type, COUNT(*) AS cnt FROM entities GROUP BY entity_type ORDER BY cnt DESC LIMIT 5`
    );
    const entityTypes = entitiesRes.rows.map((r) => r.entity_type);

    // Generate relevant suggestions
    if (types.includes('code')) {
      suggestions.push('Show all functions in the codebase');
      if (entityTypes.includes('issue')) {
        suggestions.push('List all TODOs and FIXMEs');
      }
      suggestions.push('Find authentication-related code');
      suggestions.push('Show imports and dependencies');
    }

    if (types.includes('markdown')) {
      suggestions.push('Summarize document headings and structure');
      suggestions.push('Find all external links');
    }

    if (entityTypes.includes('date')) {
      suggestions.push('Show all dates mentioned in documents');
    }

    // Generic suggestions
    suggestions.push('Overview of all files by type');
    suggestions.push('Find files mentioning "error" or "bug"');

    // Limit to 5 suggestions
    const limited = suggestions.slice(0, 5);

    if (limited.length > 0) {
      suggestionsPanel.style.display = 'block';
      suggestionsEl.innerHTML = '';
      for (const s of limited) {
        const btn = document.createElement('button');
        btn.className = 'suggestion-btn';
        btn.textContent = s;
        btn.addEventListener('click', () => {
          questionInput.value = s;
          runQuery();
        });
        suggestionsEl.appendChild(btn);
      }
    }
  } catch (err) {
    console.warn('Suggestion generation error:', err);
  }
}

/* ==================== Heuristic SQL Generation ==================== */
function heuristicSqlFromQuestion(question) {
  const q = question.toLowerCase();

  if (q.includes('todo') || q.includes('fixme') || q.includes('bug') || q.includes('issue')) {
    return `
      SELECT d.source_path, e.entity_value AS issue
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'issue'
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('function') || q.includes('method')) {
    return `
      SELECT d.source_path, e.entity_value AS function_name
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'function'
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('authentication') || q.includes('auth') || q.includes('login')) {
    return `
      SELECT d.source_path, LEFT(c.content, 300) AS excerpt
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE LOWER(c.content) LIKE '%auth%'
         OR LOWER(c.content) LIKE '%login%'
         OR LOWER(c.content) LIKE '%password%'
         OR LOWER(c.content) LIKE '%token%'
      ORDER BY d.source_path
      LIMIT 50
    `;
  }

  if (q.includes('import') || q.includes('depend') || q.includes('require')) {
    return `
      SELECT d.source_path, l.to_ref AS dependency, l.relation_type
      FROM links l
      JOIN documents d ON d.id = l.from_document_id
      WHERE l.relation_type IN ('import', 'require')
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('heading') || q.includes('structure') || q.includes('outline')) {
    return `
      SELECT d.source_path, e.entity_value AS heading
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'heading'
      ORDER BY d.source_path, e.id
      LIMIT 100
    `;
  }

  if (q.includes('link') || q.includes('citation') || q.includes('reference')) {
    return `
      SELECT d.source_path, l.to_ref AS link, l.relation_type
      FROM links l
      JOIN documents d ON d.id = l.from_document_id
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('date')) {
    return `
      SELECT d.source_path, e.entity_value AS date_found
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'date'
      ORDER BY e.entity_value DESC
      LIMIT 100
    `;
  }

  if (q.includes('overview') || q.includes('summary') || q.includes('summarize') || q.includes('type')) {
    return `
      SELECT type, COUNT(*) AS document_count, SUM(LENGTH(content)) AS total_chars
      FROM documents
      GROUP BY type
      ORDER BY document_count DESC
    `;
  }

  if (q.includes('class')) {
    return `
      SELECT d.source_path, e.entity_value AS class_name
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'class'
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  if (q.includes('export')) {
    return `
      SELECT d.source_path, e.entity_value AS export
      FROM entities e
      JOIN documents d ON d.id = e.document_id
      WHERE e.entity_type = 'export'
      ORDER BY d.source_path
      LIMIT 100
    `;
  }

  // Keyword search fallback
  const keywords = question.match(/\b[a-zA-Z]{3,}\b/g) || [];
  if (keywords.length > 0) {
    const searchTerms = keywords.slice(0, 3).map((k) => k.toLowerCase());
    const likeConditions = searchTerms.map((t) => `LOWER(c.content) LIKE '%${t}%'`).join(' OR ');
    return `
      SELECT d.source_path, d.type, LEFT(c.content, 400) AS excerpt
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE ${likeConditions}
      LIMIT 30
    `;
  }

  // Default fallback
  return `
    SELECT source_path, type, LEFT(content, 280) AS excerpt
    FROM documents
    ORDER BY id DESC
    LIMIT 20
  `;
}

/* ==================== AI SQL Generation ==================== */
async function openAiSqlSuggestion(question, apiKey) {
  // Enhanced prompt with full schema context and few-shot examples
  const prompt = `You are a PostgreSQL SQL query generator for a document ingestion system.

## Database Schema

Tables:
- documents(id SERIAL, source_path TEXT, type TEXT, content TEXT, metadata JSONB, created_at TIMESTAMPTZ)
  - type values: 'markdown', 'code', 'csv', 'pdf', 'json', 'text'
- chunks(id SERIAL, document_id INT FK, chunk_index INT, content TEXT)
  - Smaller portions of documents for search
- entities(id SERIAL, document_id INT FK, entity_type TEXT, entity_value TEXT)
  - entity_type values: 'date', 'issue', 'function', 'class', 'export', 'heading', 'wikilink', 'dependency'
- links(id SERIAL, from_document_id INT FK, to_ref TEXT, relation_type TEXT)
  - relation_type values: 'citation', 'import', 'require', 'wikilink'
- embeddings(id SERIAL, chunk_id INT FK, model TEXT, embedding JSONB)

## Examples

Question: "What functions are in the codebase?"
SQL: SELECT d.source_path, e.entity_value AS function_name FROM entities e JOIN documents d ON d.id = e.document_id WHERE e.entity_type = 'function' ORDER BY d.source_path LIMIT 100

Question: "Show all TODOs"
SQL: SELECT d.source_path, e.entity_value AS issue FROM entities e JOIN documents d ON d.id = e.document_id WHERE e.entity_type = 'issue' ORDER BY d.source_path LIMIT 100

Question: "Find files mentioning authentication"
SQL: SELECT d.source_path, LEFT(c.content, 300) AS excerpt FROM chunks c JOIN documents d ON d.id = c.document_id WHERE LOWER(c.content) LIKE '%auth%' OR LOWER(c.content) LIKE '%login%' LIMIT 50

Question: "Overview of file types"
SQL: SELECT type, COUNT(*) AS cnt FROM documents GROUP BY type ORDER BY cnt DESC

## Rules
- Return ONLY valid PostgreSQL SELECT queries
- Use JOIN when connecting tables
- Always use LIMIT to prevent large result sets
- Use LEFT() to truncate long text
- Use LOWER() and LIKE for case-insensitive search

Now generate SQL for this question:
Question: "${question}"
SQL:`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: ['Bearer', apiKey].join(' '),
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenAI request failed (${res.status})`);
  }

  const data = await res.json();
  let sql = data.choices?.[0]?.message?.content?.trim() || '';
  
  // Clean up any markdown code blocks
  sql = sql.replace(/```sql\n?/gi, '').replace(/```\n?/g, '').trim();
  
  return sql;
}

/* ==================== SQL Safety ==================== */
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

/* ==================== Result Rendering ==================== */
function renderRows(rows, sql, question) {
  resultsEl.innerHTML = '';
  state.lastQuery = question;
  state.lastSql = sql;

  if (!rows.length) {
    const card = document.createElement('div');
    card.className = 'card';
    card.textContent = 'No rows returned. Try a different query.';
    resultsEl.appendChild(card);
    return;
  }

  for (const row of rows) {
    const card = document.createElement('article');
    card.className = 'card';

    // Source attribution
    if (row.source_path) {
      const sourceDiv = document.createElement('div');
      sourceDiv.className = 'card-source';
      sourceDiv.textContent = `📄 ${row.source_path}`;
      card.appendChild(sourceDiv);
    }

    // Main heading
    const heading = document.createElement('h3');
    heading.textContent = String(row.source_path || row.type || row.function_name || row.heading || 'Result');
    card.appendChild(heading);

    // Render each field
    for (const [k, v] of Object.entries(row)) {
      if (k === 'source_path') continue; // Already shown above

      const line = document.createElement('div');
      const key = document.createElement('span');
      key.className = 'meta';
      key.textContent = k;
      line.appendChild(key);

      const value = String(v);
      
      // If it's an excerpt or content field, show in snippet box with highlighting
      if (k === 'excerpt' || k === 'content' || k === 'issue') {
        line.appendChild(document.createTextNode(': '));
        const snippet = document.createElement('div');
        snippet.className = 'card-snippet';
        
        // Highlight search terms from the question
        const terms = (question || '').match(/\b[a-zA-Z]{3,}\b/g) || [];
        let highlighted = escapeHtml(value);
        for (const term of terms.slice(0, 5)) {
          const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
          highlighted = highlighted.replace(regex, '<mark>$1</mark>');
        }
        snippet.innerHTML = highlighted;
        line.appendChild(snippet);
      } else {
        line.appendChild(document.createTextNode(`: ${value}`));
      }

      card.appendChild(line);
    }

    // Follow-up hint
    const followUp = document.createElement('p');
    followUp.className = 'meta';
    followUp.textContent = 'Tip: Ask follow-up questions for deeper analysis.';
    card.appendChild(followUp);

    resultsEl.appendChild(card);
  }

  // Show query trace
  sqlPlan.textContent = `Query: "${question || 'Raw SQL'}"\n\nSQL:\n${sql}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ==================== Query Execution ==================== */
async function runQuery() {
  const question = questionInput.value.trim();
  if (!question) return;

  state.queryHistory.push(question);

  let sql = heuristicSqlFromQuestion(question);
  const apiKey = apiKeyInput.value.trim();

  // Try AI SQL if API key provided
  if (apiKey) {
    try {
      const aiSql = await openAiSqlSuggestion(question, apiKey);
      if (aiSql) sql = aiSql;
    } catch (err) {
      console.warn('AI SQL generation failed, using heuristic:', err);
    }
  }

  try {
    sql = ensureReadOnlySql(sql);
  } catch (err) {
    resultsEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card error-card';
    card.textContent = err.message;
    resultsEl.appendChild(card);
    return;
  }

  try {
    const result = await state.db.query(sql);
    renderRows(result.rows || [], sql, question);
  } catch (err) {
    resultsEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card error-card';
    card.textContent = `Query failed: ${err.message || err}`;
    resultsEl.appendChild(card);
    sqlPlan.textContent = `Failed SQL:\n${sql}`;
  }
}

async function runRawSql() {
  const sql = rawSqlInput.value.trim();
  if (!sql) return;

  try {
    const safeSql = ensureReadOnlySql(sql);
    const result = await state.db.query(safeSql);
    renderRows(result.rows || [], safeSql, null);
  } catch (err) {
    resultsEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'card error-card';
    card.textContent = `Query failed: ${err.message || err}`;
    resultsEl.appendChild(card);
  }
}

/* ==================== Session Controls ==================== */
async function resetSession() {
  if (!confirm('Reset session? All ingested data will be lost.')) return;

  // Re-initialize database
  state.db = await initDb();
  state.ingestedPaths.clear();
  state.stats = { docs: 0, chunks: 0, entities: 0, memoryKb: 0 };
  state.queryHistory = [];
  state.lastQuery = null;
  state.lastSql = null;

  // Reset UI
  resultsEl.innerHTML = '';
  suggestionsPanel.style.display = 'none';
  statsPanel.style.display = 'none';
  ingestStatus.textContent = 'Session reset. Ready to ingest new files.';
  sqlPlan.textContent = 'SQL plan: (none)';
  questionInput.value = '';
  rawSqlInput.value = '';
}

async function exportSession() {
  try {
    const docs = await state.db.query(`SELECT * FROM documents`);
    const chunks = await state.db.query(`SELECT * FROM chunks`);
    const entities = await state.db.query(`SELECT * FROM entities`);
    const links = await state.db.query(`SELECT * FROM links`);

    const exportData = {
      exportedAt: new Date().toISOString(),
      stats: state.stats,
      queryHistory: state.queryHistory,
      lastQuery: state.lastQuery,
      lastSql: state.lastSql,
      data: {
        documents: docs.rows,
        chunks: chunks.rows,
        entities: entities.rows,
        links: links.rows,
      },
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lensai-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Export failed: ${err.message || err}`);
  }
}

/* ==================== Tab Switching ==================== */
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;

      tabs.forEach((t) => t.classList.remove('active'));
      contents.forEach((c) => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(target).classList.add('active');
    });
  });
}

/* ==================== Main Initialization ==================== */
async function main() {
  try {
    state.db = await initDb();

    // Set up event listeners
    ingestBtn.addEventListener('click', () => ingestFiles(Array.from(fileInput.files || [])));
    ingestGithubBtn.addEventListener('click', () => ingestFromGitHub(githubUrlInput.value.trim()));
    queryBtn.addEventListener('click', runQuery);
    rawSqlBtn.addEventListener('click', runRawSql);
    resetBtn.addEventListener('click', resetSession);
    exportBtn.addEventListener('click', exportSession);

    // Enter key support
    questionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runQuery();
      }
    });

    rawSqlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        runRawSql();
      }
    });

    setupTabs();

    ingestStatus.textContent = 'LensAI ready. Ingest files or paste a GitHub URL to begin.';
  } catch (err) {
    ingestStatus.textContent = `Initialization failed: ${err.message || err}`;
    console.error('LensAI init error:', err);
  }
}

main();
