'use strict';

// Agent 3 — Automatic PR code review (quality only, no security). Toggle-gated by
// the caller workflow. Posts a single summary comment (no inline) + check run.

const { runReview } = require('../_core/review');
const { resolveModel } = require('../_core/config');
const {
  buildSystemPrompt,
  makeBuildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  FINDINGS_TOOL,
  VERIFICATION_TOOL,
} = require('./prompt');

runReview({
  agentName: 'Code Review',
  mode: 'pr',
  // Model for THIS agent (high-frequency → cheaper default). Override via the workflow `model` input.
  // Options: claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | claude-fable-5
  model: resolveModel('claude-sonnet-4-6'),
  marker: '<!-- code-review-agent -->',
  systemPrompt: buildSystemPrompt({ includeSecurity: false }),
  buildUserPrompt: makeBuildUserPrompt({ includeSecurity: false }),
  findingsTool: FINDINGS_TOOL,
  verifySystemPrompt: buildVerifySystemPrompt(),
  buildVerifyUserPrompt,
  verificationTool: VERIFICATION_TOOL,
  output: { checkRun: true, inlineComments: false, summaryComment: true, jobSummary: false },
});
