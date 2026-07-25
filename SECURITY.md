# Security Policy

## Supported versions

The latest release is the only supported version.

## Reporting a vulnerability

Please **do not** open a public issue.

Use GitHub's private reporting instead: go to the **Security** tab →
**Report a vulnerability**. That opens a private advisory visible only to the
maintainers.

Please include what the issue allows an attacker to do, the steps to reproduce
it, and the affected version. You can expect an initial response within about a
week.

## Things worth knowing

These are known properties of the current design rather than vulnerabilities,
but they matter when assessing risk.

**API keys are stored unencrypted.** The AI endpoint key is kept in the editor's
`localStorage` alongside other settings. Any script running in that editor
context can read it. Use a key scoped to what this plugin needs.

**Cell content is sent to whichever engine you choose.** Bergamot runs locally
and sends nothing. LibreTranslate and AI engines transmit cell text to the
endpoint you configure — including anything sensitive in those cells.

**Cell text reaches an LLM prompt.** When the AI engine is used, cell content is
wrapped in explicit delimiters and the model is instructed to treat it as data,
never as instructions. This makes prompt injection harder, not impossible. Do
not rely on it as a security boundary for untrusted spreadsheets.

**Language models are downloaded at runtime.** Bergamot fetches models from
Mozilla's public repository over HTTPS and caches them in IndexedDB. Models are
not bundled with the plugin and are not verified beyond the transport.

**Translation memory is stored in the workbook.** The hidden `_CellTranslator`
sheet contains both source and translated text. Anyone with the file can read
it, including via a plain unzip of the `.xlsx`.
