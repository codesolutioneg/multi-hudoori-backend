-- Insurance forms (س1 / س6) + establishments

CREATE TYPE "InsuranceFormType" AS ENUM ('S1', 'S6');

CREATE TABLE "insurance_establishments" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "insurance_number" TEXT,
    "office" TEXT,
    "address" TEXT,
    "building_number" TEXT,
    "street" TEXT,
    "village" TEXT,
    "district" TEXT,
    "governorate" TEXT,
    "establishment_type" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sequence" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "insurance_establishments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "insurance_forms" (
    "company_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "form_type" "InsuranceFormType" NOT NULL,
    "employee_id" TEXT,
    "employee_name" TEXT NOT NULL,
    "employee_code" TEXT,
    "insurance_number" TEXT,
    "national_id" TEXT,
    "establishment_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "insurance_forms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "insurance_establishments_company_id_idx" ON "insurance_establishments"("company_id");
CREATE INDEX "insurance_establishments_company_id_active_idx" ON "insurance_establishments"("company_id", "active");
CREATE INDEX "insurance_forms_company_id_form_type_created_at_idx" ON "insurance_forms"("company_id", "form_type", "created_at");
CREATE INDEX "insurance_forms_company_id_employee_id_idx" ON "insurance_forms"("company_id", "employee_id");
CREATE INDEX "insurance_forms_created_by_user_id_idx" ON "insurance_forms"("created_by_user_id");

ALTER TABLE "insurance_establishments" ADD CONSTRAINT "insurance_establishments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "insurance_forms" ADD CONSTRAINT "insurance_forms_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "insurance_forms" ADD CONSTRAINT "insurance_forms_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employee_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "insurance_forms" ADD CONSTRAINT "insurance_forms_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "insurance_establishments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "insurance_forms" ADD CONSTRAINT "insurance_forms_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['insurance_establishments', 'insurance_forms'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           current_setting(''app.company_id'', true) IS NULL
           OR current_setting(''app.company_id'', true) = ''''
           OR company_id = current_setting(''app.company_id'', true)
         )
         WITH CHECK (
           current_setting(''app.company_id'', true) IS NULL
           OR current_setting(''app.company_id'', true) = ''''
           OR company_id = current_setting(''app.company_id'', true)
         )',
      t
    );
  END LOOP;
END $$;
