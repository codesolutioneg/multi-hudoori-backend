#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-}"

case "$ENV_NAME" in
  prod)
    APP_DIR="/root/hodouri/bio_time_backend"
    ENV_FILE="$APP_DIR/.env.prod"
    ;;
  dev)
    APP_DIR="/root/hodouri/bio_time_backend-dev"
    ENV_FILE="$APP_DIR/.env.dev"
    ;;
  *)
    echo "Usage: $0 <prod|dev>" >&2
    exit 1
    ;;
esac

cd "$APP_DIR"
set -a
source "$ENV_FILE"
set +a

# NODE_ENV=production would skip @types/*; install them for the TypeScript build.
npm ci --include=dev
npx prisma generate
npx prisma migrate deploy
npm run build
