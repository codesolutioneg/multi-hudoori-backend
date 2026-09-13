# Hudoori Backend

Node/TypeScript middle-layer API for **Hudoori**: attendance, shift scheduling and payroll for Egyptian retail operations.

It sits between the Flutter app and three systems of record: a **PostgreSQL** database it owns, a **ZKTeco BioTime** fingerprint server it pulls punches from, and an optional **Odoo** instance it can push to and pull from.

```
Flutter app ──JSON-RPC/HTTPS──▶ Hudoori API ──▶ PostgreSQL (own data)
                                    │
                                    ├──▶ ZKTeco BioTime  (employees, devices, punches)
                                    └──▶ Odoo            (employees, grids, payroll, deductions, advances)
```

| | |
|---|---|
| **Runtime** | Node 20, TypeScript 5.8, Express 4 |
| **Database** | PostgreSQL 16 via Prisma 5 (39 models, 32 migrations) |
| **API surface** | 211 endpoints (`/api/auth` 3, `/api/admin` 4, `/api/biotime` 204) |
| **Tests** | 762 (20 unit specs, 12 E2E specs) + load suite |
| **Language of record** | Arabic for user-facing messages, English for code |

---

## Quick start

```bash
cp .env.example .env          # then edit DATABASE_URL and the JWT secrets
npm install
npm run test:db:up            # Postgres in Docker + migrations + seed
npm run dev                   # http://localhost:3000
```

Health check: `curl http://localhost:3000/api/health`

Platform admin login is `bioadmin@admin.bio` (password in `src/config/index.ts`).

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## 🦇 The architecture

### Request path

Every request passes through the same chain, defined in `src/app.ts`:

```
helmet → cors → express.json (2mb) → hpp → rate limiter → jsonRpcParser → router → errorHandler
```

`src/middlewares/jsonRpc.ts` is the important one. The Flutter client speaks **JSON-RPC 2.0**, so bodies look like:

```json
{ "jsonrpc": "2.0", "params": { "limit": 30 }, "id": 1 }
```

The parser lifts `params` onto `req.rpcParams` and remembers `id`. A plain JSON body works too: it becomes `rpcParams` directly, and `id` comes back `null`.

**Every response is HTTP 200 with a JSON-RPC envelope**, including business failures:

```json
{ "jsonrpc": "2.0", "result": { "success": false, "message": "…", "error_code": "NOT_FOUND" }, "id": 1 }
```

Non-200 statuses are reserved for genuine faults: `404` for an unknown route, `429` for rate limiting, `500` for an unhandled exception. **Clients must branch on `result.success`, not on the HTTP status.**

### Layout

| Path | Role |
|---|---|
| `src/app.ts` / `src/server.ts` | Express wiring; bootstrap + schedulers |
| `src/routes/` | `auth.routes.ts`, `admin.routes.ts`, `biotime.routes.ts` (the 204-endpoint core) |
| `src/services/` | Business logic, one file per domain |
| `src/services/biotime/` | BioTime connector, sync, employee push, duplicate detection |
| `src/services/odoo/` | Odoo JSON-RPC client, push, pull |
| `src/middlewares/` | Auth, RBAC, JSON-RPC, rate limiting, error mapping |
| `src/utils/` | Pure helpers (pagination, IBAN, national ID, payroll period, timezone) |
| `src/jobs/` | Cron schedulers |
| `src/scripts/` | Operator scripts (sync, reset, probe, migrate) |
| `prisma/` | Schema, migrations, seed |
| `tests/` | `unit/`, `e2e/`, `load/`, `helpers/`, `mocks/` |

### Domains

