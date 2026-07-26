# Architecture

## The core idea

Translation memory belongs to the document, not to the machine. Everything the
plugin knows about a workbook's translations lives in a hidden sheet inside that
workbook, so the record survives the file being copied, emailed or renamed.

```
_CellTranslator (hidden sheet)

  A       B        C             D      | E       F        G          | I           J
  ────────────────────────────────────  | ───────────────────────────  | ──────────────────
  checksum source  translation   txn    | sheet   cellRef  ledgerRow  | cellRefRow  changes
  ───────── ledger ──────────────────── | ──── refs ─────────────────  | ─── history ──────
```

- **ledger** — one row per unique source text, keyed by an FNV-1a checksum of
  that text. The same phrase repeated across 500 cells is translated once.
- **refs** — map each cell (or shape paragraph) to its ledger row. This is what
  makes revert possible.
- **history** — timestamped record of changes.

Because the checksum is only 32 bits, every lookup also compares the stored
source text. A genuine collision gets its own key (`<hash>#1`), so two unrelated
strings can never be served each other's translation.

## Process shape

Only one window is declared in the plugin manifest: a **background** controller.
Every panel is opened at runtime by that controller.

```
ONLYOFFICE host
      │  Asc.plugin.init          (static/config.json declares one window)
      ▼
┌──────────────────────────────────────────────┐
│ index.html → src/background/main.js          │
│   src/shared/watcher.js                      │  ← essentially all logic
│     · scan / filter / translate              │
│     · ledger + refs + history                │
│     · sole writer of localStorage settings   │
│     · opens and feeds every panel            │
└──┬───────────┬────────────┬───────────┬──────┘
   │           │            │           │   PluginWindow, created at runtime
   ▼           ▼            ▼           ▼
 panel      settings   translation-   sync
                          view
```

Each panel directory has a `main.js` that only imports CSS and its real module.
The build bundles each entry into a single IIFE, because the plugin sandbox does
not support ES modules.

### Settings ownership

**Only the Settings panel causes settings to be persisted.** Other panels are
consumers. When a panel needs a one-off override — a different source language
for a single run, say — it sends the override in the event payload and the
background applies it to that operation alone.

This is not a stylistic preference. A non-owner panel once wrote
`translationEngine: "ai"` into shared state, which hid the *Improve with AI*
button in another panel even though batch translation never used AI.

## Translation pipeline

```
scanActiveSheet
      │  scope: selection | sheet | workbook
      ▼
readAllCellsInBatches ──────────┐
                                ├─→ filterTranslatableCells
Sidecar.readShapeTexts ─────────┘        skips empty, numeric, date-like,
   (shape paragraphs)                    and already-in-target-language
                                │
                                ▼
                        filterAndTranslate
                          · checksum each item
                          · probe the ledger (source-verified)
                          · collect only what is genuinely new
                                │
                                ▼
                        translateItemsPool
                          bounded workers, one shared pool
                          for all three engines
                                │
                                ▼
                          onPoolItemDone
                          · write ledger + ref rows
                          · optionally replace the cell/shape
                                │
                                ▼
                        Sidecar.writeBatch → hidden sheet
```

Everything between the reader and the writer treats a reference as an opaque
string, which is why shapes could be added without touching the middle of the
pipeline.

### Engines

All three go through one pool, so concurrency, abort handling and per-item
failure isolation behave identically whichever is selected.

| Engine | Where it runs | Notes |
| --- | --- | --- |
| Bergamot | Locally, WebAssembly | Default. Models fetched once, cached in IndexedDB. |
| LibreTranslate | Your server | The only engine that can return alternatives. |
| AI | Any OpenAI-compatible API | Cell text is fenced in the prompt and marked as data. |

`buildEngineTranslate()` returns a per-item translate function;
`validateEngineSettings()` rejects a misconfigured engine up front rather than
letting it fall through to a different one.

## Addressing

```
cell             $J$84
shape paragraph  shape:n:<shape name>#p<index>     name from ApiShape.GetName()
                 shape:i:<index>#p<index>          fallback when unnamed
selected shape   shape:n:<shape name>              whole shape, panel expands it
```

Ref keys are stored as `<sheet>!<ref>`, so the sheet name is always everything
before the first `!`. Shape paragraphs are separate ledger entries — that is
what lets each keep its own formatting when written back — but the panel shows
a selected shape as one block.

## Reading and writing the document

All document access goes through `Asc.plugin.callCommand`. The callback body is
serialised and evaluated inside the editor, which has two consequences worth
remembering:

- it captures nothing from the surrounding module, so helpers must be inlined
- it has no `Function` constructor, and can only return plain JSON

Inputs are passed via `Asc.scope`. `src/shared/sidecar.js` holds every one of
these calls.

Writes are confirmed before in-memory state is treated as durable. A failed
`writeBatch` rolls back the ledger, refs and history rather than leaving memory
claiming rows the document never received. Full-sheet sync writes first and
trims afterwards, so a failure cannot wipe the cache.

## Build

```
src/<name>/index.html  ──copy, flattened──→  dist/<name>.html
src/<name>/main.js     ──vite, IIFE, min──→  dist/scripts/<name>.js
   CSS from each entry ──merge, dedupe────→  dist/styles/plugin.css
static/*, vendors/bergamot-translator/*  ──copy──→  dist/
dist/  ──zip──→  translator-plugin.plugin
```

`scripts/build.js` drives it; `scripts/pack.js` produces the `.plugin` archive.

## Known gaps

- *Improve with AI*, *Alternatives* and *Revert* are wired for cells only, not
  for shape text.
- The AI API key is stored unencrypted in `localStorage`.
- There is no automated test harness; the plugin only runs meaningfully inside
  the editor.
