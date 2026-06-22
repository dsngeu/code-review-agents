'use strict';

// Shared configuration + small pure helpers used by every agent.
// Agent-specific choices (name, model default, marker, lens, output channels)
// are passed into runReview() by each entrypoint — not hardcoded here.

// ── Available Claude models (set per agent via the `model` workflow input, or
//    change an agent's default in its entrypoint, or this global fallback) ──────
//   claude-opus-4-8    — most capable; deepest review.   $5 in / $25 out per 1M
//   claude-opus-4-7    — previous-gen Opus.               $5 in / $25 out
//   claude-sonnet-4-6  — strong + cheaper; good default.  $3 in / $15 out
//   claude-haiku-4-5   — fastest/cheapest; shallow.       $1 in / $5  out
//   claude-fable-5     — Anthropic's most capable.        $10 in / $50 out
// Use the exact id strings above (no date suffixes).
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Resolve the Claude model: explicit env (MODEL, from the workflow `model` input)
// wins, then the agent's own default, then the global DEFAULT_MODEL above.
function resolveModel(agentDefault) {
  return process.env.MODEL || agentDefault || DEFAULT_MODEL;
}

// USD per 1M tokens, by model — used to estimate per-review cost.
const MODEL_PRICES = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5': { in: 10, out: 50 },
};

// Estimate cost from accumulated usage. Cache reads bill ~0.1x, writes ~1.25x.
function estimateCost(model, u) {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const inUsd = ((u.input || 0) + (u.cacheRead || 0) * 0.1 + (u.cacheCreation || 0) * 1.25) / 1e6 * p.in;
  const outUsd = (u.output || 0) / 1e6 * p.out;
  return inUsd + outUsd;
}

const MAX_TOKENS = 16000;
const CLAUDE_MAX_RETRIES = 5;
const CHUNK_SIZE_CHARS = 600_000;
const MAX_INLINE_COMMENTS = 50;
const MAX_FILE_CONTENT_BYTES = 100 * 1024; // 100KB
const MAX_CONTEXT_FILES = 20;

// Large-PR budget + parallelism (env-tunable per repo).
const MAX_FILES = parseInt(process.env.MAX_FILES || '80', 10);
const CHUNK_CONCURRENCY = parseInt(process.env.CHUNK_CONCURRENCY || '4', 10);

// Minimum severity for an inline comment (everything still appears in the summary).
const INLINE_MIN_SEVERITY = (process.env.INLINE_MIN_SEVERITY || 'LOW').toUpperCase();
// Adversarial verification pass on by default; set VERIFY=false to disable.
const VERIFY = process.env.VERIFY !== 'false';

// Precision tuning (Step 4 — all default to current behavior; opt-in to tighten).
// Minimum confidence for a finding to be POSTED. Default LOW = post everything.
// Raise to MEDIUM/HIGH to suppress speculative low-confidence findings.
const MIN_CONFIDENCE = (process.env.MIN_CONFIDENCE || 'LOW').toUpperCase();
// Independent verifier passes for HIGH/CRITICAL findings; a finding is dropped only
// if a MAJORITY of votes refute it. Default 1 = today's single pass (no extra cost).
const VERIFY_HIGH_STAKES_VOTES = Math.max(1, parseInt(process.env.VERIFY_HIGH_STAKES_VOTES || '1', 10));

// Optional temperatures (unset = use the model default, = current behavior).
// Lower REVIEW_TEMPERATURE → more reproducible reviews. VERIFY_TEMPERATURE should
// stay > 0 so multi-vote verification passes stay genuinely independent.
const parseTemp = (v) => (v === undefined || v === '' ? undefined : parseFloat(v));
const REVIEW_TEMPERATURE = parseTemp(process.env.REVIEW_TEMPERATURE);
const VERIFY_TEMPERATURE = parseTemp(process.env.VERIFY_TEMPERATURE);

// Hardcoded fallback reviewers when NOTIFY_USERS is not supplied.
// ⚠️ Replace with your actual reviewer usernames.
const ALWAYS_NOTIFY = ['dsngeu'];

// Build the @-mention string: PR author (dynamic) + a fixed reviewer set,
// deduped case-insensitively. NOTIFY_USERS overrides the hardcoded list.
function buildMentions() {
  const raw = [
    process.env.PR_AUTHOR || '',
    ...(process.env.NOTIFY_USERS ? process.env.NOTIFY_USERS.split(',') : ALWAYS_NOTIFY),
  ];
  const seen = new Set();
  const users = [];
  for (const u of raw) {
    const name = u.trim().replace(/^@/, '');
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      users.push(`@${name}`);
    }
  }
  return users.join(' ');
}

