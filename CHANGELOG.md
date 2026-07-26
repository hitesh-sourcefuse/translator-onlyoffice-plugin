# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-07-25

### Fixed

- The plugin shipped 1×1 placeholder icons, so it appeared blank in the
  ONLYOFFICE plugin list. Real icons are now generated from `assets/icon.svg`
  at every scale the editor asks for (28, 35, 42, 49 and 56 px), for both the
  light and dark themes.

### Changed

- `config.json` now declares icons with the scale-aware pattern form
  (`resources/%theme-type%(light|dark)/icon%scale%(default).%extension%(png)`)
  instead of a single fixed path, so the editor can pick the right size for the
  display it is on.

## [1.0.0] — 2026-07-25

First public release.

### Added

- Cell translation with translation memory stored in a hidden `_CellTranslator`
  sheet inside the workbook, so it travels with the file.
- Three translation engines: Bergamot (offline, WebAssembly), LibreTranslate
  (self-hosted) and any OpenAI-compatible endpoint.
- Translation of text inside drawn shapes, per paragraph, preserving each
  paragraph's formatting.
- Per-cell translation panel with source-language detection, manual language
  override, alternatives (LibreTranslate), *Improve with AI*, and revert.
- Deduplication by source-text checksum — repeated text is translated once.
- Per-file setting overrides and detection of a renamed or re-saved workbook.
- Scope selection: current selection, active sheet, or whole workbook.
- Debug log panel.

### Notes

- Requires ONLYOFFICE 9.4 or newer. Spreadsheets only.
- Bergamot language models are downloaded on first use and cached in IndexedDB;
  they are not bundled with the plugin.
- *Improve with AI*, *Alternatives* and *Revert* are not yet wired up for shape
  text — they currently apply to cells only.

[1.0.1]: ../../releases/tag/v1.0.1
[1.0.0]: ../../releases/tag/v1.0.0
