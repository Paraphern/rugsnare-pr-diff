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

The comment lists, per server: unchanged tool contracts (green), schema and description changes with direction grading (BREAKING / LOOSENED / EXPANDED / NOTATION / COSMETIC), new unapproved tools, and approved tools that disappeared. Identical changes are grouped into one line so an SDK-wide wave reads as one entry, not thirty. Prompts and resources are compared too: a pinned prompt that changed its text, a new prompt, a served resource that disappeared, all appear in their own sections. When drift is found the check fails (configurable).

## Advisory signals (v1.3.0)

Structural grading says WHAT changed; advisory signals say whether the new prose contains attack patterns. Changed and new tool descriptions (and changed prompts) are scored, and any hit renders as a warning line right under the grade, independent of it. Example from a deliberately planted rug pull:

```
### 🔴 `search_flights` - BREAKING
Schema changes:
- added required parameter 'context' (string) `tighten`
⚠️ [ADVISORY] score 12: A01 (tells the model to hide something from the user);
  A02 (references private keys, credentials or env files); A03 (asks for base64
  encoding/decoding - common exfiltration pattern) [ATR-2026-00105 ATR-2026-00214 ...]
```

Signal classes include hide-from-user instructions, private-key and credential lures, base64 exfiltration, non-standard exfiltration domains, shadow-tool declarations, invisible Unicode and bidi controls, ANSI escapes, payment-credential transmission, and optional exfiltration-carrier parameters identified by name. Advisories are alerts: they never fail the check, and they run on the delta only (new and changed contracts), not on the approved baseline. Live demo, three attacks caught on a real PR: [rugsnare#14](https://github.com/Paraphern/rugsnare/pull/14).

## POLICY stop

Pins record the rugsnare policy version that graded them. If the pin store was created by an older rugsnare and the grading rules have changed since, the action does **not** silently re-grade old pins as fresh drift: it posts a single `POLICY` block explaining that the verifier changed, fails the check, and asks for a re-scan on main. The vendor did nothing wrong; the ruler changed (spec: [PIN-SPEC §3.1](https://github.com/Paraphern/rugsnare/blob/main/docs/PIN-SPEC.md)).

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
| `rugsnare-ref` | no | `v1.5.0` | Which rugsnare release tag to run. Pinned by default; bump it deliberately |
| `use-workspace` | no | `false` | Use the rugsnare copy already present in the calling repository (for the rugsnare repo itself) |
| `fail-on-drift` | no | `true` | Fail the check when contract drift is found (after posting the comment) |

## Why the default is a pinned tag

The action checks other people's pinning discipline, so it pins itself: `rugsnare-ref` defaults to a release tag instead of a moving branch. Bump it in a reviewed PR like any other dependency.

## Changes

- **v1.3.0**: advisory signal scoring rendered per finding (delta-only, independent of the structural grade); `rugsnare-ref` default pinned to `v1.5.0` (outputSchema pinning, resource content hashes, A19 payment-credential signals ship in rugsnare itself).
- **v1.2.0**: prompts and resources compared and rendered (own sections); POLICY stop per PIN-SPEC §3.1; direction grading with icons; identical changes grouped; NEW/REMOVED grouped into single sections. Verified end to end on Anthropic's `@modelcontextprotocol/server-everything` (0.1.0 to 1.0.0): 40 of 40 findings shown, where v1.1.0 would have shown 17.
- **v1.1.0**: initial published version (tools only: description + inputSchema).

## Part of RugSnare

The CLI behind this action (`rugsnare`) pins MCP tool contracts (`{name, description, inputSchema}`, sha-256), gates CI on drift, and grades changes by direction (BREAKING / LOOSENED / EXPANDED / NOTATION):

- Repository: [Paraphern/rugsnare](https://github.com/Paraphern/rugsnare)
- npm: [rugsnare](https://www.npmjs.com/package/rugsnare)
- Verified drift case studies for popular MCP servers: [docs/servers](https://github.com/Paraphern/rugsnare/tree/main/docs/servers)

## License

Apache-2.0
