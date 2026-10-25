---
phase: quick-261025-rxa
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/ci.yml
autonomous: true
requirements:
  - REPO-04
estimate:
  tokens: 4000
  raw_tokens: 4000
  tasks: 1
  confidence: high
must_haves:
  truths:
    - "The secrets job in ci.yml passes GITHUB_TOKEN to the gitleaks scan step"
    - "No other job or workflow file is modified"
  artifacts:
    - ".github/workflows/ci.yml"
  key_links:
    - ".github/workflows/ci.yml secrets job -> gitleaks/gitleaks-action@v3 with env token"
---

<objective>

Fix the red `secrets` job on PR CI by passing the automatic `GITHUB_TOKEN` to the
`gitleaks/gitleaks-action@v3` scan step in `.github/workflows/ci.yml`, exactly as the
upstream README usage example prescribes.

Purpose: VERIFICATION.md (Phase 1, 9/10) records live PR #10 run 40195800824 with
typecheck/lint/test green and `secrets` failing on
`##[error]🛑 GITHUB_TOKEN is now required to scan pull requests`. This one-line config
change unblocks the last failing truth ("Every PR runs green CI").
Output: edited `.github/workflows/ci.yml`, verified locally by static checks only.
Live CI confirmation happens after the orchestrator pushes — out of scope here.

</objective>

<execution_context>
@/home/honolulu0630/.config/openchamber/gsd-core/workflows/execute-plan.md
@/home/honolulu0630/.config/openchamber/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/01-monorepo-contracts-freeze/01-VERIFICATION.md
@.github/workflows/ci.yml
</context>

<tasks>

<task type="auto">
  <name>Task 1: Pass GITHUB_TOKEN to gitleaks scan step</name>
  <files>.github/workflows/ci.yml</files>
  <action>In `.github/workflows/ci.yml`, add an `env` block with
  `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the "Scan for secrets" step
  (the step using `gitleaks/gitleaks-action@v3` in the `secrets` job), matching
  the upstream gitleaks-action README usage example. Do NOT add a `permissions`
  block (the README example has none; default token permissions suffice), do NOT
  add `GITLEAKS_LICENSE` (only required for organization-owned repos per the
  README FAQ, and this must stay minimal), do NOT touch `actions/checkout`
  versions, do NOT touch any other job in ci.yml, and do NOT touch
  `.github/workflows/openwiki-update.yml` or any other file.</action>
  <verify>
    <automated>export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; hash -r; python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/ci.yml')); steps=d['jobs']['secrets']['steps']; s=[x for x in steps if x.get('uses','').startswith('gitleaks/gitleaks-action@v3')]; assert len(s)==1, 'scan step not found'; assert s[0].get('env',{}).get('GITHUB_TOKEN')=='${{ secrets.GITHUB_TOKEN }}', 'token env missing'; print('scan step carries GITHUB_TOKEN')"</automated>
    <fails_when>Assertion error or non-zero exit: the scan step is missing, duplicated, or lacks the exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` env entry.</fails_when>
    <automated>export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; hash -r; git diff --stat && git diff -- . ':!.github/workflows/ci.yml' | grep -v '^diff --git' | grep -c '^[+-][^+-]' | grep -qx '0' && echo 'only ci.yml changed'</automated>
    <fails_when>Non-zero exit or count mismatch: any file other than `.github/workflows/ci.yml` shows added/removed lines.</fails_when>
    <automated>export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null; hash -r; git diff .github/workflows/ci.yml | grep -c '^[+-].*permissions' | grep -qx '0' && git diff .github/workflows/ci.yml | grep -c '^[+-].*GITLEAKS_LICENSE' | grep -qx '0' && git diff .github/workflows/ci.yml | grep -c '^[+-].*checkout' | grep -qx '0' && echo 'no scope creep in diff'</automated>
    <fails_when>Non-zero exit: the diff introduces `permissions`, `GITLEAKS_LICENSE`, or checkout-version changes.</fails_when>
  </verify>
  <done>The `secrets` job scan step carries `env: GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`; `git diff --stat` lists only `.github/workflows/ci.yml`; no permissions/license/checkout churn.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CI runner → GitHub API | gitleaks-action uses GITHUB_TOKEN to comment on PRs |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-qrxa-01 | Information Disclosure | secrets job / GITHUB_TOKEN | low | accept | Uses the automatic ephemeral `secrets.GITHUB_TOKEN` (scoped to the repo, expires after the run); no long-lived PAT introduced; token is consumed only by the pinned gitleaks action, never echoed |
</threat_model>

<verification>
Static/local only: YAML parses, the exact env line is present on the v3 scan step,
and the working-tree diff touches nothing but `.github/workflows/ci.yml` with no
permissions/license/checkout churn. Live green-CI confirmation (all four jobs on the
PR) happens after the orchestrator pushes — explicitly out of scope for this plan.
</verification>

<success_criteria>
`.github/workflows/ci.yml` passes all three verify gates; the remaining Phase 1 gap
(REPO-04, VERIFICATION.md truth 9) is unblocked pending live CI.
</success_criteria>

<output>
Create `.planning/quick/261025-rxa-pass-github-token-to-gitleaks-v3-secrets/261025-rxa-SUMMARY.md` when done
</output>
