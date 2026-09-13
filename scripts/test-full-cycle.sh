#!/usr/bin/env bash
# Full HR cycle test — NO BioTime sync/push
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
LOGIN="${TEST_LOGIN:-levi@l.com}"
PASS="${TEST_PASSWORD:-levi@l.com}"

rpc() {
  local path="$1"
  local body="$2"
  curl -s -X POST "${BASE}${path}" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"call\",\"params\":${body},\"id\":1}"
}

ok() { python3 -c "import json,sys; r=json.load(sys.stdin); print('OK' if r.get('result',{}).get('success') else 'FAIL: '+json.dumps(r,ensure_ascii=False)[:500])" 2>/dev/null; }

echo "=== 1. LOGIN ==="
LOGIN_RES=$(rpc /api/auth/login "{\"login\":\"${LOGIN}\",\"password\":\"${PASS}\"}")
TOKEN=$(echo "$LOGIN_RES" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['token'])")
echo "Token acquired for $(echo "$LOGIN_RES" | python3 -c "import json,sys; u=json.load(sys.stdin)['result']['data']['user']; print(u['name'], u['role'])")"

T="\"token\":\"${TOKEN}\""

echo ""
echo "=== 2. CONFIG (read-only, no sync) ==="
rpc /api/biotime/config/get "{${T}}" | ok

