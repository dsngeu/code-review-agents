'use strict';

const path = require('node:path');

// Language-aware resolution of cross-file context candidates (Step 2 of QUALITY-PLAN.md).
//
// Pure functions: given a CHANGED file's path + content and the target repo's full
// list of file paths (from the git trees API), return candidate UNCHANGED file paths
// worth pulling in for data-flow context.
//
// IMPORTANT: there is NO local checkout of the target repo on the runner — files are
// fetched over the GitHub contents API. So we cannot grep a working tree; instead we
// match references against `treePaths` (the repo's real file list). External / stdlib
// references are filtered for free: they have no matching file in the repo tree.

function extOf(p) {
  const m = p.match(/\.[A-Za-z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}

// ── JS / TypeScript ───────────────────────────────────────────────────────────
// Relative import/require/export specifiers → resolved repo path(s).
const JS_IMPORT_RE =
  /(?:import\s+(?:[^'"]+\s+from\s+)?|require\(\s*|export\s+[^'"]+\s+from\s+)['"]([^'"]+)['"]/g;
const JS_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

function resolveJsTs(file, content, treePaths) {
  const dir = path.posix.dirname(file);
  const out = [];
  let m;
  JS_IMPORT_RE.lastIndex = 0;
  while ((m = JS_IMPORT_RE.exec(content)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // only first-party relative imports
    const base = path.posix.normalize(path.posix.join(dir, spec));
    if (treePaths) {
      // Pick the first candidate that actually exists in the repo tree.
      const hit = JS_EXTS.map((e) => base + e).find((c) => treePaths.has(c));
      if (hit) out.push(hit);
    } else {
      // No tree available → emit guesses; the fetch step tries each (best-effort).
      for (const e of JS_EXTS) out.push(base + e);
    }
  }
  return out;
}

// ── Kotlin / Java (JVM) ───────────────────────────────────────────────────────
// `import a.b.C` → a repo file path ending in `a/b/C.kt` or `a/b/C.java`.
// Wildcard imports (`import a.b.*`) can't resolve to a single file → skipped.
const JVM_IMPORT_RE = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*)/gm;

function resolveJvm(content, treePaths) {
  if (!treePaths) return [];
  const out = [];
  let m;
  JVM_IMPORT_RE.lastIndex = 0;
  while ((m = JVM_IMPORT_RE.exec(content)) !== null) {
    const fqn = m[1];
    if (fqn.endsWith('.*')) continue;
    const suffix = '/' + fqn.replace(/\./g, '/');
    for (const ext of ['.kt', '.java']) {
      const target = suffix + ext;
      // External imports (kotlin.*, java.*, androidx.*, libraries) won't match any repo path.
      for (const p of treePaths) {
        if (p.endsWith(target)) { out.push(p); break; }
      }
    }
  }
  return out;
}

// ── Swift ─────────────────────────────────────────────────────────────────────
// Swift has no file-path imports (modules only). Heuristic: collect referenced
// first-party type names and match a repo file `**/<Type>.swift`. Framework types
// (UIView, URLSession, …) are filtered automatically — the repo defines no file for them.
const SWIFT_TYPE_RE = /\b([A-Z][A-Za-z0-9_]+)\b/g;
// Common Swift/Apple-framework identifiers that often appear capitalized but are not
// first-party files — cheap pre-filter to cut tree scans (tree match is the real filter).
const SWIFT_COMMON = new Set([
  'Foundation', 'UIKit', 'SwiftUI', 'Combine', 'String', 'Int', 'Double', 'Bool', 'Data',
  'Date', 'URL', 'URLSession', 'URLRequest', 'Array', 'Dictionary', 'Set', 'Optional',
  'Result', 'Error', 'Void', 'Any', 'Self', 'Codable', 'Decodable', 'Encodable', 'View',
  'Text', 'Color', 'Image', 'Task', 'MainActor', 'JSONDecoder', 'JSONEncoder', 'JSONSerialization',
  'UserDefaults', 'Bundle', 'Notification', 'DispatchQueue', 'NSObject', 'CGFloat', 'CGRect',
]);

function resolveSwift(content, treePaths) {
  if (!treePaths) return [];
  const names = new Set();
  let m;
  SWIFT_TYPE_RE.lastIndex = 0;
  while ((m = SWIFT_TYPE_RE.exec(content)) !== null) {
    const name = m[1];
    if (!SWIFT_COMMON.has(name)) names.add(name);
  }
  const out = [];
  for (const name of names) {
    const target = '/' + name + '.swift';
    for (const p of treePaths) {
      if (p.endsWith(target) || p === name + '.swift') { out.push(p); break; }
    }
  }
  return out;
}

// Dispatch a single changed file to the right resolver by extension.
// Returns candidate UNCHANGED context paths (may contain duplicates / changed files;
// the caller dedupes, skips, and caps).
function resolveContextCandidates(file, content, treePaths) {
  const ext = extOf(file);
  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mjs': case '.cjs':
      return resolveJsTs(file, content, treePaths);
    case '.kt': case '.kts': case '.java':
      return resolveJvm(content, treePaths);
    case '.swift':
      return resolveSwift(content, treePaths);
    default:
      return [];
  }
}

module.exports = {
  resolveContextCandidates,
  resolveJsTs,
  resolveJvm,
  resolveSwift,
};
