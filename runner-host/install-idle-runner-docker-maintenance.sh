#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-idle-runner-docker-maintenance.sh --maintenance-script PATH \
  --headroom-path PATH --service SERVICE [--service SERVICE ...] [options]

Options:
  --minimum-free-gb N       Default: 20
  --minimum-free-percent N  Default: 15
  --reserved-space SIZE     Default: 20GB
  --on-calendar VALUE       Default: *-*-* 03:30:00
  --unit-name NAME          Default: kontour-runner-docker-maintenance
  --enable-timer            Enable and start the timer after installation

Installs a root-owned script copy plus a systemd oneshot service and timer.
It does not stop or restart runner services. Re-running replaces only the
declared unit and installed script paths.
EOF
}

maintenance_script=''; headroom_path=''; minimum_free_gb=20
minimum_free_percent=15; reserved_space='20GB'; on_calendar='*-*-* 03:30:00'
unit_name='kontour-runner-docker-maintenance'; enable_timer=no
declare -a services=()
while (($#)); do
  case "$1" in
    --maintenance-script) maintenance_script="${2:?missing maintenance script}"; shift 2 ;;
    --headroom-path) headroom_path="${2:?missing headroom path}"; shift 2 ;;
    --service) services+=("${2:?missing service}"); shift 2 ;;
    --minimum-free-gb) minimum_free_gb="${2:?missing minimum free GiB}"; shift 2 ;;
    --minimum-free-percent) minimum_free_percent="${2:?missing minimum free percent}"; shift 2 ;;
    --reserved-space) reserved_space="${2:?missing reserved space}"; shift 2 ;;
    --on-calendar) on_calendar="${2:?missing calendar expression}"; shift 2 ;;
    --unit-name) unit_name="${2:?missing unit name}"; shift 2 ;;
    --enable-timer) enable_timer=yes; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Run as root to install systemd units.' >&2; exit 1; }
[[ -f $maintenance_script && ! -L $maintenance_script && -x $maintenance_script ]] || { echo 'maintenance-script must be an executable regular file, not a symlink.' >&2; exit 2; }
[[ $headroom_path =~ ^/[A-Za-z0-9_./-]*$ && -d $headroom_path ]] || { echo 'headroom-path must be an existing simple absolute directory.' >&2; exit 2; }
((${#services[@]} > 0)) || { echo 'at least one --service is required.' >&2; exit 2; }
[[ $minimum_free_gb =~ ^[0-9]+$ && $minimum_free_percent =~ ^[0-9]+$ ]] || { echo 'free-space thresholds must be non-negative integers.' >&2; exit 2; }
((minimum_free_percent <= 100)) || { echo 'minimum-free-percent may not exceed 100.' >&2; exit 2; }
[[ $reserved_space =~ ^[1-9][0-9]*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$ ]] || { echo 'reserved-space must be a Docker size such as 20GB.' >&2; exit 2; }
[[ $unit_name =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo 'unit-name contains unsupported characters.' >&2; exit 2; }
[[ -n $on_calendar && $on_calendar != *$'\n'* ]] || { echo 'on-calendar may not be empty or contain newlines.' >&2; exit 2; }
for service in "${services[@]}"; do
  [[ $service =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo "invalid service: $service" >&2; exit 2; }
done
command -v systemctl >/dev/null || { echo 'systemctl is required.' >&2; exit 1; }
command -v realpath >/dev/null || { echo 'realpath is required.' >&2; exit 1; }
[[ $(realpath -e -- "$headroom_path") == "$headroom_path" ]] || { echo 'headroom-path must be canonical and may not traverse symlinks.' >&2; exit 2; }

installed_script='/usr/local/sbin/idle-runner-docker-maintenance.sh'
service_path="/etc/systemd/system/${unit_name}.service"
timer_path="/etc/systemd/system/${unit_name}.timer"
install -o root -g root -m 0755 "$maintenance_script" "$installed_script"

service_args=''
for service in "${services[@]}"; do service_args+=" --service $service"; done
service_tmp="$(mktemp "${service_path}.tmp.XXXXXX")"
timer_tmp="$(mktemp "${timer_path}.tmp.XXXXXX")"
cleanup() { rm -f -- "$service_tmp" "$timer_tmp"; }
trap cleanup EXIT
cat >"$service_tmp" <<EOF
[Unit]
Description=Bounded idle Docker build-cache maintenance for self-hosted runners
After=docker.service
Requires=docker.service
ConditionPathIsDirectory=$headroom_path

[Service]
Type=oneshot
ExecStart=$installed_script prune --confirm-idle --headroom-path $headroom_path$service_args --minimum-free-gb $minimum_free_gb --minimum-free-percent $minimum_free_percent --reserved-space $reserved_space
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
EOF
cat >"$timer_tmp" <<EOF
[Unit]
Description=Schedule bounded idle Docker build-cache maintenance

[Timer]
OnCalendar=$on_calendar
Persistent=true
RandomizedDelaySec=10min
Unit=${unit_name}.service

[Install]
WantedBy=timers.target
EOF
chmod 0644 "$service_tmp" "$timer_tmp"
mv -- "$service_tmp" "$service_path"
mv -- "$timer_tmp" "$timer_path"
systemctl daemon-reload
if [[ $enable_timer == yes ]]; then systemctl enable --now "${unit_name}.timer"; fi
printf 'installed_script=%s\nservice=%s\ntimer=%s\nenabled=%s\n' "$installed_script" "$service_path" "$timer_path" "$enable_timer"
