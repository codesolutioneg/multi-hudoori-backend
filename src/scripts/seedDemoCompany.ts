/**
 * One-off: ensure shared demo tenant (code=demo) + HR login for Get Demo on landing.
 * Data sample: run seedCompanyFromDevBranches.py separately if needed.
 *
 *   npx tsx src/scripts/seedDemoCompany.ts
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { prismaBase } from '../prisma/client';
import { ensureBioTimeConfigFromEnv } from '../bootstrap/biotimeConfig';
import { ensureOdooConfigFromEnv } from '../bootstrap/odooConfig';

const DEMO_CODE = 'demo';
const DEMO_NAME = 'Demo';
const HR_LOGIN = 'hr@demo.test';
const HR_PASSWORD = 'Demo@123#';
const MAX_EMPLOYEES = 200;
const MAX_USERS = 10;

async function main() {
  let company = await prismaBase.company.findFirst({ where: { code: DEMO_CODE } });
  if (!company) {
    company = await prismaBase.company.create({
      data: {
        code: DEMO_CODE,
        name: DEMO_NAME,
        active: true,
        maxEmployees: MAX_EMPLOYEES,
        maxUsers: MAX_USERS,
      },
    });
    await ensureBioTimeConfigFromEnv(company.id);
    await ensureOdooConfigFromEnv(company.id);
    console.log('Created company demo');
  } else {
    console.log('Company demo already exists');
  }

  const passwordHash = await bcrypt.hash(HR_PASSWORD, 10);
  let user = await prismaBase.user.findFirst({
    where: { companyId: company.id, login: HR_LOGIN },
  });
  if (!user) {
    user = await prismaBase.user.create({
      data: {
        companyId: company.id,
        login: HR_LOGIN,
        email: HR_LOGIN,
        name: 'Demo HR',
        passwordHash,
        initialPassword: HR_PASSWORD,
        role: UserRole.HR_MANAGER,
      },
    });
    console.log('Created HR user', HR_LOGIN);
  } else {
    await prismaBase.user.update({
      where: { id: user.id },
      data: { passwordHash, initialPassword: HR_PASSWORD, role: UserRole.HR_MANAGER },
    });
    console.log('Updated HR password for', HR_LOGIN);
  }

  const profile = await prismaBase.employeeProfile.findFirst({ where: { userId: user.id } });
  if (!profile) {
    await prismaBase.employeeProfile.create({
      data: {
        companyId: company.id,
        userId: user.id,
        name: 'Demo HR',
        displayName: 'Demo HR',
        workEmail: HR_LOGIN,
      },
    });
  }

  console.log('Done. Optional: python3 src/scripts/seedCompanyFromDevBranches.py --company demo --branches Strip Leven');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prismaBase.$disconnect());
