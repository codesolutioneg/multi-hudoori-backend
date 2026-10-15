#!/usr/bin/env bash
# Daily Hudoori Multi DB backup → offsite (same spirit as legacy backup-prod-db.sh).
# Read-only dump. Does NOT restore, clone to dev, or expose Postgres.
set -euo pipefail

APP_DIR="/opt/hudoori-multi"
ENV_FILE="${APP_DIR}/backend/.env"
DB_ENV_FILE="${APP_DIR}/db.env"
LOCAL_DIR="/var/backups/hudoori-multi-local"
LOG_FILE="${LOCAL_DIR}/backup.log"
SSH_KEY="${SSH_KEY:-/root/.ssh/hudoori_multi_prod_to_backup_ed25519}"
REMOTE_USER="hudoori-backup"
REMOTE_HOST="164.68.110.233"
CONTAINER="hudoori-multi-postgres"

mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "ERROR: missing $ENV_FILE"
  exit 1
fi
if [[ ! -f "$DB_ENV_FILE" ]]; then
  log "ERROR: missing $DB_ENV_FILE"
  exit 1
fi

DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [[ -z "${DATABASE_URL:-}" ]]; then
  log "ERROR: DATABASE_URL empty in $ENV_FILE"
  exit 1
fi

# App role is RLS-bound; dump as Postgres superuser from db.env (read-only dump).
DB_NAME="$(python3 -c 'import sys,urllib.parse; u=urllib.parse.urlparse(sys.argv[1]); print((u.path or "").lstrip("/") or "")' "$DATABASE_URL")"
DB_USER="$(grep -E '^POSTGRES_USER=' "$DB_ENV_FILE" | head -1 | cut -d= -f2-)"
DB_PASS="$(grep -E '^POSTGRES_PASSWORD=' "$DB_ENV_FILE" | head -1 | cut -d= -f2-)"

if [[ -z "$DB_USER" || -z "$DB_NAME" ]]; then
  log "ERROR: could not resolve dump user/db (db.env + DATABASE_URL)"
  exit 1
fi

STAMP="$(date +%Y-%m-%d_%H%M)"
DUMP_NAME="hudoori_multi_${STAMP}.dump"
LOCAL_PATH="${LOCAL_DIR}/${DUMP_NAME}"
REMOTE_PATH="./${DUMP_NAME}"

log "START dump db=${DB_NAME} user=${DB_USER} → ${LOCAL_PATH}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "ERROR: container $CONTAINER not running"
  exit 1
fi

# Dump inside container (Postgres not exposed publicly; only localhost on host).
docker exec \
  -e PGDATABASE="$DB_NAME" \
  -e PGUSER="$DB_USER" \
  -e PGPASSWORD="$DB_PASS" \
  "$CONTAINER" \
  pg_dump --format=custom --compress=6 --no-owner -f "/tmp/${DUMP_NAME}"

docker cp "${CONTAINER}:/tmp/${DUMP_NAME}" "$LOCAL_PATH"
docker exec "$CONTAINER" rm -f "/tmp/${DUMP_NAME}"

if [[ ! -s "$LOCAL_PATH" ]]; then
  log "ERROR: dump file missing or empty: $LOCAL_PATH"
  exit 1
fi

SIZE="$(du -h "$LOCAL_PATH" | awk '{print $1}')"
log "DUMP OK size=${SIZE}"

if [[ ! -f "$SSH_KEY" ]]; then
  log "ERROR: SSH key missing: $SSH_KEY (copy private key from backup server)"
  exit 1
fi
chmod 600 "$SSH_KEY"

log "START rsync → ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"
rsync -a -e "ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  "$LOCAL_PATH" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"

log "RSYNC OK — removing local dump"
rm -f "$LOCAL_PATH"
log "DONE ${DUMP_NAME}"
