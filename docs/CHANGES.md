# Hardening pass: what changed, where, and what to do next

Branch: `feature/test-suite-and-schema-drift-fix`

Scope of this branch:

1. Reconcile the Prisma schema with the migration history, which was breaking fresh deploys.
2. Fix ten defects found while building the test suite and during review.
3. Build out the test suite: 40 tests (8 of them silently skipping) to 762 tests, plus coverage gates and a load-test suite.
4. Rewrite the README.

Verified on a database rebuilt from zero: `npx prisma migrate deploy` then `npx tsc --noEmit` then `npx vitest run` gives 762 passing tests and no schema drift.

---

## 1. Critical: schema drift broke every fresh deploy

**Where:** `prisma/migrations/20260728140000_schema_drift_reconcile/migration.sql` (new)

**Before.** `prisma/schema.prisma` contained two tables and about 25 columns that no migration ever created. The documented deploy path (`npm run setup`, which is `prisma migrate deploy` plus seed) therefore produced a database the running code could not query.

Missing entirely from the migration history:

| Object | Kind |
|---|---|
| `custody_types`, `employee_custodies` | tables, indexes and both foreign keys |
| `biotime_config.company_logo_path` | column |
| `employee_profiles.bank_iban`, `.mobile_line_phone` | columns |
| `hiring_appointments.notes`, `.status_note` | columns |
| `advances_short.deduction_start_date` | column |
| `payroll_lines` | 12 columns, including `days_count`, `late_checkout_deduction`, `punch_deduction_checkin/checkout`, `total_net_hours`, `department_name`, `position_name` |
| `HiringAppointmentStatus.cancelled` | enum value |
| 5 column defaults, 1 column type change, 1 stale index | schema settings |

Observed failure, and the reason 8 tests in `tests/phases.test.ts` were skipping rather than running:

```
The column `biotime_config.company_logo_path` does not exist in the current database.
```

