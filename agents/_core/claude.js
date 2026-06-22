'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { MAX_TOKENS, CLAUDE_MAX_RETRIES, isHighStakes } = require('./config');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: CLAUDE_MAX_RETRIES,
});

// Run one review call with forced structured (tool-use) output.
// `tool` is a JSON-schema tool whose input has a `findings` array.
async function callClaude({ model, system, tool, content, temperature }) {
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    ...(temperature !== undefined ? { temperature } : {}),
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'max_tokens') {
    console.warn('⚠️  Claude response hit max_tokens — findings may be truncated for this chunk.');
  }

  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
  const findings = toolUse && Array.isArray(toolUse.input?.findings)
    ? toolUse.input.findings.filter((f) => f && f.severity && f.description)
    : [];
  return { findings, usage: response.usage || null };
}

// One verifier pass → Set of finding indices voted "false_positive" (+ usage).
// When `cache` is set, the (identical) system prompt + diff payload are marked with
// cache_control so repeated multi-vote passes read them at ~0.1x instead of full price.
async function runVerifyPass({ model, system, tool, content, temperature, cache }) {
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    ...(temperature !== undefined ? { temperature } : {}),
    system: cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{
      role: 'user',
      content: cache ? [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] : content,
    }],
  });
  const usage = response.usage || null;
  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
  const refuted = new Set(
    (toolUse && Array.isArray(toolUse.input?.results) ? toolUse.input.results : [])
      .filter((r) => r.verdict === 'false_positive')
      .map((r) => r.index)
  );
  return { refuted, usage, ok: !!(toolUse && Array.isArray(toolUse.input?.results)) };
}

// Adversarial verification: drop findings the verifier refutes. Fail-open on error.
// LOW/MEDIUM findings use a single pass. HIGH/CRITICAL findings can be checked by
// `highStakesVotes` independent passes and are dropped only if a MAJORITY refute —
// a more reliable verdict on the findings that matter most. Default votes=1 → single
// pass for everything (identical cost/behaviour to before).
async function verifyFindings({ model, system, tool, buildUserPrompt, payload, findings, verify, highStakesVotes = 1, temperature }) {
  if (!verify || findings.length === 0) return { findings, usage: null };
  const usageTotal = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usageTotal.input_tokens += u.input_tokens || 0;
    usageTotal.output_tokens += u.output_tokens || 0;
    usageTotal.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageTotal.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };

  const hasHighStakes = findings.some(isHighStakes);
  const totalPasses = hasHighStakes ? Math.max(1, highStakesVotes) : 1;
  const content = buildUserPrompt(payload, findings);
  // Only worth caching when the same payload is sent more than once (multi-vote):
  // pass 1 writes the cache (~1.25x), passes 2..N read it (~0.1x). A single pass
  // would only pay the write with no read, so leave it uncached.
  const cache = totalPasses > 1;

  try {
    // Per-index tally across all passes (for high-stakes majority) + the first
    // completed pass's verdict (for single-pass semantics on the rest).
    const refuteCounts = new Array(findings.length).fill(0);
    let firstRefuted = null;
    let completedPasses = 0;
    for (let p = 0; p < totalPasses; p++) {
      const { refuted, usage, ok } = await runVerifyPass({ model, system, tool, content, temperature, cache });
      addUsage(usage);
      if (!ok) continue; // malformed verdict → ignore this pass (fail-open)
      completedPasses++;
      if (firstRefuted === null) firstRefuted = refuted;
      for (const idx of refuted) if (idx >= 0 && idx < findings.length) refuteCounts[idx]++;
    }
    // If no pass returned a usable verdict, keep everything.
    if (completedPasses === 0) return { findings, usage: usageTotal };

    const kept = findings.filter((f, i) => {
      if (isHighStakes(f) && completedPasses > 1) {
        // Drop only if a strict majority of completed passes refuted it.
        return refuteCounts[i] <= completedPasses / 2;
      }
      // Single-pass semantics (LOW/MEDIUM, or high-stakes with only 1 vote): the
      // first completed pass decides — any refute drops it.
      return !firstRefuted.has(i);
    });
    const removed = findings.length - kept.length;
    if (removed > 0) {
      console.log(`Verifier removed ${removed} false positive(s)` +
        (totalPasses > 1 ? ` (high-stakes majority of ${completedPasses} vote(s)).` : '.'));
    }
    return { findings: kept, usage: usageTotal };
  } catch (err) {
    console.error('Verification pass failed (keeping all findings):', err.message);
    return { findings, usage: usageTotal };
  }
}

module.exports = { callClaude, verifyFindings };
