'use strict';

// Per-language "common pitfalls" lenses (Step 1 of QUALITY-PLAN.md).
//
// The prompts are already polyglot via static text; this module sharpens review
// quality for our PRIORITY target languages — Swift, Kotlin, Node.js, TypeScript —
// by injecting a focused checklist for ONLY the languages present in a given chunk.
//
// Kept in the shared engine so both the security and quality agents use one source.
// Language-agnostic by design: a file whose extension isn't a target simply adds no
// lens (the generic prompt still applies).

// File extension → target-language key.
const EXT_LANG = {
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'node',
  '.jsx': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
};

// Security-focused pitfalls (used by Agent 1 + Agents 2/3 when includeSecurity).
const SECURITY_LENSES = {
  swift: [
    'Insecure local storage of secrets (UserDefaults/plist instead of Keychain).',
    'Keychain misconfiguration (overly broad accessibility, missing access control).',
    'App Transport Security disabled (NSAllowsArbitraryLoads) or cleartext endpoints.',
    'WKWebView misconfig: JS bridges exposed to untrusted content, allowsArbitraryLoads.',
    'Missing certificate/public-key pinning on sensitive network calls.',
    'Biometric / LocalAuthentication result trusted without a server-side check.',
    'URL-scheme / universal-link handling that trusts attacker-controlled input.',
  ],
  kotlin: [
    'Insecure local storage (plaintext SharedPreferences/SQLite for secrets).',
    'Exported components (activity/service/receiver/provider) without permissions.',
    'Implicit intent / deep-link handling that trusts attacker-controlled extras.',
    'Cleartext traffic allowed (usesCleartextTraffic, missing network-security-config).',
    'WebView misconfig: setJavaScriptEnabled + addJavascriptInterface to untrusted content.',
    'Weak Keystore usage or hardcoded keys; missing cert pinning.',
    'Backend (Spring): unsafe reflection, XXE, deserialization gadgets, security misconfig.',
  ],
  node: [
    'Command/SQL/NoSQL injection from unsanitized req input (child_process, raw queries).',
    'Path traversal in fs operations built from user input.',
    'SSRF via user-controlled URLs in fetch/axios/http.',
    'Secrets in logs or committed env handling; weak/custom crypto instead of node:crypto.',
    'Prototype pollution from merging/parsing untrusted objects.',
    'Unsafe deserialization, eval/Function on user input, vm misuse.',
    'Missing authz checks on routes / IDOR via unchecked resource ids.',
  ],
  typescript: [
    'Type assertions (`as`, `!`) that launder untrusted data past validation.',
    'Trusting parsed JSON shape without runtime validation (zod/io-ts) at trust boundaries.',
    'Same Node.js runtime risks apply: injection, path traversal, SSRF, authz/IDOR.',
  ],
};

// Quality-focused pitfalls (used by Agents 2/3 general-quality lens).
const QUALITY_LENSES = {
  swift: [
    'Force-unwrap (`!`) / `try!` / `as!` that can crash on nil or failure.',
    'Retain cycles in closures — missing `[weak self]` / `[unowned self]`.',
    'UIKit/SwiftUI mutations off the main thread (missing MainActor/DispatchQueue.main).',
    'Blocking work on the main thread; sync calls on hot paths.',
    'Improper Optional handling — implicitly unwrapped optionals, silent `?` swallowing.',
    'Error handling: empty `catch`, discarded `Result`, swallowed thrown errors.',
  ],
  kotlin: [
    'Null-safety holes: `!!`, platform types from Java treated as non-null.',
    'Coroutine/scope leaks: launching on GlobalScope, missing structured concurrency/cancellation.',
    '`lateinit` accessed before init; uninitialized state bugs.',
    'Lifecycle leaks: holding Context/View/Activity references, un-cancelled jobs.',
    'Blocking calls on Dispatchers.Main; missing withContext(IO) for IO.',
    'Swallowed exceptions, empty catch, ignored Result/Either.',
  ],
  node: [
    'Unhandled promise rejections / missing await (floating promises).',
    '`await` inside loops where Promise.all would parallelize.',
    'Blocking the event loop (sync fs/crypto, heavy CPU on the main path).',
    'Error handling: swallowed catches, missing failure paths, callback error not checked.',
    'Resource leaks: unclosed streams/handles/connections.',
    'Mutating shared state across async boundaries (race conditions).',
  ],
  typescript: [
    '`any` escapes and unsafe casts (`as`, non-null `!`) that defeat the type system.',
    'Missing exhaustiveness checks on unions/enums (no `never` default).',
    'Incorrect async typing: unhandled Promise, `Promise<void>` misuse, missing await.',
    'Overly loose types at module boundaries; implicit `any` from untyped imports.',
    'Same Node.js runtime concerns apply for server-side code.',
  ],
};

// Detect which target languages appear anywhere in the chunk payload by scanning
// for file paths with known extensions (diff headers + FULL FILE/CONTEXT headers).
function detectLanguages(payload) {
  const langs = new Set();
  const pathRe = /(?:\bb\/|FILE[^:]*:\s*|---\s+a\/|\+\+\+\s+b\/)?([^\s`'"]+?)(\.[a-z]+)\b/gi;
  let m;
  while ((m = pathRe.exec(payload)) !== null) {
    const lang = EXT_LANG[m[2].toLowerCase()];
    if (lang) langs.add(lang);
  }
  // TypeScript code runs on Node — include Node pitfalls alongside TS ones.
  if (langs.has('typescript')) langs.add('node');
  return langs;
}

function renderLens(langs, lenses, heading) {
  const present = [...langs].filter((l) => lenses[l]);
  if (present.length === 0) return '';
  const blocks = present.map((l) => {
    const title = l === 'typescript' ? 'TypeScript' : l === 'node' ? 'Node.js' : l[0].toUpperCase() + l.slice(1);
    return `${title}:\n` + lenses[l].map((p) => `- ${p}`).join('\n');
  });
  return `\n\n${heading}\n${blocks.join('\n\n')}`;
}

// Build the security pitfalls block for the languages present (or '' if none).
function securityLens(payload) {
  return renderLens(
    detectLanguages(payload),
    SECURITY_LENSES,
    'Pay special attention to these high-signal pitfalls for the language(s) in this changeset:'
  );
}

// Build the quality pitfalls block for the languages present (or '' if none).
function qualityLens(payload) {
  return renderLens(
    detectLanguages(payload),
    QUALITY_LENSES,
    'Pay special attention to these common quality pitfalls for the language(s) in this changeset:'
  );
}

module.exports = {
  detectLanguages,
  securityLens,
  qualityLens,
  EXT_LANG,
  SECURITY_LENSES,
  QUALITY_LENSES,
};