echo ""
echo "=== 3. EMPLOYEES / SHIFTS / ASSIGNMENTS ==="
EMP_COUNT=$(rpc /api/biotime/employees/list "{${T},\"limit\":5}" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print(d.get('count',len(d.get('employees',[]))))")
SHIFT_COUNT=$(rpc /api/biotime/shifts/list "{${T}}" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print(d.get('count',len(d.get('shifts',[]))))")
ASSIGN_COUNT=$(rpc /api/biotime/shift-assignments/list "{${T}}" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print(d.get('count',len(d.get('assignments',[]))))")
echo "Employees: $EMP_COUNT | Shifts: $SHIFT_COUNT | Assignments: $ASSIGN_COUNT"

FIRST_EMP=$(rpc /api/biotime/employees/list "{${T},\"limit\":1}" | python3 -c "import json,sys; emps=json.load(sys.stdin)['result']['data'].get('employees',[]); print(emps[0]['id'] if emps else '')")
FIRST_SHIFT=$(rpc /api/biotime/shifts/list "{${T}}" | python3 -c "import json,sys; s=json.load(sys.stdin)['result']['data'].get('shifts',[]); print(s[0]['id'] if s else '')")

if [[ -z "$FIRST_EMP" || -z "$FIRST_SHIFT" ]]; then
  echo "SKIP: need at least 1 employee and 1 shift for cycle test"
  exit 1
fi

echo "Using employee=$FIRST_EMP shift=$FIRST_SHIFT"

# Ensure assignment exists for current month
MONTH_START=$(date -u +%Y-%m-01)
MONTH_END=$(python3 -c "from datetime import date,timedelta; d=date.today(); print((date(d.year,d.month+1,1)-timedelta(days=1)).isoformat() if d.month<12 else date(d.year,12,31).isoformat())")

echo ""
echo "=== 4. CREATE SHIFT ASSIGNMENT (if none active) ==="
if [[ "$ASSIGN_COUNT" -eq 0 ]]; then
  rpc /api/biotime/shift-assignments/create "{${T},\"employeeId\":\"${FIRST_EMP}\",\"shiftId\":\"${FIRST_SHIFT}\",\"assignmentType\":\"permanent\",\"dateFrom\":\"${MONTH_START}\"}" | ok
else
  echo "Assignments exist — skip create"
fi

echo ""
echo "=== 5. ATTENDANCE GENERATE (local, no BioTime) ==="
ATT_JOB=$(rpc /api/biotime/attendance/generate "{${T},\"dateFrom\":\"${MONTH_START}\",\"dateTo\":\"${MONTH_END}\"}")
JOB_ID=$(echo "$ATT_JOB" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print(d.get('jobId',''))" 2>/dev/null || echo "")
if [[ -n "$JOB_ID" ]]; then
  echo "Attendance job queued: $JOB_ID"
  for i in $(seq 1 30); do
    sleep 2
    STATUS=$(rpc /api/biotime/jobs/status "{${T},\"jobId\":\"${JOB_ID}\"}")
    ST=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data'].get('status',''))" 2>/dev/null)
    MSG=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data'].get('message',''))" 2>/dev/null)
    echo "  [$i] status=$ST — $MSG"
    [[ "$ST" == "done" || "$ST" == "failed" ]] && break
  done
fi

ATT_LIST=$(rpc /api/biotime/attendance/list "{${T},\"dateFrom\":\"${MONTH_START}\",\"dateTo\":\"${MONTH_END}\",\"limit\":5}")
ATT_TOTAL=$(echo "$ATT_LIST" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data'].get('total',0))")
echo "Attendance records this month: $ATT_TOTAL"
echo "$ATT_LIST" | python3 -c "
import json,sys
r=json.load(sys.stdin)['result']['data'].get('records',[])[:2]
for x in r:
  print('  sample:', x.get('employeeName'), x.get('date'), 'status='+str(x.get('status')),
        'net='+str(x.get('netWorkedHours')), 'late='+str(x.get('lateMinutes')),
        'ot='+str(x.get('overtimeHours')))
" 2>/dev/null || true

echo ""
echo "=== 6. OVERTIME GENERATE ==="
OT_JOB=$(rpc /api/biotime/overtime/generate "{${T},\"dateFrom\":\"${MONTH_START}\",\"dateTo\":\"${MONTH_END}\"}")
OT_JOB_ID=$(echo "$OT_JOB" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print(d.get('jobId',''))" 2>/dev/null || echo "")
if [[ -n "$OT_JOB_ID" ]]; then
  for i in $(seq 1 20); do
    sleep 2
    STATUS=$(rpc /api/biotime/jobs/status "{${T},\"jobId\":\"${OT_JOB_ID}\"}")
    ST=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data'].get('status',''))" 2>/dev/null)
    [[ "$ST" == "done" || "$ST" == "failed" ]] && break
  done
fi
OT_LIST=$(rpc /api/biotime/overtime/list "{${T},\"state\":\"pending\"}")
OT_COUNT=$(echo "$OT_LIST" | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print(len(d.get('items',d.get('records',[]))))" 2>/dev/null || echo 0)
echo "Pending overtime records: $OT_COUNT"

echo ""
echo "=== 7. SHIFT GRID (generate + confirm flow) ==="
GRID_NAME="CycleTest-$(date +%s)"
GRID_RES=$(rpc /api/biotime/shift-grid/create "{${T},\"name\":\"${GRID_NAME}\",\"dateFrom\":\"${MONTH_START}\",\"dateTo\":\"${MONTH_END}\",\"selectionMethod\":\"manual\",\"employeeIds\":[\"${FIRST_EMP}\"],\"generate\":true}")
GRID_ID=$(echo "$GRID_RES" | python3 -c "import json,sys; g=json.load(sys.stdin)['result']['data'].get('grid',{}); print(g.get('id',''))" 2>/dev/null || echo "")
if [[ -n "$GRID_ID" ]]; then
  echo "Grid created: $GRID_ID"
  rpc /api/biotime/shift-grid/resync-dates "{${T},\"gridId\":\"${GRID_ID}\"}" | ok
  rpc /api/biotime/shift-grid/confirm-assignments "{${T},\"gridId\":\"${GRID_ID}\"}" | ok
  echo "Grid confirm-assignments done"
else
  echo "Grid create failed or skipped"
fi

echo ""
echo "=== 8. PAYROLL CYCLE ==="
PAY_CREATE=$(rpc /api/biotime/payroll/create "{${T},\"dateFrom\":\"${MONTH_START}\",\"dateTo\":\"${MONTH_END}\",\"name\":\"Cycle Test $(date +%Y-%m)\"}")
PAY_ID=$(echo "$PAY_CREATE" | python3 -c "import json,sys; p=json.load(sys.stdin)['result']['data'].get('payroll',{}); print(p.get('id',''))" 2>/dev/null || echo "")
if [[ -n "$PAY_ID" ]]; then
  echo "Payroll created: $PAY_ID"
  echo -n "Calculate: "
  rpc /api/biotime/payroll/calculate "{${T},\"payrollId\":\"${PAY_ID}\"}" | ok
  echo -n "Link deductions: "
  rpc /api/biotime/payroll/link-deductions "{${T},\"payrollId\":\"${PAY_ID}\"}" | ok
  PAY_GET=$(rpc /api/biotime/payroll/get "{${T},\"payrollId\":\"${PAY_ID}\"}")
  echo "$PAY_GET" | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']['data']
p=d.get('payroll',d)
lines=d.get('lines',p.get('lines',[]))
print('  totalNet:', p.get('totalNet'), 'totalEarnings:', p.get('totalEarnings'), 'lines:', len(lines))
for l in lines[:2]:
  print('  line:', l.get('employeeName'), 'net='+str(l.get('netSalary')),
        'workDays='+str(l.get('workingDays')), 'lateDed='+str(l.get('lateDeduction')),
        'absentDed='+str(l.get('absentDeduction')))
" 2>/dev/null || true
else
  echo "Payroll create failed"
fi

echo ""
echo "=== 9. PUNCH REPORT (Odoo-parity lines) ==="
PUNCH=$(rpc /api/biotime/punch-report/generate "{${T},\"dateFrom\":\"${MONTH_START}\",\"dateTo\":\"${MONTH_END}\",\"employeeIds\":[\"${FIRST_EMP}\"]}")
echo "$PUNCH" | python3 -c "
import json,sys
d=json.load(sys.stdin)['result']['data']
lines=d.get('lines',[])
print('Punch lines:', len(lines))
for l in lines[:3]:
  print(' ', l.get('punchDate','')[:10], 'off='+str(l.get('isOffDay')), 'absent='+str(l.get('isAbsent')),
        'late='+str(l.get('lateMinutes')), 'ot='+str(l.get('overtimeHours')))
" 2>/dev/null || echo "$PUNCH" | head -c 300

echo ""
echo "=== DONE — BioTime sync was NOT called ==="
