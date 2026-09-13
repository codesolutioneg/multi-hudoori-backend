import { prisma } from '../prisma/client';
import { requireCompanyId } from '../tenant/context';

/** Odoo ir.sequence biotime.deduction — DED/YYYY/00001 */
export async function nextDeductionReference(date = new Date()): Promise<string> {
  const year = date.getUTCFullYear();
  const counterId = `deduction_${year}`;
  const companyId = requireCompanyId();

  const row = await prisma.systemCounter.upsert({
    where: { companyId_id: { companyId, id: counterId } },
    create: { companyId, id: counterId, value: 1 },
    update: { value: { increment: 1 } },
  });

  const seq = String(row.value).padStart(5, '0');
  return `DED/${year}/${seq}`;
}

export async function nextAdvanceLoanImportReference(date = new Date()): Promise<string> {
  const year = date.getUTCFullYear();
  const counterId = `loan_import_${year}`;
  const companyId = requireCompanyId();

  const row = await prisma.systemCounter.upsert({
    where: { companyId_id: { companyId, id: counterId } },
    create: { companyId, id: counterId, value: 1 },
    update: { value: { increment: 1 } },
  });

  const seq = String(row.value).padStart(5, '0');
  return `LOAN/${year}/${seq}`;
}

export async function nextTipImportReference(date = new Date()): Promise<string> {
  const year = date.getUTCFullYear();
  const counterId = `tip_import_${year}`;
  const companyId = requireCompanyId();

  const row = await prisma.systemCounter.upsert({
    where: { companyId_id: { companyId, id: counterId } },
    create: { companyId, id: counterId, value: 1 },
    update: { value: { increment: 1 } },
  });

  const seq = String(row.value).padStart(5, '0');
  return `TIP/${year}/${seq}`;
}
