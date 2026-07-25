# Contributing

Thanks for taking an interest. Bug reports, ideas and pull requests are all
welcome.

## Getting set up

```bash
npm install
npm run pack     # builds dist/ and translator-plugin.plugin
```

Load `translator-plugin.plugin` in ONLYOFFICE via **Plugins → Settings → Add
plugin**. After a rebuild, remove and re-add it to pick up changes.

Requires ONLYOFFICE 9.4+ and Node.js 20+.

## Before opening a pull request

```bash
npm run lint     # must pass; use lint:fix for the mechanical parts
npm run build    # must succeed
```

CI runs both on every pull request.

## Testing

There is no automated test harness — the plugin only runs meaningfully inside
the ONLYOFFICE editor. Please describe what you exercised manually, and mention
the ONLYOFFICE version and platform you used.

Turn on **Debug logging** in Settings to get a log panel plus detailed console
output; it is the fastest way to see what the background controller is doing.

Areas worth checking after any change to translation or storage:

- a batch translate over a sheet with repeated text (dedupe via the ledger)
- reverting a translated cell
- reopening the file and confirming the hidden `_CellTranslator` sheet reloads
- switching engines in Settings

## How the code is laid out

`src/shared/watcher.js` is the background controller and holds essentially all
the logic: scanning, the ledger, engine dispatch, and every panel event handler.
The panels under `src/<name>/` are thin — they render and send events.

One rule matters more than the rest: **only the Settings panel causes settings
to be persisted.** Other panels are consumers. If a panel needs a one-off
override, it sends it as an event payload and the background applies it to that
operation alone. Writing shared state from a non-owner panel has caused real
bugs before.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the fuller picture.

## Style

Biome handles formatting and linting; the config is in `biome.json`. Match the
surrounding code — 4-space indent, string concatenation over template literals
in the older modules, `function` declarations at module level.

Comments should explain *why*, not restate *what*. If a comment is only
describing what the next line does, the line probably needs a better name
instead.

## Commits

Short, imperative subject lines. Conventional prefixes (`fix:`, `feat:`,
`docs:`) are used but not enforced.

## Reporting bugs

Please include:

- ONLYOFFICE version and platform
- which translation engine was selected
- the relevant console output with debug logging enabled
- what you expected versus what happened

The bug report template asks for these.

## Security

Do not open a public issue for a security problem — see [SECURITY.md](SECURITY.md).
