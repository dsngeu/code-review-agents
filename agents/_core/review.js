'use strict';

const cfg = require('./config');
const gh = require('./github');
const pl = require('./payload');
const { callClaude, verifyFindings } = require('./claude');

// ── Findings helpers ──────────────────────────────────────────────────────────

function mergeFindings(findingArrays) {
  const flat = findingArrays.flat();
  const seen = new Set();
  const deduped = [];
  for (const f of flat) {
    const key = `${f.file}:${f.line}:${(f.description || '').toLowerCase().slice(0, 80)}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(f); }
  }
  deduped.sort((a, b) => cfg.severityRank(a.severity) - cfg.severityRank(b.severity));
  return deduped;
}

function severityCounts(findings) {
  const counts = {};
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return cfg.SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
}

const remediationOf = (f) => f.fix || f.suggestion || '';
const hasCategory = (findings) => findings.some((f) => f.category);

// Make a value safe for a markdown table cell: escape pipes, flatten newlines.
const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';

function findingsTable(findings) {
  const withCat = hasCategory(findings);
  const header = withCat
    ? '| Severity | Category | Confidence | File | Line | Description |\n|---|---|---|---|---|---|'
    : '| Severity | Confidence | File | Line | Description |\n|---|---|---|---|---|';
  const rows = findings.map((f) =>
    withCat
      ? `| ${cell(f.severity)} | ${cell(f.category)} | ${cell(f.confidence)} | \`${cell(f.file)}\` | ${f.line ?? '—'} | ${cell(f.description)} |`
      : `| ${cell(f.severity)} | ${cell(f.confidence)} | \`${cell(f.file)}\` | ${f.line ?? '—'} | ${cell(f.description)} |`
  );
  return [header, ...rows].join('\n');
}

function skippedNote(skipped) {
  if (!skipped || skipped.length === 0) return '';
  const names = skipped.slice(0, 20).map((f) => `\`${f.filename}\``).join(', ');
  const more = skipped.length > 20 ? `, …and ${skipped.length - 20} more` : '';
  return `\n\n> ⚠️ **Large diff:** reviewed the ${cfg.MAX_FILES} highest-risk files. ${skipped.length} lower-risk file(s) were not analyzed: ${names}${more}. Raise \`MAX_FILES\` to widen coverage.`;
}

// ── runReview ─────────────────────────────────────────────────────────────────

