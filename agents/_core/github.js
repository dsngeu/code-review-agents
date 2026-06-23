'use strict';

const fs = require('node:fs');
const { MAX_FILE_CONTENT_BYTES, MAX_CONTEXT_FILES, SKIP_PATTERNS } = require('./config');
const { resolveContextCandidates } = require('./context-resolvers');

const path = require('node:path');

const GH_TOKEN = process.env.GH_TOKEN;

// ── Core request helper ───────────────────────────────────────────────────────
//
// SAFETY GUARANTEE: these agents may only READ code and COMMENT on PRs.
// They must never modify or delete anything. Two independent guards enforce this:
//   1. The workflow grants the runner token only `contents: read` (+ pull-requests
//      / checks write) — so it physically cannot push, edit files, or delete
//      branches even if asked.
//   2. This hard block: only GET (read), POST and PATCH (create/update comments &
//      check runs) are allowed. DELETE and PUT are refused outright — the agents
//      never delete code, branches, PRs, or even their own comments.
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH']);

async function githubRequest(method, apiPath, body = null, acceptHeader = 'application/vnd.github+json') {
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Blocked ${method} ${apiPath}: agents are read + comment only (no DELETE/PUT).`);
  }
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

function shouldSkipFile(filename) {
  return SKIP_PATTERNS.some((re) => re.test(filename));
}

// ── Diff / file fetching ──────────────────────────────────────────────────────

// PR mode: unified diff of the pull request.
async function fetchPRDiff(owner, repo, prNum) {
  return githubRequest('GET', `/repos/${owner}/${repo}/pulls/${prNum}`, null, 'application/vnd.github.v3.diff');
}

// PR mode: changed files (paginated).
async function fetchPRFiles(owner, repo, prNum) {
  const files = [];
  let page = 1;
  while (true) {
    const batch = await githubRequest('GET', `/repos/${owner}/${repo}/pulls/${prNum}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return files;
}

// Branch mode: compare base...head → { diff, files }.
async function fetchCompare(owner, repo, base, head) {
  // Encode ref segments but keep slashes — branch names like `feat/x` must stay
  // `feat/x` (percent-encoding the slash 404s the compare API).
  const data = await githubRequest('GET', `/repos/${owner}/${repo}/compare/${encodePath(base)}...${encodePath(head)}`);
  const files = data.files || [];
  // Reconstruct a unified diff from per-file patches so parseDiffValidLines works.
  const diff = files
    .filter((f) => f.patch)
    .map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`)
    .join('\n');
  return { diff, files };
}

async function getDefaultBranch(owner, repo) {
  const data = await githubRequest('GET', `/repos/${owner}/${repo}`);
  return data.default_branch;
}

// Lightweight repo metadata used to calibrate findings (e.g. don't flag fork-PR
// exfiltration on a private repo, don't call same-owner refs "third-party").
// Fail-open: returns null on any error so review never blocks on it.
async function getRepoMeta(owner, repo) {
  try {
    const d = await githubRequest('GET', `/repos/${owner}/${repo}`);
    return {
      owner,
      visibility: d.visibility || (d.private ? 'private' : 'public'),
      private: !!d.private,
      isFork: !!d.fork,
      defaultBranch: d.default_branch,
    };
  } catch (err) {
    console.error('getRepoMeta failed (continuing without repo context):', err.message);
    return null;
  }
}

async function fetchContent(owner, repo, filename, ref) {
  const data = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${encodePath(filename)}?ref=${encodeURIComponent(ref)}`);
  if (data && data.encoding === 'base64' && data.content) {
    const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64');
    if (decoded.length <= MAX_FILE_CONTENT_BYTES) return decoded.toString('utf8');
  }
  return null;
}

async function fetchFileContents(owner, repo, files, ref) {
  const contents = new Map();
  const relevant = files.filter((f) => f.status !== 'removed' && !shouldSkipFile(f.filename));
  for (const file of relevant) {
    try {
      const content = await fetchContent(owner, repo, file.filename, ref);
      if (content != null) contents.set(file.filename, content);
    } catch {
      // best-effort: fall back to diff-only context for this file
    }
    if (relevant.length > 20) await new Promise((r) => setTimeout(r, 100));
  }
  return contents;
}

// Fetch the target repo's full list of file paths in one recursive git-trees call.
// Returns a Set of blob paths, or null on any failure (fail-open → JS-only fallback).
// NOTE: works reliably when `ref` is a commit SHA (PR mode HEAD_SHA, no slashes). For
// slashed branch refs the trees endpoint may 404; we just return null and degrade.
async function fetchRepoTree(owner, repo, ref) {
  try {
    const data = await githubRequest('GET', `/repos/${owner}/${repo}/git/trees/${encodePath(ref)}?recursive=1`);
    if (!data || !Array.isArray(data.tree)) return null;
    const paths = new Set(data.tree.filter((t) => t.type === 'blob').map((t) => t.path));
    if (data.truncated) console.warn('⚠️  Repo tree truncated — cross-file context may be partial.');
    return paths;
  } catch (err) {
    console.warn(`Repo tree fetch failed (${err.message}); cross-file context limited to JS/TS guesses.`);
    return null;
  }
}

