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

## Self-hosted build fleet

Kontour CI jobs select capabilities, not a physical host. Use the smallest label
set that describes the work:

```yaml
jobs:
  linux-container-tests:
    runs-on: [self-hosted, Linux, X64, kontour-linux, docker]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      # Replace the placeholder with a reviewed full commit SHA.
      - uses: kontourai/.github/actions/runner-preflight@<full-commit-sha>
        with:
          require-docker: "true"
      - run: npm test

  windows-native-tests:
    runs-on: [self-hosted, Windows, X64, kontour-windows, native]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      # Replace the placeholder with a reviewed full commit SHA.
      - uses: kontourai/.github/actions/runner-preflight@<full-commit-sha>
      - shell: pwsh
        run: npm test
```

`kontour-linux` and `kontour-windows` are the stable fleet contracts. Add a
capability label such as `docker` or `native` only when the job needs it. Do not
use the `desktop-win` diagnostic label in normal workflows: keeping the host
out of the contract lets another machine satisfy the same job without a CI
edit. Add an `android` label only after the complete Android toolchain has been
installed and smoke-tested on that runner.

The lightweight `runner-preflight` composite action fails early when a runner
does not provide the capability its labels promise. The reusable
[`self-hosted-runner-smoke.yml`](.github/workflows/self-hosted-runner-smoke.yml)
workflow tests the shared fleet itself and can be called from another workflow:

```yaml
jobs:
  build-fleet:
    # Replace the placeholder with a reviewed full commit SHA.
    uses: kontourai/.github/.github/workflows/self-hosted-runner-smoke.yml@<full-commit-sha>
```

Always use an immutable full commit SHA for shared actions and workflows that
run on persistent infrastructure. Dependabot or a deliberate fleet-contract PR
should advance that pin; do not let a moving branch silently change executable
CI in every consumer.

Private does not automatically mean trusted. Persistent runners must execute
only protected refs, reviewed manual dispatches, or branches whose authors are
trusted with host-level code execution. Do not route untrusted forks or other
untrusted `pull_request` code to them, including through `pull_request_target`.
Use GitHub-hosted or one-job ephemeral runners for untrusted changes. Restrict
the organization runner group to explicitly enrolled repositories (and selected
workflows where the provider supports it), grant minimal permissions, and set
`persist-credentials: false` on checkouts that do not push.

Keep job output bounded, set a timeout on every self-hosted job, use workflow
`concurrency` to cancel superseded branch runs, and leave repository-specific
dependency caches to the owning workflow. Each runner accepts one job at a
time; horizontal capacity comes from registering more runners with the same
capability labels.

For a Windows host whose WSL distribution needs an SSD-backed runner workspace,
use the generic [Windows + WSL runner workspace kit](runner-host/README.md).
It attaches a parameterized VHD at boot and mounts it by ext4 UUID before
runner services start; it does not modify a live host from this repository.

### Shared physical-host capacity

Windows-native and WSL/Linux runners can still compete for CPU, RAM, disk, or a
single GPU when they are registered on the same physical Windows host. Use the
`physical-host-capacity` action for that shared-host subset. It acquires a
weighted lease rather than serializing every job, and its JavaScript action
post-step releases the lease after normal failure or workflow cancellation.

The `coordination-root` values below are different OS paths to the **same
NTFS-backed directory**. `host-id` is a stable literal identity for that one
physical host, not the Windows or WSL runner name. Give only trusted runner
identities write access to that directory; a writer can reserve or remove
capacity for every participant.

```yaml
jobs:
  windows-native-build:
    runs-on: [self-hosted, Windows, X64, kontour-windows, native]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - uses: kontourai/.github/actions/physical-host-capacity@<full-commit-sha>
        with:
          coordination-root: 'D:\kontour-runner-capacity'
          host-id: desktop-win-01
          capacity-units: '8'
          lease-weight: '5'
          timeout-seconds: '240'
          owner-lifetime-seconds: '6000' # shared 90-minute maximum plus 10-minute margin
      - shell: pwsh
        run: npm test

  wsl-linux-tests:
    runs-on: [self-hosted, Linux, X64, kontour-linux, docker]
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - uses: kontourai/.github/actions/physical-host-capacity@<full-commit-sha>
        with:
          coordination-root: /mnt/d/kontour-runner-capacity
          host-id: desktop-win-01
          capacity-units: '8'
          lease-weight: '3'
          timeout-seconds: '240'
          owner-lifetime-seconds: '6000' # shared 90-minute maximum plus 10-minute margin
      - run: npm test
```

Inputs are parsed as strict integers (`timeout-seconds` may be `0` for an
immediate fail). The root must be an existing absolute path and must be
provisioned before any workflow can use it; the action never creates a root,
marker, manifest, or queue directories. Provision once from a trusted host
administrator account, using either the Windows root or its WSL mount:

```sh
node scripts/provision-physical-host-capacity.mjs \
  --root /mnt/d/kontour-runner-capacity \
  --host-id desktop-win-01 \
  --capacity-units 8 \
  --owner-lifetime-seconds 6000
```

Provisioning writes an externally located `.kontour-physical-host-id` marker
and a schema-versioned `host-manifest.json`. Its host ID, capacity,
owner lifetime, and `bounded-owner-deadline-v1` strategy are authoritative:
every participant must match them exactly before acquire or release
can proceed. Update those values only after draining the root and deliberately
re-provisioning it.

