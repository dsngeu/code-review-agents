'use strict';

// ── Per-PR review ledger (embedded in the agent's summary comment) ─────────────
//
// Turns the single in-place summary comment from a one-shot SNAPSHOT into a
// running RECORD across every re-review (each PR push fires `synchronize`):
//   • a history table of every review — time, commit, model, tokens, AI cost
//   • cumulative AI cost across all reviews on the PR
//   • findings reported in an earlier review that the latest review no longer
//     re-reports ("No longer reported" — an honest label for likely-fixed)
//
// State lives as a hidden JSON block in the comment body, so NO external store
// is needed — the comment IS the state. Read it back on the next run, diff, and
// re-render. PR-comment agents only: branch review writes a per-run Job Summary
// with no cross-run persistence channel, so it shows per-run cost but no history.

const LEDGER_RE = /<!--\s*review-ledger:\s*([\s\S]*?)\s*-->/;
const MAX_HISTORY_ROWS = 25; // cap stored/displayed review rows (cumulative kept separately)
const MAX_RESOLVED = 50;     // cap the accumulated "no longer reported" list

// Fuzzy, line-INDEPENDENT fingerprint so a finding still matches after the next
// push shifts its line number. Mirrors mergeFindings' dedup key minus the line:
// file + category + first 80 chars of the normalized description.
function fingerprint(f) {
  const desc = String(f.description || f.desc || '')
    .toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  const cat = String(f.category || '').toLowerCase();
  return `${f.file || ''}|${cat}|${desc}`;
}

// Strip anything that could prematurely close the HTML comment / break a table.
const sanitize = (s) => String(s || '').replace(/\r?\n/g, ' ').replace(/[<>]/g, '').trim();

// Compact record persisted per finding so resolved items can be rendered later
// without keeping the full finding object around.
function toRecord(f) {
  return {
    k: fingerprint(f),
    sev: sanitize(f.severity) || '—',
    file: sanitize(f.file) || '—',
    desc: sanitize(f.description).slice(0, 140),
  };
}

// Pull a prior ledger object out of an existing comment body (null if none/bad).
function parseLedger(body) {
  if (!body) return null;
  const m = body.match(LEDGER_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Compute the next ledger state from the prior one + this review's findings.
// reviewMeta: { time, sha, model, inK, outK, cost, count }
function nextLedger(prev, findings, reviewMeta) {
  const prior = prev && typeof prev === 'object' ? prev : {};
  const priorReviews = Array.isArray(prior.reviews) ? prior.reviews : [];
  const priorLast = Array.isArray(prior.last) ? prior.last : [];
  const priorResolved = Array.isArray(prior.resolved) ? prior.resolved : [];

  const current = findings.map(toRecord);
  const currentKeys = new Set(current.map((r) => r.k));

  // Newly resolved = was in the previous review, absent now. Accumulate across
  // runs, but drop anything currently open again (a regression re-opens it).
  const newlyResolved = priorLast.filter((r) => !currentKeys.has(r.k));
  const resolvedMap = new Map();
  for (const r of [...priorResolved, ...newlyResolved]) {
    if (!currentKeys.has(r.k)) resolvedMap.set(r.k, r);
  }
  const resolved = [...resolvedMap.values()].slice(-MAX_RESOLVED);

  // Cumulative is tracked explicitly so capping the displayed rows never loses
  // historical cost. Fall back to summing rows only when migrating an old
  // comment that predates the ledger (no `cumulative` yet).
  const priorCount = prior.cumulative?.reviews ?? priorReviews.length;
  const priorCost = prior.cumulative?.cost ?? priorReviews.reduce((s, r) => s + (r.cost || 0), 0);
  const n = priorCount + 1;

  const thisRow = {
    n,
    time: reviewMeta.time,
    sha: String(reviewMeta.sha || '').slice(0, 7),
    model: reviewMeta.model,
    inK: reviewMeta.inK,
    outK: reviewMeta.outK,
    cost: reviewMeta.cost,
    count: reviewMeta.count,
  };
  const reviews = [...priorReviews, thisRow].slice(-MAX_HISTORY_ROWS);
  const cumulative = { reviews: n, cost: priorCost + (reviewMeta.cost || 0) };

  return { v: 1, reviews, cumulative, resolved, last: current };
}

const money = (v) => (typeof v === 'number' ? `$${v.toFixed(v < 0.01 ? 4 : 3)}` : '—');

// Render the human-readable sections appended below the findings table:
// (1) the accumulated "No longer reported" list, (2) a collapsible history table.
function renderSections(state) {
  let md = '';

  if (state.resolved && state.resolved.length) {
    md += `\n\n### ✅ No longer reported (${state.resolved.length})\n`;
    md += '<sub>Findings flagged in an earlier review that the latest review did **not** re-report — '
       + 'i.e. the agent no longer sees them in the diff. Usually a fix; occasionally a scope/diff-window change.</sub>\n\n';
    for (const r of state.resolved) {
      md += `- ~~**[${r.sev}]** \`${r.file}\` — ${r.desc}~~\n`;
    }
  }

  const rows = state.reviews.map((r) =>
    `| #${r.n} | ${r.time || '—'} | \`${r.sha || '—'}\` | ${r.model || '—'} | ${r.count ?? '—'} | ${r.inK ?? '—'}k / ${r.outK ?? '—'}k | ${money(r.cost)} |`
  );
  md += `\n\n<details><summary>📋 <b>Review history</b> — ${state.cumulative.reviews} review(s), ${money(state.cumulative.cost)} total AI cost</summary>\n\n`;
  md += '| # | Time (UTC) | Commit | Model | Findings | Tokens in/out | AI cost |\n';
  md += '|---|---|---|---|---|---|---|\n';
  md += rows.join('\n');
  md += `\n\n**Cumulative:** ${state.cumulative.reviews} review(s) · **${money(state.cumulative.cost)}** total AI cost`;
  md += '\n<sub>AI cost = Anthropic API token cost only; excludes GitHub Actions runner minutes.</sub>\n</details>';
  return md;
}

function serialize(state) {
  return `\n\n<!-- review-ledger: ${JSON.stringify(state)} -->`;
}

// One-call helper for postSummary: parse prior state from the existing comment
// body, fold in this review, and return the markdown block to append (visible
// sections + hidden JSON state).
function buildLedgerBlock(existingBody, findings, reviewMeta) {
  const state = nextLedger(parseLedger(existingBody), findings, reviewMeta);
  return renderSections(state) + serialize(state);
}

module.exports = { fingerprint, parseLedger, nextLedger, buildLedgerBlock };
