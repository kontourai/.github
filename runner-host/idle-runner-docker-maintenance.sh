#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  idle-runner-docker-maintenance.sh status --headroom-path PATH \
    --service SERVICE [--service SERVICE ...] [options]
  idle-runner-docker-maintenance.sh dry-run --headroom-path PATH \
    --service SERVICE [--service SERVICE ...] [options]
  idle-runner-docker-maintenance.sh prune --confirm-idle --headroom-path PATH \
    --service SERVICE [--service SERVICE ...] [options]

Options:
  --minimum-free-gb N       Prune when free space is below N GiB (default: 20).
  --minimum-free-percent N  Prune when free space is below N percent (default: 15).
  --reserved-space SIZE     Docker build cache retained after prune (default: 20GB).
  --maintenance-lock PATH   Host-wide watcher/maintenance lock.
  --receipt-path PATH       Atomic latest-run receipt (default under /var/lib).
  --log-path PATH           Bounded latest Docker output (default under /var/log).
  --log-lines N             Maximum retained Docker output lines (default: 200).

This command never removes images, containers, volumes, or project caches. It
only runs `docker builder prune --force --reserved-space SIZE`, and only after
every declared runner service is explicitly inactive, no Runner process exists,
no container is running, no local build client exists, and the shared host lock
has been acquired. Busy scheduled runs exit successfully without mutation.
EOF
}

mode="${1:-}"
[[ $mode =~ ^(status|dry-run|prune)$ ]] || { usage >&2; exit 2; }
shift

headroom_path=''; minimum_free_gb=20; minimum_free_percent=15
reserved_space='20GB'; confirm_idle=no; log_lines=200
maintenance_lock='/run/lock/kontour-runner-host-maintenance.lock'
receipt_path='/var/lib/kontour-runner-storage/docker-cache-maintenance.receipt'
log_path='/var/log/kontour-runner-docker-maintenance.log'
declare -a services=()

while (($#)); do
  case "$1" in
    --headroom-path) headroom_path="${2:?missing headroom path}"; shift 2 ;;
    --service) services+=("${2:?missing service}"); shift 2 ;;
    --minimum-free-gb) minimum_free_gb="${2:?missing minimum free GiB}"; shift 2 ;;
    --minimum-free-percent) minimum_free_percent="${2:?missing minimum free percent}"; shift 2 ;;
    --reserved-space) reserved_space="${2:?missing reserved space}"; shift 2 ;;
    --maintenance-lock) maintenance_lock="${2:?missing maintenance lock path}"; shift 2 ;;
    --receipt-path) receipt_path="${2:?missing receipt path}"; shift 2 ;;
    --log-path) log_path="${2:?missing log path}"; shift 2 ;;
    --log-lines) log_lines="${2:?missing log lines}"; shift 2 ;;
    --confirm-idle) confirm_idle=yes; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

