# Kontourai GitHub Workflows

This repository hosts organization-level GitHub workflow plumbing.

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
