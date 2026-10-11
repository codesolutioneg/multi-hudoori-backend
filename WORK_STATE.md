# Hudoori Multi Backend — Work State

**Repo:** `/root/hudoori-multi/backend`  
**Scope:** Multi-company API, Prisma/DB, tenancy, jobs.  
**Reference (read-only):** `/root/hodouri/bio_time_backend-dev`  
**Do not log dashboard work here.**

## Rules
- Copy business logic/equations from Dev reference as-is; ask before changing formulas.
- Never put secrets here.
- Never touch `/root/hodouri/*`.

## Daily log

### 2026-10-11
- **Auto**: تصدير تقرير البصمات لموظفين محددين يمرّر `includeInactive: true` (مؤرشف يظهر ويُصدَّر). **MULTI**.
- **Auto**: توحيد تقرير البصمة مع حضوري-dev + ديناميك: `punchReportLine`/`Excel`/`summary`/`import` + `loadManualOtKeySetForRange`؛ حقول إعدادات `punchReportMinLateCheckoutHours` (10) / `MinEarly` (5) / `CalendarDayFloorHour` (6)؛ migration `20261011160000`؛ UI إعدادات التأخير؛ deploy API+dashboard. **MULTI**.
- **Auto**: مراجعة معادلات تقارير البصمة Multi vs حضوري-dev: cores متطابقة (`latePolicy`/`payablePeriod`/`shiftTime`/`punchReport`/`attendance`/`overtime`)؛ Multi متأخر في `punchReportLine` + Excel/summary (أرضية 10h/5h، floor 06:00، اختيار IN، اصابة عمل، عدم احتساب يوم، manualOtOnly) + فرق sick import. **MULTI**.
- **Auto**: Migrate prod → `vicanza`: dump `biotime_2026-10-11_1156` → `biotime_mig_vicanza`؛ سكربت `migrateProdDumpToCompany.py --wipe`؛ 1351 emp / 15 users / 109k punches / 204 grids + configs؛ إصلاح dynamic import `companyGroupQuota.service.js` (BioTime sync). **MULTI**.
- **Auto**: Child hire paths — `PARENT_QUOTA_EXCEEDED` كـ `AppError` + `fromCodedError` في errorHandler؛ `remainingEmployeeSeats` = min(حصة الشركة، حصة المجموعة) قبل Excel/shift-grid import؛ رسائل أوضح. **MULTI**.
- **Auto**: Parent employee pool — مجموع حدود موظفي الفروع ≤ حد الرئيسية؛ منع «بلا حد» تحت رئيسية محدودة؛ رفض تخفيض حد الرئيسية تحت مجموع الفروع؛ `parentPool` في قائمة الشركات؛ اختبارات `companyGroupQuota` 5/5؛ deploy. **MULTI**.
- **Auto**: Deploy Multi — طبّق `loan_notification_emails_enabled` عبر `MIGRATE_DATABASE_URL` + `migrate resolve`؛ esbuild `dist/routes/biotime/index.js` + PM2 restart `hudoori-multi-backend`؛ `/api/health` و quota OK. **MULTI**.
- **Auto**: Port hodouri prod/dev HR parity إلى Multi: `loanNotificationEmailsEnabled` + Odoo JSON-RPC 300s؛ archive-preview + تحذير سلف طويلة + تسوية مؤرشف على مسير؛ Payslip دورة + ZIP payroll-xlsx؛ Option A home = `locationId` البطاقة؛ `CODE_ARCHIVED_CONFLICT` + bulk unarchive + `shift-grid/search-employee`. Migration `20261011120000_loan_notification_emails_enabled` (طبّقها مالك DB إن فشل migrate). **MULTI**.
- **Auto**: إصلاح BioTime sync create — `injectCreateData` يحقن `companyId` داخل nested `mapping.create` (كان يفشل Argument company is missing على levi). **MULTI**.
- **Auto**: levi BioTime probe (read-only) على `91.99.195.177:8089` — 2 dept / 229 emp / 2 devices؛ punches ~26840 من 2026-01-21 → 2026-10-11 (بدون فلتر تاريخ API ترجع آخر يوم تقريباً). **MULTI**.
- **Auto**: levi BioTime — إصلاح port محفوظ `8090` → `8089` على `91.99.195.177`؛ JWT testConnection ناجح (`is_connected=true`). **MULTI**.

