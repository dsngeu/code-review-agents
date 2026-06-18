---
name: code-review
description: Review the current git branch (or a specified diff/PR) the way this platform's agents do — security + general-quality lenses, severity/confidence/category schema, large-diff budgeting, and an adversarial false-positive pass. Use when asked to review local changes, a branch, or a diff before pushing.
---

# Code Review

Run a review locally that mirrors the agents in this repo (`agents/_core` + `agents/security`, `agents/review`). This is the same lens and schema the GitHub workflows apply — just driven from the working tree instead of a PR. **Advisory only, read-only: never modify code, only report findings.**

## 1. Resolve the scope

Default scope is the current branch vs. its base.

- Branch vs base: `git merge-base HEAD <base>` then `git diff <merge-base>...HEAD` (base defaults to `main`/`master` — detect with `git symbolic-ref refs/remotes/origin/HEAD` or fall back to `main`).
- Uncommitted work: `git diff HEAD` (and `git diff --staged`).
- A specific PR: `gh pr diff <num>` and `gh pr view <num> --json files`.
- **Full codebase** (no diff — review the whole tree as it stands): enumerate first-party source with `git ls-files`, apply the same `SKIP_PATTERNS` exclusions and large-repo risk budget as below, and review entire files rather than just `+` lines. Use this when the user asks to review "the codebase"/"the whole project" rather than a change.

Ask the user which scope only if it's ambiguous; otherwise default to branch-vs-base.

**Clean-tree fallback:** if branch == base *and* the working tree is clean (every diff-based scope is empty), do **not** silently report "No issues found." — that just means there's no diff, not that the code is clean. Ask whether they want a full-codebase review or a different scope.

## 2. Filter and budget (match the engine)

- **Skip dependency/build/binary artifacts** using the same `SKIP_PATTERNS` as `agents/_core/config.js` (illustrative subset — `config.js` is authoritative): lockfiles, `node_modules`, `dist`/`build`/`out`/`.next`, `Pods`/`DerivedData`/Carthage, `.gradle`/`.cxx`, `target/{debug,release}`, `vendor`, `bin`/`obj`, `.venv`/`__pycache__`/`*.egg-info`, minified bundles, and binary/media/font extensions. Never skip first-party source.
- **Removed files** (`status === 'removed'`) are out of scope.
- **Large diffs:** if more than ~80 files remain, risk-rank and review the highest-risk first. Risk = touches security-sensitive tokens (`auth|login|password|secret|token|crypto|sql|exec|eval|admin|payment|session|jwt|upload|redirect|cors|deserialize|…`) and is *not* a docs/config/data file (`.md/.json/.yaml/.toml/.xml/.csv/.html/.css/…`). Note explicitly which files you did not review.

## 3. Review — two lenses

For a **diff** scope, focus on **changed lines** (the `+` side); use surrounding/full-file content only to trace data flow, and don't flag issues in unchanged code unless the change introduces or depends on them. For a **full-codebase** scope there is no `+` side — review each file in full. Infer each file's language from its extension and apply idiomatic expectations — stay polyglot, don't assume Node.

**Security lens** (always): injection (SQL/NoSQL/command/template), auth & access-control / IDOR, hardcoded secrets / data exposure, weak crypto, insecure deserialization, path traversal, SSRF, open redirect, XSS/CSRF, plus ecosystem-specific checks (Python `pickle`/`shell=True`, Java XXE/reflection, Android exported components/WebView, iOS Keychain/ATS, PHP LFI/unserialize, web prototype pollution/CORS/`dangerouslySetInnerHTML`).

**Quality lens** (always, category-tagged):
- **Correctness** — logic bugs, off-by-one, null/undefined, races, wrong API usage, missed edge cases
- **Performance** — needless O(n²), repeated work, N+1, blocking calls on hot paths
- **Design** — leaky boundaries, tight coupling, duplicated logic, violated invariants
- **Maintainability** — unclear naming, dead code, over-complex functions
- **ErrorHandling** — swallowed errors, missing failure paths, unhandled rejections, unsafe casts
- **Testing** — missing coverage for changed logic, brittle tests

## 4. Each finding carries

- `severity`: CRITICAL | HIGH | MEDIUM | LOW | INFO
- `category`: Security | Correctness | Performance | Design | Maintainability | ErrorHandling | Testing
- `confidence`: HIGH | MEDIUM | LOW
- `file` + `line` (line in the new version, or omit if not pinpointable)
- `description`: specific issue + concrete impact
- `fix`/`suggestion`: actionable remediation

Report only real, demonstrable issues — no stylistic nitpicks a formatter/linter already covers, no theoretical concerns. If a sanitizer/validator already neutralizes an input, don't flag it.

## 5. Adversarial verify pass (do not skip)

Before presenting, re-examine every candidate as a skeptic trying to **refute** it. Drop a finding when the input is already validated/escaped/parameterized, the code isn't reachable with attacker-controlled input, the pattern is safe in context, or the claim is speculative without code evidence. When genuinely uncertain, keep it but say so. This is the engine's `verifyFindings` precision pass — it's what keeps the signal high.

## 6. Output

Sort by severity (CRITICAL→INFO). Present a summary line with severity counts, then a markdown table:

```
| Severity | Category | Confidence | File | Line | Description |
```

Follow with the fixes/suggestions. If a large diff was budget-trimmed, list the files you skipped. If nothing surfaces, say "No issues found." plainly. Never block — this is advisory.
