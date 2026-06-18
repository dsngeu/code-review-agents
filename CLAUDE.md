# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A **centralized, reusable code-review platform** for GitHub. The logic lives here once; target repos add small caller workflows that invoke it. Three agents share one engine (`agents/_core`):

- **Agent 1 — Security** (`agents/security/index.js`): auto on every PR, security-only, inline + summary comments + Check Run. Default model Sonnet.
- **Agent 2 — Branch review** (`agents/review/branch.js`): manual (`workflow_dispatch`), reviews branch-vs-base for general quality **+** security, writes to the Actions **Job Summary**. Default model Sonnet.
- **Agent 3 — PR review** (`agents/review/pr.js`): auto on every PR, **general quality only** (no security — Agent 1 covers that), single summary comment, **toggled per repo** by the repo variable `ENABLE_PR_REVIEW`. Default model Sonnet.

**All advisory only — never block a merge. Fail-open: agent errors never block a PR.** Model is configurable per agent via the `model` workflow input (→ `MODEL` env), default `claude-sonnet-4-6`.

## Architecture

```
agents/_core/        Shared engine (the brain):
  config.js          env, model resolution, mentions, severity, SKIP_PATTERNS, risk heuristics
  github.js          all GitHub I/O: diff/compare/files/contents, check runs, comments, Job Summary
  payload.js         risk ranking, MAX_FILES budget, diff filtering, chunking, concurrency
  claude.js          callClaude() + verifyFindings() (tool-use structured output)
  review.js          runReview(opts) — the orchestration shared by all agents
agents/security/     Agent 1: index.js (thin entry) + prompt.js (security lens)
agents/review/       Agents 2 & 3: prompt.js (general lens, includeSecurity flag) + pr.js + branch.js
.github/workflows/   security-review.yml, pr-review.yml, branch-review.yml (all reusable, workflow_call)
caller-workflow-template/  pr-security.yml, pr-review.yml, branch-review.yml (copied into target repos)
package.json         Deps: @anthropic-ai/sdk only
```

Each agent entrypoint is a thin wrapper that calls `runReview(opts)` with: agent name, mode (`pr`/`branch`), prompts + tools, model, comment marker, and which output channels to use (`checkRun`/`inlineComments`/`summaryComment`/`jobSummary`).

`runReview` flow: resolve diff (PR diff, or `compare/base...head` for branch) → risk-rank + `MAX_FILES` budget → pull imported context files → chunk on file boundaries → review chunks in parallel (`CHUNK_CONCURRENCY`) → adversarial verifier drops false positives → merge/dedup → emit via the configured channels (idempotent: deletes prior bot comments by marker first).

## Critical constraints — do not regress these

- **Check Runs require the built-in Actions token, NOT a PAT.** The Checks API returns `403 "You must authenticate via a GitHub App"` for classic PATs. The agent uses `github.token` (`GH_TOKEN` env) for all target-repo API calls. `GH_PAT` is used ONLY to check out this private repo in the workflow. Never switch Check Run / comment calls back to a PAT.
- **Inline comment lines must exist in the diff.** GitHub 422s the *entire* review if one comment's line isn't in the diff. `parseDiffValidLines()` filters lines; there's a per-comment fallback. Keep both.
- **Structured output via Claude tool-use.** Findings come from the `report_findings` tool (forced `tool_choice`), not parsed JSON. Don't reintroduce `JSON.parse` on raw text.
- **READ + COMMENT ONLY — never destructive.** Agents may only read code and post/update PR comments + check runs. They must NEVER modify or delete code, branches, PRs, or comments. Enforced by two guards, both must stay: (1) workflows grant the runner token `contents: read` only (no push/edit/delete); (2) `githubRequest` hard-blocks every method except GET/POST/PATCH — DELETE and PUT throw. Do not add `contents: write` or a DELETE/PUT call.
- **Fail-open always.** Any error → post an error comment/Job-Summary note + `@mention`, set Check Run to `neutral`, never `failure`. Check Run conclusion is always `neutral`. On error the script still `process.exit(1)` so the Actions run shows red for operator visibility — that's intentional. The "never block" guarantee comes from the neutral **Check Run**, so consumers must require the *Check Run* in branch protection, **never the workflow job** (requiring the job would let a failed run block a merge).
- **Idempotency via update-in-place (no deletion).** Re-runs UPDATE the agent's existing summary comment, found by a per-agent hidden marker (`<!-- security-review-agent -->`, `<!-- code-review-agent -->`, `<!-- branch-review-agent -->`) — via `upsertIssueComment`, never delete-then-repost. Keep the marker on every comment body.
- **Universal skip list.** `SKIP_PATTERNS` in `_core/config.js` excludes dependency/build artifacts for ALL stacks (node_modules, Pods, Gradle, DerivedData, target/, .venv, etc.) — not just JS. Keep it stack-agnostic; only skip dependency/build dirs, never first-party source.
- **Shared engine.** All review logic lives in `agents/_core`. New agents = a thin entrypoint + a prompt module calling `runReview(opts)`. Don't fork the engine per agent.

## Conventions

- **Node 20+, CommonJS, native `fetch`.** Only runtime dep is `@anthropic-ai/sdk`; GitHub calls use plain `fetch` via the `githubRequest()` helper. Don't add an Octokit/HTTP dependency.
- **Model:** default `claude-sonnet-4-6` (configurable per agent). Use the latest Anthropic SDK patterns (tool use, `tool_choice`).
- **Tunables are env-first** (`MAX_FILES`, `CHUNK_CONCURRENCY`, `INLINE_MIN_SEVERITY`, `VERIFY`) with code-constant defaults at the top of `index.js`. Add new knobs the same way.
- Keep the agent **language-agnostic**: the prompt detects language per file. Don't hardcode a single ecosystem.

## Working in this repo

- **Git: never commit or push.** The user handles all commits/pushes. Provide the exact git commands for them to run instead. (See user memory.)
- **No build step / no tests yet.** Validate changes with `node --check agents/security/index.js` and small inline `node -e` snippets for pure helpers (diff parsing, risk scoring, concurrency).
- Secrets live on **target repos**, not here (`secrets: inherit` reads from the caller). This repo only needs them if reviewing its own PRs.
- Onboarding a new target repo: add the caller workflow + two secrets (`ANTHROPIC_API_KEY`, `GH_PAT`); if the run hits `startup_failure`, set the repo's default workflow token permission to **write**. The agent repo's Actions access level must be `user` (one-time, account-wide).

## Scope

In scope: three agents (security auto-PR, manual branch review, toggleable auto-PR quality review), advisory comments / Job Summary + Check Run, per-agent model config.
Out of scope: push-to-main triggers, merge blocking, GitHub App auth (planned for client accounts). Agent 2 is API-based (not subscription/Claude Code Action) to stay one-runtime and client-portable.
