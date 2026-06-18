# code-review-agents

Centralized, reusable code-review agents for GitHub pull requests. Write the review logic **once** here; every other repo just adds a tiny caller workflow and gets it automatically. Fix or improve the agent in one place and all repos pick it up.

Current agent: **Security Review** — reviews PR diffs for vulnerabilities using Claude Opus 4.8, posts inline comments + a summary, and @-mentions you on HIGH/CRITICAL findings. Advisory only — it never blocks a merge.

---

## How it works

```
┌─────────────────────────────────┐
│  code-review-agents (this repo)  │   ← the brain (you maintain this)
│  .github/workflows/              │
│    security-review.yml           │   reusable workflow (workflow_call)
│  agents/security/                │
│    index.js                      │   agent logic
│    prompt.js                     │   what to look for (polyglot)
└─────────────────────────────────┘
              ▲  "review my PR"
   ┌──────────┴──────────┬─────────────┐
┌────────┐         ┌────────┐     ┌────────┐
│  news  │         │debrief │     │ future │   ← each has a 10-line caller workflow
└────────┘         └────────┘     └────────┘
```

When a PR is opened/updated in a target repo:

1. The target repo's caller workflow (`pr-security.yml`) fires on `opened`, `synchronize`, `reopened`.
2. It invokes this repo's reusable workflow, passing the repo name, PR number, and HEAD SHA.
3. The agent (`agents/security/index.js`) runs on a GitHub-hosted runner:
   - Fetches the PR diff + full content of changed files (skips lockfiles/binaries)
   - Chunks very large PRs on file boundaries
   - Sends each chunk to **Claude Opus 4.8** with a security-focused, language-aware prompt
   - Parses structured findings: `severity`, `confidence`, `file`, `line`, `description`, `fix`
   - Posts **inline review comments** on the exact lines + a **summary comment**
   - @-mentions `@dsngeu` if any CRITICAL/HIGH finding exists (GitHub emails you)
   - Records a **Check Run** (always `neutral` — visible but never blocking)
4. **Fail-open:** if anything errors (API down, bad key), it posts a comment explaining why, @-mentions you, sets the Check Run to `neutral`, and never blocks the PR.

The prompt is **polyglot** — it detects each file's language from its extension and applies the right checks (Node/JS, Python, Go, Java, Kotlin/Android, Swift/iOS, PHP, etc.) plus universal categories (injection, secrets, crypto, auth, SSRF, path traversal…).

---

## Repository layout

```
.github/workflows/security-review.yml   Reusable workflow (workflow_call)
agents/security/index.js                Main agent script
agents/security/prompt.js               System + user prompts
caller-workflow-template/pr-security.yml Copy this into each target repo
package.json                            Dependencies (@anthropic-ai/sdk)
```

---

## Setup

### 1. Create the tokens

**Anthropic API key** — https://console.anthropic.com → Settings → API Keys → Create Key. Starts with `sk-ant-...`. Make sure billing/credits are set up.

**GitHub Personal Access Token (classic)** — GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token (classic). Check only the top-level **`repo`** scope. Starts with `ghp_...`.

> `repo` alone covers reading diffs, posting comments, and creating Check Runs. No other scopes needed.

### 2. Add secrets to every participating repo

Personal accounts can't share secrets across repos, so add both secrets to **this repo and each target repo** (`news`, `debrief`, …). `secrets: inherit` passes the *caller* repo's secrets into the reusable workflow, so each target repo needs its own copy.

In each repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|------|-------|
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
| `GH_PAT` | your `ghp_...` token |

Names must match exactly.

> Scaling to many repos or moving to a client? Use a **GitHub Organization** and set the two secrets once at the org level instead of per-repo.

### 3. Push this repo

Push `code-review-agents` to GitHub on the `main` branch so the reusable workflow exists.

### 4. Add the caller workflow to a target repo

Copy `caller-workflow-template/pr-security.yml` into the target repo at `.github/workflows/pr-security.yml` and push to `main`:

```yaml
name: Security Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  trigger-security-review:
    uses: dsngeu/code-review-agents/.github/workflows/security-review.yml@main
    with:
      repo: ${{ github.repository }}
      pr_number: ${{ github.event.pull_request.number }}
      head_sha: ${{ github.event.pull_request.head.sha }}
    secrets: inherit
```

Repeat for each repo you want covered. This is the only file a target repo needs.

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

Key knobs live at the top of `agents/security/index.js`:

| Constant | Default | Meaning |
|----------|---------|---------|
| `CLAUDE_MODEL` | `claude-opus-4-8` | Model used for review |
| `CHUNK_SIZE_CHARS` | `600_000` | Char threshold (~150k tokens) before chunking |
| `MENTION_USER` | `@dsngeu` | Who to @-mention on HIGH/CRITICAL |
| `MAX_INLINE_COMMENTS` | `50` | Cap on inline comments per review |
| `SKIP_PATTERNS` | lockfiles, binaries | Files excluded from review |

The review criteria live in `agents/security/prompt.js`.

---

## Design guarantees

- **No servers** — runs on GitHub Actions, on demand, only when a PR opens.
- **One source of truth** — fix the agent here, every repo updates instantly.
- **Parallel & independent** — each PR runs its own isolated job.
- **Advisory only** — v1 never blocks a merge.
- **Fail-open** — agent errors never block a PR.

---

## Roadmap

- Additional agents (style/quality, performance) beyond security
- GitHub App auth (for client accounts, instead of a personal PAT)
- Optional merge-blocking mode
