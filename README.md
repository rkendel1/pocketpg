# pocketpg

## LensAI – Universal Data Lens with AI + PGlite

A session-only, in-browser web application that turns any collection of files into a queryable knowledge base. LensAI ingests files into **PGlite** (PostgreSQL running in WebAssembly) and lets you explore your data with natural language queries backed by real SQL.

### 🔒 Privacy First

**All processing happens in your browser.** Nothing is sent to any server unless you explicitly provide an OpenAI API key for enhanced query translation.

### Features

#### Ingestion
- **Drag & drop files** – Markdown, code files, plain text, CSV, JSON, PDFs
- **GitHub repo URL** – Paste a public repo URL to ingest directly via GitHub API
- **Progress tracking** – File-by-file status with progress bar
- **Smart extraction** – Functions, classes, exports, TODOs, headings, wikilinks, imports
- **Configurable** – Max file size, chunk size, and overlap settings
- **Deduplication** – Same file won't be ingested twice

#### Querying
- **Natural language** – Ask questions like "Show all TODOs" or "Find authentication code"
- **Heuristic SQL** – Built-in patterns for common queries (no API key needed)
- **OpenAI-powered** – Optional AI translation with schema context and few-shot examples
- **Raw SQL tab** – Power users can run direct SELECT queries
- **Result cards** – Source attribution, snippet highlighting, query trace

#### Session Management
- **Reset session** – Clear all ingested data and start fresh
- **Export results** – Download JSON with all documents, chunks, entities, and query history
- **Stats panel** – Live counts of docs, chunks, entities, and memory usage

#### Database Schema
```sql
documents (id, source_path, type, content, metadata, created_at)
chunks (id, document_id, chunk_index, content)
entities (id, document_id, entity_type, entity_value)
links (id, from_document_id, to_ref, relation_type)
embeddings (id, chunk_id, model, embedding)
```

### Run

Open `index.html` in any modern browser. No server or build step required.

```bash
# Or use a simple HTTP server
python3 -m http.server 8000
# Then open http://localhost:8000
```

### Files

- `index.html` – UI structure with responsive design
- `styles.css` – Dark theme, cards, progress bar, tabs
- `app.js` – PGlite initialization, ingestion, entity extraction, query engine, rendering

### Technologies

- [PGlite](https://pglite.dev/) – PostgreSQL in WebAssembly
- [pdf.js](https://mozilla.github.io/pdf.js/) – PDF text extraction
- Vanilla JavaScript (ES modules)
