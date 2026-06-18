'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, buildUserPrompt } = require('./prompt');

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
const CHUNK_SIZE_CHARS = 600_000;
const MENTION_USER = '@dsngeu';
const MAX_INLINE_COMMENTS = 50;
const MAX_FILE_CONTENT_BYTES = 100 * 1024; // 100KB

const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /\.lock$/,
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|tar|gz|wasm|bin|exe|dll)$/i,
];

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── GitHub API helper ────────────────────────────────────────────────────────

async function githubRequest(method, path, body = null, acceptHeader = 'application/vnd.github.v3+json') {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: acceptHeader,
      'Content-Type': 'application/json',
      'User-Agent': 'code-review-agents/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res.text();
}

// ── GitHub operations ────────────────────────────────────────────────────────

async function fetchPRDiff() {
  return githubRequest(
    'GET',
    `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}`,
    null,
    'application/vnd.github.v3.diff'
  );
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

async function fetchFileContents(files) {
  const contents = new Map();
  const relevantFiles = files.filter(
    (f) => f.status !== 'removed' && !shouldSkipFile(f.filename)
  );

  for (const file of relevantFiles) {
    try {
      const data = await githubRequest(
        'GET',
        `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(file.filename)}?ref=${HEAD_SHA}`
      );
      if (data.encoding === 'base64' && data.content) {
        const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
        if (decoded.length <= MAX_FILE_CONTENT_BYTES) {
          contents.set(file.filename, decoded.toString('utf8'));
        }
      }
    } catch {
      // skip files that can't be fetched (e.g. submodules)
    }

    // small delay to avoid secondary rate limits on large PRs
    if (relevantFiles.length > 20) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return contents;
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
    output: {
      title: 'Security Review',
      summary,
    },
  });
}

async function postSummaryComment(findings) {
  const hasCriticalOrHigh = findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  let body;

  if (findings.length === 0) {
    body = '## Security Review\n\nNo security issues found in this PR.';
  } else {
    const rows = findings
      .map((f) => `| ${f.severity} | ${f.confidence} | \`${f.file}\` | ${f.line ?? '—'} | ${f.description} |`)
      .join('\n');

    body = `## Security Review\n\nFound **${findings.length}** security issue${findings.length === 1 ? '' : 's'}.\n\n| Severity | Confidence | File | Line | Description |\n|----------|------------|------|------|-------------|\n${rows}`;

    if (hasCriticalOrHigh) {
      body += `\n\n${MENTION_USER} — HIGH/CRITICAL findings require attention.`;
    }
  }

  await githubRequest('POST', `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`, { body });
}

async function postInlineReviewComments(findings) {
  const inlineable = findings
    .filter((f) => f.file && f.line != null)
    .slice(0, MAX_INLINE_COMMENTS);

  if (inlineable.length === 0) return;

  const comments = inlineable.map((f) => ({
    path: f.file,
    line: f.line,
    body: `**[${f.severity}]** ${f.description}\n\n**Fix:** ${f.fix}`,
  }));

  try {
    await githubRequest('POST', `/repos/${OWNER}/${REPO}/pulls/${PR_NUM}/reviews`, {
      commit_id: HEAD_SHA,
      event: 'COMMENT',
      comments,
    });
  } catch (err) {
    // inline comments fail if line numbers are outside the diff — post summary only
    console.error('Inline comments failed (lines may be outside diff):', err.message);
  }
}

async function postErrorComment(err) {
  const body = `## Security Review — Error\n\nThe security review agent encountered an error and could not complete.\n\n**Error:** ${err.message}\n\n${MENTION_USER} — please re-run the workflow or review manually.`;
  await githubRequest('POST', `/repos/${OWNER}/${REPO}/issues/${PR_NUM}/comments`, { body });
}

// ── Diff payload ─────────────────────────────────────────────────────────────

function buildDiffPayload(rawDiff, fileContents) {
  let payload = `=== UNIFIED DIFF ===\n${rawDiff}`;
  for (const [filename, content] of fileContents) {
    payload += `\n\n=== FULL FILE: ${filename} ===\n${content}`;
  }
  return payload;
}

function chunkPayload(payload) {
  if (payload.length <= CHUNK_SIZE_CHARS) return [payload];

  const chunks = [];
  // split on file boundaries
  const boundaries = [...payload.matchAll(/(?=\n=== (FULL FILE|UNIFIED DIFF))/g)].map((m) => m.index);
  boundaries.push(payload.length);

  let current = '';
  let lastBoundary = 0;

  for (const boundary of boundaries.slice(1)) {
    const segment = payload.slice(lastBoundary, boundary);

    if (current.length + segment.length > CHUNK_SIZE_CHARS) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      // segment alone is larger than chunk size — put it in its own chunk
      if (segment.length > CHUNK_SIZE_CHARS) {
        chunks.push(segment);
      } else {
        current = segment;
      }
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
    max_tokens: 8192,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserPrompt(diffPayload) }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) return [];

  try {
    const parsed = JSON.parse(textBlock.text.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f) => f && typeof f.severity === 'string' && typeof f.description === 'string'
    );
  } catch {
    console.error('Failed to parse Claude response as JSON:', textBlock.text.slice(0, 500));
    return [];
  }
}

function mergeFindings(findingArrays) {
  const flat = findingArrays.flat();
  const seen = new Set();
  const deduped = [];

  for (const f of flat) {
    const key = `${f.file}:${f.line}:${f.description.slice(0, 60)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  deduped.sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  return deduped;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Starting security review for ${OWNER}/${REPO} PR #${PR_NUM}`);

  const checkRunId = await createCheckRun();

  try {
    const rawDiff = await fetchPRDiff();
    const changedFiles = await fetchChangedFiles();
    const filteredFiles = changedFiles.filter((f) => !shouldSkipFile(f.filename));
    const fileContents = await fetchFileContents(filteredFiles);

    console.log(`Analyzing ${filteredFiles.length} files (${fileContents.size} with full content)`);

    const payload = buildDiffPayload(rawDiff, fileContents);
    const chunks = chunkPayload(payload);

    console.log(`Sending ${chunks.length} chunk(s) to Claude`);

    const findingArrays = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      const findings = await callClaude(chunks[i]);
      findingArrays.push(findings);
    }

    const allFindings = mergeFindings(findingArrays);
    console.log(`Found ${allFindings.length} security issue(s)`);

    await postInlineReviewComments(allFindings);
    await postSummaryComment(allFindings);

    const summary =
      allFindings.length === 0
        ? 'No security issues found.'
        : `Found ${allFindings.length} security issue(s). See PR comments for details.`;

    await updateCheckRun(checkRunId, 'neutral', summary);
    console.log('Security review completed successfully');
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
