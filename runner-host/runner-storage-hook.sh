#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  runner-storage-hook.sh preflight --workspace-root PATH --headroom-path PATH \
    --minimum-free-gb N --minimum-free-percent N
  runner-storage-hook.sh completed --workspace-root PATH --usage-log PATH \
    [--usage-log-lines N] [--ephemeral-root PATH --job-id ID]

The completed mode removes only an explicit, direct-child scratch directory
that contains the .kontour-ephemeral-job marker. It never removes workspaces,
caches, receipts, or arbitrary runner directories.
EOF
}

require_absolute_directory() {
  local path="$1" label="$2"
  [[ $path == /* && -d $path ]] || { echo "$label must be an existing absolute directory: $path" >&2; exit 2; }
}

free_bytes() { df -Pk "$1" | awk 'NR == 2 { print $4 * 1024 }'; }
free_percent() { df -Pk "$1" | awk 'NR == 2 { sub(/%/, "", $5); print 100 - $5 }'; }

mode="${1:-}"; [[ -n $mode ]] || { usage >&2; exit 2; }; shift || true
workspace_root=''; headroom_path=''; minimum_free_gb=''; minimum_free_percent=''
usage_log=''; usage_log_lines=200; ephemeral_root=''; job_id=''
while (($#)); do
  case "$1" in
    --workspace-root) workspace_root="${2:?missing workspace root}"; shift 2 ;;
    --headroom-path) headroom_path="${2:?missing headroom path}"; shift 2 ;;
    --minimum-free-gb) minimum_free_gb="${2:?missing free GB}"; shift 2 ;;
    --minimum-free-percent) minimum_free_percent="${2:?missing free percent}"; shift 2 ;;
    --usage-log) usage_log="${2:?missing usage log}"; shift 2 ;;
    --usage-log-lines) usage_log_lines="${2:?missing usage log line count}"; shift 2 ;;
    --ephemeral-root) ephemeral_root="${2:?missing ephemeral root}"; shift 2 ;;
    --job-id) job_id="${2:?missing job id}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$mode" in
  preflight)
    require_absolute_directory "$workspace_root" workspace-root
    require_absolute_directory "$headroom_path" headroom-path
    [[ $minimum_free_gb =~ ^[0-9]+$ && $minimum_free_percent =~ ^[0-9]+$ && $minimum_free_percent -le 100 ]] || { echo 'free-space thresholds must be non-negative integers; percent must be <= 100.' >&2; exit 2; }
    required_bytes=$((minimum_free_gb * 1024 * 1024 * 1024))
    for checked_path in "$workspace_root" "$headroom_path"; do
      available_bytes="$(free_bytes "$checked_path")"
      available_percent="$(free_percent "$checked_path")"
      if (( available_bytes < required_bytes || available_percent < minimum_free_percent )); then
        echo "Runner storage preflight failed for $checked_path: free=${available_bytes}B/${available_percent}%, required>=${minimum_free_gb}GiB and >=${minimum_free_percent}%" >&2
        exit 1
      fi
    done
    ;;
  completed)
    require_absolute_directory "$workspace_root" workspace-root
    [[ $usage_log == /* && $usage_log_lines =~ ^[1-9][0-9]*$ ]] || { echo 'usage log must be absolute and usage-log-lines positive.' >&2; exit 2; }
    mkdir -p "$(dirname "$usage_log")"
    printf '%s workspace=%s used_bytes=%s free_bytes=%s\n' "$(date -u +%FT%TZ)" "$workspace_root" "$(du -sxB1 "$workspace_root" | awk '{print $1}')" "$(free_bytes "$workspace_root")" >> "$usage_log"
    tail -n "$usage_log_lines" "$usage_log" > "${usage_log}.tmp"
    mv "${usage_log}.tmp" "$usage_log"
    if [[ -n $ephemeral_root || -n $job_id ]]; then
      require_absolute_directory "$ephemeral_root" ephemeral-root
      [[ $job_id =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'job-id must be a simple path component.' >&2; exit 2; }
      job_path="$ephemeral_root/$job_id"
      [[ $(dirname "$job_path") == "$ephemeral_root" ]] || { echo 'refusing non-direct ephemeral child.' >&2; exit 2; }
      if [[ -e $job_path ]]; then
        [[ -d $job_path && -f "$job_path/.kontour-ephemeral-job" ]] || { echo "refusing to remove unmarked path: $job_path" >&2; exit 1; }
        rm -rf --one-file-system "$job_path"
      fi
    fi
    ;;
  *) echo "Unknown mode: $mode" >&2; usage >&2; exit 2 ;;
esac
