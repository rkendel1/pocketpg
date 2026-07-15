# pocketpg

## LensAI – Universal Data Lens with AI + PGlite

This repository now contains a session-only web prototype for **LensAI**: an in-browser, private knowledge lens that ingests mixed files into **PGlite** and supports natural-language exploration through SQL-backed results.

### What it does

- Ingests files directly in the browser (no server upload):
  - Markdown/code/plain text
  - CSV
  - Simple PDF text extraction (best-effort)
- Builds a relational schema in PGlite:
  - `documents`
  - `chunks`
  - `entities`
  - `links`
  - `embeddings` (schema-ready, optional)
- Supports AI-style natural language queries with SQL translation:
  - Heuristic NL → SQL planning for key prompts (issues, auth/functions, themes)
  - Optional OpenAI API key path for prompt-based SQL generation
- Shows results as rich cards with source references and follow-up hints
- Session-only behavior: data lives in-memory and is reset on refresh

## Run

Open `/home/runner/work/pocketpg/pocketpg/index.html` in a browser.

No backend or build step is required.

## Files

- `index.html` – UI shell
- `styles.css` – styles for cards/dashboard
- `app.js` – PGlite initialization, ingestion pipeline, entity/link extraction, NL query planner, and rendering