The action never starts a detached process. Its post step releases the lease on
normal failure or cancellation. If GitHub removes a command file after the
lease is acquired, the main step releases its own lease immediately; the post
step remains an idempotent fallback. Both lease and FIFO ticket records include
repository, run/attempt, workflow, job, and runner metadata to make contention
diagnostics actionable while a job is still waiting. The coordinator owns each
record's token, weight, sequence (tickets), and timestamps; caller metadata
cannot replace those fields.
If the runner is lost before either cleanup path can run, a later participant
reclaims its lease or queue ticket only after the recorded owner lifetime
expires. Set `owner-lifetime-seconds` to at least the workflow job's
`timeout-minutes` in seconds plus a conservative recovery margin; all callers
for a root must use the same value.

This is the action's liveness boundary without a GitHub token or API: expiry
does not probe GitHub or prove a process died. It is safe only because the
workflow contract guarantees the owner cannot still run beyond its declared job
timeout. Do not set a lifetime below that timeout. The shared default is 6000
seconds: Station's 90-minute maximum job timeout plus ten minutes of margin.

Roots provisioned by schema v6 are read in compatibility mode so the first
updated participant can clear the stranded records from a killed runner. Those
legacy records have no deadline, so their shared-file timestamp uses at least
the 6000-second shared safety floor even if a caller supplies a shorter value.
Drain and re-provision the root afterward to make the v7 deadline contract
authoritative. Do not change a v7 root's shared lifetime while live records
exist: drain it first, then re-provision every caller with the same value.

Waiting jobs create durable weighted FIFO tickets. Their order comes from a
shared monotonic sequence assigned under the control protocol—not process
clock time—so Windows/WSL wall-clock skew cannot reorder waiters. Only the
oldest ticket may claim available capacity, so later small jobs cannot starve
an older larger job. The action deliberately does not backfill a smaller ticket
around an oversized head: without a separate bounded-bypass and aging policy,
that optimization can starve the head indefinitely. Timeout cleanup retries independently for up to five
seconds even when the acquisition timeout is zero.
Contention diagnostics are capped and include an omitted-entry count. Each
shown lease or ticket identifies its repository, run/attempt, workflow, job,
and runner; individual metadata values are length-bounded. Older records that
predate this metadata remain valid and are reported as `unknown`, rather than
being treated as corrupt. Use the ticket UUID in the diagnostic with the
recovery command only after the documented quiescence check.

Sequence values are append-only directory markers, so a crash can leave a gap
but cannot truncate or reorder an assigned value. Lease and ticket JSON is
written and fsynced in the private `staging/` directory before an atomic rename
publishes the final record.

Control ownership uses a fully-synced candidate JSON file with an immutable
owner token, instance token, and bounded repository/run/workflow/job/runner
metadata. It atomically hard-links that file to `control-tickets/active`, so
Windows and WSL observe one immutable active record with no empty-lock window.
The normal post step may reclaim an active lock only when its persisted owner
token exactly matches that same job's token—for example, when GitHub cancelled
its `acquire` process while it held control. Cleanup first hard-links the exact
active instance to a deterministic private retirement claim; only the cleaner
that created that claim may unlink `active`. A second same-owner cleanup never
deletes a later foreign active record. The live candidate remains an inode
witness until protected work exits: immediately before entering that work,
`active` must still name the exact owner/instance and inode, never merely the
same owner token.

Candidate and retired artifacts are cleaned only when their filename and
owner token exactly match the post step. A retirement claim whose active link
still exists is intentionally fail-closed: it means a cleaner may have died
between claiming and unlinking, so it requires the documented quiesced manual
recovery rather than automatic stealing. If `active` is already absent, a
later invocation with that exact owner token consumes only its deterministic
detached candidate and retirement paths before it publishes a new lock; it
never scans or removes other owners' artifacts. Different owners never steal
automatically, and incomplete, malformed, or redirected active records fail
closed. After draining the runners and confirming no owner job is live, an
operator must create the distinct regular
`.kontour-physical-host-quiesced` file (never the permanent identity marker)
containing exactly the host ID after draining the runners, then run the
explicit recovery command for one record:

```sh
printf 'desktop-win-01\n' > /mnt/d/kontour-runner-capacity/.kontour-physical-host-quiesced
node scripts/recover-physical-host-capacity.mjs \
  --root /mnt/d/kontour-runner-capacity \
  --host-id desktop-win-01 \
  --capacity-units 8 \
  --owner-lifetime-seconds 6000 \
  --recover lease:<owner-uuid>
```

Use `--recover ticket:<owner-uuid>` for a confirmed-abandoned queue ticket,
`--recover sequence:<20-digit-marker>` only for a malformed regular sequence
entry, or `--recover control:active` for a wedged control record. The command never
accepts a broad clear operation. Never delete the external marker, manifest,
queue-sequence directory, staging directory, or an unreviewed record. On success it removes the
quiescence marker; on failure, inspect it before removing it when the root is
safe to resume.

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

The checkout depth is not caller-configurable: the workflow always checks out
full history (`fetch-depth: 0`) and fails closed with a non-zero exit unless
`git rev-parse --is-shallow-repository` reports exactly `false`. A shallow
checkout, an empty result, an unexpected value, or the command itself
erroring all fail the run rather than silently scanning a partial history.

Self-hosted secret scans must provide capacity root and host identity. The
reusable workflow fixes `capacity-owner-lifetime-seconds` at 6000 seconds and
forwards it to the physical-host action, so it remains compatible with the
shared 90-minute Station capacity manifest.

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
