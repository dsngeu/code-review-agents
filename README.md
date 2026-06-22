# code-review-agents

Centralized, reusable **code-review platform** for GitHub. Write the review logic **once** here; every other repo adds tiny caller workflows and gets it automatically. Fix or improve a shared engine once and all repos pick it up. Three agents share one engine, are **advisory only** (never block a merge), **fail-open**, and **polyglot** (detect each file's language and apply the right checks).

## The three agents

| Agent | Trigger | Reviews | Output | Default model | Toggle |
|-------|---------|---------|--------|---------------|--------|
| **1 · Security** | Auto, every PR | Security vulnerabilities only | Inline + summary comments + Check Run | Sonnet | always on |
| **2 · Branch review** | Manual (Actions tab) | The branch's changes vs base — quality **+** security | Job Summary on the run page | Sonnet | n/a (manual) |
| **3 · PR review** | Auto, every PR | General quality (bugs, perf, design) — **no security** | Single summary comment + Check Run | Sonnet | repo variable `ENABLE_PR_REVIEW` |

All three @-mention the PR author + your reviewer list on HIGH/CRITICAL, and the **model is configurable per agent** (`model` workflow input, default `claude-sonnet-4-6`).

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
- Pulls in **unchanged dependency files referenced by the changed code** for cross-file data-flow context — language-aware: Swift type references, Kotlin/Java package imports, JS/TS imports (resolved against the repo's file tree)
- Applies **per-language pitfall lenses** (Swift/Kotlin/Node/TS) so findings target each ecosystem's real failure modes
- Chunks large diffs on file boundaries and reviews chunks **in parallel**
- Returns **structured findings** via Claude tool-use (no brittle JSON parsing)
- Runs an **adversarial verifier pass** that drops false positives (optional majority-vote for HIGH/CRITICAL), and a **confidence gate** before posting
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

## Setup — add the agents to your repo

You need this **once**: a fork (or copy) of this repo on your account, then **two keys** stored in each repo you want reviewed, and a **caller workflow file** per agent. Full walkthrough below.

> **Adopting this project?** Fork it to your own account/org first. Everywhere you see `dsngeu/code-review-agents` below, replace `dsngeu` with **your** GitHub username/org. The agents call *your* fork's reusable workflows.

### Step 1 — Generate the two keys

**Key 1: Anthropic API key** (lets the agent call Claude)
1. Go to **https://console.anthropic.com**
2. **Settings → API Keys → Create Key**, name it e.g. `code-review`
3. Copy the value — it starts with `sk-ant-...` (shown once)
4. Make sure your account has billing/credits enabled, or calls will fail

**Key 2: GitHub Personal Access Token** (lets the agent check out the agent code)
1. Go to **https://github.com/settings/tokens** → **Tokens (classic)**
2. **Generate new token → Generate new token (classic)**
3. Name it `code-review`, pick an expiry
4. Check the single top-level **`repo`** scope (nothing else)
5. **Generate token** and copy it — starts with `ghp_...` (shown once)

> If your fork of `code-review-agents` is **public**, the PAT is technically optional (public repos clone without auth) — but keeping it set is harmless and required if your fork is private.

### Step 2 — Save the keys in each target repo

GitHub stores these per-repo. In **every repo you want reviewed**, go to:

**Repo → Settings → Secrets and variables → Actions → _Secrets_ tab → New repository secret**

Add both (names must match **exactly**):

| Name | Value | Tab |
|------|-------|-----|
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key | **Secrets** |
| `GH_PAT` | your `ghp_...` token | **Secrets** |

> ⚠️ These go under the **Secrets** tab, **not** Variables. `secrets: inherit` in the caller passes them through to the reusable workflow.
>
> Using a **GitHub Organization**? Set them once as **org-level** secrets instead of per-repo.

### Step 3 — Add the caller workflow file(s)

In the target repo, create the file(s) below under **`.github/workflows/`** — one per agent you want. Pick any subset.

**Agent 1 — Security** → `.github/workflows/pr-security.yml`
```yaml
name: Security Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  checks: write
  pull-requests: write
jobs:
  security:
    uses: dsngeu/code-review-agents/.github/workflows/security-review.yml@main
    with:
      repo: ${{ github.repository }}
      pr_number: ${{ github.event.pull_request.number }}
      head_sha: ${{ github.event.pull_request.head.sha }}
      pr_author: ${{ github.event.pull_request.user.login }}
      # model: 'claude-sonnet-4-6'   # optional per-repo override
    secrets: inherit
```

**Agent 3 — PR quality review** → `.github/workflows/pr-review.yml`
```yaml
name: Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  checks: write
  pull-requests: write
jobs:
  code-review:
    if: ${{ vars.ENABLE_PR_REVIEW == 'true' }}   # toggle (see Step 4)
    uses: dsngeu/code-review-agents/.github/workflows/pr-review.yml@main
    with:
      repo: ${{ github.repository }}
      pr_number: ${{ github.event.pull_request.number }}
      head_sha: ${{ github.event.pull_request.head.sha }}
      pr_author: ${{ github.event.pull_request.user.login }}
    secrets: inherit
```

**Agent 2 — Manual branch review** → `.github/workflows/branch-review.yml`
```yaml
name: Branch Review
on:
  workflow_dispatch:
    inputs:
      model:
        description: 'Claude model id'
        required: false
        default: 'claude-sonnet-4-6'
permissions:
  contents: read
jobs:
  branch-review:
    uses: dsngeu/code-review-agents/.github/workflows/branch-review.yml@main
    with:
      repo: ${{ github.repository }}
      ref: ${{ github.ref_name }}   # the branch you pick in "Use workflow from"
      base: ''                       # diff against the default branch
      model: ${{ inputs.model }}
    secrets: inherit
```

> Ready-to-copy versions of all three live in [`caller-workflow-template/`](caller-workflow-template/). Remember to push these to your repo's **default branch** (`main`) — `workflow_dispatch` (Agent 2) and `pull_request` triggers need the file on `main`.

### Step 4 — Turn on Agent 3 (only if you added it)

Agent 3 is **off by default** so it never surprises a repo. Enable it with a repo **variable**:

**Repo → Settings → Secrets and variables → Actions → _Variables_ tab → New repository variable**
- Name: `ENABLE_PR_REVIEW`
- Value: `true`

Set it to anything else (or delete it) to turn Agent 3 back off — no file changes needed. (Agents 1 and 2 don't use this.)

### Step 5 — If a run fails to start (`startup_failure`)

GitHub may default the runner token to read-only. If you see `startup_failure`, give the token write access once:

**Repo → Settings → Actions → General → Workflow permissions → "Read and write permissions" → Save**

(Or `gh api --method PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=write`.)

### Quick reference

| Want to… | Where |
|----------|-------|
| Add the keys | Repo → Settings → Secrets and variables → Actions → **Secrets** |
| Enable Agent 3 | Repo → Settings → Secrets and variables → Actions → **Variables** → `ENABLE_PR_REVIEW=true` |
| Change an agent's model | `model:` under `with:` in that caller file |
| Run Agent 2 | Repo → **Actions** tab → Branch Review → Run workflow → pick branch |

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
   - The PR author + configured reviewers @-mentioned (because of HIGH/CRITICAL findings) → email notification

**Error-path test:** temporarily set `ANTHROPIC_API_KEY` to an invalid value, open a PR, and confirm the agent posts an error comment + @-mention and the Check Run is `neutral` (PR still mergeable).

---

## Configuration

### Environment variables (tune per target repo, no code change)

Set these as repo/org variables or in the caller workflow's `env:` if you need to override defaults:

| Knob | Where | Default | Meaning |
|------|-------|---------|---------|
| `model` | caller `with:` input | per agent | Claude model id. All agents default to `claude-sonnet-4-6`. |
| `ENABLE_PR_REVIEW` | repo **variable** | unset | Set to `true` to enable Agent 3 (auto PR review) in a repo. |
| `notify_users` | caller `with:` input | — | Extra comma-separated reviewers to @-mention (in addition to the PR author). |
| `agent_ref` | caller `with:` input | `main` | Ref (branch/tag/SHA) of **this** agent repo to run. Set to a branch to test agent changes before merging; defaults to `main`. |
| `MAX_FILES` | env | `80` | Max changed files deeply analyzed; the rest are risk-ranked out and disclosed as skipped. |
| `CHUNK_CONCURRENCY` | env | `4` | Chunks sent to Claude in parallel. |
| `INLINE_MIN_SEVERITY` | env | `LOW` | Minimum severity for an **inline** comment (everything still appears in the summary). |
| `VERIFY` | env | `true` | Adversarial pass that drops false positives. `false` = faster/cheaper/noisier. |
| `MIN_CONFIDENCE` | env | `LOW` | Minimum confidence for a finding to be **posted**. Default `LOW` posts everything; raise to `MEDIUM`/`HIGH` to suppress speculative findings (suppression is disclosed, never silent). |
| `VERIFY_HIGH_STAKES_VOTES` | env | `1` | Independent verifier passes for **HIGH/CRITICAL** findings; dropped only on a **majority** refute. `1` = single pass (default). Raise (e.g. `3`) for more reliable verdicts on high-severity findings. Multi-vote passes reuse a **prompt cache** so passes 2…N bill input at ~0.1×. |
| `REVIEW_TEMPERATURE` | env | model default | Temperature for the review pass. Unset = model default. Lower (e.g. `0.2`) → more reproducible reviews. |
| `VERIFY_TEMPERATURE` | env | model default | Temperature for verifier passes. Keep **> 0** so multi-vote passes stay independent. |

> **Note on the `env` knobs:** the engine reads these from `process.env`, but the reusable workflows do **not** yet forward arbitrary repo/org variables into the run step — so today, overriding an `env` knob means adding it to the `env:` block of the relevant reusable workflow (`.github/workflows/*.yml`). `agent_ref`, `model`, `notify_users`, and `ENABLE_PR_REVIEW` are wired through and settable from the caller as shown.

### Code constants (`agents/_core/config.js`)

| Constant | Default | Meaning |
|----------|---------|---------|
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Global model fallback when no `model` input is given |
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
