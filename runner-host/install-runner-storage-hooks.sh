#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-runner-storage-hooks.sh --hook-script PATH --workspace-root PATH \
  --headroom-path PATH --minimum-free-gb N --minimum-free-percent N \
  --usage-log PATH --runner-root PATH [--runner-root PATH ...]

Creates per-runner hook wrappers under each runner root and prints the two
ACTIONS_RUNNER_HOOK_* exports to place in that runner's service environment.
It never edits or restarts a service.
EOF
}

hook_script=''; workspace_root=''; headroom_path=''; minimum_free_gb=''; minimum_free_percent=''; usage_log=''
declare -a runner_roots=()
while (($#)); do
  case "$1" in
    --hook-script) hook_script="${2:?missing hook script}"; shift 2 ;;
    --workspace-root) workspace_root="${2:?missing workspace root}"; shift 2 ;;
    --headroom-path) headroom_path="${2:?missing headroom path}"; shift 2 ;;
    --minimum-free-gb) minimum_free_gb="${2:?missing free GB}"; shift 2 ;;
    --minimum-free-percent) minimum_free_percent="${2:?missing free percent}"; shift 2 ;;
    --usage-log) usage_log="${2:?missing usage log}"; shift 2 ;;
    --runner-root) runner_roots+=("${2:?missing runner root}"); shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -x $hook_script && $workspace_root == /* && $headroom_path == /* && $usage_log == /* && ${#runner_roots[@]} -gt 0 ]] || { usage >&2; exit 2; }
printf -v hook_q '%q' "$hook_script"
printf -v workspace_q '%q' "$workspace_root"
printf -v headroom_q '%q' "$headroom_path"
printf -v minimum_gb_q '%q' "$minimum_free_gb"
printf -v minimum_percent_q '%q' "$minimum_free_percent"
printf -v usage_log_q '%q' "$usage_log"

for runner_root in "${runner_roots[@]}"; do
  [[ $runner_root == /* && -d $runner_root ]] || { echo "runner root must be an existing absolute directory: $runner_root" >&2; exit 2; }
  hook_dir="$runner_root/.kontour-hooks"; mkdir -p "$hook_dir"
  cat > "$hook_dir/job-started.sh" <<EOF
#!/usr/bin/env bash
exec $hook_q preflight --workspace-root $workspace_q --headroom-path $headroom_q --minimum-free-gb $minimum_gb_q --minimum-free-percent $minimum_percent_q
EOF
  cat > "$hook_dir/job-completed.sh" <<EOF
#!/usr/bin/env bash
exec $hook_q completed --workspace-root $workspace_q --usage-log $usage_log_q
EOF
  chmod 0755 "$hook_dir/job-started.sh" "$hook_dir/job-completed.sh"
  printf 'runner=%s\nACTIONS_RUNNER_HOOK_JOB_STARTED=%s\nACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\n' "$runner_root" "$hook_dir/job-started.sh" "$hook_dir/job-completed.sh"
done
