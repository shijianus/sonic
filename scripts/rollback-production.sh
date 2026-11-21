#!/usr/bin/env bash
# Preserve the documented entry point and serialize local execute/recover operations.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if (( $# <= 1 )) && [[ "${1:-}" == "--execute" || "${1:-}" == "--recover" ]]; then
  state_dir="${SONIC_ROLLBACK_STATE_DIR:-${SCRIPT_DIR}/../rollback-backups}"
  umask 077
  mkdir -p -- "$state_dir"
  exec flock -n -E 75 "$state_dir/.operation.lock" node "$SCRIPT_DIR/rollback-production.mjs" "$@"
fi
exec node "$SCRIPT_DIR/rollback-production.mjs" "$@"
