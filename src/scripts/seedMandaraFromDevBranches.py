#!/usr/bin/env python3
"""
Seed mandara (hudoori_multi_dev) with a sample from biotime_dev.

- 2 branches: Bri.Mad + Sizzler
- Shared catalogs + employees at those branches (capped)
- Limited punches / attendance / advances / deductions / grids

Schema-aware: copies column intersection only; adds company_id; skips user_id.
"""

from __future__ import annotations

import csv
import io
import os
import re
import subprocess
import sys
from pathlib import Path

COMPANY_ID = "cmtzm46jf000410wbw2x5icz4"  # mandara
LOCATION_IDS = [
    "cmruv0w640055spj2c6u9ccj2",  # Bri.Mad
    "cmruv0wr7005espj2on91yp0u",  # Sizzler
]

MAX_EMPLOYEES = 80
MAX_TXN = 1500
MAX_ATT = 1500
MAX_ADV_SHORT = 40
MAX_DED = 40
MAX_GRIDS = 4
MAX_GRID_LINES = 2500

BACKEND = Path(__file__).resolve().parents[2]
MULTI_ENV = BACKEND / ".env"
DEV_ENV = Path("/root/hodouri/bio_time_backend-dev/.env.dev")

SKIP_ALWAYS = {"company_id", "user_id", "org_parent_manual"}


def parse_db_url(path: Path, prefer_migrate: bool = False) -> dict:
    text = path.read_text()
    migrate = normal = None
    for line in text.splitlines():
        if line.startswith("MIGRATE_DATABASE_URL="):
            migrate = line.split("=", 1)[1].strip().strip('"')
        elif line.startswith("DATABASE_URL="):
            normal = line.split("=", 1)[1].strip().strip('"')
    url = (migrate if prefer_migrate and migrate else None) or migrate or normal
    m = re.match(r"postgresql://([^:]+):([^@]+)@([^:/]+):?(\d+)?/([^?]+)", url or "")
    if not m:
        raise SystemExit(f"Bad DATABASE_URL in {path}")
    user, pw, host, port, db = m.groups()
    return {"user": user, "password": pw, "host": host, "port": port or "5432", "db": db}


def env_for(cfg: dict) -> dict:
    return {
        **os.environ,
        "PGHOST": cfg["host"],
        "PGPORT": cfg["port"],
        "PGUSER": cfg["user"],
        "PGPASSWORD": cfg["password"],
        "PGDATABASE": cfg["db"],
        "PGOPTIONS": "-c client_min_messages=warning",
    }


def psql(cfg: dict, sql: str, tuples: bool = False) -> str:
    cmd = ["psql", "-v", "ON_ERROR_STOP=1"]
    cmd += ["-tAc", sql] if tuples else ["-c", sql]
    p = subprocess.run(cmd, env=env_for(cfg), capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"psql failed:\n{p.stderr}\nSQL:\n{sql[:1000]}")
    return p.stdout


def columns(cfg: dict, table: str) -> list[str]:
    sql = f"""
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='{table}'
    ORDER BY ordinal_position
    """
    return [l for l in psql(cfg, sql, tuples=True).splitlines() if l.strip()]


def col_types(cfg: dict, table: str) -> dict[str, str]:
    sql = f"""
    SELECT column_name || '|' || data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='{table}'
    """
    out = {}
    for line in psql(cfg, sql, tuples=True).splitlines():
        if "|" in line:
            n, t = line.split("|", 1)
            out[n] = t
    return out


def fetch_csv(cfg: dict, sql: str) -> list[dict]:
    wrapped = f"COPY ({sql}) TO STDOUT WITH CSV HEADER"
    p = subprocess.run(
        ["psql", "-v", "ON_ERROR_STOP=1", "-c", wrapped],
        env=env_for(cfg),
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"COPY failed:\n{p.stderr}\nSQL:\n{sql[:1000]}")
    return list(csv.DictReader(io.StringIO(p.stdout)))


def lit(v: str | None) -> str:
    if v is None or v == "" or v == "\\N":
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def sql_val(v: str | None, data_type: str, col: str) -> str:
    if v is None or v == "" or v == "\\N":
        if col == "basic_salary":
            return "0"
        if data_type == "boolean":
            return "false"
        if data_type == "ARRAY":
            return "ARRAY[]::text[]"
        return "NULL"
    if data_type == "boolean":
        return "true" if v.lower() in ("t", "true", "1", "yes") else "false"
    if data_type in ("integer", "bigint", "smallint", "double precision", "numeric", "real"):
        return v
    if data_type == "ARRAY":
        if v == "{}":
            return "ARRAY[]::text[]"
        return lit(v) + "::text[]"
    # timestamps / text / enums
    return lit(v)


def in_list(ids: list[str]) -> str:
    return ",".join(lit(i) for i in ids)


