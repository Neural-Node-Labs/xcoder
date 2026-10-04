#!/usr/bin/env bash
# Quick end-to-end check against a running stack: ./scripts/smoke.sh [base-url]
set -euo pipefail
B=${1:-http://localhost:7000}
echo "health:   $(curl -fsS $B/healthz)"
echo "status:   $(curl -fsS $B/status)"
echo "chat:     $(curl -fsS -H 'content-type: application/json' -d '{"message":"hello"}' $B/chat | head -c 200)"
echo "measuring KPIs (runs 8 sandbox scenarios)..."
curl -fsS -X POST $B/goal/measure | python3 -c "import sys,json; [print(f\"  {r['id']:14} {'PASS' if r['pass'] else 'FAIL'}\") for r in json.load(sys.stdin)]"
echo "goal:     $(curl -fsS $B/goal | python3 -c "import sys,json; print({k['name']:k.get('current') for k in json.load(sys.stdin)['kpis']})")"
