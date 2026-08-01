# Kontourai GitHub Workflows

This repository hosts the public organization profile, shared community health
files, and organization-level GitHub workflow plumbing.

- [`profile/README.md`](profile/README.md) is the public product map shown on the
  Kontour AI organization page. Keep repository names and product boundaries in
  that file aligned with the owning repositories and
  [kontourai.io](https://kontourai.io).
- [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) supplies default issue
  intake for repositories that do not override it locally.
- [`.github/workflows/`](.github/workflows/) contains reusable workflows called
  by product repositories.

## Issue intake to Project v2

Every kontourai repository with issues enabled should install a thin caller workflow at `.github/workflows/add-to-project.yml`. On `issues.opened`, `issues.reopened`, and `issues.closed`, the caller invokes the reusable workflow in this repository:

```yaml
name: Add issue to org project

on:
  issues:
    types: [opened, reopened, closed]

permissions:
  contents: read
  issues: read

jobs:
  add-to-project:
    uses: kontourai/.github/.github/workflows/add-issue-to-project.yml@main
    secrets:
      ADD_TO_PROJECT_PAT: ${{ secrets.ADD_TO_PROJECT_PAT }}
```

The reusable workflow adds the issue to [Flow Agents Builder Platform](https://github.com/orgs/kontourai/projects/1), resolves the target Status option ID by name at runtime, and sets the Project v2 `Status` field: `Triage` on `opened`/`reopened`, `Done` on `closed`.

### Required owner setup

Create an organization secret named `ADD_TO_PROJECT_PAT` before enabling the caller workflows:

1. Create a classic PAT with the `project` scope, or use a GitHub App installation token that can write organization Project v2 items.
2. Open `https://github.com/organizations/kontourai/settings/secrets/actions`.
3. Create an organization repository secret named `ADD_TO_PROJECT_PAT`.
4. Grant the secret repository access to all organization repositories (or at minimum every repo with issues enabled — the rollout script discovers that set dynamically).

The default `GITHUB_TOKEN` cannot write organization-level Project v2 items, so the workflow is expected to fail until this secret exists and has project write permission.

### Close-to-Done

Issue close → `Done` is handled by the same reusable workflow (the caller's `closed` trigger), so the whole intake lifecycle lives in versioned, reviewable code. Optionally also enable the built-in Project workflow ("item closed → set Status: Done") at `https://github.com/orgs/kontourai/projects/1/workflows` as redundancy — the two are idempotent together.

### Rollout

`scripts/open-add-to-project-rollout-prs.sh` opens the thin-caller PRs for the remaining consumer repositories after the central workflow and `flow-agents` pilot have merged. Do not run it before the pilot proves the secret and reusable workflow path.

## Veritas advisory governance

Repositories using observe-only Veritas readiness should call the shared workflow instead of copying its setup and execution steps:

```yaml
jobs:
  readiness:
    uses: kontourai/.github/.github/workflows/veritas-advisory.yml@main
```

Set `with: { install-browser: true }` only when the repository's evidence check needs Chromium. The shared job pins the supported Veritas version, retains the evidence artifact, and has a 30-minute outer timeout as defense in depth. It reports governance findings without promoting them to a required merge gate.

## Secret scan

Repositories can call the reusable `secret-scan.yml` workflow to scan complete
git history reachable from the checked-out ref. It intentionally does not scan
other fetched remote branches: those commits are not part of the caller's PR or
branch and must not fail its gate. A secret in the caller's HEAD history,
including a fixture intentionally committed on that PR, remains a failing,
redacted finding.

## Release-note policy

Repositories that use normal merge commits use GitHub's supported `PR_TITLE/BLANK` setting pair.
Pull request titles are plain-language, non-conventional summaries; implementation commits remain
the conventional release-note source. The merge therefore preserves the PR boundary without
introducing a second conventional message for release automation to parse.

Audit or apply the policy to an explicit public-repository set:

```bash
node scripts/release-note-policy.mjs check --suite
node scripts/release-note-policy.mjs apply --suite
```

The versioned suite target lists every public Kontour repository currently using Release Please.
The command changes only GitHub's merge title/body settings to the supported `PR_TITLE`/`BLANK`
pair and verifies the resulting state. Contributors must keep PR titles free of Conventional Commit
prefixes such as `fix:` and `feat:`; those prefixes belong on implementation commits.
Repositories with merge commits disabled are already compliant.