def insert_batch(cfg: dict, table: str, cols: list[str], value_rows: list[list[str]]) -> int:
    if not value_rows:
        print(f"  {table}: 0")
        return 0
    total = 0
    batch = 80
    col_sql = ", ".join(cols)
    for i in range(0, len(value_rows), batch):
        chunk = value_rows[i : i + batch]
        values = ",\n".join("(" + ",".join(r) + ")" for r in chunk)
        sql = f"INSERT INTO {table} ({col_sql}) VALUES {values} ON CONFLICT (id) DO NOTHING;"
        psql(cfg, sql)
        total += len(chunk)
    print(f"  {table}: {total}")
    return total


def copy_table(
    multi: dict,
    dev: dict,
    table: str,
    where: str | None = None,
    order_limit: str | None = None,
    extra_defaults: dict[str, str] | None = None,
    nullify: set[str] | None = None,
) -> int:
    mcols = columns(multi, table)
    dcols = columns(dev, table)
    shared = [c for c in dcols if c in mcols and c not in SKIP_ALWAYS]
    if "id" in shared:
        shared = ["id"] + [c for c in shared if c != "id"]
    if not shared:
        print(f"  {table}: skip (no shared cols)")
        return 0

    sql = f"SELECT {', '.join(shared)} FROM {table}"
    if where:
        sql += f" WHERE {where}"
    if order_limit:
        sql += f" {order_limit}"

    rows = fetch_csv(dev, sql)
    types = col_types(multi, table)
    extra_defaults = extra_defaults or {}
    nullify = nullify or set()

    insert_cols = ["company_id"] + shared
    for k in extra_defaults:
        if k in mcols and k not in insert_cols:
            insert_cols.append(k)

    out = []
    for r in rows:
        vals = [lit(COMPANY_ID)]
        for c in shared:
            if c in nullify:
                vals.append("NULL")
            else:
                vals.append(sql_val(r.get(c), types.get(c, "text"), c))
        for k, default in extra_defaults.items():
            if k in insert_cols and k not in shared and k != "company_id":
                vals.append(default)
        out.append(vals)
    return insert_batch(multi, table, insert_cols, out)


