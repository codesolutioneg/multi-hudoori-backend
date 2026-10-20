-- Employee seats count active profiles only. Archiving frees a seat; restoring
-- (active false → true) consumes one and is enforced by an UPDATE trigger.

CREATE OR REPLACE FUNCTION enforce_company_employee_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cap integer;
  used integer;
BEGIN
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Inactive / archived rows do not consume a seat.
  IF NEW.active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- UPDATE: only when becoming active (or moving company while already active).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.active IS TRUE
       AND OLD.company_id IS NOT DISTINCT FROM NEW.company_id THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT max_employees INTO cap FROM companies WHERE id = NEW.company_id;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize per company so concurrent create/restore cannot both pass.
  PERFORM pg_advisory_xact_lock(hashtext('employee_quota:' || NEW.company_id));

  SELECT count(*) INTO used FROM employee_profiles
    WHERE company_id = NEW.company_id
      AND active = true
      AND id <> NEW.id;

  IF used >= cap THEN
    RAISE EXCEPTION 'EMPLOYEE_QUOTA_EXCEEDED:%:%', used, cap
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_profiles_quota ON "employee_profiles";
CREATE TRIGGER employee_profiles_quota
  BEFORE INSERT OR UPDATE OF active, company_id ON "employee_profiles"
  FOR EACH ROW EXECUTE FUNCTION enforce_company_employee_quota();