### 2026-10-07
- **Auto**: `employeeListJson.userId` لقائمة الموظفين (إرسال FCM لأفراد). **MULTI**.
- **Auto**: إصلاح `COMPANY_CONTEXT_REQUIRED` لمدير HR — `asyncHandler` يلف الطلب بـ `runWithTenant`؛ إعادة build `dist/routes/biotime/index.js` + symlinks `dist/routes/{tenant,prisma}`؛ `scripts/build-biotime-routes.mjs`. **MULTI**.
- **Auto**: FCM HR — `POST /notifications/send` (أفراد) + `admin-list`؛ `employeeJson.userId` للوحة الإرسال. **MULTI**.
- **Auto**: FCM (odc-chat) — `User.fcmToken`, `app_notifications`, Firebase Admin من service account JSON, topic `company_{id}`, APIs list/read/broadcast + hooks موافقة الطلبات/confirmPayroll؛ موبايل: messaging + inbox `/notifications`. **MULTI**.
- **Auto**: Punch-report export بدون BioTime — `listLocalEmpCodes` / `listAllEmpCodesForPunchReport`؛ `queuePunchReportExport` يتخطى sync ويُرجع `usedLocal` + رسالة؛ مسار export-xlsx/download يمرّر fallback؛ esbuild dist + PM2 restart. **MULTI**.
- **Auto**: Parent/child quota — child caps ≤ parent; sum sibling caps ≤ parent; group dashboard user/employee counts ≤ root caps; membership link child-only under home parent; `set-password` + revoke tokens on reset; unit `companyGroupQuota.test.ts`. **MULTI**.
- **Auto**: yasser/levi E1001 — grid `test` من 2026-10-04؛ B.10 على 4–18 أكتوبر (إصلاح 5–6 بدون shiftId). **MULTI**.
- **Auto**: Super Admin companies UI — optional parent company on create; «شركة أم» edit dialog; list shows `parentCompany`; API create accepts `parentCompanyId`; cycle guard on parent chain. **MULTI**.
- **Auto**: Multi-company membership — `user_company_memberships` + `parent_company_id`; auth accepts `X-Company-Id`/`activeCompanyId` when membership exists; `/me` + login return `memberships`; admin list/add/remove; `/me` user load via `prismaBase` when switched tenant. CRM sales — `ownerUserId`, `nextFollowUpAt`, `source`, `sales_request_activities`, manual create, list analytics, note API. E2E `companyMembership.test.ts`. Migration `20261007120000_membership_crm`. **MULTI**.
- **Auto**: HR sidebar `hr_requests` (موافقة الطلبات → `/requests`) + `MENU_FEATURE_MAP` entitlement. **MULTI**.
- **Auto**: Mobile employee↔HR request cycle — unlocked employee `/requests/my`, leave/attendance-edit/shift-change create; `requestFulfillment.service` on HR approve (grid leave/shift, punch fix + attendance); `payrollCycleGuard` `PERIOD_LOCKED` on confirmed/sent payroll; `openCycle` on my/pending; employee `/payroll/my` + own payslip line; menus `my_requests`/`my_payroll` + entitlements. E2E `mobileRequestCycle` + unit `payrollCycleGuard`; PM2 restart `hudoori-multi-backend`. **MULTI**.

