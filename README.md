<p align="center">
  <img src="assets/icon.svg" alt="Cell Translator" width="96" height="96">
</p>

<h1 align="center">Cell Translator</h1>

<p align="center">
  Translate spreadsheet cells and shape text in place — and keep the record inside the file.
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: MIT" src="https://img.shields.io/badge/licence-MIT-blue.svg"></a>
  <img alt="ONLYOFFICE 9.4+" src="https://img.shields.io/badge/ONLYOFFICE-9.4%2B-orange.svg">
  <img alt="Spreadsheet only" src="https://img.shields.io/badge/editor-spreadsheet-green.svg">
</p>

---

An [ONLYOFFICE](https://www.onlyoffice.com/) **spreadsheet** plugin that translates cell
content and text inside drawn shapes, then records every translation in a hidden
sheet inside the workbook itself.

That last part is the point. Translation memory lives in the file, not on your
machine, so it travels with the workbook when it is copied, emailed or renamed.
Repeated text is translated once and reused; any translated cell can be reverted
to its original.

## Features

- **Three engines** — offline (Bergamot), self-hosted (LibreTranslate), or any
  OpenAI-compatible endpoint.
- **Works offline.** Bergamot runs as WebAssembly in the editor. Language models
  download once and are cached locally.
- **Translation memory in the workbook.** A hidden `_CellTranslator` sheet holds
  the ledger, so identical text is never translated twice.
- **Shapes too.** Text inside autoshapes and callouts is translated per
  paragraph, preserving each paragraph's formatting.
- **Revert anything.** Every translated cell keeps a route back to its original.
- **Refine a single cell** with AI, or pick from alternative translations
  (LibreTranslate only).
- **Automatic language detection**, with a manual override per cell.

## Requirements

- ONLYOFFICE Desktop Editors or Docs **9.4 or newer**
- Node.js 20+ (only to build the plugin)

## Install

Download `translator-plugin.plugin` from the
[latest release](../../releases/latest) and open it with ONLYOFFICE, or build it
yourself:

```bash
git clone <this-repo>
cd translator-onlyoffice-plugin
npm install
npm run pack        # produces translator-plugin.plugin
```

Then in ONLYOFFICE: **Plugins → Settings → Add plugin** and select the file.

## Usage

| Action | How |
| --- | --- |
| Translate a sheet | Toolbar → Cell Translator → **Execute Translation** |
| Inspect one cell | Right-click a cell → **Show translation panel** |
| Translate a shape | Select the shape with the panel open |
| Change engine or target language | Toolbar → Cell Translator → **Settings** |
| Undo a translation | Translation panel → **Revert** |

By default translations are shown in the panel and the sheet is left untouched.
Switch **Display Mode** to *Replace* in Settings to write translations into the
cells themselves.

## Engines

| Engine | Runs where | Needs | Notes |
| --- | --- | --- | --- |
| **Bergamot** | Locally, WebAssembly | Nothing | Default. Fully offline once models are cached. |
| **LibreTranslate** | Your own server | A running instance | The only engine that offers alternative translations. |
| **AI** | Any OpenAI-compatible API | Endpoint + model | Also powers *Improve with AI* on a single cell. |

A `compose.yml` is included to run LibreTranslate locally:

```bash
docker compose up -d      # http://localhost:15065
```

## How translations are stored

```
_CellTranslator (hidden sheet)
  A–D   ledger    checksum | source | translation | txn
  E–G   refs      sheet | cellRef -> ledgerRow
  I–J   history   timestamped events
```

The ledger is keyed by a checksum of the source text, so the same phrase
repeated across hundreds of cells is translated once. Refs map each cell — or
each shape paragraph — back to its ledger row, which is what makes revert
possible.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Development

```bash
npm install
npm run build       # bundle into dist/
npm run pack        # build + zip into translator-plugin.plugin
npm run lint        # biome
npm run lint:fix
```

Source lives in `src/`, one directory per plugin window, each with a `main.js`
entry that the build bundles into a single IIFE (the ONLYOFFICE plugin sandbox
does not support ES modules).

```
src/
  background/        the controller — owns all state and logic
  panel/             Cell Translator panel
  settings/          Settings panel
  translation-view/  per-cell inspector
  sync/              manual sync to the document
  shared/            engines, ledger, sidecar sheet, logging
```

## Privacy

Bergamot translates entirely on your machine; nothing leaves it. Choosing
LibreTranslate or AI sends cell text to whichever endpoint you configure — pick
one you trust with the contents of your spreadsheets.

Your AI API key is stored in the editor's `localStorage`, unencrypted. Treat it
as you would any other credential kept in a browser profile.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT — see [LICENSE](LICENSE).

Bundled third-party components under `vendors/` keep their own licences; see
[NOTICE](NOTICE), which also records an unresolved licensing question about the
vendored Bergamot package.
