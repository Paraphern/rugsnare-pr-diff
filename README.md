# RugSnare PR diff

A GitHub Action that posts a **human-readable diff of MCP tool contracts** on your pull requests: reviewers see the changed words in tool descriptions and schemas, not hashes.

Tool descriptions are instructions your agent obeys. When an MCP server (or a PR touching `.mcp.json` / pin files) changes a tool's name, description, or input schema after it was approved, your agent is now following different instructions without anyone deciding to. This action makes that visible on every PR.

```yaml
# .github/workflows/rugsnare-pr-diff.yml
name: rugsnare PR diff
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  contract-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Paraphern/rugsnare-pr-diff@v1
        with:
          config: .mcp.json
```

The comment lists, per server: unchanged tool contracts (green), description changes with before/after text, new unapproved tools, and approved tools that disappeared. When drift is found the check fails (configurable).

## Prerequisites

The repository must carry a RugSnare pin store (`.rugsnare/pins.json`), created once on your main branch:

```bash
npx rugsnare scan --config .mcp.json
# review the report, then commit .rugsnare/pins.json
```

Baselines are updated deliberately via `rugsnare approve`, never silently.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `config` | yes | - | Path to the MCP config file (e.g. `.mcp.json`), relative to `working-directory` |
| `working-directory` | no | `.` | Directory containing the config and the committed `.rugsnare` pin store |
| `rugsnare-ref` | no | `v1.1.0` | Which rugsnare release tag to run. Pinned by default; bump it deliberately |
| `use-workspace` | no | `false` | Use the rugsnare copy already present in the calling repository (for the rugsnare repo itself) |
| `fail-on-drift` | no | `true` | Fail the check when contract drift is found (after posting the comment) |

## Why the default is a pinned tag

The action checks other people's pinning discipline, so it pins itself: `rugsnare-ref` defaults to a release tag instead of a moving branch. Bump it in a reviewed PR like any other dependency.

## Part of RugSnare

The CLI behind this action (`rugsnare`) pins MCP tool contracts (`{name, description, inputSchema}`, sha-256), gates CI on drift, and grades changes by direction (BREAKING / LOOSENED / EXPANDED / NOTATION):

- Repository: [Paraphern/rugsnare](https://github.com/Paraphern/rugsnare)
- npm: [rugsnare](https://www.npmjs.com/package/rugsnare)
- Verified drift case studies for popular MCP servers: [docs/servers](https://github.com/Paraphern/rugsnare/tree/main/docs/servers)

## License

Apache-2.0
