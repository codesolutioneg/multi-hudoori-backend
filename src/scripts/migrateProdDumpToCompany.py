#!/usr/bin/env python3
"""
Migrate a restored single-tenant biotime dump into one Multi company.

- Restores are read from a temp DB (e.g. biotime_mig_vicanza) — never writes prod.
- Re-keys every id with `_<companyCode>` so PKs don't collide with other tenants.
- Injects company_id; copies users (except PLATFORM_ADMIN), configs, and full HR data.

Usage:
  python3 src/scripts/migrateProdDumpToCompany.py \
      --company vicanza \
      --source-db biotime_mig_vicanza \
      --wipe
"""

from __future__ import annotations

import argparse
import csv
import re
import subprocess
import sys
from pathlib import Path

# punch_report_imports / imports can embed large Excel payloads
csv.field_size_limit(min(sys.maxsize, 64 * 1024 * 1024))

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seedCompanyFromDevBranches import (  # noqa: E402
    Seeder,
    insert_batch,
    psql_stdin,
)
from seedMandaraFromDevBranches import (  # noqa: E402
    MULTI_ENV,
    columns,
    env_for,
    fetch_csv,
    in_list,
    lit,
    parse_db_url,
    psql,
)

# Delete order: children before parents (company-scoped tables only).
WIPE_TABLES = [
    "shift_grid_manual_ot_lines",
    "shift_grid_lines",
    "shift_grids",
    "shift_assignments",
    "shift_change_requests",
    "payroll_lines",
    "payrolls",
    "deductions",
    "advance_long_payments",
    "advances_long",
    "advances_short",
    "advance_loan_import_lines",
    "advance_loan_imports",
    "advance_requests",
    "loan_requests",
    "leave_requests",
    "salary_requests",
    "certificate_requests",
    "attendance_edit_requests",
    "overtime_analyses",
    "hiring_appointments",
    "punch_report_imports",
    "employee_custodies",
    "employee_mappings",
    "attendances",
    "transactions",
    "devices",
    "department_mappings",
    "sync_jobs",
    "odoo_sync_maps",
    "system_counters",
    "api_tokens",
    "app_notifications",
    "dashboard_notification_reads",
    "audit_logs",
    "user_feature_grants",
    "user_company_memberships",
    "employee_profiles",
    "locations",
    "departments",
    "job_titles",
    "job_levels",
    "shifts",
    "custody_types",
    "insurance_companies",
    "archive_reasons",
    "biotime_config",
    "odoo_config",
    "users",
]


def source_cfg(db_name: str) -> dict:
    """Reuse multi DB host/user from MIGRATE_DATABASE_URL, swap database name."""
    base = parse_db_url(MULTI_ENV, prefer_migrate=True)
    return {**base, "db": db_name}


def wipe_company(multi: dict, company_id: str) -> None:
    cid = lit(company_id)
    print(f"\n[wipe] company {company_id}")
    # Break self-FKs first
    for sql in (
        f"UPDATE employee_profiles SET manager_id=NULL, user_id=NULL WHERE company_id={cid}",
        f"UPDATE locations SET manager_employee_id=NULL WHERE company_id={cid}",
        f"UPDATE shift_grids SET merged_into_grid_id=NULL WHERE company_id={cid}",
        f"UPDATE transactions SET duplicate_of_id=NULL WHERE company_id={cid}",
        f"UPDATE advances_short SET source_grid_id=NULL, payroll_id=NULL, payroll_line_id=NULL WHERE company_id={cid}",
        f"UPDATE deductions SET payroll_id=NULL, payroll_line_id=NULL, device_id=NULL WHERE company_id={cid}",
    ):
        try:
            psql(multi, sql)
        except RuntimeError as e:
            print(f"  pre-wipe note: {e}")
    for table in WIPE_TABLES:
        try:
            n = psql(multi, f"WITH d AS (DELETE FROM {table} WHERE company_id={cid} RETURNING 1) SELECT count(*) FROM d", True).strip()
            if n and n != "0":
                print(f"  deleted {table}: {n}")
        except RuntimeError as e:
            # Table may not have company_id in older schemas — skip quietly if missing.
            if "company_id" in str(e) or "does not exist" in str(e):
                print(f"  skip wipe {table}: {e}")
            else:
                raise