**After.** One migration closes the gap. Every statement is guarded (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object`), so it is safe to run against a server that was previously synced with `prisma db push` and already has the objects. `advances_short.deduction_start_date` backfills from the existing `date` column before it is set `NOT NULL`, so existing advances keep a truthful start date instead of today's.

**What to do.**

- Run `npm run setup` on every environment. The migration is idempotent, so it is safe on servers that already have the columns.
- Before merging anything that touches `schema.prisma`, check the drift is still zero:
  ```bash
  npx prisma migrate diff --from-url "$DATABASE_URL" \
    --to-schema-datamodel prisma/schema.prisma --script
  ```
  Empty output means clean. Any SQL means a migration is missing. Worth adding to CI.
- Use `npx prisma migrate dev` when changing the schema. `prisma db push` is what caused this, because it mutates a database without recording a migration.

---

## 2. Critical: rehired employees were dropped from payroll

**Where:** `src/utils/payrollPeriod.ts:28-49` (`effectivePayrollEnd`)
**Test:** `tests/unit/payrollRestoredEmployee.test.ts`, plus an end-to-end case in `tests/e2e/employees.test.ts`

**Before.** `restoreEmployee` (`src/services/employeeArchive.service.ts`) deliberately keeps `archivedAt` as an audit trail and clears only `departureDate`. But the payroll cutoff treated a non-null `archivedAt` as proof of departure:

```ts
if (cutoff && (!emp.active || emp.archivedAt || emp.departureDate)) {
  if (cutoff < utcDateOnly(payrollDateFrom)) return null;   // skip the employee
  if (cutoff < end) end = cutoff;                           // or truncate their pay
}
```

For a restored (rehired) employee that meant:

- old archive date before the payroll period: `return null`, so **no payroll line at all, no salary**;
- old archive date inside the period: pay truncated at a date they were no longer absent on.

**After.** A cutoff only applies when the employee has genuinely departed:

```ts
const hasDeparted = !emp.active || Boolean(emp.departureDate);
if (!hasDeparted) return end;
```

Archived employees are unaffected, because archiving sets both `active = false` and `departureDate`.

**What to do.**

- Check production for employees who were archived and later restored:
  ```sql
  SELECT id, name, code, archived_at
  FROM employee_profiles
  WHERE active = true AND archived_at IS NOT NULL AND departure_date IS NULL;
  ```
- For any payroll run since those restores, re-run `payroll/calculate` (draft or calculated states only) and compare. Employees who were silently missing will now appear.
- Confirmed payrolls are immutable by design, so any underpayment already paid out needs a manual correction, not a recalculation.

---

## 3. High: a deactivated user's token reported as valid

**Where:** `src/services/auth.service.ts:59-67` (`validateToken`)
**Test:** `tests/e2e/auth.test.ts`

**Before.** `/api/auth/validate` checked only that the token row existed and had not expired, while `requireAuth` also checked `user.active`. Deactivating a user therefore left the app believing its session was fine, and it only discovered otherwise on the next real request.

**After.** `validateToken` loads the user and checks `active`, matching `requireAuth`.

**What to do.** Nothing operationally. Worth knowing on the Flutter side: `/auth/validate` is now authoritative, so a deactivated user is logged out at the next validate call rather than on a random later request.

---

## 4. High: rate limiter locked out whole branches and throttled health checks

**Where:** `src/middlewares/rateLimiter.ts` (rewritten), `src/config/index.ts:12-14` and `:67-71`
**Test:** `tests/e2e/errorHandling.test.ts`

**Before.** A single global limiter, hardcoded:

```ts
export const defaultLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
```

Three problems:

- Keyed by IP. Every employee in one branch shares that branch's NAT egress address, so **500 requests per 15 minutes was a shared budget for the whole branch**. One HR user paginating payroll can exhaust it and lock out colleagues.
- Applied to `/api/health`, so an uptime monitor can be throttled and report a false outage.
- Not configurable, so ops could not raise it without a code change and redeploy.

Reproduced during load testing: every scenario returned 100% non-2xx at 2ms, because the limiter, not the app, was answering.

**After.** Two layers, because neither alone is correct. The first attempt keyed everything on the token, which review correctly flagged as a bypass: the limiter runs before authentication, so an attacker could rotate a fake token per request and mint unlimited fresh buckets.

- **`ipLimiter`** is the ceiling, keyed on the source address, `RATE_LIMIT_IP_MAX` (default 20000). Not bypassable, because a caller controls their token but not their IP.
- **`tokenLimiter`** sits underneath, keyed on the presented token, `RATE_LIMIT_MAX` (default 2000). Gives each authenticated user a fair share so one cannot drain a shared branch address. Skipped when no token is presented, since that traffic is already bounded by the ceiling.
- `/api/health` is exempt from both.
- `RATE_LIMIT_AUTH_MAX` (default 50) still guards login and stays IP-keyed, because an attacker guessing passwords has no token to be budgeted by.

Token extraction is now a single shared helper, `src/utils/requestToken.ts`, used by both `requireAuth` and the limiter. Review flagged that the limiter had grown its own copy of logic that already existed in `src/middlewares/auth.ts`; if the two ever diverged, a caller could be authenticated under one token while budgeted under a different key.

**What to do.**

- **Decide both budgets for your busiest branch.** 2000 per token and 20000 per address per 15 minutes are starting points, not measured figures. Keep `RATE_LIMIT_IP_MAX` at or above `RATE_LIMIT_MAX`, or the ceiling becomes the tighter limit and the fair-share layer stops mattering.
- Keep `RATE_LIMIT_AUTH_MAX` low. It is the brute-force guard on login and is still IP-keyed on purpose.
- Set both high when load testing, or you will measure the limiter.

---

## 5. Medium: unhandled errors leaked internals to clients

**Where:** `src/middlewares/errorHandler.ts:38-47`
**Test:** `tests/e2e/errorHandling.test.ts`

**Before.** `jsonRpcFail(res, err.message || 'Internal server error', ...)` echoed the raw exception message to the caller. Captured live during this work:

```json
{ "success": false, "message": "(0 , express_rate_limit_1.ipKeyGenerator) is not a function", "error_code": "SERVER_ERROR" }
```

That names internal modules and, for database errors, column and table names.

**After.** Unexpected failures log the full detail server-side and return a flat `Internal server error`. Deliberate `AppError`s still carry their own message, because those are written for the user.

**What to do.** Watch the logs rather than the response body when diagnosing a 500. The detail is in the `Unhandled error` log line together with the request path.

---

## 6. Medium: ordinary outcomes surfaced as HTTP 500

**Where:** `src/middlewares/errorHandler.ts:8-36` (`fromPrisma`, `fromHttpError`)
**Test:** `tests/e2e/errorHandling.test.ts`

**Before.** Approving a request that did not exist called `prisma.update`, which throws `P2025`, which fell through as `500 SERVER_ERROR`. The same for unique-constraint clashes, malformed JSON bodies and oversized payloads. Client mistakes looked like server outages and polluted error monitoring.

**After.** Mapped to the right code and status:

| Cause | Now returns |
|---|---|
| Prisma `P2025` (row not found) | `NOT_FOUND` |
| Prisma `P2002` (unique constraint) | `DUPLICATE` |
| Prisma `P2003` (foreign key) | `VALIDATION_ERROR` |
| Malformed JSON body | `VALIDATION_ERROR` |
| Body over the 2mb limit | `PAYLOAD_TOO_LARGE` |

**What to do.** If any monitoring alert keys on 500s from these endpoints, expect the volume to drop. That is the fix working, not traffic disappearing.

---

## 7. Medium: birthdays stored one day early

**Where:** `src/utils/egyptianNationalId.ts:57` (parse), `:12-20` (age), `:72-74` (future-date guard)
**Test:** `tests/e2e/employees.test.ts`, `tests/unit/egyptianNationalId.test.ts`

**Before.** The birth date decoded from a national ID was built with `new Date(year, mm - 1, dd)`, which is **local** midnight. Stored in a UTC column from Cairo (UTC+2/+3) that becomes the previous day at 22:00Z, and every UTC-based renderer in the codebase then showed the wrong date. National ID `29001011234571` (1 January 1990) stored as `1989-12-31`.

**After.** Built with `Date.UTC(...)`. Age and the future-date guard also compare in UTC, so the three are consistent.

**What to do.**

- Existing rows are still off by a day. Employees created before this fix need a backfill; the value is recoverable because it is derived from `national_id_confirm`, which is stored:
  ```sql
  SELECT id, code, national_id_confirm, birthday FROM employee_profiles
  WHERE national_id_confirm IS NOT NULL AND birthday IS NOT NULL;
  ```
  Re-derive digits 2 to 7 as `YYMMDD` (leading `2` is 1900s, `3` is 2000s) and compare. Worth a one-off script if birthdays are used for anything official.
- New rule for the codebase: date-only values are UTC midnight. Never `new Date(y, m, d)`.

---

## 8. Low: three small defects

| Where | Before | After |
|---|---|---|
| `src/services/shiftCalculations.service.ts:18-31` | `floatToTimeString(8.999)` returned `"08:60"`, because hours and minutes were rounded independently | Rounds to whole minutes first, then **clamps** to 23:59 rather than wrapping. Review caught that an earlier `% 24` wrap rendered 23.999 as `00:00` while `isOvernight` stayed false, which collapsed that shift's expected hours to zero downstream. Tests in `tests/unit/shiftCalculations.test.ts` |
| `src/services/advances.service.ts:55-58` | A 333.34 balance against a 333.33 instalment reported **2** remaining instalments, though one payment clears it. The `1e-9` epsilon was far too small for cent-level residues | One-cent tolerance. Test in `tests/unit/advanceAmounts.test.ts` |
| `src/services/locationsExcel.service.ts:7-33` | `locations/export-xlsx` returned `{ base64, filename }` while every other export returned `{ file, base64, filename, mimeType }`, forcing a client special case | Returns the standard envelope. `base64` retained, so existing callers keep working |

**What to do.** The locations export change is additive, so the Flutter client needs no change, but its special case for that one endpoint can now be deleted.

---

## 9. Test suite

**Where:** `tests/` restructured into `unit/`, `e2e/`, `helpers/`, `load/`; `vitest.config.ts`; `scripts/test-db.sh`; new npm scripts

**Before.** 9 test files, 40 tests, of which **8 silently skipped** because the suite could not reach a usable schema. No coverage measurement, no database bootstrap, no load testing. Existing tests all sat flat in `tests/`.

**After.** 762 tests in 32 files, about 50 seconds end to end.

| Area | Count | Notes |
|---|---|---|
| Unit specs | 19 files | Shift and overtime maths, payroll totals, advance instalments, punch-report summaries, timezone, IBAN, national ID, pagination, plus the BioTime connector and Odoo client with mocked HTTP |
| E2E specs | 12 files | Real Express app against real Postgres via supertest: auth, employees, payroll lifecycle, shift grid, deductions, advances, all six request types, Excel and PDF exports parsed back with exceljs, BioTime sync, Odoo pull, error handling |
| Authorization matrix | 235 assertions | `tests/e2e/rbac.test.ts` checks allow and deny for every role against a representative endpoint per guard |

Supporting pieces:

- `tests/helpers/db.ts`: truncate between specs, seed a user per role with a ready token, fixture builders.
- `tests/helpers/api.ts`: JSON-RPC client and assertions (`expectOk`, `expectFail`, `expectRpcEnvelope`).
- `scripts/test-db.sh up|down|reset`: Postgres in Docker, migrations, seed. Runs with `fsync=off`, which cut the E2E auth spec from 43s to 1.5s.
- Coverage: v8 provider, currently 54% lines, 62% functions, 60% branches. The gate sits just underneath so a regression fails CI. `src/scripts/**` and `src/server.ts` are excluded as operator tooling.
- No test ever contacts a real BioTime or Odoo server. Both are mocked.

**What to do.**

- Run `npm run test:db:up` once per machine, then `npm test`.
- Wire `npm run test:coverage` into CI and ratchet the thresholds in `vitest.config.ts` upwards as coverage grows.
- Biggest remaining coverage gaps, in priority order: `odooPush.service.ts` (13%), `sync.service.ts` (49%), and the Excel import paths.

---

## 10. Load testing

**Where:** `tests/load/seed.mjs`, `tests/load/run.mjs`, `tests/load/k6-api.js`, `npm run load`, `npm run load:k6`

**Before.** None.

**After.** A seeder that builds a realistic dataset, an autocannon runner with a p99 budget per endpoint, and a k6 ramping profile for CI dashboards. The runner exits non-zero when a scenario breaches its budget or a 1% error rate, so it can gate a release.

Measured on one dev laptop: 200 employees, 6 000 grid lines, 12 000 punches, 20 connections.

| Scenario | rps | p50 | p99 | budget |
|---|---|---|---|---|
| `health` | 5 550 | 2 ms | 10 ms | 150 ms |
| `login` | 51 | 386 ms | 482 ms | 2 500 ms |
| `me` | 519 | 35 ms | 74 ms | 400 ms |
| `employees-list` | 319 | 58 ms | 128 ms | 800 ms |
| `shift-grid-get` | 229 | 77 ms | 191 ms | 3 000 ms |
| `payroll-get` | 137 | 137 ms | 250 ms | 2 000 ms |
| `dashboard-stats` | 209 | 91 ms | 148 ms | 1 500 ms |

All 13 scenarios within budget, zero errors. `login` is slow by design, because bcrypt runs at cost 12.

**What to do.**

```bash
npm run test:db:up
node tests/load/seed.mjs --employees 200 --days 30 > tests/load/.fixture.json
RATE_LIMIT_MAX=1000000 RATE_LIMIT_AUTH_MAX=1000000 npm run dev   # separate shell
npm run load -- --url http://localhost:3000 --duration 10 --connections 20
```

Re-measure against production-like data. The budgets in `tests/load/run.mjs` were set from a 200-employee dataset; a real branch count may need them widened, and if so that is a finding about the endpoint, not about the budget.

---

## 11. README

**Where:** `README.md`

**Before.** 81 lines: quick start, a script table, a short pagination note.

**After.** Full reference: architecture and request path, the JSON-RPC contract, the role and permission matrix, location scoping, data model, all 211 endpoints grouped, both integrations, every environment variable, testing and load runbooks, deployment checklist, known issues, and a troubleshooting table.

---

## Open decision: two conflicting late-day rules

**Not changed in this branch, because it moves real salaries.**

**Where:** `src/services/punchReportLine.service.ts` (`getIgnoredLateLineIds`) versus `src/services/punchReport.service.ts` (`calculateEmployeePayrollFromLines`)
**Test:** `tests/unit/punchReportSummary.test.ts`, the case named "late-day forgiveness rule differs between the report and payroll"

Both implement "the first two late days are free", differently:

- The **punch report** forgives the two **chronologically earliest** late days.
- **Payroll** forgives the two **smallest** late days, by minutes.

Same employee, same period, three late days of 90, 25 and 45 minutes:

| | Forgives | Charges | Deduction |
|---|---|---|---|
| Punch report | 90 min and 25 min | 45 min | 0.5 day |
| Payroll | 25 min and 45 min | 90 min | 1.0 day |

So the report an employee is shown can disagree with the deduction on their payslip, and payroll is the harsher of the two on this example.

**What to do.** Confirm with whoever owns the payroll policy which rule is correct, most likely against the original Odoo implementation, then align the other and delete the characterization test in favour of a real assertion. Until then the test pins both behaviours so neither drifts unnoticed.

---

## Completeness sweep: same defect class elsewhere, left for a follow-up ticket

Fixing the birthday bug raised the obvious question: is local-time date handling wrong anywhere else? It is, in code this branch does not touch. Listed here rather than changed, because these sit in the attendance and payroll read paths and altering them would move reported numbers, which needs its own ticket and its own verification.

| Where | Risk |
|---|---|
| `src/services/shiftTime.service.ts:57` and `:170` | `punchDate.setHours(0, 0, 0, 0)` and `workDate.setHours(0, 0, 0, 0)` set **local** midnight, then the values are compared against `@db.Date` columns that hold UTC midnight. Same class as the birthday bug, but on the attendance path |
| `src/services/employeeLeave.service.ts:6-7` | Year boundaries built with `new Date(year, 0, 1)` and `new Date(year, 11, 31, 23:59:59)`, both local |
| `src/services/dashboard.service.ts:33`, `src/services/healthCertificate.service.ts:25`, `src/services/shiftGridAssignment.service.ts:6`, `src/routes/biotime.routes.ts:238` and `:2512` | Same local-midnight pattern for "today" comparisons |

The rule to apply when that ticket is picked up: date-only values are UTC midnight, built with `Date.UTC(...)` and read with `getUTC*`. `src/utils/biotimeTimezone.ts` already provides the conversion helpers.

---

## Pre-existing risks, noted but untouched

Not defects introduced here, and out of scope for this branch, but they should be on someone's list.

| Where | Risk |
|---|---|
| `src/config/index.ts` | The platform admin password and `PLATFORM_ADMIN_LOCAL_TOKEN` are hardcoded in source. The local token is a static shared credential that grants full platform-admin access to anyone who knows it |
| `src/routes/admin.routes.ts` | `initialPassword` stores the plaintext of the last set password, and `/users/list` returns it. Anyone with database read access can read user passwords |
| `src/app.ts` | With `NODE_ENV=development` the CORS check accepts **any** origin. Production must set `NODE_ENV=production` |
| `src/jobs/*.scheduler.ts` | Cron and background jobs run in-process with no queue. Two API instances run every schedule twice, and an in-flight job dies with the process |
| `src/routes/biotime.routes.ts` | 3 886 lines in one router. New endpoints belong in a new file |
| `src/services/advances.service.ts` | `linkLongAdvancesOnly` ignores the deduction start month, unlike `applyLongAdvancesForLine`, and will take an instalment from a `draft` advance |
