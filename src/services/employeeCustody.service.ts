import { prisma } from '../prisma/client';
import { getCompanyId } from '../tenant/context';
import { employeeCustodyJson } from './custodyType.service';

const LEGACY_CODE_MAP: Record<string, 'laptopProvided' | 'mobileProvided' | 'mobileLine'> = {
  LAPTOP: 'laptopProvided',
  MOBILE: 'mobileProvided',
  MOBILE_LINE: 'mobileLine',
};

export async function listEmployeeCustodies(employeeId: string) {
  const rows = await prisma.employeeCustody.findMany({
    where: { employeeId },
    include: { custodyType: true },
    orderBy: [{ custodyType: { sequence: 'asc' } }, { custodyType: { name: 'asc' } }],
  });
  return rows.map(employeeCustodyJson);
}

export async function syncEmployeeCustodies(
  employeeId: string,
  items: Array<{ custodyTypeId: string; provided?: boolean }>,
) {
  const typeIds = [...new Set(items.map((i) => String(i.custodyTypeId)).filter(Boolean))];
  if (typeIds.length) {
    const found = await prisma.custodyType.count({ where: { id: { in: typeIds }, active: true } });
    if (found !== typeIds.length) {
      throw new Error('نوع عهدة غير صالح');
    }
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.employeeCustody.findMany({
      where: { employeeId },
      include: { custodyType: true },
    });
    const incoming = new Map(typeIds.map((id) => [id, items.find((i) => i.custodyTypeId === id)]));

    for (const id of typeIds) {
      const provided = incoming.get(id)?.provided === true;
      await tx.employeeCustody.upsert({
        where: { employeeId_custodyTypeId: { employeeId, custodyTypeId: id } },
        create: { employeeId, custodyTypeId: id, provided },
        update: { provided },
      });
    }

    const removeIds = existing
      .filter((e) => !typeIds.includes(e.custodyTypeId))
      .map((e) => e.id);
    if (removeIds.length) {
      await tx.employeeCustody.deleteMany({ where: { id: { in: removeIds } } });
    }

    const legacyPatch: Record<string, boolean> = {};
    const all = await tx.employeeCustody.findMany({
      where: { employeeId },
      include: { custodyType: true },
    });
    for (const row of all) {
      const code = row.custodyType.code?.toUpperCase() ?? '';
      const legacyKey = LEGACY_CODE_MAP[code];
      if (legacyKey) legacyPatch[legacyKey] = row.provided;
    }
    if (Object.keys(legacyPatch).length) {
      await tx.employeeProfile.update({ where: { id: employeeId }, data: legacyPatch });
    }
  });

  return listEmployeeCustodies(employeeId);
}

export async function ensureDefaultCustodyTypes() {
  const companyId = getCompanyId();
  if (!companyId) {
    throw new Error('COMPANY_CONTEXT_REQUIRED:CustodyType.ensureDefault');
  }
  const defaults = [
    { name: 'Laptop', code: 'LAPTOP', sequence: 10 },
    { name: 'Mobile', code: 'MOBILE', sequence: 20 },
    { name: 'خط الموبايل', code: 'MOBILE_LINE', sequence: 25 },
  ];
  for (const d of defaults) {
    const existing = await prisma.custodyType.findFirst({
      where: { companyId, code: d.code },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.custodyType.create({
      data: {
        companyId,
        name: d.name,
        code: d.code,
        sequence: d.sequence,
        active: true,
      },
    });
  }
}