- **Employees**: profile, documents, custody, archive/restore, BioTime push, Excel import/export.
- **Shifts & assignments**: shift definitions (float times, overnight, grace periods, rest days) and per-employee assignment, including weekday patterns.
- **Shift grid**: the scheduling matrix: one row per employee, one column per day, each cell a shift or a status (off, sick, annual, excluded, bus delay, present, resignation, work absence, work injury). Lifecycle `setup → grid → confirmed`.
- **Attendance & punch report**: punches are pulled from BioTime and assigned to a *work date* (overnight shifts straddle midnight), then reduced to late minutes, early leave, net hours and overtime. The punch report is a direct port of the Odoo `biotime.punch.report.wizard`.
- **Payroll**: `draft → calculated → confirmed`. Calculation derives every line from punch-report lines, then links deductions and advances. Extensive Excel export (payroll, Fawry bank transfer, cash Fawry, edit template, duplicates) and payslip PDF.
- **Deductions**: typed money deductions (fines, checks, documents, admin penalty, …) that map onto specific payroll-line columns.
- **Advances**: short (one-off, deducted in the grant month) and long (instalments across months), gated by an eligibility rule based on actual worked days.
- **Self-service requests**: leave, loan, shift change, salary, certificate, attendance edit. Employee creates, HR approves or rejects.
- **Hiring appointments**: appointment records, PDF generation, and a webhook that can provision an employee account on approval.

### Time handling

This is the subtlest part of the system, and the source of most historical bugs.

- BioTime stores **device-local wall clock**, not UTC. `src/utils/biotimeTimezone.ts` converts a stored instant into Cairo wall clock re-encoded as UTC, so the rest of the code can use UTC getters and read local time.
- Report timezone comes from `biotime_config.timezone`, defaulting to `Africa/Cairo`.
- Date-only values (`punchDate`, `birthday`, `departureDate`, grid line `date`) are **UTC midnight**. Construct them with `Date.UTC(...)`, never `new Date(y, m, d)`, because local-midnight construction stores the previous day east of UTC.
- Overnight shifts use `workDateReference` (`start` or `end`) plus `earlyCheckinThreshold` / `lateCheckoutThreshold` to decide which calendar day a punch belongs to.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Roles and permissions

Seven roles, enforced by guards in `src/middlewares/auth.ts`:

| Guard | Roles allowed | Example endpoints |
|---|---|---|
| `requireAuth` | any authenticated user | `/me`, `/dashboard/stats`, `/attendance/my`, `/payroll/my`, `/requests/*/create` |
| `requireHrOrBranchManager` | HR + `BRANCH_MANAGER` | `/employees/list`, `/shift-grid/*`, `/locations/list`, `/hiring-appointments/list` |
| `requireHr` | `HR_MANAGER`, `HR_SUPERVISOR`, `HR_USER`, `PLATFORM_ADMIN` | `/payroll/*`, `/deductions/*`, `/advances/*`, `/attendance/list`, `/requests/*/approve` |
| `requireHrManager` | `HR_MANAGER`, `PLATFORM_ADMIN` | `/config/*`, `/locations/create`, `/departments/*`, `/employees/delete` |
| `requirePlatformAdmin` | `PLATFORM_ADMIN` | `/api/admin/users*` |

`DEVICE_MANAGER` and `EMPLOYEE` have no HR access. The whole matrix is asserted in `tests/e2e/rbac.test.ts`: 235 allow/deny checks across every guard.

### Location scoping

`HR_USER` and `BRANCH_MANAGER` are **branch-scoped**: their `locationId` restricts employee lists, shift grids and shifts, and it overrides any `locationId` they pass when creating an employee. `HR_MANAGER`, `HR_SUPERVISOR` and `PLATFORM_ADMIN` see every branch.

A scoped user with **no** `locationId` set is unrestricted. Always assign a location when creating one of those roles. The admin endpoint enforces this.

### Authentication

Opaque 64-character tokens in the `api_tokens` table, 30-day expiry, sent as `Authorization: Bearer <token>` or as a `token` param. There is no JWT verification path in the request flow despite the JWT secrets in config; the secrets are validated at boot but the tokens are database-backed.

`PLATFORM_ADMIN_LOCAL_TOKEN` (`platform-admin-local-session`) is a fixed token that grants platform-admin access for the app's offline dashboard. It is a **shared static credential**: anyone who knows it has full access. Treat it accordingly.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Data model

39 Prisma models. The ones that matter:

