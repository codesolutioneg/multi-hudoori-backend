# Mobile app — full feature & API E2E coverage

## What is covered

Two layers (both required for “every mobile feature”):

| Layer | File | What it proves |
|-------|------|----------------|
| **Full API surface** | `tests/e2e/mobileApiSurface.test.ts` | All **~348** paths in `mobile-app/lib/data/api/biotime_api_client.dart` respond without HTTP **404/500** |
| **Feature / screen map** | `tests/e2e/mobileFeaturesE2e.test.ts` | Every **app area** (auth, home, punch, requests, payroll, shift grid, deductions, reports, admin, …) → primary APIs the UI calls on load |

Catalog: `tests/helpers/mobileFeatureCatalog.ts` (31 feature groups, ~90 screen-critical paths).

Deep flows (mutations, roles, location):

- `mobileRequestCycle.test.ts` — requests + open cycle + grid-on-approve
- `mobileApiRoles.test.ts` — EMPLOYEE / BM / HR matrix
- `mobileLocationPunch.test.ts` — geofence + `locations/update`
- `advanceRequests.test.ts` — سلفة + مدير فرع + HR

## Mobile features mapped (screens → APIs)

- Auth, session/me
- Employee home (stats, charts, attendance)
- Notifications
- My schedule / my attendance
- Mobile & location punch
- Requests (employee + HR queue)
- Advance request (employee + BM approve + HR list)
- My payroll
- Absences
- Employees, HR attendance, shifts, shift assignments
- Shift grid (list, get, merge, sync status)
- Payroll HR, deductions, advances (short/long/loan import)
- Hiring appointments, overtime
- Reports hub (punch, location mismatch, fawry, insurance, health, …)
- Org chart, health certificate alerts
- Settings (config, devices, branch managers, Odoo, logo, quota)
- Audit, push broadcast, assistant
- Platform admin (companies, plans, users, sales, feature grants)

## Run

```bash
cd backend
npm run test:mobile-surface          # all client paths
npm run test:mobile-deep             # surface + deep + features
npx vitest run tests/e2e/mobileFeaturesE2e.test.ts
npm run smoke:vicanza                # live Vicanza read smoke
```

## Live Vicanza

Non-destructive reads per role (`scripts/vicanza-live-smoke.ts`). Optional: `SMOKE_HR_LOGIN` / `SMOKE_HR_PASSWORD`.

## Backend / mobile contract fixes (shared with dashboard)

- `config/sync-transactions` → business error when BioTime unset
- Odoo list → `ODOO_NOT_CONFIGURED`
- `payroll/link-deductions-confirmed` → `NOT_FOUND`
- Mobile: approve `_unwrap`, NO_GRID dialog; create request without grid OK

Heavy HR actions (payroll confirm, grid wipe, Odoo push) are exercised only in **isolated test DB**, not on live Vicanza.
