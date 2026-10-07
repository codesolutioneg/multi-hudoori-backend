#!/usr/bin/env python3
"""
Seed any Multi company (hudoori_multi_dev) with a sample from biotime_dev.

Unlike seedMandaraFromDevBranches.py, every copied id is re-keyed with a
per-company suffix so the same dev rows (e.g. Sizzler, shared catalogs) can be
copied into several companies without colliding on the global `id` PK.
Id-shaped FK values that point outside the copied set are nulled (or the row
is skipped when the column is NOT NULL) so nothing references another tenant.

Usage:
  python3 src/scripts/seedCompanyFromDevBranches.py --company beta \
      --branches Strip Leven Bri.Str Sizzler
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import subprocess  # noqa: E402

from seedMandaraFromDevBranches import (  # noqa: E402
    DEV_ENV,
    MULTI_ENV,
    SKIP_ALWAYS,
    columns,
    env_for,
    fetch_csv,
    in_list,
    lit,
    parse_db_url,
    psql,
    sql_val,
)


def psql_stdin(cfg: dict, sql: str) -> None:
    """Large statements go through stdin — argv has a hard size limit."""
    p = subprocess.run(
        ["psql", "-v", "ON_ERROR_STOP=1", "-q"],
        input=sql,
        env=env_for(cfg),
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"psql failed:\n{p.stderr}\nSQL:\n{sql[:1000]}")


def insert_batch(cfg: dict, table: str, cols: list[str], value_rows: list[list[str]]) -> int:
    col_sql = ", ".join(cols)
    batch = 500
    for i in range(0, len(value_rows), batch):
        chunk = value_rows[i : i + batch]
        values = ",\n".join("(" + ",".join(r) + ")" for r in chunk)
        # Any unique key (id, company_id+code, …) — not only PK — so re-seeds
        # against companies that already have starter catalogs don't abort.
        psql_stdin(cfg, f"INSERT INTO {table} ({col_sql}) VALUES {values} ON CONFLICT DO NOTHING;")
    print(f"  {table}: {len(value_rows)}")
    return len(value_rows)

MAX_EMPLOYEES = 80
MAX_TXN = 1500
MAX_ATT = 1500
MAX_ADV_SHORT = 40
MAX_DED = 40
MAX_GRIDS = 4
MAX_GRID_LINES = 2500

CUID_RE = re.compile(r"^c[a-z0-9]{20,}$")


class Seeder:
    def __init__(self, multi: dict, dev: dict, company_id: str, suffix: str):
        self.multi = multi
        self.dev = dev
        self.company_id = company_id
        self.suffix = suffix
        self.ids: set[str] = set()

    def remap(self, v: str) -> str:
        return v + self.suffix

    def remap_array(self, v: str | None) -> str:
        """Postgres text[] literal: remap copied ids, drop ids outside the sample."""
        items = [x.strip('"') for x in (v or "{}").strip("{}").split(",") if x]
        out = []
        for x in items:
            if x in self.ids:
                out.append(self.remap(x))
            elif not CUID_RE.match(x):
                out.append(x)
        if not out:
            return "ARRAY[]::text[]"
        return "ARRAY[" + ",".join(lit(x) for x in out) + "]::text[]"

    def col_meta(self, table: str) -> dict[str, tuple[str, bool]]:
        sql = f"""
        SELECT column_name || '|' || data_type || '|' || is_nullable
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='{table}'
        """
        out = {}
        for line in psql(self.multi, sql, tuples=True).splitlines():
            parts = line.split("|")
            if len(parts) == 3:
                out[parts[0]] = (parts[1], parts[2] == "YES")
        return out

    def copy(
        self,
        table: str,
        where: str | None = None,
        order_limit: str | None = None,
        nullify: set[str] | None = None,
        skip: set[str] | None = None,
        overrides: dict[str, str] | None = None,
    ) -> list[str]:
        """Copy rows; returns the dev ids that were selected."""
        mcols = columns(self.multi, table)
        dcols = columns(self.dev, table)
        skip = (skip or set()) | SKIP_ALWAYS
        shared = [c for c in dcols if c in mcols and c not in skip]
        shared = ["id"] + [c for c in shared if c != "id"]
        sql = f"SELECT {', '.join(shared)} FROM {table}"
        if where:
            sql += f" WHERE {where}"
        if order_limit:
            sql += f" {order_limit}"
        rows = fetch_csv(self.dev, sql)
        dev_ids = [r["id"] for r in rows]
        self.ids.update(dev_ids)

        meta = self.col_meta(table)
        nullify = nullify or set()
        overrides = {k: v for k, v in (overrides or {}).items() if k in mcols}
        insert_cols = ["company_id", *shared, *[k for k in overrides if k not in shared]]

        out, skipped = [], 0
        for r in rows:
            vals = [lit(self.company_id)]
            ok = True
            for c in shared:
                dtype, nullable = meta.get(c, ("text", True))
                v = r.get(c)
                if c in overrides:
                    vals.append(overrides[c])
                    continue
                if c in nullify:
                    vals.append("NULL")
                    continue
                if dtype == "ARRAY":
                    vals.append(self.remap_array(v))
                    continue
                if v and v in self.ids:
                    v = self.remap(v)
                elif v and CUID_RE.match(v):
                    if nullable:
                        vals.append("NULL")
                        continue
                    else:
                        ok = False
                        break
                vals.append(sql_val(v, dtype, c))
            if not ok:
                skipped += 1
                continue
            for k, v in overrides.items():
                if k not in shared:
                    vals.append(v)
            out.append(vals)
        insert_batch(self.multi, table, insert_cols, out)
        if skipped:
            print(f"    ({skipped} rows skipped: required FK outside sample)")
        return dev_ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", required=True, help="Multi company code")
    ap.add_argument("--branches", nargs="+", required=True, help="Dev location names")
    ap.add_argument(
        "--full",
        action="store_true",
        help="All branch employees, grids (with merge links), punches and attendance — no caps",
    )
    args = ap.parse_args()

    multi = parse_db_url(MULTI_ENV, prefer_migrate=True)
    dev = parse_db_url(DEV_ENV)
    assert multi["db"] == "hudoori_multi_dev", multi["db"]
    assert dev["db"] == "biotime_dev", dev["db"]

    company_id = psql(
        multi, f"SELECT id FROM companies WHERE code={lit(args.company)}", True
    ).strip()
    if not company_id:
        raise SystemExit(f"company not found: {args.company}")
    suffix = "_" + re.sub(r"[^a-z0-9]", "", args.company.lower())

    loc_ids = [
        l
        for l in psql(
            dev, f"SELECT id FROM locations WHERE name IN ({in_list(args.branches)})", True
        ).splitlines()
        if l.strip()
    ]
    if len(loc_ids) != len(args.branches):
        raise SystemExit(f"branches found {len(loc_ids)}/{len(args.branches)}")
    loc_sql = in_list(loc_ids)

    s = Seeder(multi, dev, company_id, suffix)
    print(f"{args.company}={company_id} suffix={suffix}")
    print(f"branches: {', '.join(args.branches)}")

    print("\n[1] catalogs")
    for t in ("archive_reasons", "custody_types", "insurance_companies", "job_levels",
              "departments", "job_titles", "shifts"):
        s.copy(t)

    print("\n[2] locations + devices")
    s.copy(
        "locations",
        where=f"id IN ({loc_sql})",
        nullify={"manager_employee_id"},
        overrides={
            "location_punch_enabled": "false",
            "latitude": "NULL",
            "longitude": "NULL",
            "geofence_radius_meters": "200",
        },
    )
    s.copy("devices", where=f"location_id IN ({loc_sql})")

    print("\n[3] employees")
    emp_ids: list[str] = []
    if args.full:
        emp_ids = [
            l
            for l in psql(
                dev, f"SELECT id FROM employee_profiles WHERE location_id IN ({loc_sql})", True
            ).splitlines()
            if l.strip()
        ]
    else:
        per_branch = max(1, MAX_EMPLOYEES // len(loc_ids))
        for lid in loc_ids:
            emp_ids += [
                l
                for l in psql(
                    dev,
                    f"""SELECT id FROM employee_profiles
                        WHERE location_id={lit(lid)} AND active = true
                        ORDER BY code NULLS LAST LIMIT {per_branch}""",
                    True,
                ).splitlines()
                if l.strip()
            ]
    print(f"  selected={len(emp_ids)}")
    emp_sql = in_list(emp_ids)
    s.ids.update(emp_ids)
    s.copy("employee_profiles", where=f"id IN ({emp_sql})")
    if args.full:
        s.copy("employee_mappings", where=f"employee_id IN ({emp_sql})")

    print("\n[4] shift grids")
    grid_limit = "" if args.full else f"LIMIT {MAX_GRIDS}"
    grid_ids = [
        l
        for l in psql(
            dev,
            f"""SELECT id FROM shift_grids WHERE location_id IN ({loc_sql})
                ORDER BY date_to DESC NULLS LAST, created_at DESC {grid_limit}""",
            True,
        ).splitlines()
        if l.strip()
    ]
    if grid_ids:
        gsql = in_list(grid_ids)
        if args.full:
            # Earlier sample runs stored these grids without merge links; re-insert them whole.
            mine = in_list([s.remap(g) for g in grid_ids])
            cid = lit(company_id)
            psql(multi, f"DELETE FROM shift_grid_manual_ot_lines WHERE company_id={cid} AND grid_id IN ({mine})")
            psql(multi, f"DELETE FROM shift_grid_lines WHERE company_id={cid} AND grid_id IN ({mine})")
            psql(multi, f"UPDATE advances_short SET source_grid_id=NULL WHERE company_id={cid} AND source_grid_id IN ({mine})")
            psql(multi, f"UPDATE shift_grids SET merged_into_grid_id=NULL WHERE company_id={cid} AND id IN ({mine})")
            psql(multi, f"DELETE FROM shift_grids WHERE company_id={cid} AND id IN ({mine})")
        s.copy(
            "shift_grids",
            where=f"id IN ({gsql})",
            nullify=set() if args.full else {"merged_into_grid_id", "merged_from_grid_ids", "merged_at", "device_id"},
        )
        s.copy(
            "shift_grid_lines",
            where=f"grid_id IN ({gsql}) AND employee_id IN ({emp_sql})",
            order_limit="" if args.full else f"LIMIT {MAX_GRID_LINES}",
        )
        if args.full:
            s.copy(
                "shift_grid_manual_ot_lines",
                where=f"grid_id IN ({gsql}) AND employee_id IN ({emp_sql})",
            )

    print("\n[5] punches / attendance")
    txn_ids = s.copy(
        "transactions",
        where=f"employee_id IN ({emp_sql})",
        order_limit="" if args.full else f"ORDER BY punch_time DESC NULLS LAST LIMIT {MAX_TXN}",
        overrides={"punch_source": lit("device")},
        nullify={"duplicate_of_id"},
    )
    if txn_ids:
        # Self-reference set after all rows exist (the original may land in a later batch).
        pairs = fetch_csv(
            dev,
            f"SELECT id, duplicate_of_id FROM transactions WHERE duplicate_of_id IS NOT NULL AND employee_id IN ({emp_sql})",
        )
        pairs = [p for p in pairs if p["duplicate_of_id"] in s.ids]
        for i in range(0, len(pairs), 500):
            chunk = pairs[i : i + 500]
            values = ",".join(f"({lit(s.remap(p['id']))},{lit(s.remap(p['duplicate_of_id']))})" for p in chunk)
            psql_stdin(
                multi,
                f"""UPDATE transactions t SET duplicate_of_id=v.dup
                    FROM (VALUES {values}) AS v(id, dup)
                    WHERE t.id=v.id AND t.company_id={lit(company_id)}""",
            )
        print(f"  transactions duplicate links: {len(pairs)}")
    s.copy(
        "attendances",
        where=f"employee_id IN ({emp_sql})",
        order_limit="" if args.full else f"ORDER BY date DESC NULLS LAST LIMIT {MAX_ATT}",
    )

    print("\n[6] advances / deductions / hiring")
    s.copy(
        "advances_short",
        where=f"employee_id IN ({emp_sql})",
        order_limit=f"ORDER BY created_at DESC NULLS LAST LIMIT {MAX_ADV_SHORT}",
        nullify={"source_grid_id", "payroll_id", "payroll_line_id"},
    )
    s.copy(
        "deductions",
        where=f"employee_id IN ({emp_sql})",
        order_limit=f"ORDER BY created_at DESC NULLS LAST LIMIT {MAX_DED}",
        nullify={"payroll_id", "payroll_line_id", "device_id"},
    )
    hr_user = psql(
        multi,
        f"SELECT id FROM users WHERE company_id={lit(company_id)} ORDER BY created_at LIMIT 1",
        True,
    ).strip()
    if hr_user:
        s.copy(
            "hiring_appointments",
            where=f"location_id IN ({loc_sql})",
            order_limit="LIMIT 10",
            nullify={"approved_by_user_id", "employee_profile_id"},
            overrides={"created_by_user_id": lit(hr_user)},
        )
    else:
        print("  hiring_appointments: skipped (no company user)")

    print(f"\n[summary] {args.company}")
    for t in ["locations", "departments", "job_titles", "job_levels", "shifts", "devices",
              "employee_profiles", "employee_mappings", "shift_grids", "shift_grid_lines",
              "shift_grid_manual_ot_lines", "transactions",
              "attendances", "advances_short", "deductions", "hiring_appointments"]:
        n = psql(multi, f"SELECT count(*) FROM {t} WHERE company_id={lit(company_id)}", True).strip()
        print(f"  {t}={n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