| Model | Notes |
|---|---|
| `User` / `ApiToken` | App accounts and live sessions. `initialPassword` stores the plaintext of the last set password so a platform admin can re-read it. |
| `EmployeeProfile` | The central record. Archive metadata (`archivedAt`, `archiveReason`, `departureDate`) drives the payroll cutoff. |
| `EmployeeMapping` | BioTime identity for an employee (`biotimeEmpId`, `biotimeEmpCode`, hire date). |
| `Location` | Branch. Drives all scoping. |
| `Shift` / `ShiftAssignment` | Definitions and per-employee, per-weekday assignment. |
| `ShiftGrid` / `ShiftGridLine` | The schedule matrix; one line per employee per day. |
| `Transaction` | A raw BioTime punch. `isDuplicate` / `duplicateOfId` mark near-identical scans. |
| `Attendance` | Reduced daily attendance derived from punches. |
| `Payroll` / `PayrollLine` | Header and per-employee money lines (about 40 money columns). |
| `Deduction` | Typed deduction, linked to a payroll line when applied. |
| `AdvanceShort` / `AdvanceLong` / `AdvanceLongPayment` | Salary advances and instalment ledger. |
| `HiringAppointment` | Hiring record, PDF, optional employee provisioning. |
| `SyncJob` | Background job status for sync and generate operations. |

### API state names differ from database state names

The serializers relabel some enums for the client. Do not assume they match:

| Domain | Database | API |
|---|---|---|
| Deduction | `draft` | `pending` |
| Deduction | `linked` | `applied` |
| Shift grid | `confirmed` | `confirmed` (both `close` and `confirm` land here; there is no separate closed state) |

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## API reference

All endpoints are `POST` (except `GET /api/health`) and all take a JSON-RPC envelope.

### Auth: `/api/auth`

| Endpoint | Purpose |
|---|---|
| `/login` | `login` + `password` (+ optional `device_info`) → token, expiry, user. Rate limited separately. |
| `/logout` | Deletes the token. Idempotent. |
| `/validate` | Reports whether a token is live *and* its user is still active. |

### Admin: `/api/admin` (platform admin only)

| Endpoint | Purpose |
|---|---|
| `/users` | Create a user (+ employee profile for employee/HR roles); emails credentials. Cannot mint a `PLATFORM_ADMIN`. |
| `/users/list` | All non-platform-admin users, including `initialPassword`. |
| `/users/deactivate` | Sets `active = false`; existing tokens stop working immediately. |
| `/users/reset-password` | Sets or generates a password and emails it. Refuses platform admins. |

### Core: `/api/biotime` (204 endpoints)

| Group | Count | Highlights |
|---|---|---|
| `payroll/*` | 34 | `create`, `calculate`, `confirm`, `back-to-draft`, `line/update`, `link-deductions`, `duplicates/*`, `edit-template/*`, `export-xlsx`, `export-fawry`, `export-cash-fawry`, `payslip/pdf`, `my` |
| `shift-grid/*` | 26 | `create`, `generate`, `get`, `cell/update`, `bulk/row`, `bulk/column`, `add-employee(s)`, `remove-employee`, `transfer-employee`, `confirm`, `close`, `reopen`, `sync/*`, `export-xlsx`, `import-xlsx` |
| `employees/*` | 22 | `list`, `get`, `create`, `update`, `archive`, `restore`, `delete`, `document/*`, `punch-report*`, `push-biotime`, `import-xlsx`, `export-xlsx` |
| `requests/*` | 20 | `my`, `pending`, and `create`/`approve`/`reject` for leave, loan, shift-change, salary, certificate, attendance-edit |
| `advances/*` | 18 | `eligibility/preview`, `settings/get`, `short/*`, `long/*`, `loan-import/*` |
| `config/*` | 11 | `get`, `update`, `test-connection`, `sync-employees`, `sync-departments`, `sync-devices`, `sync-transactions`, `sync-all`, `sync-pull`, `sync-status`, `sync-jobs/list` |
| `deductions/*` | 8 | `types`, `list`, `create`, `cancel`, template export/import (single and multi) |
| `shifts/*`, `shift-assignments/*` | 12 | CRUD plus Excel import/export |
| `locations/*`, `departments/*`, `devices/*`, `insurance-companies/*`, `custody-types/*` | 24 | Reference data CRUD |
| `dashboard/*`, `absences/*` | 6 | Stats, charts, notifications, absence alerts |
| `hiring-appointments/*` | 7 | `list`, `create`, `update`, `pdf`, `mark-seen`, `unread-count`, `webhook/status` |
| `odoo/*` | 5 | Config, connection test, push status, push-all |
| `overtime/*` | 4 | `list`, `generate`, `approve`, `reject` |
| `attendance/*` | 3 | `my`, `list`, `generate` |
| `me`, `jobs/status`, `punch-report/generate`, `health-certificates/alerts`, `company/logo/*` | 6 | Misc |

