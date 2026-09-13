#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-}"

case "$ENV_NAME" in
  prod)
    APP_DIR="/root/hodouri/biotime_web_dashboard"
    API_URL="https://apihodouri.all.eatbalkans.com"
    APP_ENV="prod"
    ;;
  dev)
    APP_DIR="/root/hodouri/biotime_web_dashboard-dev"
    API_URL="https://api.dev.hudoori.code-solution.org"
    APP_ENV="dev"
    ;;
  *)
    echo "Usage: $0 <prod|dev>" >&2
    exit 1
    ;;
esac

cd "$APP_DIR"
flutter pub get
flutter build web --release \
  --dart-define=BIOTIME_API_URL="$API_URL" \
  --dart-define=BIOTIME_PIN_LOCALHOST=false \
  --dart-define=BIOTIME_APP_ENV="$APP_ENV"

WEB_DIR="$APP_DIR/build/web"

if [ "$ENV_NAME" = "dev" ]; then
  # Source HTML/manifest stay prod-branded; stamp DEV only on the built output.
  sed -i \
    -e 's|<title>حضوري</title>|<title>حضوري · DEV</title>|g' \
    -e 's|content="حضوري"|content="حضوري · DEV"|g' \
    -e 's|content="حضوري — Attendance \& Payroll"|content="حضوري · DEV — Attendance \& Payroll (development)"|g' \
    -e 's|<h1 class="splash-title">حضوري</h1>|<h1 class="splash-title">حضوري · DEV</h1>|g' \
    "$WEB_DIR/index.html" || true
  if [ -f "$WEB_DIR/manifest.json" ]; then
    python3 - <<PY
import json
from pathlib import Path
p = Path("$WEB_DIR/manifest.json")
data = json.loads(p.read_text())
data["name"] = "حضوري · DEV"
data["short_name"] = "Hudoori DEV"
data["description"] = "حضوري · DEV — Attendance & Payroll (development)"
p.write_text(json.dumps(data, ensure_ascii=False, indent=4) + "\n")
PY
  fi
fi

cat > "$WEB_DIR/tunnel-url.json" <<EOF
{
  "apiUrl": "$API_URL",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "note": "${ENV_NAME} API build output",
  "appEnv": "$APP_ENV"
}
EOF
