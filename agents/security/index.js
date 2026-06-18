'use strict';

const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  FINDINGS_TOOL,
  VERIFICATION_TOOL,
} = require('./prompt');

const {
  ANTHROPIC_API_KEY,
  GH_TOKEN,
  TARGET_REPO,
  PR_NUMBER,
  HEAD_SHA,
} = process.env;

const [OWNER, REPO] = TARGET_REPO.split('/');
const PR_NUM = parseInt(PR_NUMBER, 10);

const CLAUDE_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 16000;
const CLAUDE_MAX_RETRIES = 5;
const CHUNK_SIZE_CHARS = 600_000;
const MENTION_USER = '@dsngeu';
const MAX_INLINE_COMMENTS = 50;
const MAX_FILE_CONTENT_BYTES = 100 * 1024; // 100KB
const MAX_CONTEXT_FILES = 20; // extra unchanged files pulled in for data-flow context
const COMMENT_MARKER = '<!-- security-review-agent -->';

// Large-PR budget: cap how many changed files we deeply analyze. When a PR
// exceeds this, we review the highest-risk files and disclose what was skipped.
const MAX_FILES = parseInt(process.env.MAX_FILES || '80', 10);
// How many chunks to send to Claude concurrently.
const CHUNK_CONCURRENCY = parseInt(process.env.CHUNK_CONCURRENCY || '4', 10);

// Risk heuristics for prioritizing files when a PR exceeds the budget.
// Language-agnostic by design: we do NOT keep an allowlist of "code" extensions
// (that would penalize any language we forgot). Instead we deprioritize known
// docs/config/data files; everything else — any programming language, known or
// not — is treated as code and keeps full priority.
const RISK_KEYWORDS = /(auth|login|signin|password|passwd|secret|cred|token|crypto|cipher|hash|sql|query|exec|spawn|eval|admin|payment|billing|checkout|session|cookie|oauth|jwt|upload|download|redirect|cors|api[_-]?key|webhook|deserialize|pickle|unserialize)/i;
const NONCODE_EXT = /\.(md|markdown|txt|rst|adoc|json|ya?ml|toml|ini|cfg|conf|properties|xml|csv|tsv|lock|svg|map|snap|po|mo|html?|css|scss|less)$/i;

// Minimum severity to post as an inline comment (everything still appears in the summary).
const INLINE_MIN_SEVERITY = (process.env.INLINE_MIN_SEVERITY || 'LOW').toUpperCase();
// Adversarial verification pass on by default; set VERIFY=false to disable.
const VERIFY = process.env.VERIFY !== 'false';

const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /(^|\/)(node_modules|dist|build|vendor|out|\.next|coverage)\//,
  /\.min\.(js|css)$/,
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|tar|gz|wasm|bin|exe|dll|woff2?|ttf|mp3|mp4|mov)$/i,
];

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const severityRank = (s) => {
  const i = SEVERITY_ORDER.indexOf((s || '').toUpperCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
};
const severityAtLeast = (s, min) => severityRank(s) <= severityRank(min);

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: CLAUDE_MAX_RETRIES });

// ── GitHub API helper ────────────────────────────────────────────────────────

async function githubRequest(method, apiPath, body = null, acceptHeader = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: acceptHeader,
      'Content-Type': 'application/json',
      'User-Agent': 'code-review-agents/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${apiPath} → ${res.status}: ${text}`);
  }

  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('application/json') ? res.json() : res.text();
}

// Encode each path segment but preserve the slashes (fixes nested-file fetches).
function encodePath(filename) {
  return filename.split('/').map(encodeURIComponent).join('/');
}

// ── GitHub operations ────────────────────────────────────────────────────────

async function fetchPRDiff() {
  return githubRequest('GET', `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}`, null, 'application/vnd.github.v3.diff');
}