// Pull in unchanged first-party files referenced by changed files, for data-flow context.
// Language-aware (Step 2): JS/TS relative imports, Kotlin/Java package imports, Swift type
// references — all resolved against the repo's real file list (`treePaths`).
async function gatherContextFiles(owner, repo, fileContents, ref) {
  const already = new Set(fileContents.keys());
  const treePaths = await fetchRepoTree(owner, repo, ref);

  const wanted = new Set();
  for (const [file, content] of fileContents) {
    for (const candidate of resolveContextCandidates(file, content, treePaths)) {
      wanted.add(candidate);
    }
  }

  const context = new Map();
  for (const candidate of wanted) {
    if (context.size >= MAX_CONTEXT_FILES) break;
    if (already.has(candidate) || shouldSkipFile(candidate)) continue;
    // If we have the tree, only fetch paths that actually exist (avoids wasted 404s).
    if (treePaths && !treePaths.has(candidate)) continue;
    try {
      const content = await fetchContent(owner, repo, candidate, ref);
      if (content != null) context.set(candidate, content);
    } catch {
      // candidate path guess didn't resolve — ignore
    }
  }
  return context;
}

// Parse a unified diff → Map<file, Set<newLineNumbers>> of commentable lines.
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
      // "\ No newline at end of file"
    } else {
      map.get(current).add(newLine);
      newLine++;
    }
  }
  return map;
}

// ── Check runs ────────────────────────────────────────────────────────────────

async function createCheckRun(owner, repo, sha, name) {
  const data = await githubRequest('POST', `/repos/${owner}/${repo}/check-runs`, {
    name,
    head_sha: sha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });
  return data.id;
}

async function updateCheckRun(owner, repo, checkRunId, name, conclusion, summary) {
  await githubRequest('PATCH', `/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title: name, summary },
  });
}

// ── Comments (idempotent via per-agent marker, WITHOUT deletion) ──────────────
// We never delete comments. Re-runs UPDATE the agent's existing summary comment
// in place (found by its hidden marker); only the first run creates one.

// Find the agent's existing summary comment by marker → { id, body } or null.
// Returns the body too so callers can recover embedded state (the review ledger).
async function getIssueComment(owner, repo, prNum, marker) {
  try {
    let page = 1;
    while (true) {
      const batch = await githubRequest('GET', `/repos/${owner}/${repo}/issues/${prNum}/comments?per_page=100&page=${page}`);
      const hit = batch.find((c) => c.body && c.body.includes(marker));
      if (hit) return { id: hit.id, body: hit.body };
      if (batch.length < 100) break;
      page++;
    }
  } catch {
    // listing failed — treat as none found
  }
  return null;
}

async function findIssueCommentByMarker(owner, repo, prNum, marker) {
  const c = await getIssueComment(owner, repo, prNum, marker);
  return c ? c.id : null;
}

// Create or update the agent's summary comment in place (no deletion). When the
// caller already located the comment (e.g. to read its prior ledger), it can pass
// `knownId` to skip the extra lookup.
async function upsertIssueComment(owner, repo, prNum, marker, body, knownId) {
  const existingId = knownId !== undefined ? knownId : await findIssueCommentByMarker(owner, repo, prNum, marker);
  if (existingId) {
    await githubRequest('PATCH', `/repos/${owner}/${repo}/issues/comments/${existingId}`, { body });
  } else {
    await githubRequest('POST', `/repos/${owner}/${repo}/issues/${prNum}/comments`, { body });
  }
}

async function postIssueComment(owner, repo, prNum, body) {
  await githubRequest('POST', `/repos/${owner}/${repo}/issues/${prNum}/comments`, { body });
}

// All existing inline (review) comments on a PR, paginated. Used to make inline
// posting idempotent WITHOUT deletion: we skip a finding whose {path,line} we've
// already commented on under this agent's marker. Fail-open → [] on error.
async function fetchReviewComments(owner, repo, prNum) {
  const comments = [];
  try {
    let page = 1;
    while (true) {
      const batch = await githubRequest('GET', `/repos/${owner}/${repo}/pulls/${prNum}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
  } catch {
    return []; // listing failed — proceed without dedup rather than lose findings
  }
  return comments;
}

async function postReview(owner, repo, prNum, sha, comments) {
  await githubRequest('POST', `/repos/${owner}/${repo}/pulls/${prNum}/reviews`, {
    commit_id: sha,
    event: 'COMMENT',
    comments,
  });
}

async function postSingleReviewComment(owner, repo, prNum, sha, c) {
  await githubRequest('POST', `/repos/${owner}/${repo}/pulls/${prNum}/comments`, {
    commit_id: sha,
    path: c.path,
    line: c.line,
    side: 'RIGHT',
    body: c.body,
  });
}

// ── Actions Job Summary (for branch mode, no PR) ──────────────────────────────

function writeJobSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    fs.appendFileSync(file, markdown + '\n');
  } else {
    console.log(markdown); // fallback when not running in Actions
  }
}

module.exports = {
  githubRequest,
  encodePath,
  shouldSkipFile,
  fetchPRDiff,
  fetchPRFiles,
  fetchCompare,
  getDefaultBranch,
  getRepoMeta,
  fetchContent,
  fetchFileContents,
  gatherContextFiles,
  fetchRepoTree,
  parseDiffValidLines,
  createCheckRun,
  updateCheckRun,
  getIssueComment,
  upsertIssueComment,
  fetchReviewComments,
  postIssueComment,
  postReview,
  postSingleReviewComment,
  writeJobSummary,
};