### Pagination

List endpoints take `limit` / `offset` (or `page`), clamped by `src/utils/pagination.ts` (default 30, max typically 100–200). A `limit` of `0` or a non-numeric value falls back to the default.

Two response shapes exist, so check which one you are calling:

- **Nested**: `data.meta = { total, limit, offset, page, count, hasMore }`
- **Inlined**: those fields sit directly on `data` (e.g. `employees/list`, `payroll/list`)

Nested sub-collections use their own params: `shift-grid/get` takes `employeeLimit` / `employeeOffset`; `payroll/get` takes `lineLimit` / `lineOffset` and returns `linePagination`.

### File responses

Exports return base64 in a common envelope:

```json
{
  "file": "UEsDBB…",
  "base64": "UEsDBB…",
  "filename": "payroll_x.xlsx",
  "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}
```

Imports accept the same base64 under `file` or `base64`.

### The one unauthenticated write

`POST /api/biotime/hiring-appointments/webhook/status` has no `requireAuth`. It is gated by a shared secret compared against `HIRING_WEBHOOK_SECRET`, supplied as the `x-hiring-webhook-secret` header or a `secret` param. **If `HIRING_WEBHOOK_SECRET` is unset the endpoint rejects everything.** That is the safe default, so set it deliberately when you want the webhook live.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Integrations

### BioTime (ZKTeco)

`src/services/biotime/biotimeConnector.service.ts` wraps the BioTime REST API.

- Auth is `jwt` (`/jwt-api-token-auth/`, `Authorization: JWT <token>`) or `token` (`/api-token-auth/`, `Token <token>`), chosen by `biotime_config.authType`. Tokens are cached in the database for 12 hours and refreshed automatically; a `401` triggers exactly one re-auth and retry.
- **Always construct via `BioTimeConnector.fromDb()`.** That is the path that authenticates. A directly constructed instance sends no auth header until `testConnection()` runs.
- Paging follows the API's `next` cursor, capped at 100 pages.
- Punch sync is idempotent on `biotimeTransactionId`. Near-identical scans within `duplicateGraceMinutes` are stored but flagged `isDuplicate`, so nothing is silently dropped.

Scheduled sync (`src/jobs/sync.scheduler.ts`) runs every `SYNC_CRON_INTERVAL_HOURS` (default 12) and can be disabled with `SYNC_CRON_ENABLED=false` or per-install via `biotime_config.scheduledAutoSyncEnabled`. A second scheduler refreshes no-punch alerts every 6 hours.

### Odoo (optional)

`src/services/odoo/odooClient.service.ts` speaks Odoo's JSON-RPC over HTTP with a bearer token refreshed a minute before expiry.

Pull order matters, because later stages resolve foreign keys created by earlier ones:

```
employees → shifts → assignments → shift grids → deductions → advances → payrolls
```

```bash
npm run odoo:pull                              # everything
npm run odoo:pull -- --employees               # one stage
npm run odoo:pull -- --grids --grid-limit=25
npm run server:odoo-sync -- --reset --yes      # server deploy: reset + full pull
```

Rows whose parent was never pulled are counted as `skipped`, not failed.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Configuration

