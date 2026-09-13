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