async function runReview(opts) {
  const {
    agentName,            // e.g. 'Security Review' | 'Code Review'
    mode,                 // 'pr' | 'branch'
    base,                 // branch mode base ref ('' → default branch)
    model,
    marker,               // hidden HTML comment marker for idempotency
    systemPrompt,
    buildUserPrompt,      // (payload) => string
    findingsTool,
    verifySystemPrompt,
    buildVerifyUserPrompt, // (payload, findings) => string
    verificationTool,
    output,               // { checkRun, inlineComments, summaryComment, jobSummary }
  } = opts;

  const [OWNER, REPO] = process.env.TARGET_REPO.split('/');
  const mentions = cfg.buildMentions();

  const PR_NUM = process.env.PR_NUMBER ? parseInt(process.env.PR_NUMBER, 10) : null;
  const HEAD_SHA = process.env.HEAD_SHA || null;

  console.log(`Starting ${agentName} (${mode}) for ${OWNER}/${REPO} on model ${model}`);

  // Check run only makes sense in PR mode (needs a PR head SHA).
  let checkRunId = null;
  if (output.checkRun && mode === 'pr' && HEAD_SHA) {
    checkRunId = await gh.createCheckRun(OWNER, REPO, HEAD_SHA, agentName);
  }

  let resolvedBase = base; // for branch-mode Job Summary header
  try {
    // 1. Resolve diff + changed files + the ref to read full content from.
    let rawDiff, changedFiles, contentRef;
    if (mode === 'branch') {
      const head = process.env.REF;
      resolvedBase = base || (await gh.getDefaultBranch(OWNER, REPO));
      const cmp = await gh.fetchCompare(OWNER, REPO, resolvedBase, head);
      rawDiff = cmp.diff;
      changedFiles = cmp.files;
      contentRef = head;
      console.log(`Comparing ${resolvedBase}...${head}`);
    } else {
      rawDiff = await gh.fetchPRDiff(OWNER, REPO, PR_NUM);
      changedFiles = await gh.fetchPRFiles(OWNER, REPO, PR_NUM);
      contentRef = HEAD_SHA;
    }

    const reviewable = changedFiles.filter((f) => f.status !== 'removed' && !gh.shouldSkipFile(f.filename));

    // 2. Large-diff budget.
    const { selected, skipped } = pl.selectFilesByBudget(reviewable);
    const selectedSet = new Set(selected.map((f) => f.filename));
    const scopedDiff = skipped.length > 0 ? pl.filterDiffToFiles(rawDiff, selectedSet) : rawDiff;

    // 3. Content + context + commentable lines.
    const fileContents = await gh.fetchFileContents(OWNER, REPO, selected, contentRef);
    const contextFiles = await gh.gatherContextFiles(OWNER, REPO, fileContents, contentRef);
    const validLines = gh.parseDiffValidLines(scopedDiff);

    console.log(
      `${reviewable.length} reviewable file(s); analyzing ${selected.length} ` +
      `(${skipped.length} skipped by budget), ${fileContents.size} with full content, ` +
      `${contextFiles.size} context file(s).`
    );

    if (reviewable.length === 0) {
      await emitEmpty(opts, { OWNER, REPO, PR_NUM, checkRunId, agentName, skipped, resolvedBase });
      return;
    }

    // 4. Chunk + parallel review/verify.
    const payload = pl.buildDiffPayload(scopedDiff, fileContents, contextFiles);
    const chunks = pl.chunkPayload(payload);
    console.log(`Sending ${chunks.length} chunk(s), ${cfg.CHUNK_CONCURRENCY} at a time (verify=${cfg.VERIFY}).`);

    // Accumulate token usage across every Claude call (review + verify, all chunks).
    const usageTotal = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const addUsage = (u) => {
      if (!u) return;
      usageTotal.input += u.input_tokens || 0;
      usageTotal.output += u.output_tokens || 0;
      usageTotal.cacheRead += u.cache_read_input_tokens || 0;
      usageTotal.cacheCreation += u.cache_creation_input_tokens || 0;
    };

    // Per-chunk fail-open: a failed chunk returns null (sentinel), not [], so we
    // can distinguish "reviewed, found nothing" from "review failed".
    const results = await pl.mapWithConcurrency(chunks, cfg.CHUNK_CONCURRENCY, async (chunk, i) => {
      console.log(`Processing chunk ${i + 1}/${chunks.length}`);
      try {
        const reviewed = await callClaude({ model, system: systemPrompt, tool: findingsTool, content: buildUserPrompt(chunk), temperature: cfg.REVIEW_TEMPERATURE });
        addUsage(reviewed.usage);
        const verified = await verifyFindings({
          model, system: verifySystemPrompt, tool: verificationTool,
          buildUserPrompt: buildVerifyUserPrompt, payload: chunk, findings: reviewed.findings, verify: cfg.VERIFY,
          highStakesVotes: cfg.VERIFY_HIGH_STAKES_VOTES, temperature: cfg.VERIFY_TEMPERATURE,
        });
        addUsage(verified.usage);
        return verified.findings;
      } catch (err) {
        console.error(`Chunk ${i + 1}/${chunks.length} failed, skipping:`, err.message);
        return null;
      }
    });

    const failedChunks = results.filter((r) => r === null).length;
    // If EVERY chunk failed (e.g. API outage), do NOT report a false all-clear —
    // throw so it goes down the error path (error comment + @mention).
    if (chunks.length > 0 && failedChunks === chunks.length) {
      throw new Error(`All ${chunks.length} review chunk(s) failed — likely an API/auth/outage issue.`);
    }
    // Partial failure: proceed with what we got, but disclose that it's incomplete.
    const partialNote = failedChunks > 0
      ? `\n\n> ⚠️ **Partial review:** ${failedChunks} of ${chunks.length} chunk(s) failed; some files may not have been reviewed.`
      : '';

    const mergedFindings = mergeFindings(results.map((r) => r || []));

    // Confidence gate (Step 4): suppress findings below MIN_CONFIDENCE from posting.
    // Default MIN_CONFIDENCE=LOW keeps everything. Suppression is disclosed, never silent.
    const allFindings = mergedFindings.filter((f) => cfg.confidenceAtLeast(f.confidence, cfg.MIN_CONFIDENCE));
    const suppressed = mergedFindings.length - allFindings.length;
    const confidenceNote = suppressed > 0
      ? `\n\n> ℹ️ ${suppressed} lower-confidence finding(s) hidden (below \`MIN_CONFIDENCE=${cfg.MIN_CONFIDENCE}\`). Lower the threshold to show them.`
      : '';
    console.log(
      `Confirmed ${allFindings.length} finding(s)` +
      (suppressed ? `, ${suppressed} hidden by confidence gate` : '') +
      `.${failedChunks ? ` (${failedChunks} chunk(s) failed)` : ''}`
    );

    // Cost / usage line.
    const cost = cfg.estimateCost(model, usageTotal);
    const inK = (usageTotal.input / 1000).toFixed(1);
    const outK = (usageTotal.output / 1000).toFixed(1);
    const costStr = cost != null ? ` · est. $${cost.toFixed(2)}` : '';
    const usageLine = `Reviewed with \`${model}\` · ${inK}k in / ${outK}k out${costStr}`;
    console.log(usageLine);
    const footer = partialNote + confidenceNote + `\n\n<sub>${usageLine}</sub>`;

    // 5. Emit through configured channels (read + comment only; no deletion).
    if (output.inlineComments) {
      await postInline(OWNER, REPO, PR_NUM, HEAD_SHA, allFindings, validLines, marker);
    }
    if (output.summaryComment) {
      await postSummary(OWNER, REPO, PR_NUM, allFindings, skipped, mentions, marker, agentName, footer);
    }
    if (output.jobSummary) {
      gh.writeJobSummary(buildJobSummary(agentName, allFindings, skipped, mentions, resolvedBase, process.env.REF, footer));
    }

    let summaryText = allFindings.length === 0
      ? 'No issues found.'
      : `Found ${allFindings.length} finding(s) (${severityCounts(allFindings)}).` +
        (skipped.length ? ` ${skipped.length} file(s) skipped by budget.` : '');
    if (failedChunks) summaryText += ` ${failedChunks}/${chunks.length} chunk(s) failed — partial review.`;
    summaryText += ` · ${usageLine.replace(/`/g, '')}`;
    if (checkRunId) await gh.updateCheckRun(OWNER, REPO, checkRunId, agentName, 'neutral', summaryText);

    console.log(`${agentName} completed.`);
  } catch (err) {
    console.error(`${agentName} error:`, err);
    try {
      await emitError(opts, { OWNER, REPO, PR_NUM, checkRunId, agentName, mentions, marker, err });
    } catch (notifyErr) {
      console.error('Failed to post error notification:', notifyErr.message);
    }
    process.exit(1);
  }
}

// ── Emit helpers ──────────────────────────────────────────────────────────────

async function postInline(owner, repo, prNum, sha, findings, validLines, marker) {
  // Idempotency WITHOUT deletion: collect {path:line} we've already commented on
  // under THIS agent's marker, so re-runs (every PR push) don't duplicate inline
  // comments. Keyed per-marker so different agents don't dedup against each other.
  const existing = await gh.fetchReviewComments(owner, repo, prNum);
  const alreadyPosted = new Set(
    existing
      .filter((c) => c.body && c.body.includes(marker))
      .map((c) => `${c.path}:${c.line ?? c.original_line}`)
  );

  const inlineable = findings
    .filter((f) => f.file && f.line != null)
    .filter((f) => cfg.severityAtLeast(f.severity, cfg.INLINE_MIN_SEVERITY))
    .filter((f) => validLines.get(f.file)?.has(f.line))
    .filter((f) => !alreadyPosted.has(`${f.file}:${f.line}`))
    .slice(0, cfg.MAX_INLINE_COMMENTS);
  if (inlineable.length === 0) {
    console.log(alreadyPosted.size > 0
      ? 'No new inline-eligible findings (existing inline comments left in place).'
      : 'No inline-eligible findings.');
    return;
  }
  const comments = inlineable.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: `${marker}\n**[${f.severity}${f.category ? ' · ' + f.category : ''}]** ${f.description}\n\n**Fix:** ${remediationOf(f)}`,
  }));
  try {
    await gh.postReview(owner, repo, prNum, sha, comments);
  } catch (err) {
    console.error('Batch review failed, falling back to individual comments:', err.message);
    for (const c of comments) {
      try { await gh.postSingleReviewComment(owner, repo, prNum, sha, c); }
      catch (e) { console.error(`  skipped ${c.path}:${c.line} — ${e.message}`); }
    }
  }
}

async function postSummary(owner, repo, prNum, findings, skipped, mentions, marker, agentName, footer = '') {
  const hasCriticalOrHigh = findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  let body;
  if (findings.length === 0) {
    body = `${marker}\n## ${agentName}\n\n✅ No issues found.`;
  } else {
    body = `${marker}\n## ${agentName}\n\nFound **${findings.length}** issue${findings.length === 1 ? '' : 's'} (${severityCounts(findings)}).\n\n${findingsTable(findings)}`;
    if (hasCriticalOrHigh && mentions) body += `\n\n${mentions} — HIGH/CRITICAL findings require attention.`;
  }
  body += skippedNote(skipped) + footer;
  await gh.upsertIssueComment(owner, repo, prNum, marker, body);
}

