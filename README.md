# code-review-agents

Centralized, reusable **code-review platform** for GitHub. Write the review logic **once** here; every other repo adds tiny caller workflows and gets it automatically. Fix or improve a shared engine once and all repos pick it up. Three agents share one engine, are **advisory only** (never block a merge), **fail-open**, and **polyglot** (detect each file's language and apply the right checks).

## The three agents

| Agent | Trigger | Reviews | Output | Default model | Toggle |
|-------|---------|---------|--------|---------------|--------|
| **1 · Security** | Auto, every PR | Security vulnerabilities only | Inline + summary comments + Check Run | Opus | always on |
| **2 · Branch review** | Manual (Actions tab) | The branch's changes vs base — quality **+** security | Job Summary on the run page | Sonnet | n/a (manual) |
| **3 · PR review** | Auto, every PR | General quality (bugs, perf, design) — **no security** | Single summary comment + Check Run | Sonnet | repo variable `ENABLE_PR_REVIEW` |

All three @-mention the PR author + your reviewer list on HIGH/CRITICAL, and the **model is configurable per agent** (`model` workflow input, default `claude-opus-4-8`).

> 📖 New here? Read **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** — diagrams + plain-English walkthrough of how all three agents work and what code each one reviews.

---

## How it works

```
┌─────────────────────────────────────────────┐
│  code-review-agents (this repo) — the brain  │
│  agents/_core/        shared engine          │
│  agents/security/     Agent 1 (security)     │
│  agents/review/       Agents 2 & 3 (quality) │
│  .github/workflows/   3 reusable workflows   │
└─────────────────────────────────────────────┘
              ▲  callers invoke the reusable workflows
   ┌──────────┴──────────┬─────────────┐
┌────────┐         ┌────────┐     ┌────────┐
│ repo 1 │         │ repo 2 │     │ repo N │   ← each adds small caller workflows
└────────┘         └────────┘     └────────┘
```

A target repo's caller workflow invokes a reusable workflow here, which runs the matching agent on a GitHub-hosted runner. Each agent is a thin entrypoint over the shared `runReview()` engine, which:
- Fetches the PR diff (or `compare/base...head` for branch reviews) + full content of changed files
- **Skips dependency/build artifacts on any stack** (node_modules, Pods, Gradle, DerivedData, target/, .venv, lockfiles, binaries…)
- Risk-ranks files and applies a `MAX_FILES` budget (discloses what it skipped)
- Pulls in imported unchanged files for data-flow context
- Chunks large diffs on file boundaries and reviews chunks **in parallel**
- Returns **structured findings** via Claude tool-use (no brittle JSON parsing)
- Runs an **adversarial verifier pass** that drops false positives
- Emits via the agent's channels (inline / summary comment / Job Summary / Check Run), **idempotently** (deletes its prior comments first)

**Fail-open:** any error → an error comment / Job-Summary note + @-mention, Check Run `neutral`, never blocks the PR.

---

## Repository layout

```
agents/_core/        config.js · github.js · payload.js · claude.js · review.js (shared engine)
agents/security/     index.js (Agent 1) · prompt.js (security lens)
agents/review/       prompt.js (general lens) · pr.js (Agent 3) · branch.js (Agent 2)
.github/workflows/   security-review.yml · pr-review.yml · branch-review.yml (reusable)
caller-workflow-template/  pr-security.yml · pr-review.yml · branch-review.yml (copy into target repos)
package.json         Dependencies (@anthropic-ai/sdk)
```

---

## Setup

### 1. Create the tokens

**Anthropic API key** — https://console.anthropic.com → Settings → API Keys → Create Key. Starts with `sk-ant-...`. Make sure billing/credits are set up.

**GitHub Personal Access Token (classic)** — GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token (classic). Check only the top-level **`repo`** scope. Starts with `ghp_...`.

> `repo` alone covers reading diffs, posting comments, and creating Check Runs. No other scopes needed.

### 2. Add secrets to every participating repo

Personal accounts can't share secrets across repos, so add both secrets to **each target repo** (repo 1, repo 2, …). `secrets: inherit` passes the *caller* repo's secrets into the reusable workflow, so each target repo needs its own copy.

In each repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
| `GH_PAT` | your `ghp_...` token |

Names must match exactly.

> Scaling to many repos or moving to a client? Use a **GitHub Organization** and set the two secrets once at the org level instead of per-repo.

### 3. Push this repo

Push `code-review-agents` to GitHub on the `main` branch so the reusable workflow exists.

### 4. Add the caller workflow(s) to a target repo

Copy the caller(s) you want from `caller-workflow-template/` into the target repo's `.github/workflows/` and push. Each repo can run any subset of the three agents:

| Agent | Copy this template | Notes |
|-------|-------------------|-------|
| **1 · Security** | `pr-security.yml` | Auto on every PR. No extra config. |
| **3 · PR review** | `pr-review.yml` | Auto on every PR, **but gated** — set repo variable `ENABLE_PR_REVIEW=true` to turn it on (unset = skipped). |
| **2 · Branch review** | `branch-review.yml` | Manual — appears under the repo's **Actions** tab; run it against a branch. |

> **Enabling Agent 3:** in the target repo → **Settings → Secrets and variables → Actions → Variables → New repository variable** → `ENABLE_PR_REVIEW` = `true`. Set it to anything else (or delete it) to disable — no file changes needed.

> **Per-repo model override:** add `model: 'claude-sonnet-4-6'` (or any model id) under `with:` in any caller to change that agent's model for that repo.

---

## Testing it

1. In a target repo, create a branch and add a file with deliberate vulnerabilities, e.g.:

   ```javascript
   // test-vulnerabilities.js
   function getUser(userId) {
     db.query(`SELECT * FROM users WHERE id = ${userId}`); // SQL injection
   }
   const API_KEY = 'sk-prod-abc123def456';                 // hardcoded secret
   function runCmd(input) {
     require('child_process').execSync(`ls ${input}`);      // command injection
   }
   ```

2. Open a PR from that branch to `main`.
3. Check the PR — you should see:
   - A **Security Review** Check Run (neutral)
   - **Inline comments** on the vulnerable lines
   - A **summary comment** with a findings table
   - `@dsngeu` mentioned (because of HIGH/CRITICAL findings) → email notification

**Error-path test:** temporarily set `ANTHROPIC_API_KEY` to an invalid value, open a PR, and confirm the agent posts an error comment + @-mention and the Check Run is `neutral` (PR still mergeable).

---

## Configuration

### Environment variables (tune per target repo, no code change)

Set these as repo/org variables or in the caller workflow's `env:` if you need to override defaults:

| Knob | Where | Default | Meaning |
|------|-------|---------|---------|
| `model` | caller `with:` input | per agent | Claude model id. Defaults: Agents 1 & 2 = `claude-opus-4-8`, Agent 3 = `claude-sonnet-4-6`. |
| `ENABLE_PR_REVIEW` | repo **variable** | unset | Set to `true` to enable Agent 3 (auto PR review) in a repo. |
| `notify_users` | caller `with:` input | — | Extra comma-separated reviewers to @-mention (in addition to the PR author). |
| `MAX_FILES` | env | `80` | Max changed files deeply analyzed; the rest are risk-ranked out and disclosed as skipped. |
| `CHUNK_CONCURRENCY` | env | `4` | Chunks sent to Claude in parallel. |
| `INLINE_MIN_SEVERITY` | env | `LOW` | Minimum severity for an **inline** comment (everything still appears in the summary). |
| `VERIFY` | env | `true` | Adversarial pass that drops false positives. `false` = faster/cheaper/noisier. |

### Code constants (`agents/_core/config.js`)

| Constant | Default | Meaning |
|----------|---------|---------|
| `DEFAULT_MODEL` | `claude-opus-4-8` | Global model fallback when no `model` input is given |
| `MAX_TOKENS` | `16000` | Max output tokens per Claude call |
| `CLAUDE_MAX_RETRIES` | `5` | Retries on transient API errors (429/5xx) |
| `CHUNK_SIZE_CHARS` | `600_000` | Char threshold (~150k tokens) before chunking |
| `ALWAYS_NOTIFY` | `['dsngeu']` | Hardcoded reviewer fallback (used when `notify_users` is empty) |
| `MAX_INLINE_COMMENTS` | `50` | Cap on inline comments per review |
| `MAX_CONTEXT_FILES` | `20` | Unchanged imported files pulled in for data-flow context |
| `SKIP_PATTERNS` | deps/build/binaries (all stacks) | Files excluded from review |

Security review criteria live in `agents/security/prompt.js`; general review criteria in `agents/review/prompt.js`.

### How it handles tricky cases

- **Large PRs:** files are risk-ranked (security keywords + code-ness beat raw size); top `MAX_FILES` reviewed, rest disclosed in the summary — never silently dropped.
- **Reliable findings:** Claude returns structured tool output (no JSON parsing); inline comment lines are validated against the diff, with per-comment fallback so one bad line can't drop the whole review.
- **Fewer false positives:** the verifier pass refutes weak findings before they're posted.
- **Idempotent re-runs:** each push deletes the agent's prior comments (tagged with a hidden marker) before posting fresh ones — no duplicate spam.

---

## Design guarantees

- **Read + comment only** — agents can only read code and post/update PR comments. They **cannot modify or delete code, branches, PRs, or comments.** Enforced two ways: the workflow token is `contents: read` (no push/edit/delete), and the code hard-blocks every HTTP method except GET/POST/PATCH (DELETE/PUT throw). Re-runs update the existing comment in place — never delete.
- **No servers** — runs on GitHub Actions, on demand.
- **One source of truth** — fix the shared engine here, every repo updates instantly.
- **Per-agent model** — each agent's model is set via the `model` input (see Configuration); change one without touching others.
- **Advisory only** — never blocks a merge.
- **Fail-open** — agent errors never block a PR.

---

## Roadmap

- GitHub App auth (for client accounts, instead of a personal PAT)
- Optional merge-blocking mode
- Additional review lenses (accessibility, test quality) on the shared engine
