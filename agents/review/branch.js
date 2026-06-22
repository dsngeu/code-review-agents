'use strict';

// Agent 2 — Full branch review (general quality + security). Manually triggered.
// Reviews branch vs base; writes the report to the GitHub Actions Job Summary.

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
  agentName: 'Branch Review',
  mode: 'branch',
  base: process.env.BASE || '', // '' → resolve repo default branch
  // Model for THIS agent. Override via the workflow `model` input.
  // Options: claude-opus-4-8 | claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5 | claude-fable-5
  model: resolveModel('claude-sonnet-4-6'),
  marker: '<!-- branch-review-agent -->',
  systemPrompt: buildSystemPrompt({ includeSecurity: true }),
  buildUserPrompt: makeBuildUserPrompt({ includeSecurity: true }),
  findingsTool: FINDINGS_TOOL,
  verifySystemPrompt: buildVerifySystemPrompt(),
  buildVerifyUserPrompt,
  verificationTool: VERIFICATION_TOOL,
  output: { checkRun: false, inlineComments: false, summaryComment: false, jobSummary: true },
});