function buildJobSummary(agentName, findings, skipped, mentions, base, ref, footer = '') {
  let md = `## ${agentName}\n\n**Branch:** \`${ref || '?'}\`  •  **Base:** \`${base || 'default'}\`\n\n`;
  if (findings.length === 0) {
    md += '✅ No issues found.';
  } else {
    md += `Found **${findings.length}** issue${findings.length === 1 ? '' : 's'} (${severityCounts(findings)}).\n\n${findingsTable(findings)}`;
  }
  md += skippedNote(skipped) + footer;
  return md;
}

async function emitEmpty(opts, ctx) {
  const { OWNER, REPO, PR_NUM, checkRunId, agentName, skipped, resolvedBase } = ctx;
  const mentions = cfg.buildMentions();
  if (opts.output.summaryComment) {
    await postSummary(OWNER, REPO, PR_NUM, [], skipped, mentions, opts.marker, agentName);
  }
  if (opts.output.jobSummary) {
    gh.writeJobSummary(buildJobSummary(agentName, [], skipped, mentions, resolvedBase ?? opts.base, process.env.REF));
  }
  if (checkRunId) await gh.updateCheckRun(OWNER, REPO, checkRunId, agentName, 'neutral', 'No reviewable files changed.');
  console.log(`${agentName}: no reviewable files.`);
}

async function emitError(opts, ctx) {
  const { OWNER, REPO, PR_NUM, checkRunId, agentName, mentions, marker, err } = ctx;
  const msg = `**Error:** ${err.message}`;
  if (opts.output.summaryComment && PR_NUM) {
    const body = `${marker}\n## ${agentName} — Error\n\nThe agent could not complete.\n\n${msg}\n\n${mentions} — please re-run or review manually.`;
    await gh.upsertIssueComment(OWNER, REPO, PR_NUM, marker, body); // update-in-place, no spam on repeated failures
  }
  if (opts.output.jobSummary) {
    gh.writeJobSummary(`## ${agentName} — Error\n\nThe agent could not complete.\n\n${msg}`);
  }
  if (checkRunId) await gh.updateCheckRun(OWNER, REPO, checkRunId, agentName, 'neutral', `Agent error: ${err.message}`);
}

module.exports = { runReview };
