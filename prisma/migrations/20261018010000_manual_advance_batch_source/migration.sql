-- Manual short-advance open batches share AdvanceLoanImport with source='manual'.
ALTER TABLE "advance_loan_imports"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sheet';

CREATE INDEX IF NOT EXISTS "advance_loan_imports_company_id_source_state_idx"
  ON "advance_loan_imports"("company_id", "source", "state");
