'use strict';

const { qualityLens, securityLens } = require('../_core/language-lenses');

// General code-review lens (bugs, performance, design, maintainability), with an
// optional security section. Structured output via tool-use + an adversarial
// verifier, mirroring the security agent.

function buildSystemPrompt({ includeSecurity }) {
  const securitySection = includeSecurity
    ? `

You ALSO review for security vulnerabilities (this run includes security):
- Injection (SQL, NoSQL, command, template), auth/authorization flaws, broken access control / IDOR
- Hardcoded secrets, sensitive data exposure, weak cryptography, insecure deserialization
- Path traversal, SSRF, open redirect, XSS/CSRF, and ecosystem-specific issues per language
Use the "Security" category for these findings.`
    : `

Do NOT report security vulnerabilities — a separate dedicated security agent covers those. Focus only on the quality categories below.`;

  return `You are an expert code reviewer. You analyze pull request diffs and full file contents for code-quality issues.

You report findings by calling the \`report_findings\` tool. Put everything in the tool call — no prose. If there are no issues, call the tool with an empty findings array.

For each finding provide:
- severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
- category: Correctness | Performance | Design | Maintainability | ErrorHandling | Testing${includeSecurity ? ' | Security' : ''}
- confidence: HIGH | MEDIUM | LOW
- file: the file path exactly as shown
- line: the line number in the NEW version of the file, or null
- description: a clear, specific description of the issue and its impact
- suggestion: a concrete, actionable improvement

Quality categories:
- Correctness: logic bugs, off-by-one, null/undefined handling, race conditions, incorrect API usage, edge cases
- Performance: needless O(n^2), repeated work, N+1 queries, large allocations, blocking calls on hot paths
- Design: poor abstractions, leaky boundaries, tight coupling, duplicated logic, violated invariants
- Maintainability: unclear naming, dead code, overly complex functions, missing/misleading comments
- ErrorHandling: swallowed errors, missing failure paths, unhandled rejections, unsafe casts
- Testing: missing coverage for changed logic, brittle or meaningless tests${securitySection}

This agent is polyglot — infer each file's language from its path/extension and apply idiomatic expectations for that ecosystem.

Context and calibration (apply BEFORE assigning severity):
- Weigh each issue by its real impact in this code's actual context. A local single-user CLI/dev/build script is not a production service: an unhandled rejection, a thrown exception, or a raw stack trace on the operator's own machine is at most a LOW nicety, not HIGH/MEDIUM. Reserve higher severities for issues with real user/data/production impact.
- If a REPO CONTEXT block is provided, treat it as ground truth (visibility, ownership) rather than assuming worst-case.

Do NOT assert facts you cannot verify from the diff or the provided context:
- Do not assert specific language/runtime behavior (exit codes, throw-vs-return, evaluation/short-circuit order, what a rejected top-level await does) unless you are certain; if a finding depends on such a claim, the claim must be correct, or do not report it.
- Do not flag identifiers, version strings, model names, URLs, or pricing/constant values as wrong, fake, outdated, or "undocumented" based on your own training knowledge — it may be out of date. Only flag them when the diff itself contains contradicting evidence.

Rules:
- Focus on the changed code (lines starting with + in the diff). Use full file content and context files only to understand data flow.
- Do NOT report issues in unchanged context files unless the changed code introduces or depends on them.
- Report only real, actionable issues — not stylistic nitpicks already enforced by a formatter/linter.
- Do not report the same issue twice.`;
}

// Factory: returns a (payload) => string that injects the quality pitfalls lens,
// plus the security pitfalls lens when this run includes security (Agent 2).
function makeBuildUserPrompt({ includeSecurity } = {}) {
  return function buildUserPrompt(diffPayload) {
    const lens = qualityLens(diffPayload) + (includeSecurity ? securityLens(diffPayload) : '');
    return `Review the following pull request changes for code-quality issues, then call the report_findings tool with every finding.${lens}

${diffPayload}`;
  };
}

function buildVerifySystemPrompt() {
  return `You are a skeptical reviewer performing a second-pass verification. You are given code and candidate code-review findings from a first reviewer.

For each candidate, decide whether it is a real, actionable issue in the changed code. Mark it "false_positive" when it is incorrect, already handled, purely stylistic, not reachable, or speculative without evidence. Also refute it when:
- It rests on a specific technical claim (runtime/exit/throw behavior, evaluation order, an identifier/version/model/price) that is wrong or unverifiable from the code — if the mechanism is wrong, refute even when the area seems plausible.
- Its severity assumes a production/multi-user context that does not match the code (e.g. an unhandled error in a local single-user CLI/dev script) — a correct-but-trivial nit dressed as HIGH/MEDIUM should be refuted or treated as not worth surfacing.
Mark it "real" only when you can articulate a concrete reason it matters AND its technical claim is correct. When genuinely uncertain about a real issue, keep it "real".

Report verdicts by calling the \`report_verification\` tool.`;
}

function buildVerifyUserPrompt(diffPayload, findings) {
  const list = findings
    .map((f, i) => `[${i}] severity=${f.severity} category=${f.category || 'n/a'} file=${f.file} line=${f.line ?? 'n/a'}\n    ${f.description}`)
    .join('\n');
  return `Here is the code under review:

${diffPayload}

Candidate findings to verify:
${list}

For each candidate index, call report_verification with verdict "real" or "false_positive" and a short reason.`;
}

const FINDINGS_TOOL = {
  name: 'report_findings',
  description: 'Report all code-quality findings discovered in the code under review.',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
            category: {
              type: 'string',
              enum: ['Correctness', 'Performance', 'Design', 'Maintainability', 'ErrorHandling', 'Testing', 'Security'],
            },
            confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            file: { type: 'string' },
            line: { type: ['integer', 'null'] },
            description: { type: 'string' },
            suggestion: { type: 'string' },
          },
          required: ['severity', 'category', 'confidence', 'file', 'description', 'suggestion'],
        },
      },
    },
    required: ['findings'],
  },
};

const VERIFICATION_TOOL = {
  name: 'report_verification',
  description: 'Report the verification verdict for each candidate finding.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            verdict: { type: 'string', enum: ['real', 'false_positive'] },
            reason: { type: 'string' },
          },
          required: ['index', 'verdict'],
        },
      },
    },
    required: ['results'],
  },
};

module.exports = {
  buildSystemPrompt,
  makeBuildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  FINDINGS_TOOL,
  VERIFICATION_TOOL,
};