### 2026-10-05
- **Auto**: Seeded `levi` from biotime_dev branches Bri.Str + Sizzler — raised `max_employees` 10→100; 80 employees (+2 existing=82), 50 shifts, 2 locations + 2 devices, 4 grids / 525 lines (total grids 5 / 532 lines), 1500 punches + 1500 attendance, catalogs/depts/titles. Fixed `seedCompanyFromDevBranches.py` `ON CONFLICT DO NOTHING` for starter catalog code collisions. **MULTI**.
- **Auto**: Mobile GPS punch now upserts the employee's `attendances` day (so «حضوري» shows check-in/out); context includes `todayPunches`. Backfilled yasser/levi 2026-10-05 punches. **MULTI**.
- **Auto**: Settings menu no longer requires `advanced_permissions` in `MENU_FEATURE_MAP` (HR managers always see إعدادات). **MULTI**.
- **Auto**: E2E `tests/e2e/planEntitlements.test.ts` (2 green) — public sales → approve Attendance plan → company snapshot (`subscriptionPlanId` / plan names / `company_features`); plan `featureKeys` edit after approve does not mutate snapshot; HR `/me` menus hide payroll; `/payroll/*` → 403 `FEATURE_DISABLED`; attendance allowed; admin override enables payroll + menu; legacy company (no rows) keeps full catalog. Applied entitlements migration on `hudoori_multi_test`. **MULTI**.
- **Auto**: Plan entitlements — `feature_keys` on plans + `company_features` snapshot on sales approve (`applyPlanSnapshotToCompany`); code catalog `featureCatalog.ts`; admin APIs catalog/plan keys/company toggles; `requireFeatureMiddleware` on `/api/biotime`; menus filtered via `filterMenusByEntitlements`; `/me` returns `entitlements`. Migration `20261005120000_company_plan_entitlements`. Dashboard: plans checklist + company feature toggles. Landing: header Contact sales → `#pricing`; modal caps employees read-only for non-unlimited plans. Smoke: attendance-only snapshot disables payroll flag; demo reverted to legacy (no rows = all features). **MULTI**.
- **Auto**: Landing sales modal — from plan CTA: plan select locked; employees prefilled from `defaultMaxEmployees` and read-only except Professional (unlimited). Public plans API exposes `defaultMaxEmployees`. Loader logo centered above title. **MULTI**.
- **Auto**: Landing brand polish — local Cairo `@font-face` (same TTFs as web app), RTL letter-spacing/rotator gradient fix for Arabic shaping, fingerprint mark → official `assets/hudoori-logo.png`; How-it-works stage 1 card uses Hudoori logo (was BioTime SVG). **MULTI**.
- **Auto**: Price + seat caps — HR 35 / HR+Payroll 45 / Professional 60 (Attendance stays 20); `defaultMaxEmployees` 25 / 50 / 100 / unlimited; feature lines AR/EN + landing redeploy. **MULTI**.
- **Auto**: Pricing card polish — number-first price (`20` + small `EGP /emp/mo`), equal-height cards with CTA pinned bottom, denser 4-col spacing; fixed API hydration that blew up full price string to 2.6rem. Redeployed `/landing/`. **MULTI**.
- **Auto**: Replaced public pricing with 4 EGP tiers (Attendance 20 / HR 30 / HR+Payroll 40 / Professional 50); old Start/Business/Enterprise kept DRAFT. Landing HTML + AR/EN strings + deploy `/landing/`. Public `GET /api/public/plans` returns the four published cards only. **MULTI**.

### 2026-10-01
- **Auto**: Aligned sales registration mail with prod path — `sendRegistrationSuccessEmail` now wraps same `sendUserCredentialsEmail` / `getTransporter` as `/root/hodouri/bio_time_backend` (SMTP host/auth/tls/timeouts identical). Approve UI shows whether email was sent. **MULTI**.
- **Auto**: SMTP wired on Multi from single-company prod settings (`mail.code-solution.org`); restarted `hudoori-multi-backend`. Resent registration mail for approved `levi` request (password rotated). **MULTI**.
- **Auto**: Sales update API + approve uses edited `requestedEmployees` as company maxEmployees; registration email includes code/name/phone/quota/plan. Fixed broken `mail.service` merge. **MULTI**.
- **Auto**: Sanitize demo tenant PII — branches `Demo 1..4`, employees `Demo Employee N`, phones/national IDs/emails/birthdays/doc URLs/bank cleared; hiring + devices + shift grids anonymized. Script `src/scripts/sanitizeDemoCompany.py`. **MULTI**.
- **Auto**: Landing sales — Prisma `subscription_plans` + `sales_requests` (PUBLISHED/DRAFT, no hard delete); public `GET /api/public/plans`, `POST /api/public/sales-requests` (rate limit); admin approve/reject + plans CRUD. Approve → `createCompany` + HR + `sendRegistrationSuccessEmail` with `companyCode`. Demo company `demo` + `hr@demo.test` / fixed password; seeded 4 branches from biotime_dev (~81 employees). CORS: `http://164.68.110.233:8090`. e2e `salesRequests` green; esbuild refresh of route/service `dist`, PM2 restart `hudoori-multi-backend`. **MULTI**.

