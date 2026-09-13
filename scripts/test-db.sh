#!/usr/bin/env bash
# Bring up (or tear down) the Postgres instance the test suite runs against.
#
#   ./scripts/test-db.sh up     start container, apply migrations, seed
#   ./scripts/test-db.sh down   stop and remove the container
#   ./scripts/test-db.sh reset  drop the schema and re-apply migrations
#
# Default DB name is biotime_test. NEVER point this at biotime_dev or biotime.
set -euo pipefail

CONTAINER="${TEST_DB_CONTAINER:-hudoori-test-db}"
PORT="${TEST_DB_PORT:-5434}"
PGUSER_="${TEST_DB_USER:-biotime}"
PGPASS="${TEST_DB_PASSWORD:-biotime_dev_password}"
PGDB="${TEST_DB_NAME:-biotime_test}"
export DATABASE_URL="${TEST_DATABASE_URL:-postgresql://${PGUSER_}:${PGPASS}@127.0.0.1:${PORT}/${PGDB}}"

case "$PGDB" in
  biotime|biotime_dev)
    echo "Refusing TEST_DB_NAME=$PGDB — use biotime_test (or another isolated name)." >&2
    exit 1
    ;;
esac

wait_ready() {
  for _ in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U "$PGUSER_" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Postgres did not become ready in 30s" >&2
  exit 1
}

case "${1:-up}" in
  up)
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "▸ $CONTAINER already running"
    elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      echo "▸ starting existing $CONTAINER"
      docker start "$CONTAINER" >/dev/null
      wait_ready
    elif docker ps --format '{{.Names}}' | grep -qx biotime_postgres && [[ "$PORT" == "5434" ]]; then
      echo "▸ reusing biotime_postgres on :$PORT — creating DB $PGDB if needed"
      docker exec biotime_postgres psql -U "$PGUSER_" -d postgres -tc \
        "SELECT 1 FROM pg_database WHERE datname='${PGDB}'" | grep -q 1 \
        || docker exec biotime_postgres psql -U "$PGUSER_" -d postgres \
          -c "CREATE DATABASE ${PGDB} OWNER ${PGUSER_};"
    else
      echo "▸ creating $CONTAINER on port $PORT"
      docker run -d --name "$CONTAINER" \
        -e POSTGRES_USER="$PGUSER_" \
        -e POSTGRES_PASSWORD="$PGPASS" \
        -e POSTGRES_DB="$PGDB" \
        -p "${PORT}:5432" \
        postgres:16 \
        -c fsync=off -c synchronous_commit=off -c full_page_writes=off >/dev/null
      wait_ready
    fi
    echo "▸ applying migrations"
    npx prisma migrate deploy
    echo "▸ seeding"
    npx ts-node prisma/seed.ts
    echo "✔ test database ready at $DATABASE_URL"
    ;;
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "✔ $CONTAINER removed"
    ;;
  reset)
    if docker ps --format '{{.Names}}' | grep -qx biotime_postgres && [[ "$PORT" == "5434" ]]; then
      docker exec biotime_postgres psql -U "$PGUSER_" -d "$PGDB" -q \
        -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    else
      docker exec "$CONTAINER" psql -U "$PGUSER_" -d "$PGDB" -q \
        -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    fi
    npx prisma migrate deploy
    npx ts-node prisma/seed.ts
    echo "✔ test database reset"
    ;;
  *)
    echo "usage: $0 {up|down|reset}" >&2
    exit 2
    ;;
esac