// Universal dependency/build/binary exclusion — applies to every stack, not just JS.
// Only obvious dependency and build artifacts are skipped; first-party source
// (including a top-level `modules/` of custom native code) is always reviewed.
const SKIP_PATTERNS = [
  // lockfiles
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|Podfile\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$/,
  /\.lock$/,
  // JS / web
  /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|\.turbo)\//,
  /\.min\.(js|css)$/,
  // iOS / CocoaPods / Carthage / Xcode
  /(^|\/)(Pods|Carthage|DerivedData)\//,
  /\.(xcworkspace|xcodeproj)\//,
  // Android / Gradle
  /(^|\/)\.gradle\//,
  /(^|\/)\.cxx\//,
  // Swift PM / Rust / Go / .NET
  /(^|\/)\.build\//,
  /(^|\/)target\/(debug|release)\//,
  /(^|\/)vendor\//,
  /(^|\/)(bin|obj)\//,
  // Python
  /(^|\/)(\.venv|venv|__pycache__)\//,
  /\.egg-info(\/|$)/,
  // misc build/tooling
  /(^|\/)(\.expo|\.idea|\.vscode|patches)\//,
  // binaries / media / fonts
  /\.(png|jpg|jpeg|gif|svg|ico|webp|pdf|zip|tar|gz|tgz|wasm|bin|exe|dll|so|dylib|a|o|class|jar|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|mkv|psd|sketch)$/i,
];

// Risk heuristics for prioritizing files when a PR exceeds the budget.
// Language-agnostic: we deprioritize known docs/config/data; everything else —
// any programming language, known or not — is treated as code and kept.
const RISK_KEYWORDS = /(auth|login|signin|password|passwd|secret|cred|token|crypto|cipher|hash|sql|query|exec|spawn|eval|admin|payment|billing|checkout|session|cookie|oauth|jwt|upload|download|redirect|cors|api[_-]?key|webhook|deserialize|pickle|unserialize)/i;
const NONCODE_EXT = /\.(md|markdown|txt|rst|adoc|json|ya?ml|toml|ini|cfg|conf|properties|xml|csv|tsv|lock|svg|map|snap|po|mo|html?|css|scss|less)$/i;

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const severityRank = (s) => {
  const i = SEVERITY_ORDER.indexOf((s || '').toUpperCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
};
const severityAtLeast = (s, min) => severityRank(s) <= severityRank(min);

// Confidence ordering mirrors severity: lower rank = stronger. A missing/unknown
// confidence is treated as LOW (the weakest VALID level) — so it still passes the
// default MIN_CONFIDENCE=LOW gate and is never silently dropped by default.
const CONFIDENCE_ORDER = ['HIGH', 'MEDIUM', 'LOW'];
const confidenceRank = (c) => {
  const i = CONFIDENCE_ORDER.indexOf((c || '').toUpperCase());
  return i === -1 ? CONFIDENCE_ORDER.length - 1 : i; // unknown → LOW
};
const confidenceAtLeast = (c, min) => confidenceRank(c) <= confidenceRank(min);

// Is this a high-stakes finding (gets multi-vote verification)?
const isHighStakes = (f) => f && (String(f.severity).toUpperCase() === 'CRITICAL' || String(f.severity).toUpperCase() === 'HIGH');

module.exports = {
  DEFAULT_MODEL,
  resolveModel,
  MODEL_PRICES,
  estimateCost,
  MAX_TOKENS,
  CLAUDE_MAX_RETRIES,
  CHUNK_SIZE_CHARS,
  MAX_INLINE_COMMENTS,
  MAX_FILE_CONTENT_BYTES,
  MAX_CONTEXT_FILES,
  MAX_FILES,
  CHUNK_CONCURRENCY,
  INLINE_MIN_SEVERITY,
  VERIFY,
  MIN_CONFIDENCE,
  VERIFY_HIGH_STAKES_VOTES,
  REVIEW_TEMPERATURE,
  VERIFY_TEMPERATURE,
  buildMentions,
  SKIP_PATTERNS,
  RISK_KEYWORDS,
  NONCODE_EXT,
  SEVERITY_ORDER,
  severityRank,
  severityAtLeast,
  CONFIDENCE_ORDER,
  confidenceRank,
  confidenceAtLeast,
  isHighStakes,
};
