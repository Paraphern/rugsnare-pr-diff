#!/usr/bin/env node
/**
 * RugSnare PR-diff action script.
 *
 * Compares the committed pin store against the live MCP servers declared in
 * a config file, and posts (or updates) a PR comment with a HUMAN-READABLE
 * diff of tool contracts — reviewers see the changed words, not hashes.
 *
 * Runs in-process (imports rugsnare modules directly, spawns nothing).
 * Environment:
 *   RUGSNARE_SRC       – path to rugsnare/product/src (workspace or self-checkout)
 *   RUGSNARE_CONFIG    – path to the mcp config (relative to RUGSNARE_CWD)
 *   RUGSNARE_CWD       – working directory for pins/config resolution
 *   GITHUB_TOKEN       – token with pull-requests:write
 *   GITHUB_CONTEXT     – JSON of the github event context (repo, event.number)
 *   RUGSNARE_FAIL_ON_DRIFT – "true" (default) → exit 1 when drift is found
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const srcDir = process.env.RUGSNARE_SRC;
const cwd = process.env.RUGSNARE_CWD || process.cwd();
const configFile = process.env.RUGSNARE_CONFIG;
const failOnDrift = (process.env.RUGSNARE_FAIL_ON_DRIFT ?? 'true') !== 'false';

if (!srcDir || !configFile) {
  console.error('pr-comment: RUGSNARE_SRC and RUGSNARE_CONFIG are required');
  process.exit(2);
}

const mod = (name) => import(pathToFileURL(path.join(srcDir, name)).href);
const { loadPins } = await mod('pins.js');
const { fetchTools } = await mod('rpc.js');
const { toolHash } = await mod('hash.js');
const { compareTools } = await mod('pins.js');
const { readJsonFile } = await mod('jsonfile.js');

// ---- 1. run the diff (in-process) ----
const configPath = path.isAbsolute(configFile) ? configFile : path.join(cwd, configFile);
const config = readJsonFile(configPath);
const pins = loadPins(cwd);

const servers = Object.fromEntries(
  Object.entries(config.mcpServers ?? {}).filter(([, v]) => v && typeof v.command === 'string')
);

const report = [];
const tools = [];
  for (const [name, entry] of Object.entries(servers)) {
    const pin = pins.servers[name];
    if (!pin?.cmd) {
      report.push({ server: name, verdicts: [{ tool: '(all)', status: 'NEW', note: 'not pinned yet — run rugsnare scan on main first' }] });
      continue;
    }
    const liveFromConfig = servers[name];
    const cmd = liveFromConfig?.command === pin.cmd.command && JSON.stringify(liveFromConfig.args ?? []) === JSON.stringify(pin.cmd.args)
      ? { command: pin.cmd.command, args: pin.cmd.args }
      : { command: liveFromConfig.command, args: liveFromConfig.args ?? [] }; // config changed → check what it NOW runs
    const { tools: serverTools } = await fetchTools({ command: cmd.command, args: cmd.args, env: entry.env ?? {}, cwd, timeoutMs: 20000 });
    tools.push(...serverTools);
    report.push({ server: name, verdicts: compareTools(pin, serverTools, toolHash) });
  }

// ---- 2. render markdown ----
const clip = (s, n = 700) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s || '(empty)');
const icon = { DRIFT: '🔴', NEW: '🟡', REMOVED: '⚫', UNCHANGED: '🟢' };

let findings = 0;
const lines = ['<!-- rugsnare-pr-diff -->', '## 🪤 RugSnare — MCP tool contract diff', ''];
for (const { server, verdicts } of report) {
  const bad = verdicts.filter((v) => v.status !== 'UNCHANGED');
  if (bad.length === 0) {
    lines.push(`**${server}** — 🟢 all ${verdicts.length} tool contracts unchanged`, '');
    continue;
  }
  lines.push(`**${server}** — ${bad.length} finding(s):`, '');
  for (const v of bad) {
    findings++;
    if (v.status === 'DRIFT') {
      lines.push(
        `### ${icon.DRIFT} \`${v.tool}\` — description changed after approval`,
        '',
        '**Before (pinned):**',
        '```',
        clip(v.oldDescription),
        '```',
        '**After (live):**',
        '```',
        clip(v.newDescription),
        '```',
        `hash: \`${(v.oldHash ?? '').slice(0, 16)}\` → \`${(v.hash ?? '').slice(0, 16)}\``,
        ''
      );
    } else if (v.status === 'NEW') {
      lines.push(`### ${icon.NEW} \`${v.tool}\` — unapproved new tool${v.note ? ` (${v.note})` : ''}`, '');
    } else if (v.status === 'REMOVED') {
      lines.push(`### ${icon.REMOVED} \`${v.tool}\` — approved tool disappeared`, '');
    }
  }
}
lines.push('---', '_RugSnare pins tool contracts (`{name, description, inputSchema}`) at approval; this comment shows every silent change. Baseline pins live in the repo — update them deliberately via `rugsnare approve`._');

const body = lines.join('\n');
console.log(body);

// ---- 3. post or update the PR comment ----
const ctx = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
const repo = process.env.GITHUB_REPOSITORY || ctx.repository; // owner/name
const prNumber = ctx.event?.number ?? Number(process.env.PR_NUMBER ?? 0);
const api = `https://api.github.com/repos/${repo}`;

if (prNumber && process.env.GITHUB_TOKEN) {
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rugsnare-pr-diff',
  };
  const list = await fetch(`${api}/issues/${prNumber}/comments?per_page=100`, { headers });
  const comments = await list.json();
  const marker = '<!-- rugsnare-pr-diff -->';
  const existing = Array.isArray(comments) ? comments.find((c) => (c.body ?? '').startsWith(marker)) : null;
  const res = existing
    ? await fetch(`${api}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ body }) })
    : await fetch(`${api}/issues/${prNumber}/comments`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
  console.error(`pr-comment: ${existing ? 'updated' : 'posted'} comment → ${res.status}`);
  if (!res.ok) console.error(`pr-comment: failed: ${await res.text()}`);
} else {
  console.error('pr-comment: no PR number/token — dry-run, markdown printed above only');
}

process.exit(findings > 0 && failOnDrift ? 1 : 0);
