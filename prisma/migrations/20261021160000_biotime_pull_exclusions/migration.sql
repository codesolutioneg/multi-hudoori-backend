-- Hard-deleted employees must not be recreated by BioTime pull.
CREATE TABLE "biotime_pull_exclusions" (
  "company_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "biotime_emp_id" INTEGER,
  "emp_code" TEXT,
  "employee_name" TEXT,
  "deleted_employee_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "biotime_pull_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "biotime_pull_exclusions_company_id_biotime_emp_id_idx"
  ON "biotime_pull_exclusions"("company_id", "biotime_emp_id");
CREATE INDEX "biotime_pull_exclusions_company_id_emp_code_idx"
  ON "biotime_pull_exclusions"("company_id", "emp_code");

ALTER TABLE "biotime_pull_exclusions"
  ADD CONSTRAINT "biotime_pull_exclusions_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "biotime_pull_exclusions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "biotime_pull_exclusions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "biotime_pull_exclusions";
CREATE POLICY tenant_isolation ON "biotime_pull_exclusions"
  USING (
    current_setting('app.company_id', true) IS NULL
    OR current_setting('app.company_id', true) = ''
    OR company_id = current_setting('app.company_id', true)
  )
  WITH CHECK (
    current_setting('app.company_id', true) IS NULL
    OR current_setting('app.company_id', true) = ''
    OR company_id = current_setting('app.company_id', true)
  );