### 2026-09-30
- **Auto**: SaaS seats per company — `companies.max_employees` / `max_users` (null = unlimited). Hard lock = Postgres BEFORE INSERT triggers + advisory lock per company (migration `20260930120000_company_seat_quotas`); archived employees still count; EMPLOYEE / PLATFORM_ADMIN logins take no user seat. `licenseQuota.service` + Prisma extension pre-check → `EMPLOYEE_QUOTA_EXCEEDED` / `USER_QUOTA_EXCEEDED` (Arabic message). Super Admin create requires both caps, `/companies/update` edits them, list/get return `quota`; HR read-only `POST /api/biotime/company/quota`. Excel + shift-grid imports fail fast before any write; BioTime/Odoo employee sync skips new employees once full and keeps updating the rest. Tests: unit `licenseQuota` (4) + e2e `companyQuota` (7) + `tenantIsolation` green; other e2e failures identical to HEAD (pre-existing). Rebuilt `dist`, restarted `hudoori-multi-backend` (health 200). Live check on acme (set 1/1 → rejects HR + employee logins) then reset to unlimited. **MULTI**.

### 2026-09-29
- **Auto**: Seeded `beta` from biotime_dev — branches Strip, Leven, Bri.Str, Sizzler (80 employees, 1500 punches/attendance, 4 grids, 40 advances/deductions, catalogs). New `src/scripts/seedCompanyFromDevBranches.py` re-keys all ids with `_<company>` suffix so the same dev rows can go to several companies; cross-tenant FK scan = 0; mandara unchanged. **MULTI**.
- **Auto**: `--full` run for beta (same 4 branches): all 523 employees + 443 BioTime mappings, 45 shift grids with merge links (5 monthly), 40,486 grid lines, 997 manual OT lines, 46,453 punches (2026-07-16 → 09-29), 51,393 attendance rows. Large inserts via psql stdin. Cross-tenant FK = 0; mandara unchanged. **MULTI**.

### 2026-09-28
- **Auto**: Punch-report sync falls back to local DB punches when BioTime is unconfigured/unreachable (empty `serverIp` caused Invalid URL); job soft-completes instead of failing. **MULTI**.
- **Auto**: Ported single-company prod logic (Sept) into Multi: punch 31→30 adj, loan import/eligibility + approveConflicts, deductions delete-bulk, shift-grid monthly reports (service+routes+tests), payroll/odoo/excel/grouping/Fawry updates; kept `getCompanyId` audit filter. Unit: punch 66 + grouping 11 + monthly reports 3 green. Rebuilt `dist`, restarted `hudoori-multi-backend` (`hr-api` health 200). **MULTI**.
- **Auto**: Seeded mandara from biotime_dev sample — branches Bri.Mad + Sizzler, catalogs, ~80 employees, grids/punches/advances/deductions (schema-aware `company_id`). Script `src/scripts/seedMandaraFromDevBranches.py`. **MULTI**.

### 2026-09-15
- **Auto**: Restored Multi API — built `dist`, PM2 `hudoori-multi-backend` on `:3003` (nginx `hr-api` → 200 `/api/health`). Ecosystem `deploy/pm2.multi.config.cjs`; `pm2 save`. Fixes «تعذر الاتصال بالخادم» on hr.hudoori companies page. **MULTI**.
- **Auto**: Ported single-company prod loan-import name fixes (`cellToText` rejects `[object Object]`, prefer profile name over Excel redaction `••••`), loan sheet name `سلف` + job-ladder sort on template. Unit tips tests green. **MULTI**.
- **Auto**: Ported single-company prod punch/loan fixes from `/root/hodouri`: loan-import `eligibilityPeriodForBatch` no longer pre-caps `dateTo`; `isPayrollLengthSpan` so weekly reports stay ~7 days not fixed-30; day-shift past-midnight checkout attribution (`isWithinDayShiftPastMidnightCheckoutWindow`); unit tests updated. **MULTI**.