require_uint() { [[ $1 =~ ^[0-9]+$ ]] || { echo "$2 must be a non-negative integer." >&2; exit 2; }; }
require_path() {
  [[ $1 == /* && $1 != *$'\n'* ]] || { echo "$2 must be an absolute path without newlines." >&2; exit 2; }
}
require_service() { [[ $1 =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo "service must be a simple .service unit name: $1" >&2; exit 2; }; }

[[ -d $headroom_path ]] || { echo 'headroom-path must be an existing directory.' >&2; exit 2; }
((${#services[@]} > 0)) || { echo 'at least one --service is required.' >&2; exit 2; }
require_uint "$minimum_free_gb" minimum-free-gb
require_uint "$minimum_free_percent" minimum-free-percent
((minimum_free_percent <= 100)) || { echo 'minimum-free-percent may not exceed 100.' >&2; exit 2; }
require_uint "$log_lines" log-lines
((log_lines > 0)) || { echo 'log-lines must be positive.' >&2; exit 2; }
[[ $reserved_space =~ ^[1-9][0-9]*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$ ]] || { echo 'reserved-space must be a positive Docker size such as 20GB.' >&2; exit 2; }
for service in "${services[@]}"; do require_service "$service"; done
for path_spec in "$maintenance_lock:maintenance-lock" "$receipt_path:receipt-path" "$log_path:log-path"; do
  require_path "${path_spec%%:*}" "${path_spec#*:}"
done
for command_name in flock systemctl pgrep docker df awk mktemp tail; do
  command -v "$command_name" >/dev/null || { echo "$command_name is required." >&2; exit 1; }
done
[[ $mode != prune || $confirm_idle == yes ]] || { echo 'prune requires --confirm-idle.' >&2; exit 2; }

mkdir -p "$(dirname "$receipt_path")" "$(dirname "$log_path")"
[[ -d $(dirname "$maintenance_lock") ]] || { echo 'maintenance-lock parent must exist.' >&2; exit 2; }

exec 9>"$maintenance_lock"
if ! flock -n -x 9; then
  printf 'result=skipped_busy reason=host_maintenance_lock mode=%s\n' "$mode"
  exit 0
fi

busy_reason=''
for service in "${services[@]}"; do
  load_state="$(systemctl show --property=LoadState --value "$service" 2>/dev/null || true)"
  [[ $load_state == loaded ]] || { busy_reason="unknown_service:$service"; break; }
  active_state="$(systemctl is-active "$service" 2>/dev/null || true)"
  [[ $active_state == inactive ]] || { busy_reason="service_not_inactive:$service:$active_state"; break; }
done
if [[ -z $busy_reason ]]; then
  if pgrep -f 'Runner\.(Worker|Listener)' >/dev/null 2>&1; then
    busy_reason=runner_process
  elif (($? != 1)); then
    busy_reason=runner_process_check_failed
  fi
fi
if [[ -z $busy_reason ]]; then
  if ! running_containers="$(docker ps --quiet 2>/dev/null)"; then
    busy_reason=docker_ps_failed
  elif [[ -n $running_containers ]]; then
    busy_reason=running_container
  fi
fi
if [[ -z $busy_reason ]]; then
  if pgrep -f '(^|/)(docker|buildctl)([[:space:]]+)(build|buildx)([[:space:]]|$)' >/dev/null 2>&1; then
    busy_reason=build_client
  elif (($? != 1)); then
    busy_reason=build_client_check_failed
  fi
fi

read -r total_bytes _ free_bytes capacity_percent < <(df -PB1 -- "$headroom_path" | awk 'NR==2 {gsub(/%/, "", $5); print $2, $3, $4, $5}')
[[ ${total_bytes:-} =~ ^[0-9]+$ && ${free_bytes:-} =~ ^[0-9]+$ && ${capacity_percent:-} =~ ^[0-9]+$ ]] || { echo 'could not read filesystem headroom.' >&2; exit 1; }
free_percent=$((100 - capacity_percent))
minimum_free_bytes=$((minimum_free_gb * 1024 * 1024 * 1024))
needs_prune=no
((free_bytes < minimum_free_bytes || free_percent < minimum_free_percent)) && needs_prune=yes

write_receipt() {
  local result="$1" reason="$2" before_free="$3" after_free="$4" temporary
  temporary="$(mktemp "${receipt_path}.tmp.XXXXXX")"
  chmod 0600 "$temporary"
  {
    printf 'version=1\n'
    printf 'at=%s\n' "$(date -u +%FT%TZ)"
    printf 'mode=%s\nresult=%s\nreason=%s\n' "$mode" "$result" "$reason"
    printf 'headroom_path=%s\nbefore_free_bytes=%s\nafter_free_bytes=%s\n' "$headroom_path" "$before_free" "$after_free"
    printf 'minimum_free_gb=%s\nminimum_free_percent=%s\nreserved_space=%s\n' "$minimum_free_gb" "$minimum_free_percent" "$reserved_space"
  } >"$temporary"
  mv -- "$temporary" "$receipt_path"
}

if [[ -n $busy_reason ]]; then
  write_receipt skipped_busy "$busy_reason" "$free_bytes" "$free_bytes"
  printf 'result=skipped_busy reason=%s free_bytes=%s free_percent=%s\n' "$busy_reason" "$free_bytes" "$free_percent"
  exit 0
fi
if [[ $needs_prune == no ]]; then
  write_receipt skipped_headroom_sufficient threshold_not_reached "$free_bytes" "$free_bytes"
  printf 'result=skipped_headroom_sufficient free_bytes=%s free_percent=%s\n' "$free_bytes" "$free_percent"
  exit 0
fi
if [[ $mode != prune ]]; then
  write_receipt would_prune threshold_reached "$free_bytes" "$free_bytes"
  printf 'result=would_prune free_bytes=%s free_percent=%s reserved_space=%s\n' "$free_bytes" "$free_percent" "$reserved_space"
  exit 0
fi

temporary_log="$(mktemp "${log_path}.tmp.XXXXXX")"
cleanup() { rm -f -- "$temporary_log"; }
trap cleanup EXIT
if docker builder prune --force --reserved-space "$reserved_space" >"$temporary_log" 2>&1; then
  tail -n "$log_lines" "$temporary_log" >"$log_path"
else
  result=$?
  tail -n "$log_lines" "$temporary_log" >"$log_path"
  write_receipt failed docker_builder_prune_failed "$free_bytes" "$free_bytes"
  echo "docker builder prune failed; bounded output is at $log_path" >&2
  exit "$result"
fi
read -r _ _ after_free_bytes _ < <(df -PB1 -- "$headroom_path" | awk 'NR==2 {gsub(/%/, "", $5); print $2, $3, $4, $5}')
[[ ${after_free_bytes:-} =~ ^[0-9]+$ ]] || { echo 'could not read post-prune filesystem headroom.' >&2; exit 1; }
write_receipt pruned threshold_reached "$free_bytes" "$after_free_bytes"
printf 'result=pruned before_free_bytes=%s after_free_bytes=%s reserved_space=%s log=%s receipt=%s\n' "$free_bytes" "$after_free_bytes" "$reserved_space" "$log_path" "$receipt_path"
