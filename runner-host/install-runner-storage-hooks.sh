#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-runner-storage-hooks.sh --hook-script PATH --workspace-root PATH \
  --headroom-path PATH --minimum-free-gb N --minimum-free-percent N \
  --usage-log PATH --runner-service-user USER --runner-root PATH [--runner-root PATH ...]

Creates per-runner hook wrappers under each runner root and prints the two
ACTIONS_RUNNER_HOOK_* exports to place in that runner's service environment.
It provisions a service-user-writable usage-log directory and never edits or
restarts a service.
EOF
}

hook_script=''; workspace_root=''; headroom_path=''; minimum_free_gb=''; minimum_free_percent=''; usage_log=''; runner_service_user=''
declare -a runner_roots=()
while (($#)); do
  case "$1" in
    --hook-script) hook_script="${2:?missing hook script}"; shift 2 ;;
    --workspace-root) workspace_root="${2:?missing workspace root}"; shift 2 ;;
    --headroom-path) headroom_path="${2:?missing headroom path}"; shift 2 ;;
    --minimum-free-gb) minimum_free_gb="${2:?missing free GB}"; shift 2 ;;
    --minimum-free-percent) minimum_free_percent="${2:?missing free percent}"; shift 2 ;;
    --usage-log) usage_log="${2:?missing usage log}"; shift 2 ;;
    --runner-service-user) runner_service_user="${2:?missing runner service user}"; shift 2 ;;
    --runner-root) runner_roots+=("${2:?missing runner root}"); shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo 'Run as root to provision the runner service log path.' >&2; exit 1; }
[[ -x $hook_script && $workspace_root == /* && $headroom_path == /* && $usage_log == /* && -n $runner_service_user && ${#runner_roots[@]} -gt 0 ]] || { usage >&2; exit 2; }
command -v realpath >/dev/null || { echo 'realpath is required.' >&2; exit 1; }
command -v runuser >/dev/null || { echo 'runuser is required to validate runner-service-user access.' >&2; exit 1; }
id -u "$runner_service_user" >/dev/null 2>&1 || { echo "runner service user does not exist: $runner_service_user" >&2; exit 2; }
runner_service_group="$(id -gn "$runner_service_user")"
usage_log_directory="$(dirname "$usage_log")"
[[ ! -L $usage_log && ! -L $usage_log_directory ]] || { echo 'usage log path and parent directory may not be symlinks.' >&2; exit 2; }
if [[ ! -e $usage_log_directory ]]; then
  install -d -o "$runner_service_user" -g "$runner_service_group" -m 0750 "$usage_log_directory"
fi
[[ -d $usage_log_directory ]] || { echo "usage log parent is not a directory: $usage_log_directory" >&2; exit 2; }
[[ $(realpath -e -- "$usage_log_directory") == $(realpath -m -- "$usage_log_directory") ]] || { echo 'usage log directory must be canonical and may not traverse symlinks.' >&2; exit 2; }
if [[ -e $usage_log ]]; then
  [[ -f $usage_log && ! -L $usage_log ]] || { echo "usage log must be a regular file: $usage_log" >&2; exit 2; }
else
  install -o "$runner_service_user" -g "$runner_service_group" -m 0640 /dev/null "$usage_log"
fi
runuser -u "$runner_service_user" -- test -w "$usage_log_directory"
runuser -u "$runner_service_user" -- test -w "$usage_log"
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
