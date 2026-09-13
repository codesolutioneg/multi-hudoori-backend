import { prisma } from '../prisma/client';

export async function generateSettingsCode(
  prefix: string,
  exists: (code: string) => Promise<boolean>,
): Promise<string> {
  const normalized = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'ITEM';
  for (let i = 1; i < 10000; i++) {
    const code = `${normalized}-${String(i).padStart(3, '0')}`;
    if (!(await exists(code))) return code;
  }
  throw new Error('تعذر إنشاء كود تلقائي');
}

export async function generateLocationCode(): Promise<string> {
  return generateSettingsCode('LOC', async (code) => {
    const row = await prisma.location.findFirst({ where: { code } });
    return row != null;
  });
}

export async function generateInsuranceCompanyCode(): Promise<string> {
  return generateSettingsCode('INS', async (code) => {
    const row = await prisma.insuranceCompany.findFirst({ where: { code } });
    return row != null;
  });
}

export async function generateDepartmentCode(): Promise<string> {
  return generateSettingsCode('DEPT', async (code) => {
    const row = await prisma.department.findFirst({ where: { code } });
    return row != null;
  });
}

export async function generateCustodyTypeCode(): Promise<string> {
  return generateSettingsCode('CUST', async (code) => {
    const row = await prisma.custodyType.findFirst({ where: { code } });
    return row != null;
  });
}

export async function generateJobTitleCode(): Promise<string> {
  return generateSettingsCode('JOB', async (code) => {
    const row = await prisma.jobTitle.findFirst({ where: { code } });
    return row != null;
  });
}