### 2026-09-13
- **Auto**: Scaffold — copied Dev backend into `/root/hudoori-multi/backend` (excluded node_modules, dist, .env*, uploads, storage). Fresh git repo, no remotes. Created empty Postgres DB `hudoori_multi_dev` on biotime_postgres:5434. Local `.env.dev` on PORT `3003`. **MULTI**.
- **Auto**: Multi-tenant schema baseline — `Company` model + `companyId` on all operational tables; composite uniques; migration `20260913120000_multi_tenant_baseline`. Seed platform admin only (no global BioTime/Odoo). **MULTI**.
- **Auto**: Tenant ALS (`enterTenant`) + Prisma extension scoping + login `companyCode + email + password` for company users; Super Admin login without code. Admin APIs: `/admin/companies/*`; users CRUD requires selected company (`X-Company-Id` / `activeCompanyId`). Legacy no-punch cron deferred. Smoke-tested: create acme/beta, HR login isolation. Business payroll/attendance formulas untouched (copied as-is). **MULTI**.
- **Auto**: Domains wired for Multi only — frontend `https://hr.hudoori.code-solution.org`, API `https://hr-api.hudoori.code-solution.org` (CORS, APP_PUBLIC_URL, dashboard ApiConfig, isolation rule). Single-company Hudoori DNS untouched. **MULTI**.
- **Auto**: Per-company BioTime/Odoo/uploads + BullMQ queues (`REDIS_URL` db/3); CORS allows `X-Company-Id`; RLS ENABLE+FORCE + runtime role `hudoori_multi_app` (owner `biotime` bypasses RLS — use `MIGRATE_DATABASE_URL` for migrate). e2e `tenantIsolation` (4) green on `hudoori_multi_test`. **MULTI**.
- **Auto**: Nginx + Let's Encrypt لـ `hr.` / `hr-api.` (كان الافتراضي يخدم شهادة cloud-kitchen → `ERR_CERT_COMMON_NAME_INVALID`). API على `:3003`، الواجهة static على `:8083`. **MULTI**.
- **Auto**: بصمة موقع للموظف — حقول Location + Transaction (`punchSource`/`lat`/`lng`)، API `mobile-punch/*`، geofence، e2e (5) ناجحة. **MULTI**.
- **Auto**: توضيح UI أن `geofenceRadiusMeters` قابل للضبط لأي متر (10/50/…) مع chips سريعة — ليس ثابتاً على 200. **MULTI**.
- **Auto**: إصلاح فشل حفظ صفحة تفاصيل الموظف — `syncEmployeeLoginFromWorkEmail` كان يستخدم `findUnique({ login })` بينما الـ unique أصبح `(companyId, login)`؛ إصلاح الـ extension أيضاً عندما `select` يحذف `companyId` فيرجع `NOT_FOUND` (أرشفة). e2e `employeeRoutes` (7) + `orgChart` (26) خضراء. **MULTI**.
- **Auto**: تغطية REST المتبقية — e2e `restRoutesCoverage` (15): archive-reasons / custody / insurance / job-titles / departments / locations / shifts / assignments / devices / jobs / odoo status / absences / overtime / shift-change / تقارير. إصلاحات مصاحبة: `ensureDefaultCustodyTypes` و `getOdooConfig` بـ `companyId`. **MULTI**.
- **Auto**: تشخيص فشل دخول `i@mandara.com` — الإيميل/الباسورد محفوظان لكن `userId` كان null (مزامنة login فشلت سابقاً بصمت). تمت مزامنة الحساب يدوياً؛ الدخول يعمل بـ `companyCode=mandara`. e2e `employeeWorkEmailLogin` (13) تغطي حالات WORK_STATE: provision / companyCode / menus / READ_ONLY / auto-mint / archive / collision / report. **MULTI**.
- **Auto**: Initial commit + `origin` → `codesolutioneg/multi-hudoori-backend` (local `main`). Push blocked: token user has pull-only (403). **MULTI**.
- **Auto**: Pushed `main` to `https://github.com/codesolutioneg/multi-hudoori-backend.git`. **MULTI**.
- **Auto**: Hardening Multi tenant — إصلاح `prismaExtension` upsert (كان `AND` يكسر unique)، تحويل `COMPANY_CONTEXT_REQUIRED`/`RECORD_NOT_FOUND_IN_COMPANY` إلى AppError، إصلاح uniques مركّبة (jobLevel/device/odooSyncMap/systemCounter/transaction)، لف `generateJob` بـ `runWithTenant`، عزل raw SQL، جيل ALS + `TEST_FALLBACK_COMPANY_ID` لاختبارات Vitest. e2e خضراء: advanceRequests/jobLevels/payroll/weeklyPayrollCycle/overnightAttribution/orgChart/isolation/workEmail/restRoutes/tenantExtension. live mandara: دخول موظف، قائمة/حفظ/أرشفة/استعادة موظف، job-levels/create. **MULTI**.