`src/config/index.ts` validates the environment with Zod at boot and **exits the process** if anything required is missing.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` allows **any** CORS origin |
| `PORT` | `3000` | |
| `DATABASE_URL` | (none) | **required** |
| `JWT_ACCESS_SECRET` | (none) | **required**, min 32 chars |
| `JWT_REFRESH_SECRET` | (none) | **required**, min 32 chars |
| `JWT_ACCESS_EXPIRY` | `30d` | |
| `CORS_ORIGINS` | `http://localhost:3000` | comma-separated; any localhost port is always allowed |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | |
| `RATE_LIMIT_MAX` | `2000` | fair share per authenticated **token** per window |
| `RATE_LIMIT_IP_MAX` | `20000` | absolute ceiling per source address per window. Must stay at or above `RATE_LIMIT_MAX` |
| `RATE_LIMIT_AUTH_MAX` | `50` | login attempts per window per IP |
| `SYNC_CRON_ENABLED` | `true` | |
| `SYNC_CRON_INTERVAL_HOURS` | `12` | 1–168 |
| `BIOTIME_SERVER_IP` / `_PORT` / `_USE_HTTPS` / `_USERNAME` / `_PASSWORD` | (none) | seeded into `biotime_config` at boot |
| `ODOO_BASE_URL` / `_DATABASE` / `_LOGIN` / `_PASSWORD` | (none) | optional |
| `HIRING_WEBHOOK_SECRET` | (none) | unset means the webhook rejects everything |
| `HIRING_EMPLOYEE_DEFAULT_PASSWORD` | (none) | for webhook-provisioned accounts |
| `APP_PUBLIC_URL` | `https://hudoori.code-solution.org` | used in emails |
| `SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASS` / `_FROM_EMAIL` / `_FROM_NAME` | (none) | credential emails; failures are reported, not fatal |

Rate limiting is **two layers**, because neither alone is correct:

- **`ipLimiter`** is the ceiling, keyed on the source address. It cannot be bypassed, since a caller controls their token but not their IP.
- **`tokenLimiter`** sits underneath and gives each authenticated token a fair share, so one busy HR user cannot drain the budget of a branch that shares a single NAT egress address.

