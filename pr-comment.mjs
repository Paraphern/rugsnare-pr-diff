#!/usr/bin/env node
/**
 * RugSnare PR-diff action script.
 *
 * Compares the committed pin store against the live MCP servers declared in
 * a config file, and posts (or updates) a PR comment with a HUMAN-READABLE
 * diff of tool contracts - reviewers see the changed words, not hashes.
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
const { loadPins, compareTools, policyVersionFor } = await mod('pins.js');
const { fetchTools } = await mod('rpc.js');
const { toolHash } = await mod('hash.js');
const { comparePinned, promptHash, resourceHash } = await mod('prompts.js');
const { scanToolDescription, atrRuleIds } = await mod('advisory.js');
const { readJsonFile } = await mod('jsonfile.js');

const pins = loadPins(cwd);

// ---- 0. POLICY stop-rule (PIN-SPEC §3.1) ----
// The pin store records the verifier policy that graded it. When a newer
// rugsnare grades old pins, the CLI stops with exactly one POLICY finding.
// The Action must do the same: a legacy pin silently re-graded as ordinary
// drift violates §3.1 and confuses reviewers with stale BREAKING classes.
const currentPolicy = policyVersionFor();
if ((pins.policyVersion ?? null) !== currentPolicy) {
  const body = [
    '<!-- rugsnare-pr-diff -->',
    '## 🪤 RugSnare - MCP tool contract diff',
    '',
    '### ⛔ POLICY - pins graded under a different verifier policy',
    '',
    `Pins were taken under \`${pins.policyVersion ?? 'pre-1.4'}\`; this check runs \`${currentPolicy}\`.`,
    '',
    'The grading rules changed between these versions, so every drift class below would be misleading.',
    'Re-run `rugsnare scan` on main and commit the updated `.rugsnare/pins.json` to grade under the current policy.',
    '',
    '---',
    '_This is not server drift - the vendor did nothing wrong. PIN-SPEC §3.1: the ruler changed._',
  ].join('\n');
  console.log(body);
  // still post the comment so reviewers see WHY the check failed
  const ctx0 = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
  const pr0 = ctx0.event?.number ?? Number(process.env.PR_NUMBER ?? 0);
  if (pr0 && process.env.GITHUB_TOKEN) {
    const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'rugsnare-pr-diff' };
    const repo0 = process.env.GITHUB_REPOSITORY || ctx0.repository;
    await fetch(`https://api.github.com/repos/${repo0}/issues/${pr0}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
  }
  process.exit(1);
}

// ---- 1. run the diff (in-process) ----
const configPath = path.isAbsolute(configFile) ? configFile : path.join(cwd, configFile);
const config = readJsonFile(configPath);

const servers = Object.fromEntries(
  Object.entries(config.mcpServers ?? {}).filter(([, v]) => v && typeof v.command === 'string')
);

const report = [];
const tools = [];
  for (const [name, entry] of Object.entries(servers)) {
    const pin = pins.servers[name];
    if (!pin?.cmd) {
      report.push({ server: name, verdicts: [{ tool: '(all)', status: 'NEW', note: 'not pinned yet - run rugsnare scan on main first' }] });
      continue;
    }
    const liveFromConfig = servers[name];
    const cmd = liveFromConfig?.command === pin.cmd.command && JSON.stringify(liveFromConfig.args ?? []) === JSON.stringify(pin.cmd.args)
      ? { command: pin.cmd.command, args: pin.cmd.args }
      : { command: liveFromConfig.command, args: liveFromConfig.args ?? [] }; // config changed → check what it NOW runs
    const { tools: serverTools, prompts: serverPrompts = [], resources: serverResources = [] } = await fetchTools({ command: cmd.command, args: cmd.args, env: entry.env ?? {}, cwd, timeoutMs: 20000 });
    tools.push(...serverTools);
    const toolVerdicts = compareTools(pin, serverTools, toolHash);
    // prompts and resources are instructions too - compare them the same
    // way the CLI does (comparePinned), then append to the report so the
    // PR comment shows the full surface, not just tools
    let promptVerdicts = [];
    let resourceVerdicts = [];
    if (pin.prompts) promptVerdicts = comparePinned('prompt', pin.prompts, serverPrompts, promptHash);
    if (pin.resources) resourceVerdicts = comparePinned('resource', pin.resources, serverResources, resourceHash);
    report.push({ server: name, verdicts: toolVerdicts, promptVerdicts, resourceVerdicts });
  }

// ---- 2. render markdown ----
const clip = (s, n = 700) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s || '(empty)');
const icon = { DRIFT: '🔴', NEW: '🟡', REMOVED: '⚫', UNCHANGED: '🟢' };
const gradeIcon = { BREAKING: '🔴', LOOSENED: '🟠', EXPANDED: '🟡', NOTATION: '🔵', COSMETIC: '⚪', ANNOTATION: '🟣', POLICY: '⛔', IDENTITY: '🔄' };

// Advisory scoring: structural grades say WHAT changed, advisory signals say
// WHETHER the new text is suspicious. A tool that changes its description to
// "ignore previous instructions" grades COSMETIC (schema untouched) - the
// advisory layer flags it as A15 (instruction hijack). Run on new/changed
// descriptions, not on unchanged ones (a pinned-and-approved description
// already passed review).
function advisoryWarning(description) {
  if (!description || typeof description !== 'string') return null;
  const r = scanToolDescription(description);
  if (!r.advisory) return null;
  const atr = atrRuleIds(r);
  const signalList = r.signals.map((s) => `${s.id} (${s.desc.slice(0, 60)})`).slice(0, 3).join('; ');
  const atrList = atr.length ? ` [${atr.join(' ')}]` : '';
  return `⚠️ **[ADVISORY]** score ${r.score}: ${signalList}${atrList}${r.signals.length > 3 ? ` +${r.signals.length - 3} more` : ''}`;
}

let findings = 0;
const lines = ['<!-- rugsnare-pr-diff -->', '## 🪤 RugSnare - MCP tool contract diff', ''];
for (const r of report) {
  const { server, verdicts } = r;
  const bad = verdicts.filter((v) => v.status !== 'UNCHANGED');
  if (bad.length === 0) {
    lines.push(`**${server}** - 🟢 all ${verdicts.length} tool contracts unchanged`, '');
    continue;
  }

  // group DRIFT verdicts by identical change signature (SDK waves: 24 tools
  // with the same notation change collapse into one line, not 24 sections)
  const driftGroups = new Map(); // signature -> { tools: [], sample: verdict }
  const nonDrift = [];
  for (const v of bad) {
    findings++;
    if (v.status !== 'DRIFT') { nonDrift.push(v); continue; }
    const changes = v.schemaChanges ?? [];
    const notation = v.notationChanges ?? [];
    // advisory result is part of the group signature: tools with different
    // advisory outcomes must not share a section, otherwise the warning
    // from the sample tool gets misattributed to (or hidden from) others
    const advResult = v.newDescription ? (scanToolDescription(v.newDescription).advisory ? 'adv' : 'clean') : 'none';
    const sig = JSON.stringify({
      driftType: v.driftType,
      changes: changes.map((c) => c.text).sort(),
      notation,
      prose: v.proseChanged ? 'changed' : 'same',
      advisory: advResult,
    });
    if (!driftGroups.has(sig)) driftGroups.set(sig, { tools: [], sample: v });
    driftGroups.get(sig).tools.push(v.tool);
  }

  lines.push(`**${server}** - ${bad.length} finding(s):`, '');

  for (const { tools, sample } of driftGroups.values()) {
    const g = gradeIcon[sample.driftType] ?? '🔴';
    const label = sample.driftType ?? 'DRIFT';
    const toolList = tools.length === 1 ? `\`${tools[0]}\`` : `${tools.length} tools (\`${tools[0]}\`, \`${tools[1]}\`… )`;

    lines.push(`### ${g} ${toolList} - ${label}`);

    const changes = sample.schemaChanges ?? [];
    if (changes.length > 0) {
      lines.push('', '**Schema changes:**');
      for (const c of changes.slice(0, 5)) {
        const dir = c.direction ? ` \`${c.direction}\`` : '';
        lines.push(`- ${c.text}${dir}`);
      }
      if (changes.length > 5) lines.push(`- … +${changes.length - 5} more`);
    }
    const notation = sample.notationChanges ?? [];
    if (notation.length > 0) {
      lines.push('', '**Notation (no parameter structure changed):**');
      for (const n of notation.slice(0, 3)) lines.push(`- ${n}`);
      if (notation.length > 3) lines.push(`- … +${notation.length - 3} more`);
    }
    if (sample.paywallWarning) {
      lines.push('', `⚠️ **[PAYWALL]** ${sample.paywallWarning}`);
    }
    if (sample.proseChanged && sample.oldDescription !== sample.newDescription) {
      lines.push('', '**Description changed:**', '**Before:**', '```', clip(sample.oldDescription, 300), '```', '**After:**', '```', clip(sample.newDescription, 300), '```');
    }
    // advisory: is the new text suspicious? (structural grade says WHAT
    // changed; advisory says whether the new prose contains attack patterns)
    if (sample.newDescription) {
      const adv = advisoryWarning(sample.newDescription);
      if (adv) lines.push('', adv);
    }
    lines.push(`hash: \`${(sample.oldHash ?? '').slice(0, 16)}\` → \`${(sample.hash ?? '').slice(0, 16)}\``, '');
  }

  // group NEW and REMOVED into single sections (playwright case: 18 NEW
  // tools as 18 separate ### headings = PR comment spam)
  const newTools = nonDrift.filter((v) => v.status === 'NEW');
  const removedTools = nonDrift.filter((v) => v.status === 'REMOVED');

  if (newTools.length > 0) {
    if (newTools.length === 1) {
      lines.push(`### ${icon.NEW} \`${newTools[0].tool}\` - unapproved new tool${newTools[0].note ? ` (${newTools[0].note})` : ''}`, '');
    } else {
      const list = newTools.slice(0, 8).map((v) => `\`${v.tool}\``).join(', ');
      const more = newTools.length > 8 ? `, +${newTools.length - 8} more` : '';
      lines.push(`### ${icon.NEW} ${newTools.length} new tools - not in the approved baseline`, '');
      lines.push(`${list}${more}`, '');
    }
    // advisory scan on new tools' descriptions (first contact, no baseline)
    for (const v of newTools) {
      if (v.description) {
        const adv = advisoryWarning(v.description);
        if (adv) lines.push(`- \`${v.tool}\`: ${adv}`);
      }
    }
    if (newTools.some((v) => v.description && advisoryWarning(v.description))) lines.push('');
  }

  if (removedTools.length > 0) {
    if (removedTools.length === 1) {
      lines.push(`### ${icon.REMOVED} \`${removedTools[0].tool}\` - approved tool disappeared`, '');
    } else {
      const list = removedTools.slice(0, 8).map((v) => `\`${v.tool}\``).join(', ');
      const more = removedTools.length > 8 ? `, +${removedTools.length - 8} more` : '';
      lines.push(`### ${icon.REMOVED} ${removedTools.length} approved tools disappeared`, '');
      lines.push(`${list}${more}`, '');
    }
  }

  // prompts and resources are instructions too - render their findings
  const prIcon = { DRIFT: '🔴', NEW: '🟡', REMOVED: '⚫' };
  const renderPinnedSection = (label, verdicts) => {
    const bad = verdicts.filter((v) => v.status !== 'UNCHANGED');
    if (bad.length === 0) return;
    findings += bad.length;
    lines.push(`### 📝 ${label} (${bad.length} finding${bad.length === 1 ? '' : 's'}):`, '');
    for (const v of bad) {
      const i = prIcon[v.status] ?? '🔴';
      if (v.status === 'DRIFT') {
        lines.push(`- ${i} \`${v.item}\` - ${v.contentChanged ? 'body text changed (envelope identical)' : 'definition changed'}`);
        // advisory on changed prompt descriptions (same as tools)
        if (v.newDescription) {
          const adv = advisoryWarning(v.newDescription);
          if (adv) lines.push(`  ${adv}`);
        }
      } else if (v.status === 'NEW') {
        lines.push(`- ${i} \`${v.item}\` - new, not in the approved baseline`);
        // advisory on new prompts (first contact)
        if (v.newDescription) {
          const adv = advisoryWarning(v.newDescription);
          if (adv) lines.push(`  ${adv}`);
        }
      } else if (v.status === 'REMOVED') {
        lines.push(`- ${i} \`${v.item}\` - approved, no longer served`);
      }
    }
    lines.push('');
  };
  if (r.promptVerdicts?.length) renderPinnedSection('Prompts', r.promptVerdicts);
  if (r.resourceVerdicts?.length) renderPinnedSection('Resources', r.resourceVerdicts);
}
lines.push('---', '_RugSnare pins tool contracts (`{name, description, inputSchema}`) at approval; this comment shows every silent change with direction grading (BREAKING / LOOSENED / EXPANDED / NOTATION). Identical changes are grouped. Baseline pins live in the repo - update them deliberately via `rugsnare approve`._');

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
  console.error('pr-comment: no PR number/token - dry-run, markdown printed above only');
}

process.exit(findings > 0 && failOnDrift ? 1 : 0);
