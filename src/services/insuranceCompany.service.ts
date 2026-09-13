import { InsuranceCompany } from '@prisma/client';
import { prisma } from '../prisma/client';
import { NotFoundError } from '../utils/errors';

export async function resolveInsuranceCompany(id: string): Promise<InsuranceCompany> {
  const row = await prisma.insuranceCompany.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('شركة التأمين غير موجودة');
  return row;
}