Keying only by IP starves colleagues. Keying only by token is bypassable, because the limiter runs before authentication and an attacker could rotate a fake token per request to mint fresh buckets. `/api/health` is exempt from both.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server, hot reload |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run setup` | `prisma migrate deploy` + seed |
| `npm run prisma:migrate` | Create a migration in development |
| `npm test` | Full suite (762 tests) |
| `npm run test:unit` | Unit specs only, no database needed |
| `npm run test:e2e` | E2E specs, needs Postgres |
| `npm run test:coverage` | Suite + coverage, fails under the floor |
| `npm run test:db:up` / `:down` / `:reset` | Manage the test database |
| `npm run load` | autocannon load suite |
| `npm run load:k6` | k6 ramping profile |
| `npm run db:reset -- --yes` | Wipe business data, keep admin + config |
| `npm run odoo:pull` | Pull from Odoo |
| `npm run biotime:probe` | Probe a BioTime server |

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Testing

762 tests across 32 files, about 50 seconds end to end.

```bash
npm run test:db:up     # once
npm test
npm run test:coverage
```

### Layout

| Path | What it covers |
|---|---|
| `tests/unit/` (20 specs) | Pure logic: shift maths, payroll totals, advance instalments, pagination, IBAN, national ID, timezone, punch-report summaries, BioTime connector, Odoo client |
| `tests/e2e/` (12 specs) | Real Express app + real Postgres via supertest: auth, RBAC matrix, employees, payroll, shift grid, deductions, advances, requests, exports, BioTime sync, Odoo pull, error handling |
| `tests/helpers/` | `db.ts` (truncate, seed users per role, fixtures), `api.ts` (JSON-RPC client, assertions) |
| `tests/mocks/` | BioTime API responses. **No test ever calls a real BioTime or Odoo server** |
| `tests/load/` | Seeder, autocannon runner, k6 profile |

### Conventions

- E2E specs call `resetDatabase()` in `beforeEach`; the test database runs with `fsync=off` so a truncate costs milliseconds.
- `createUser()` mints a token directly rather than logging in, so specs do not pay bcrypt per request.
- `fileParallelism: false`, because E2E files share one database.
- Coverage floor: 52% lines/statements, 60% functions, 58% branches. Excluded: `src/scripts/**` (operator tools), `src/server.ts`, generated types.
- Uncovered by design: Excel/PDF *generation* internals beyond the round-trip assertions, and `odooPush`.

### Load testing

```bash
npm run test:db:up
node tests/load/seed.mjs --employees 200 --days 30 > tests/load/.fixture.json
RATE_LIMIT_MAX=1000000 RATE_LIMIT_AUTH_MAX=1000000 npm run dev     # separate shell
npm run load -- --url http://localhost:3000 --duration 10 --connections 20
```

Raise the rate limits for the run, otherwise the limiter (not the app) is what you measure. The runner exits non-zero when a scenario breaches its p99 budget or a 1% error rate, so it can gate a release.

Reference numbers on one dev laptop (200 employees, 6 000 grid lines, 12 000 punches, 20 connections):

| Scenario | rps | p50 | p99 | budget |
|---|---|---|---|---|
| `health` | 5 550 | 2 ms | 10 ms | 150 ms |
| `login` | 51 | 386 ms | 482 ms | 2 500 ms |
| `me` | 519 | 35 ms | 74 ms | 400 ms |
| `employees-list` | 319 | 58 ms | 128 ms | 800 ms |
| `shift-grid-get` | 229 | 77 ms | 191 ms | 3 000 ms |
| `payroll-get` | 137 | 137 ms | 250 ms | 2 000 ms |
| `dashboard-stats` | 209 | 91 ms | 148 ms | 1 500 ms |

`login` is slow by design: bcrypt cost 12. Everything else is database-bound.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Deployment

```bash
git pull
npm ci
npm run prisma:generate
npm run setup                 # migrate deploy + seed
npm run build
npm start
```

Fresh server that should mirror Odoo:

```bash
npm run setup
npm run server:odoo-sync -- --reset --yes
npm run build && npm start
```

Checklist:

- `NODE_ENV=production`, otherwise **CORS accepts every origin**.
- Real `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` (min 32 chars).
- `CORS_ORIGINS` listing the deployed web origins.
- `RATE_LIMIT_MAX` sized for your busiest branch.
- `uploads/` is persistent: logos, employee documents and hiring PDFs are written there, not to object storage.
- After `db:reset`, every app session is invalidated; users must log in again.

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Known issues and gotchas

Things a newcomer will otherwise rediscover the hard way.

### Behaviour worth knowing

1. **Two different "first two late days are free" rules.** The punch report (`getIgnoredLateLineIds`) forgives the two **chronologically earliest** late days. Payroll (`calculateEmployeePayrollFromLines`) forgives the two **smallest** ones. The same employee and period can therefore show a different late deduction on the report than on the payslip. `tests/unit/punchReportSummary.test.ts` pins both rules with a worked example (0.5 day vs 1.0 day). Reconciling them is a business decision, so the divergence is recorded rather than silently changed.
2. **`restoreEmployee` keeps `archivedAt` on purpose** as an audit trail and clears only `departureDate`. Payroll therefore must not treat `archivedAt` alone as a departure. See `effectivePayrollEnd`.
3. **`parseTimeToFloat` treats a sub-1 number as hours, not an Excel day fraction.** `0.5` is `00:30`, never `12:00`. There is unreachable day-fraction code in that function; do not assume it runs.
4. **`round2` inherits binary-float half-cent behaviour** (`round2(1.005) === 1`). Every stored money value already uses this rule, so leave it alone.
5. **Grid cell removal is strict.** `remove-employee` only succeeds when *every* cell for that employee is blank. Any flag (including `off`) counts as an assignment.
6. **`linkLongAdvancesOnly` ignores the deduction start month**, unlike `applyLongAdvancesForLine`, and will take an instalment from `draft` advances. Deliberate Odoo parity, but surprising.
7. **`initialPassword` stores plaintext.** `/api/admin/users/list` returns it to platform admins by design. Anyone with database read access can read user passwords.
8. **`PLATFORM_ADMIN_LOCAL_TOKEN` is a static shared credential** hardcoded in `src/config/index.ts`, as is the platform admin password.
9. **Background jobs are in-process.** `setImmediate` plus `node-cron`, no queue. Two API instances run every schedule twice, and an in-flight job dies with the process.
10. **`biotime.routes.ts` is 3 886 lines.** New endpoints belong in a new router file.

### Fixed here: do not reintroduce

| Was | Now |
|---|---|
| `schema.prisma` had drifted from the migrations: 2 tables and ~25 columns existed only in the schema, so `prisma migrate deploy` on a fresh database produced one the app could not query (`column biotime_config.company_logo_path does not exist`) | `20260728140000_schema_drift_reconcile` closes the gap with guarded, re-runnable SQL. `prisma migrate diff` against a clean deploy is empty; keep it that way |
| A **restored (rehired) employee was dropped from payroll entirely** when their old archive date predated the period, or paid only up to that stale date | `effectivePayrollEnd` requires a genuine departure (`!active` or a `departureDate`) before applying a cutoff |
| `/auth/validate` reported a **deactivated user's token as valid**, while every protected route rejected it | `validateToken` checks `user.active`, matching `requireAuth` |
| `birthday` parsed from a national ID was stored **one day early** (local-midnight construction in a UTC column) | Built with `Date.UTC`; age and the future-date guard compare in UTC too |
| `floatToTimeString(8.999)` returned `"08:60"` | Rounds to whole minutes first, then clamps to 23:59 rather than wrapping to midnight |
| A 333.34 balance against a 333.33 instalment reported **2** remaining instalments when one payment would clear it | One-cent tolerance in `computeLongAdvanceAmounts` |
| A global **500 requests / 15 min per IP** limit throttled `/api/health` and gave a whole NAT'd branch one shared budget | Configurable window/budget, keyed per token when authenticated, health check exempt |
| Unhandled errors echoed **internal messages** to clients (`(0 , express_rate_limit_1.ipKeyGenerator) is not a function`) | Generic `Internal server error`; detail goes to the log |
| `prisma.update` on a missing row surfaced as **500 SERVER_ERROR** | Mapped: `P2025` → `NOT_FOUND`, `P2002` → `DUPLICATE`, `P2003` → `VALIDATION_ERROR` |
| Malformed JSON and oversized bodies were reported as **500** | Mapped to `VALIDATION_ERROR` / `PAYLOAD_TOO_LARGE` |
| `locations/export-xlsx` returned a different envelope from every other export, forcing a client special case | Returns the standard `file` + `mimeType` envelope (`base64` retained) |
| `tests/phases.test.ts` silently skipped 8 tests because the suite could not reach a usable schema | Suite green; drift fixed |

▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔╲▁╱▔▔▔

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `column … does not exist` | Schema drift between `schema.prisma` and migrations | Run `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`. If that prints SQL, a migration is missing |
| Process exits at boot printing `Invalid environment` | Zod rejected the env | Check the listed fields; JWT secrets need 32+ chars |
| `429 Too Many Requests` under load | Rate limiter | Raise `RATE_LIMIT_MAX`; it is per token, per window |
| `CORS blocked for origin` | Origin not listed | Add to `CORS_ORIGINS` (any localhost port is already allowed) |
| `BioTime configuration not found` | No `biotime_config` row | Seed, or set `BIOTIME_SERVER_IP` and restart to bootstrap it |
| BioTime calls return 401 forever | Bad credentials | The connector clears and re-auths once, then propagates. Check `biotime:probe` |
| `Odoo URL not configured` | `ODOO_BASE_URL` unset and no `odoo_config` row | Set it, or skip Odoo, which is optional |
| Payroll calculate fails `لا توجد بيانات بصمة` | No punches in the period | Sync punches, or check the period and shift grid |
| Payslip PDF fails | Puppeteer has no Chromium | `npx puppeteer browsers install chrome` |
| E2E tests fail on connect | No test database | `npm run test:db:up` |
| Tests are slow | Test database has `fsync` on | Recreate via `npm run test:db:reset`, which sets the fast flags |