async function fetchChangedFiles() {
  const files = [];
  let page = 1;
  while (true) {
    const batch = await githubRequest('GET', `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return files;
}

function shouldSkipFile(filename) {
  return SKIP_PATTERNS.some((re) => re.test(filename));
}

// Higher score = more likely to contain security issues → reviewed first.
// Size contributes only a little (capped) so a huge data/JSON file can't
// outrank security-relevant source. Any source file in any language is treated
// as code; only known docs/config/data extensions are deprioritized.
function riskScore(f) {
  let s = Math.min(f.additions || 0, 60); // cap size influence
  if (RISK_KEYWORDS.test(f.filename)) s += 100;
  s += NONCODE_EXT.test(f.filename) ? -100 : 50; // code (any language) keeps priority
  return s;
}

// Apply the large-PR budget: keep the top MAX_FILES by risk, return the rest as skipped.
function selectFilesByBudget(files) {
  if (files.length <= MAX_FILES) return { selected: files, skipped: [] };
  const ranked = [...files].sort((a, b) => riskScore(b) - riskScore(a));
  return { selected: ranked.slice(0, MAX_FILES), skipped: ranked.slice(MAX_FILES) };
}

// Keep only the diff sections for the given set of file paths.
function filterDiffToFiles(rawDiff, keep) {
  const lines = rawDiff.split('\n');
  const out = [];
  let include = false;
  for (const line of lines) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) include = keep.has(m[1]);
    if (include) out.push(line);
  }
  return out.join('\n');
}

// Run async fn over items with a bounded number of concurrent workers.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchContent(filename) {
  const data = await githubRequest('GET', `/repos/${OWNER}/${REPO}/contents/${encodePath(filename)}?ref=${HEAD_SHA}`);
  if (data && data.encoding === 'base64' && data.content) {
    const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
    if (decoded.length <= MAX_FILE_CONTENT_BYTES) return decoded.toString('utf8');
  }
  return null;
}

async function fetchFileContents(files) {
  const contents = new Map();
  const relevant = files.filter((f) => f.status !== 'removed' && !shouldSkipFile(f.filename));

  for (const file of relevant) {
    try {
      const content = await fetchContent(file.filename);
      if (content != null) contents.set(file.filename, content);
    } catch {
      // best-effort: fall back to diff-only context for this file
    }
    if (relevant.length > 20) await new Promise((r) => setTimeout(r, 100));
  }
  return contents;
}

// Pull in unchanged local files imported by changed files, for data-flow context.
async function gatherContextFiles(fileContents) {
  const already = new Set(fileContents.keys());
  const wanted = new Set();
  const importRe = /(?:import\s+(?:[^'"]+\s+from\s+)?|require\(\s*|export\s+[^'"]+\s+from\s+)['"]([^'"]+)['"]/g;
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

  for (const [file, content] of fileContents) {
    const dir = path.posix.dirname(file);
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // only resolve relative imports
      const base = path.posix.normalize(path.posix.join(dir, spec));
      for (const ext of exts) wanted.add(base + ext);
    }
  }

  const context = new Map();
  for (const candidate of wanted) {
    if (context.size >= MAX_CONTEXT_FILES) break;
    if (already.has(candidate) || shouldSkipFile(candidate)) continue;
    try {
      const content = await fetchContent(candidate);
      if (content != null) context.set(candidate, content);
    } catch {
      // candidate path guess didn't resolve — ignore
    }
  }
  return context;
}

// Parse a unified diff → Map<file, Set<newLineNumbers>> of lines that can take inline comments.
function parseDiffValidLines(rawDiff) {
  const map = new Map();
  let current = null;
  let newLine = 0;

  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '').trim();
      current = p === '/dev/null' ? null : p;
      if (current && !map.has(current)) map.set(current, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      map.get(current).add(newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // removed line — does not advance the new-file counter
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — ignore
    } else {
      // context line
      map.get(current).add(newLine);
      newLine++;
    }
  }
  return map;
}

async function createCheckRun() {
  const data = await githubRequest('POST', `/repos/${OWNER}/${REPO}/check-runs`, {
    name: 'Security Review',
    head_sha: HEAD_SHA,
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });
  return data.id;
}

async function updateCheckRun(checkRunId, conclusion, summary) {
  await githubRequest('PATCH', `/repos/${OWNER}/${REPO}/check-runs/${checkRunId}`, {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title: 'Security Review', summary },
  });
}

// Idempotency: remove the agent's prior summary + inline comments before re-posting.
async function deletePreviousComments() {
  const targets = [
    { list: `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`, del: (id) => `/repos/${OWNER}/${REPO}/issues/comments/${id}` },
    { list: `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}/comments`, del: (id) => `/repos/${OWNER}/${REPO}/pulls/comments/${id}` },
  ];
  for (const t of targets) {
    try {
      let page = 1;
      while (true) {
        const batch = await githubRequest('GET', `${t.list}?per_page=100&page=${page}`);
        for (const c of batch) {
          if (c.body && c.body.includes(COMMENT_MARKER)) {
            try { await githubRequest('DELETE', t.del(c.id)); } catch { /* ignore */ }
          }
        }
        if (batch.length < 100) break;
        page++;
      }
    } catch {
      // listing failed — non-fatal, we just may leave stale comments
    }
  }
}

function severityCounts(findings) {
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
}

function skippedFilesNote(skipped) {
  if (!skipped || skipped.length === 0) return '';
  const names = skipped.slice(0, 20).map((f) => `\`${f.filename}\``).join(', ');
  const more = skipped.length > 20 ? `, …and ${skipped.length - 20} more` : '';
  return (
    `\n\n> ⚠️ **Large PR:** reviewed the ${MAX_FILES} highest-risk files. ` +
    `${skipped.length} lower-risk file(s) were not analyzed: ${names}${more}. ` +
    `Raise the budget with the \`MAX_FILES\` env var if needed.`
  );
}

