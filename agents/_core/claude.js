'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { MAX_TOKENS, CLAUDE_MAX_RETRIES } = require('./config');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: CLAUDE_MAX_RETRIES,
});

// Run one review call with forced structured (tool-use) output.
// `tool` is a JSON-schema tool whose input has a `findings` array.
async function callClaude({ model, system, tool, content }) {
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
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

// Adversarial second pass: drop findings the verifier refutes. Fail-open on error.
async function verifyFindings({ model, system, tool, buildUserPrompt, payload, findings, verify }) {
  if (!verify || findings.length === 0) return { findings, usage: null };
  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: buildUserPrompt(payload, findings) }],
    });
    const usage = response.usage || null;
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!toolUse || !Array.isArray(toolUse.input?.results)) return { findings, usage };

    const refuted = new Set(
      toolUse.input.results.filter((r) => r.verdict === 'false_positive').map((r) => r.index)
    );
    const kept = findings.filter((_, i) => !refuted.has(i));
    if (refuted.size > 0) console.log(`Verifier removed ${refuted.size} false positive(s).`);
    return { findings: kept, usage };
  } catch (err) {
    console.error('Verification pass failed (keeping all findings):', err.message);
    return { findings, usage: null };
  }
}

module.exports = { callClaude, verifyFindings };
