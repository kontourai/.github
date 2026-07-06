#!/usr/bin/env bash
set -euo pipefail

branch="${BRANCH:-chore/auto-add-to-project}"
remote="${REMOTE:-origin}"
tmp_root="${TMPDIR:-/tmp}/kontourai-add-to-project-rollout.$$"

# Discover targets dynamically: every non-archived org repo with issues enabled,
# excluding this central repo and the flow-agents pilot (already covered).
repos=()
while IFS= read -r name; do
  case "${name}" in
    .github|flow-agents) continue ;;
  esac
  repos+=("${name}")
done < <(gh repo list kontourai --limit 200 --json name,hasIssuesEnabled,isArchived \
  --jq '.[] | select(.hasIssuesEnabled and (.isArchived | not)) | .name' | sort)

if [ "${#repos[@]}" -eq 0 ]; then
  echo "No target repositories discovered; aborting." >&2
  exit 1
fi

workflow_content='name: Add issue to org project

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
'

pr_body='## Summary

- add the thin caller workflow for org Project v2 intake automation
- sends opened/reopened issues to the central reusable workflow in kontourai/.github

Refs kontourai/flow-agents#441 and kontourai/flow-agents#443.

## Verification

- Not run locally by this rollout script; each generated PR should rely on workflow syntax checks and pilot evidence.
- End-to-end project writes require the ADD_TO_PROJECT_PAT org secret.'

cleanup() {
  rm -rf "${tmp_root}"
}
trap cleanup EXIT

mkdir -p "${tmp_root}"

for repo in "${repos[@]}"; do
  full_repo="kontourai/${repo}"
  checkout="${tmp_root}/${repo}"

  echo "==> Creating rollout PR for ${full_repo}"
  base="${BASE_BRANCH:-$(gh repo view "${full_repo}" --json defaultBranchRef --jq '.defaultBranchRef.name')}"
  gh repo clone "${full_repo}" "${checkout}" -- --depth 1 --branch "${base}"

  (
    cd "${checkout}"
    git checkout -b "${branch}"
    mkdir -p .github/workflows
    workflow_file=".github/workflows/add-to-project.yml"
    candidate="$(mktemp)"
    printf '%s\n' "${workflow_content}" > "${candidate}"

    if [ -e "${workflow_file}" ] && ! cmp -s "${candidate}" "${workflow_file}"; then
      echo "${workflow_file} already exists in ${full_repo}; skipping to avoid overwriting repo-specific automation." >&2
      echo "Review ${full_repo} manually." >&2
      rm -f "${candidate}"
      exit 0
    fi

    mv "${candidate}" "${workflow_file}"

    if git diff --quiet -- .github/workflows/add-to-project.yml; then
      echo "No changes for ${full_repo}; skipping."
      exit 0
    fi

    git add .github/workflows/add-to-project.yml
    git commit -m "Add org project intake workflow"
    git push -u "${remote}" "${branch}"

    gh pr create \
      --repo "${full_repo}" \
      --base "${base}" \
      --head "${branch}" \
      --title "Add org project intake workflow" \
      --body "${pr_body}"
  )
done