async function postSummaryComment(findings, skipped) {
  const hasCriticalOrHigh = findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  let body;

  if (findings.length === 0) {
    body = `${COMMENT_MARKER}\n## Security Review\n\n✅ No security issues found in this PR.`;
  } else {
    const rows = findings
      .map((f) => `| ${f.severity} | ${f.confidence} | \`${f.file}\` | ${f.line ?? '—'} | ${f.description} |`)
      .join('\n');
    body =
      `${COMMENT_MARKER}\n## Security Review\n\nFound **${findings.length}** security issue${findings.length === 1 ? '' : 's'} (${severityCounts(findings)}).\n\n` +
      `| Severity | Confidence | File | Line | Description |\n|----------|------------|------|------|-------------|\n${rows}`;
    if (hasCriticalOrHigh) body += `\n\n${MENTION_USER} — HIGH/CRITICAL findings require attention.`;
  }

  body += skippedFilesNote(skipped);
  await githubRequest('POST', `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`, { body });
}

async function postInlineReviewComments(findings, validLines) {
  const inlineable = findings
    .filter((f) => f.file && f.line != null)
    .filter((f) => severityAtLeast(f.severity, INLINE_MIN_SEVERITY))
    .filter((f) => validLines.get(f.file)?.has(f.line)) // only lines that exist in the diff
    .slice(0, MAX_INLINE_COMMENTS);

  if (inlineable.length === 0) {
    console.log('No inline-eligible findings (lines outside diff or below threshold).');
    return;
  }

  const comments = inlineable.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: `${COMMENT_MARKER}\n**[${f.severity}]** ${f.description}\n\n**Fix:** ${f.fix}`,
  }));

  try {
    await githubRequest('POST', `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}/reviews`, {
      commit_id: HEAD_SHA,
      event: 'COMMENT',
      comments,
    });
  } catch (err) {
    // One bad line 422s the whole review — fall back to posting comments individually.
    console.error('Batch review failed, falling back to individual comments:', err.message);
    for (const c of comments) {
      try {
        await githubRequest('POST', `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}/comments`, {
          commit_id: HEAD_SHA,
          path: c.path,
          line: c.line,
          side: 'RIGHT',
          body: c.body,
        });
      } catch (e) {
        console.error(`  skipped ${c.path}:${c.line} — ${e.message}`);
      }
    }
  }
}

async function postErrorComment(err) {
  const body = `${COMMENT_MARKER}\n## Security Review — Error\n\nThe security review agent encountered an error and could not complete.\n\n**Error:** ${err.message}\n\n${MENTION_USER} — please re-run the workflow or review manually.`;
  await githubRequest('POST', `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`, { body });
}

// ── Diff payload ─────────────────────────────────────────────────────────────

function buildDiffPayload(rawDiff, fileContents, contextFiles) {
  let payload = `=== UNIFIED DIFF ===\n${rawDiff}`;
  for (const [filename, content] of fileContents) {
    payload += `\n\n=== FULL FILE (changed): ${filename} ===\n${content}`;
  }
  for (const [filename, content] of contextFiles) {
    payload += `\n\n=== CONTEXT FILE (unchanged, for data-flow only): ${filename} ===\n${content}`;
  }
  return payload;
}

function chunkPayload(payload) {
  if (payload.length <= CHUNK_SIZE_CHARS) return [payload];

  const chunks = [];
  const boundaries = [...payload.matchAll(/(?=\n=== (FULL FILE|CONTEXT FILE|UNIFIED DIFF))/g)].map((m) => m.index);
  boundaries.push(payload.length);

  let current = '';
  let lastBoundary = 0;
  for (const boundary of boundaries.slice(1)) {
    const segment = payload.slice(lastBoundary, boundary);
    if (current.length + segment.length > CHUNK_SIZE_CHARS) {
      if (current.length > 0) { chunks.push(current); current = ''; }
      if (segment.length > CHUNK_SIZE_CHARS) chunks.push(segment);
      else current = segment;
    } else {
      current += segment;
    }
    lastBoundary = boundary;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ── Claude ───────────────────────────────────────────────────────────────────

async function callClaude(diffPayload) {
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    tools: [FINDINGS_TOOL],
    tool_choice: { type: 'tool', name: 'report_findings' },
    messages: [{ role: 'user', content: buildUserPrompt(diffPayload) }],
  });

  if (response.stop_reason === 'max_tokens') {
    console.warn('⚠️  Claude response hit max_tokens — findings may be truncated for this chunk.');
  }

  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'report_findings');
  if (!toolUse || !Array.isArray(toolUse.input?.findings)) return [];
  return toolUse.input.findings.filter((f) => f && f.severity && f.description);
}