def main() -> int:
    multi = parse_db_url(MULTI_ENV, prefer_migrate=True)
    dev = parse_db_url(DEV_ENV)
    assert multi["db"] == "hudoori_multi_dev", multi["db"]
    assert dev["db"] == "biotime_dev", dev["db"]

    loc_sql = in_list(LOCATION_IDS)
    print(f"mandara={COMPANY_ID}")
    print(f"branches: Bri.Mad + Sizzler")
    print(f"{dev['db']} -> {multi['db']} as {psql(multi, 'SELECT current_user', True).strip()}")

    print("\n[1] catalogs")
    for t in ("archive_reasons", "custody_types", "insurance_companies", "job_levels", "departments", "job_titles", "shifts"):
        copy_table(multi, dev, t)

    print("\n[2] locations + devices")
    # locations: shared cols + multi geo defaults
    mcols = columns(multi, "locations")
    dcols = columns(dev, "locations")
    shared = [c for c in dcols if c in mcols and c not in SKIP_ALWAYS | {"manager_employee_id"}]
    shared = ["id"] + [c for c in shared if c != "id"]
    locs = fetch_csv(dev, f"SELECT {', '.join(shared)} FROM locations WHERE id IN ({loc_sql})")
    types = col_types(multi, "locations")
    insert_cols = ["company_id", *shared, "manager_employee_id"]
    extras = []
    for extra, default in [
        ("location_punch_enabled", "false"),
        ("latitude", "NULL"),
        ("longitude", "NULL"),
        ("geofence_radius_meters", "200"),
    ]:
        if extra in mcols:
            insert_cols.append(extra)
            extras.append(default)
    out = []
    for r in locs:
        vals = [lit(COMPANY_ID)]
        for c in shared:
            vals.append(sql_val(r.get(c), types.get(c, "text"), c))
        vals.append("NULL")  # manager_employee_id
        vals.extend(extras)
        out.append(vals)
    insert_batch(multi, "locations", insert_cols, out)

    copy_table(multi, dev, "devices", where=f"location_id IN ({loc_sql})")

    print("\n[3] employees")
    emp_ids = [
        l
        for l in psql(
            dev,
            f"""
            SELECT id FROM employee_profiles
            WHERE location_id IN ({loc_sql}) AND active = true
            ORDER BY code NULLS LAST
            LIMIT {MAX_EMPLOYEES}
            """,
            True,
        ).splitlines()
        if l.strip()
    ]
    print(f"  selected={len(emp_ids)}")
    if not emp_ids:
        raise SystemExit("no employees")
    emp_sql = in_list(emp_ids)

    mcols = columns(multi, "employee_profiles")
    dcols = columns(dev, "employee_profiles")
    shared = [c for c in dcols if c in mcols and c not in SKIP_ALWAYS]
    shared = ["id"] + [c for c in shared if c != "id"]
    emps = fetch_csv(dev, f"SELECT {', '.join(shared)} FROM employee_profiles WHERE id IN ({emp_sql})")
    types = col_types(multi, "employee_profiles")
    out = []
    for r in emps:
        vals = [lit(COMPANY_ID), "NULL"]  # company_id, user_id
        for c in shared:
            v = r.get(c)
            if c == "manager_id" and v and v not in emp_ids:
                vals.append("NULL")
            else:
                vals.append(sql_val(v, types.get(c, "text"), c))
        out.append(vals)
    insert_batch(multi, "employee_profiles", ["company_id", "user_id", *shared], out)

    print("\n[4] shift grids")
    grid_ids = [
        l
        for l in psql(
            dev,
            f"""
            SELECT id FROM shift_grids
            WHERE location_id IN ({loc_sql})
            ORDER BY date_to DESC NULLS LAST, created_at DESC
            LIMIT {MAX_GRIDS}
            """,
            True,
        ).splitlines()
        if l.strip()
    ]
    if grid_ids:
        gsql = in_list(grid_ids)
        copy_table(
            multi,
            dev,
            "shift_grids",
            where=f"id IN ({gsql})",
            nullify={
                "merged_into_grid_id",
                "merged_from_grid_ids",
                "merged_at",
                "device_id",  # may point outside selected devices
            },
        )
        copy_table(
            multi,
            dev,
            "shift_grid_lines",
            where=f"grid_id IN ({gsql}) AND employee_id IN ({emp_sql})",
            order_limit=f"LIMIT {MAX_GRID_LINES}",
            nullify={"shift_id"} if False else set(),  # keep shift_id; shifts copied
        )

    print("\n[5] punches / attendance")
    copy_table(
        multi,
        dev,
        "transactions",
        where=f"employee_id IN ({emp_sql})",
        order_limit=f"ORDER BY punch_time DESC NULLS LAST LIMIT {MAX_TXN}",
        extra_defaults={"punch_source": lit("device")} if "punch_source" in columns(multi, "transactions") else None,
    )
    copy_table(
        multi,
        dev,
        "attendances",
        where=f"employee_id IN ({emp_sql})",
        order_limit=f"ORDER BY date DESC NULLS LAST LIMIT {MAX_ATT}",
    )

    print("\n[6] advances / deductions / hiring")
    copy_table(
        multi,
        dev,
        "advances_short",
        where=f"employee_id IN ({emp_sql})",
        order_limit=f"ORDER BY created_at DESC NULLS LAST LIMIT {MAX_ADV_SHORT}",
        nullify={"source_grid_id", "payroll_id", "payroll_line_id"},
    )
    copy_table(
        multi,
        dev,
        "deductions",
        where=f"employee_id IN ({emp_sql})",
        order_limit=f"ORDER BY created_at DESC NULLS LAST LIMIT {MAX_DED}",
        nullify={"payroll_id", "payroll_line_id", "device_id"},
    )
    # hiring: created_by is NOT NULL — attach to mandara HR user
    hr_user = psql(
        multi,
        f"SELECT id FROM users WHERE company_id={lit(COMPANY_ID)} ORDER BY created_at LIMIT 1",
        True,
    ).strip()
    if hr_user:
        mcols = columns(multi, "hiring_appointments")
        dcols = columns(dev, "hiring_appointments")
        shared = [c for c in dcols if c in mcols and c not in SKIP_ALWAYS]
        shared = ["id"] + [c for c in shared if c != "id"]
        rows = fetch_csv(
            dev,
            f"SELECT {', '.join(shared)} FROM hiring_appointments WHERE location_id IN ({loc_sql}) LIMIT 10",
        )
        types = col_types(multi, "hiring_appointments")
        out = []
        for r in rows:
            vals = [lit(COMPANY_ID)]
            for c in shared:
                if c in ("created_by_user_id", "approved_by_user_id"):
                    vals.append(lit(hr_user) if c == "created_by_user_id" else "NULL")
                elif c == "employee_profile_id":
                    vals.append("NULL")
                else:
                    vals.append(sql_val(r.get(c), types.get(c, "text"), c))
            out.append(vals)
        insert_batch(multi, "hiring_appointments", ["company_id", *shared], out)
    else:
        print("  hiring_appointments: skipped (no mandara user)")

    print("\n[summary] mandara")
    for t in [
        "locations",
        "departments",
        "job_titles",
        "job_levels",
        "shifts",
        "devices",
        "employee_profiles",
        "shift_grids",
        "shift_grid_lines",
        "transactions",
        "attendances",
        "advances_short",
        "deductions",
        "hiring_appointments",
        "archive_reasons",
        "custody_types",
        "insurance_companies",
    ]:
        n = psql(
            multi,
            f"SELECT count(*) FROM {t} WHERE company_id={lit(COMPANY_ID)}",
            True,
        ).strip()
        print(f"  {t}={n}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"FAILED: {e}", file=sys.stderr)
        raise
