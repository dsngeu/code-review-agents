'use strict';

// Agent 1 — Security review. Auto on every PR. Thin entrypoint over the shared
// engine: security lens, inline + summary comments + check run.

const { runReview } = require('../_core/review');
const { resolveModel } = require('../_core/config');
const {
  buildSystemPrompt,
  buildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  FINDINGS_TOOL,
  VERIFICATION_TOOL,
} = require('./prompt');

runReview({
  agentName: 'Security Review',
  mode: 'pr',
  // Model for THIS agent. Override per repo via the workflow `model` input.
  // Options: claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | claude-fable-5
  model: resolveModel('claude-sonnet-4-6'),
  marker: '<!-- security-review-agent -->',
  systemPrompt: buildSystemPrompt(),
  buildUserPrompt,
  findingsTool: FINDINGS_TOOL,
  verifySystemPrompt: buildVerifySystemPrompt(),
  buildVerifyUserPrompt,
  verificationTool: VERIFICATION_TOOL,
  output: { checkRun: true, inlineComments: true, summaryComment: true, jobSummary: false },
});