// Adversarial second pass: drop findings the verifier refutes. Fail-open on error.
async function verifyFindings(diffPayload, findings) {
  if (!VERIFY || findings.length === 0) return findings;
  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: buildVerifySystemPrompt(),
      tools: [VERIFICATION_TOOL],
      tool_choice: { type: 'tool', name: 'report_verification' },
      messages: [{ role: 'user', content: buildVerifyUserPrompt(diffPayload, findings) }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'report_verification');
    if (!toolUse || !Array.isArray(toolUse.input?.results)) return findings;

    const refuted = new Set(
      toolUse.input.results.filter((r) => r.verdict === 'false_positive').map((r) => r.index)
    );
    const kept = findings.filter((_, i) => !refuted.has(i));
    if (refuted.size > 0) console.log(`Verifier removed ${refuted.size} false positive(s).`);
    return kept;
  } catch (err) {
    console.error('Verification pass failed (keeping all findings):', err.message);
    return findings;
  }
}

function mergeFindings(findingArrays) {
  const flat = findingArrays.flat();
  const seen = new Set();
  const deduped = [];
  for (const f of flat) {
    const key = `${f.file}:${f.line}:${(f.description || '').toLowerCase().slice(0, 80)}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(f); }
  }
  deduped.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return deduped;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Starting security review for ${OWNER}/${REPO} PR #${PR_NUM}`);
  const checkRunId = await createCheckRun();

  try {
    const rawDiff = await fetchPRDiff();
    const changedFiles = await fetchChangedFiles();
    const reviewable = changedFiles.filter((f) => f.status !== 'removed' && !shouldSkipFile(f.filename));

    // Large-PR budget: deeply review the highest-risk files, disclose the rest.
    const { selected, skipped } = selectFilesByBudget(reviewable);
    const selectedSet = new Set(selected.map((f) => f.filename));
    const scopedDiff = skipped.length > 0 ? filterDiffToFiles(rawDiff, selectedSet) : rawDiff;

    const fileContents = await fetchFileContents(selected);
    const contextFiles = await gatherContextFiles(fileContents);
    const validLines = parseDiffValidLines(scopedDiff);

    console.log(
      `${reviewable.length} reviewable file(s); analyzing ${selected.length} ` +
      `(${skipped.length} skipped by budget), ${fileContents.size} with full content, ` +
      `${contextFiles.size} context file(s) pulled in.`
    );

    const payload = buildDiffPayload(scopedDiff, fileContents, contextFiles);
    const chunks = chunkPayload(payload);
    console.log(`Sending ${chunks.length} chunk(s) to Claude, ${CHUNK_CONCURRENCY} at a time (verify=${VERIFY}).`);

    const findingArrays = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, async (chunk, i) => {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      let findings = await callClaude(chunk);
      findings = await verifyFindings(chunk, findings); // verify against the same chunk's context
      return findings;
    });

    const allFindings = mergeFindings(findingArrays);
    console.log(`Confirmed ${allFindings.length} security issue(s).`);

    await deletePreviousComments(); // idempotent re-runs
    await postInlineReviewComments(allFindings, validLines);
    await postSummaryComment(allFindings, skipped);

    let summary =
      allFindings.length === 0
        ? 'No security issues found.'
        : `Found ${allFindings.length} security issue(s) (${severityCounts(allFindings)}). See PR comments.`;
    if (skipped.length > 0) summary += ` (${skipped.length} lower-risk file(s) skipped by budget.)`;
    await updateCheckRun(checkRunId, 'neutral', summary);
    console.log('Security review completed successfully.');
  } catch (err) {
    console.error('Security review agent error:', err);
    try {
      await postErrorComment(err);
      await updateCheckRun(checkRunId, 'neutral', `Agent error: ${err.message}`);
    } catch (notifyErr) {
      console.error('Failed to post error notification:', notifyErr.message);
    }
    process.exit(1);
  }
}

main();
