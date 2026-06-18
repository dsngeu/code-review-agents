'use strict';

const {
  CHUNK_SIZE_CHARS,
  MAX_FILES,
  RISK_KEYWORDS,
  NONCODE_EXT,
} = require('./config');

// Higher score = more likely to contain issues → reviewed first when over budget.
// Size contributes only a little (capped); any source file in any language is
// treated as code — only known docs/config/data extensions are deprioritized.
function riskScore(f) {
  let s = Math.min(f.additions || 0, 60);
  if (RISK_KEYWORDS.test(f.filename)) s += 100;
  s += NONCODE_EXT.test(f.filename) ? -100 : 50;
  return s;
}

// Large-PR budget: keep the top MAX_FILES by risk, return the rest as skipped.
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

module.exports = {
  riskScore,
  selectFilesByBudget,
  filterDiffToFiles,
  buildDiffPayload,
  chunkPayload,
  mapWithConcurrency,
};