def copy_config_row(s: Seeder, table: str) -> None:
    """Single-tenant config tables: one row → remapped id + company_id."""
    rows = fetch_csv(s.dev, f"SELECT * FROM {table} LIMIT 1")
    if not rows:
        print(f"  {table}: 0 (source empty)")
        return
    mcols = columns(s.multi, table)
    dcols = columns(s.dev, table)
    shared = [c for c in dcols if c in mcols and c not in {"company_id"}]
    if "id" in shared:
        shared = ["id"] + [c for c in shared if c != "id"]
    meta = s.col_meta(table)
    r = rows[0]
    old_id = r.get("id")
    if old_id:
        s.ids.add(old_id)
    vals = [lit(s.company_id)]
    insert_cols = ["company_id", *shared]
    for c in shared:
        dtype, nullable = meta.get(c, ("text", True))
        v = r.get(c)
        if c == "id" and v:
            vals.append(lit(s.remap(v)))
            continue
        if v and v in s.ids:
            v = s.remap(v)
        elif v and re.match(r"^c[a-z0-9]{20,}$", v or "") and c != "id":
            if nullable:
                vals.append("NULL")
                continue
        from seedMandaraFromDevBranches import sql_val

        vals.append(sql_val(v, dtype, c))
    # Upsert: wipe already removed old config; insert fresh.
    psql_stdin(
        s.multi,
        f"DELETE FROM {table} WHERE company_id={lit(s.company_id)};\n"
        f"INSERT INTO {table} ({', '.join(insert_cols)}) VALUES ({','.join(vals)});",
    )
    print(f"  {table}: 1")


