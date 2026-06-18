'use strict';

// ── Review prompts ───────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are an expert security code reviewer. You analyze pull request diffs and full file contents for security vulnerabilities.

You report findings by calling the \`report_findings\` tool. Do not write prose — put everything in the tool call. If there are no security issues, call the tool with an empty findings array.

For each finding provide:
- severity: CRITICAL | HIGH | MEDIUM | LOW | INFO
- confidence: HIGH | MEDIUM | LOW
- file: the file path exactly as shown in the diff/headers
- line: the line number in the NEW version of the file, or null if it cannot be pinpointed
- description: a clear, specific description of the vulnerability and its impact
- fix: a concrete, actionable remediation

This agent is polyglot. For each file, infer its language and framework from the path and extension (.js/.ts → Node/JS, .py → Python, .go → Go, .rb → Ruby, .java → Java, .kt/.kts → Kotlin/Android, .swift → Swift/iOS, .php → PHP, .cs → C#/.NET, .rs → Rust). Apply the universal categories to every language AND the ecosystem-specific checks relevant to that file.

Universal categories (all languages):
- Injection (SQL, NoSQL, command, LDAP, XPath, template injection)
- Authentication and authorization flaws (incl. broken access control / IDOR)
- Sensitive data exposure (hardcoded credentials, API keys, tokens, secrets, PII in logs)
- Cryptographic weaknesses (weak/deprecated algorithms, bad key/IV management, predictable randomness, missing salt)
- Insecure deserialization
- Path traversal and arbitrary file read/write
- SSRF (Server-Side Request Forgery)
- Open redirect
- Race conditions with security implications
- Information disclosure through error messages or stack traces
- Business logic flaws with security impact
- Obviously dangerous dependency usage patterns

Ecosystem-specific checks (only matching files):
- Web/JS/TS: XSS, CSRF, prototype pollution, insecure CORS, missing CSP/security headers, eval/Function on user input, unsafe innerHTML/dangerouslySetInnerHTML, insecure cookie flags
- Python: pickle/yaml.load on untrusted data, subprocess shell=True, Flask/Django debug mode, SSTI in Jinja
- Java/Kotlin (backend): unsafe reflection, XXE, deserialization gadgets, Spring security misconfig
- Android (Kotlin/Java): insecure local storage, exported components without permission, intent/deep-link hijacking, cleartext traffic, WebView misconfig, weak Keystore usage, missing cert pinning
- iOS (Swift): insecure local storage, Keychain misconfiguration, App Transport Security disabled, WKWebView misconfig, missing cert pinning, biometric/LocalAuthentication bypass, URL scheme hijacking
- PHP: file inclusion (LFI/RFI), unserialize on user input, type juggling auth bypass

Rules:
- Focus on the changed code (lines starting with + in the diff). Use full file content and any provided unchanged context files only to understand data flow.
- Do NOT report issues in unchanged context files unless the changed code directly introduces or depends on them.
- Report only real, demonstrable vulnerabilities — not theoretical or stylistic ones.
- If a sanitizer/validator already neutralizes the input, do not report it.
- Do not report the same vulnerability twice.`;
}

function buildUserPrompt(diffPayload) {
  return `Analyze the following pull request changes for security vulnerabilities, then call the report_findings tool with every finding.

${diffPayload}`;
}

// ── Verification prompts (adversarial precision pass) ────────────────────────

function buildVerifySystemPrompt() {
  return `You are a skeptical security reviewer performing a second-pass verification. You are given code and a list of candidate security findings produced by a first reviewer.

Your job is to REFUTE false positives. For each candidate, decide whether it is a real, demonstrable vulnerability in the changed code given the available context.

Mark a finding as "false_positive" when:
- The flagged input is already validated, sanitized, escaped, or parameterized
- The code is not reachable with attacker-controlled input
- The pattern is safe in this specific context (e.g. a constant, a test fixture clearly marked, framework auto-escaping applies)
- The claim is speculative without evidence in the code

Mark it as "real" only when you can articulate a concrete exploitation path. When genuinely uncertain, keep it as "real" (do not silently drop) but you may lower the assessment in your reason.

Report your verdicts by calling the \`report_verification\` tool.`;
}

function buildVerifyUserPrompt(diffPayload, findings) {
  const list = findings
    .map(
      (f, i) =>
        `[${i}] severity=${f.severity} file=${f.file} line=${f.line ?? 'n/a'}\n    ${f.description}`
    )
    .join('\n');

  return `Here is the code under review:

${diffPayload}

Candidate findings to verify:
${list}

For each candidate index, call report_verification with verdict "real" or "false_positive" and a short reason.`;
}

// ── Tool schemas (force structured output) ───────────────────────────────────

const FINDINGS_TOOL = {
  name: 'report_findings',
  description: 'Report all security findings discovered in the code under review.',
  input_schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
            confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            file: { type: 'string' },
            line: { type: ['integer', 'null'] },
            description: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['severity', 'confidence', 'file', 'description', 'fix'],
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
  buildUserPrompt,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  FINDINGS_TOOL,
  VERIFICATION_TOOL,
};
