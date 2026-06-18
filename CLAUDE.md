# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A **centralized, reusable security review agent** for GitHub pull requests. The logic lives here once; target repos (e.g. `dsngeu/ai-receptionist`, `dsngeu/news`, `dsngeu/debrief`) add a small caller workflow that invokes it. When a PR opens, the agent reviews the diff with **Claude Opus 4.8**, posts inline + summary comments, @-mentions the owner on HIGH/CRITICAL findings, and records a non-blocking Check Run. **Advisory only — it never blocks a merge. Fail-open: agent errors never block a PR.**

## Architecture

```
.github/workflows/security-review.yml   Reusable workflow (workflow_call) — the entry point
agents/security/index.js                Agent orchestration (GitHub API + Claude calls)
agents/security/prompt.js               System/user prompts + Claude tool schemas
caller-workflow-template/pr-security.yml Template copied into each target repo
package.json                            Deps: @anthropic-ai/sdk only
```

Flow per PR: caller workflow (in target repo) → reusable workflow (here) → `node agents/security/index.js`:
1. Fetch diff + changed-file contents (skip lockfiles/binaries/vendored/minified)
2. Risk-rank files, apply `MAX_FILES` budget, scope diff to selected files
3. Pull in imported unchanged files for data-flow context
4. Chunk on file boundaries, review chunks in parallel (`CHUNK_CONCURRENCY`)
5. Adversarial verifier pass drops false positives
6. Delete prior bot comments (idempotency) → post inline + summary → update Check Run

## Critical constraints — do not regress these

- **Check Runs require the built-in Actions token, NOT a PAT.** The Checks API returns `403 "You must authenticate via a GitHub App"` for classic PATs. The agent uses `github.token` (`GH_TOKEN` env) for all target-repo API calls. `GH_PAT` is used ONLY to check out this private repo in the workflow. Never switch Check Run / comment calls back to a PAT.
- **Inline comment lines must exist in the diff.** GitHub 422s the *entire* review if one comment's line isn't in the diff. `parseDiffValidLines()` filters lines; there's a per-comment fallback. Keep both.
- **Structured output via Claude tool-use.** Findings come from the `report_findings` tool (forced `tool_choice`), not parsed JSON. Don't reintroduce `JSON.parse` on raw text.
- **Fail-open always.** Any error → post an error comment + `@mention`, set Check Run to `neutral`, never `failure`. Check Run conclusion is always `neutral`.
- **Idempotency via `COMMENT_MARKER`.** Every posted comment includes the hidden marker so re-runs can delete prior ones. Keep the marker on all comment bodies.

## Conventions

- **Node 20+, CommonJS, native `fetch`.** Only runtime dep is `@anthropic-ai/sdk`; GitHub calls use plain `fetch` via the `githubRequest()` helper. Don't add an Octokit/HTTP dependency.
- **Model:** `claude-opus-4-8`. Use the latest Anthropic SDK patterns (tool use, `tool_choice`).
- **Tunables are env-first** (`MAX_FILES`, `CHUNK_CONCURRENCY`, `INLINE_MIN_SEVERITY`, `VERIFY`) with code-constant defaults at the top of `index.js`. Add new knobs the same way.
- Keep the agent **language-agnostic**: the prompt detects language per file. Don't hardcode a single ecosystem.

## Working in this repo

- **Git: never commit or push.** The user handles all commits/pushes. Provide the exact git commands for them to run instead. (See user memory.)
- **No build step / no tests yet.** Validate changes with `node --check agents/security/index.js` and small inline `node -e` snippets for pure helpers (diff parsing, risk scoring, concurrency).
- Secrets live on **target repos**, not here (`secrets: inherit` reads from the caller). This repo only needs them if reviewing its own PRs.
- Onboarding a new target repo: add the caller workflow + two secrets (`ANTHROPIC_API_KEY`, `GH_PAT`); if the run hits `startup_failure`, set the repo's default workflow token permission to **write**. The agent repo's Actions access level must be `user` (one-time, account-wide).

## Scope (v1 pilot)

In scope: security agent, PR `opened`/`synchronize`/`reopened`, advisory comments + Check Run.
Out of scope: push-to-main triggers, merge blocking, other agent types, GitHub App auth (planned for client accounts).