def ensure_memberships(multi: dict, company_id: str) -> None:
    users = [
        l
        for l in psql(
            multi,
            f"SELECT id FROM users WHERE company_id={lit(company_id)} AND role <> 'PLATFORM_ADMIN'",
            True,
        ).splitlines()
        if l.strip()
    ]
    for uid in users:
        psql(
            multi,
            f"""
            INSERT INTO user_company_memberships (id, user_id, company_id, role, created_at, updated_at)
            SELECT {lit(uid + '_m')}, {lit(uid)}, {lit(company_id)}, u.role, NOW(), NOW()
            FROM users u WHERE u.id={lit(uid)}
            ON CONFLICT DO NOTHING
            """,
        )
    print(f"  memberships ensured for {len(users)} users")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", required=True)
    ap.add_argument("--source-db", required=True, help="Restored dump DB name (read-only source)")
    ap.add_argument("--wipe", action="store_true", help="Delete existing company tenant rows first")
    args = ap.parse_args()

    multi = parse_db_url(MULTI_ENV, prefer_migrate=True)
    src = source_cfg(args.source_db)
    assert multi["db"] == "hudoori_multi_dev", multi["db"]
    assert src["db"] == args.source_db

    company_id = psql(
        multi, f"SELECT id FROM companies WHERE code={lit(args.company)}", True
    ).strip()
    if not company_id:
        raise SystemExit(f"company not found: {args.company}")

    suffix = "_" + re.sub(r"[^a-z0-9]", "", args.company.lower())
    print(f"company={args.company} id={company_id} suffix={suffix}")
    print(f"source={src['db']}@{src['host']}:{src['port']}")

    emp_n = psql(src, "SELECT count(*) FROM employee_profiles", True).strip()
    user_n = psql(src, "SELECT count(*) FROM users WHERE role <> 'PLATFORM_ADMIN'", True).strip()
    tx_n = psql(src, "SELECT count(*) FROM transactions", True).strip()
    print(f"source counts: employees={emp_n} users(non-admin)={user_n} transactions={tx_n}")

    if args.wipe:
        wipe_company(multi, company_id)

    s = Seeder(multi, src, company_id, suffix)

    print("\n[1] catalogs")
    for t in (
        "archive_reasons",
        "custody_types",
        "insurance_companies",
        "job_levels",
        "departments",
        "job_titles",
        "shifts",
    ):
        s.copy(t)

    print("\n[2] users (no PLATFORM_ADMIN)")
    # Keep password_hash / initial_password so logins work.
    s.copy(
        "users",
        where="role <> 'PLATFORM_ADMIN'",
        nullify={"location_id", "fcm_token"},  # location remapped later if needed
    )
    # Re-link location_id after locations exist — done after step 3.

    print("\n[3] locations + devices")
    s.copy("locations", nullify={"manager_employee_id"})
    s.copy("devices")

    # Fix user.location_id now that locations exist
    pairs = fetch_csv(
        src,
        "SELECT id, location_id FROM users WHERE location_id IS NOT NULL AND role <> 'PLATFORM_ADMIN'",
    )
    for i in range(0, len(pairs), 200):
        chunk = pairs[i : i + 200]
        values = ",".join(
            f"({lit(s.remap(p['id']))},{lit(s.remap(p['location_id']))})"
            for p in chunk
            if p["location_id"] in s.ids
        )
        if not values:
            continue
        psql_stdin(
            multi,
            f"""UPDATE users u SET location_id=v.loc
                FROM (VALUES {values}) AS v(id, loc)
                WHERE u.id=v.id AND u.company_id={lit(company_id)}""",
        )
    print(f"  users.location_id linked: {len(pairs)}")

    print("\n[4] employees + mappings + custodies")
    # Null manager_id on insert (self-FK order), then wire after all rows exist.
    s.copy("employee_profiles", nullify={"manager_id"})
    mgr_pairs = fetch_csv(
        src,
        "SELECT id, manager_id FROM employee_profiles WHERE manager_id IS NOT NULL",
    )
    mgr_pairs = [p for p in mgr_pairs if p["manager_id"] in s.ids]
    for i in range(0, len(mgr_pairs), 400):
        chunk = mgr_pairs[i : i + 400]
        values = ",".join(
            f"({lit(s.remap(p['id']))},{lit(s.remap(p['manager_id']))})" for p in chunk
        )
        psql_stdin(
            multi,
            f"""UPDATE employee_profiles e SET manager_id=v.mid
                FROM (VALUES {values}) AS v(id, mid)
                WHERE e.id=v.id AND e.company_id={lit(company_id)}""",
        )
    print(f"  employee manager links: {len(mgr_pairs)}")
    s.copy("employee_mappings")
    s.copy("employee_custodies")

    # manager_employee_id on locations
    loc_mgr = fetch_csv(
        src,
        "SELECT id, manager_employee_id FROM locations WHERE manager_employee_id IS NOT NULL",
    )
    for i in range(0, len(loc_mgr), 200):
        chunk = loc_mgr[i : i + 200]
        values = ",".join(
            f"({lit(s.remap(p['id']))},{lit(s.remap(p['manager_employee_id']))})"
            for p in chunk
            if p["manager_employee_id"] in s.ids
        )
        if not values:
            continue
        psql_stdin(
            multi,
            f"""UPDATE locations l SET manager_employee_id=v.mid
                FROM (VALUES {values}) AS v(id, mid)
                WHERE l.id=v.id AND l.company_id={lit(company_id)}""",
        )

    print("\n[5] shift grids")
    s.copy("shift_grids")
    s.copy("shift_grid_lines")
    s.copy("shift_grid_manual_ot_lines")
    s.copy("shift_assignments")

    print("\n[6] punches / attendance")
    s.copy("transactions", nullify={"duplicate_of_id"}, overrides={"punch_source": lit("device")})
    pairs = fetch_csv(
        src,
        "SELECT id, duplicate_of_id FROM transactions WHERE duplicate_of_id IS NOT NULL",
    )
    pairs = [p for p in pairs if p["duplicate_of_id"] in s.ids]
    for i in range(0, len(pairs), 500):
        chunk = pairs[i : i + 500]
        values = ",".join(
            f"({lit(s.remap(p['id']))},{lit(s.remap(p['duplicate_of_id']))})" for p in chunk
        )
        psql_stdin(
            multi,
            f"""UPDATE transactions t SET duplicate_of_id=v.dup
                FROM (VALUES {values}) AS v(id, dup)
                WHERE t.id=v.id AND t.company_id={lit(company_id)}""",
        )
    print(f"  transactions duplicate links: {len(pairs)}")
    s.copy("attendances")

    print("\n[7] payroll / advances / deductions")
    s.copy("payrolls")
    s.copy("payroll_lines")
    s.copy("advances_long")
    s.copy("advance_long_payments")
    s.copy("advances_short")
    s.copy("deductions")
    s.copy("advance_loan_imports")
    s.copy("advance_loan_import_lines")
    s.copy("punch_report_imports")

    print("\n[8] requests / hiring / overtime")
    for t in (
        "leave_requests",
        "loan_requests",
        "advance_requests",
        "shift_change_requests",
        "salary_requests",
        "certificate_requests",
        "attendance_edit_requests",
        "overtime_analyses",
        "hiring_appointments",
    ):
        try:
            s.copy(t)
        except RuntimeError as e:
            print(f"  {t}: skipped ({e})")

    print("\n[9] biotime + odoo config")
    copy_config_row(s, "biotime_config")
    copy_config_row(s, "odoo_config")
    try:
        s.copy("odoo_sync_maps")
    except RuntimeError as e:
        print(f"  odoo_sync_maps: skipped ({e})")
    try:
        s.copy("department_mappings")
    except RuntimeError as e:
        print(f"  department_mappings: skipped ({e})")

    print("\n[10] memberships")
    ensure_memberships(multi, company_id)

    print(f"\n[summary] {args.company}")
    for t in [
        "users",
        "locations",
        "departments",
        "employee_profiles",
        "devices",
        "shift_grids",
        "shift_grid_lines",
        "transactions",
        "attendances",
        "payrolls",
        "payroll_lines",
        "advances_short",
        "advances_long",
        "deductions",
        "biotime_config",
        "odoo_config",
    ]:
        n = psql(multi, f"SELECT count(*) FROM {t} WHERE company_id={lit(company_id)}", True).strip()
        print(f"  {t}={n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
