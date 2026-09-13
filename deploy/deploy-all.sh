#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-}"

case "$ENV_NAME" in
  prod|dev)
    ;;
  *)
    echo "Usage: $0 <prod|dev>" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="/root/hodouri/deploy/hudoori"

"$SCRIPT_DIR/build-backend.sh" "$ENV_NAME"
"$SCRIPT_DIR/build-dashboard.sh" "$ENV_NAME"
pm2 startOrReload "$SCRIPT_DIR/pm2.ecosystem.config.cjs" --only "biotime-backend-$ENV_NAME,hudoori-dashboard-$ENV_NAME"
