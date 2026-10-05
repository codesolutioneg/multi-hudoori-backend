#!/usr/bin/env python3
"""Sanitize PII in the shared Multi demo company (code=demo).

Safe to re-run. Renames branches/devices/grids and clears phones, national IDs,
emails, birthdays, bank/Fawry, doc URLs, and real employee names.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"


def load_database_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    if not ENV_FILE.exists():
        raise SystemExit(f"Missing {ENV_FILE}")
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("DATABASE_URL not found")


def main() -> None:
    db = load_database_url()
    cid = subprocess.check_output(
        ["psql", db, "-tAc", "SELECT id FROM companies WHERE code='demo'"],
        text=True,
    ).strip()
    if not cid:
        raise SystemExit("Company code=demo not found")

    sql = f"""
BEGIN;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) AS rn
  FROM locations WHERE company_id = '{cid}'
)
UPDATE locations l SET name = 'Demo ' || o.rn FROM ordered o WHERE l.id = o.id;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY code NULLS LAST, name, id) AS rn
  FROM employee_profiles WHERE company_id = '{cid}'
)
UPDATE employee_profiles e SET
  name = 'Demo Employee ' || n.rn,
  display_name = 'Demo Employee ' || n.rn,
  mobile_phone = NULL,
  work_phone = NULL,
  mobile_line_phone = NULL,
  work_email = NULL,
  work_email_password = NULL,
  address = NULL,
  national_id_confirm = NULL,
  identification_id = CASE
    WHEN e.identification_id IS NULL OR e.identification_id = '' THEN NULL
    ELSE 'DEMO-' || n.rn END,
  birthday = NULL,
  fawry_account = NULL,
  bank_iban = NULL,
  insurance_number = NULL,
  id_card_photo_url = NULL,
  personal_photo_doc_url = NULL,
  insurance_print_url = NULL,
  qualification_doc_url = NULL,
  military_doc_url = NULL,
  birth_certificate_doc_url = NULL,
  criminal_record_doc_url = NULL,
  has_fawry_account = false,
  misr_account = false,
  mobile_line = false
FROM numbered n WHERE e.id = n.id;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY appointment_date, id) AS rn
  FROM hiring_appointments WHERE company_id = '{cid}'
)
UPDATE hiring_appointments h SET
  employee_name = 'Demo Candidate ' || n.rn,
  mobile_phone = '010000000' || LPAD(n.rn::text, 2, '0'),
  national_id = '000000000000' || LPAD(n.rn::text, 2, '0'),
  notes = NULL,
  status_note = NULL,
  pdf_path = NULL,
  approved_by_name = CASE WHEN h.approved_by_name IS NULL THEN NULL ELSE 'Demo HR' END
FROM numbered n WHERE h.id = n.id;

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
  FROM devices WHERE company_id = '{cid}'
)
UPDATE devices d SET
  name = 'Demo Device ' || n.rn,
  alias = 'Demo Device ' || n.rn,
  serial_number = 'DEMO-SN-' || COALESCE(d.biotime_id::text, n.rn::text),
  ip_address = NULL
FROM numbered n WHERE d.id = n.id;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) AS rn
  FROM shift_grids WHERE company_id = '{cid}'
)
UPDATE shift_grids g SET name = 'Demo Grid ' || o.rn
FROM ordered o WHERE g.id = o.id;

COMMIT;
"""
    subprocess.check_call(["psql", db, "-v", "ON_ERROR_STOP=1", "-c", sql])
    print(f"Sanitized demo company {cid}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit(e.returncode)
