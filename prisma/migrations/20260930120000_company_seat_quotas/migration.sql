-- SaaS seats per company. NULL = unlimited.
-- Enforced in Postgres so every insert path (API, imports, BioTime/Odoo sync, scripts) is capped.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "max_employees" INTEGER,
  ADD COLUMN IF NOT EXISTS "max_users" INTEGER;

ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_max_employees_nonneg";
ALTER TABLE "companies" ADD CONSTRAINT "companies_max_employees_nonneg"
  CHECK ("max_employees" IS NULL OR "max_employees" >= 0);
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_max_users_nonneg";
ALTER TABLE "companies" ADD CONSTRAINT "companies_max_users_nonneg"
  CHECK ("max_users" IS NULL OR "max_users" >= 0);

-- Every employee row counts, archived included (archiving does not free a seat).
CREATE OR REPLACE FUNCTION enforce_company_employee_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  used integer;
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT max_employees INTO cap FROM companies WHERE id = NEW.company_id;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  -- Serialize inserts per company so concurrent requests cannot both pass the check.
  PERFORM pg_advisory_xact_lock(hashtext('employee_quota:' || NEW.company_id));
  SELECT count(*) INTO used FROM employee_profiles WHERE company_id = NEW.company_id;
  IF used >= cap THEN
    RAISE EXCEPTION 'EMPLOYEE_QUOTA_EXCEEDED:%:%', used, cap
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_profiles_quota ON "employee_profiles";
CREATE TRIGGER employee_profiles_quota
  BEFORE INSERT ON "employee_profiles"
  FOR EACH ROW EXECUTE FUNCTION enforce_company_employee_quota();

-- Dashboard seats only: EMPLOYEE (work-email login) and PLATFORM_ADMIN are not counted.
CREATE OR REPLACE FUNCTION enforce_company_user_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  used integer;
BEGIN
  IF NEW.company_id IS NULL OR NEW.role IN ('EMPLOYEE', 'PLATFORM_ADMIN') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.role NOT IN ('EMPLOYEE', 'PLATFORM_ADMIN')
     AND OLD.company_id IS NOT DISTINCT FROM NEW.company_id THEN
    RETURN NEW;
  END IF;
  SELECT max_users INTO cap FROM companies WHERE id = NEW.company_id;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('user_quota:' || NEW.company_id));
  SELECT count(*) INTO used FROM users
    WHERE company_id = NEW.company_id
      AND role NOT IN ('EMPLOYEE', 'PLATFORM_ADMIN')
      AND id <> NEW.id;
  IF used >= cap THEN
    RAISE EXCEPTION 'USER_QUOTA_EXCEEDED:%:%', used, cap
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_quota ON "users";
-- UPDATE OF role too: promoting an EMPLOYEE login to HR takes a seat.
CREATE TRIGGER users_quota
  BEFORE INSERT OR UPDATE OF role, company_id ON "users"
  FOR EACH ROW EXECUTE FUNCTION enforce_company_user_quota();
