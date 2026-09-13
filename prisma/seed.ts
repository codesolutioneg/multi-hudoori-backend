import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';

const PLATFORM_ADMIN_LOGIN = 'bioadmin@admin.bio';
const PLATFORM_ADMIN_PASSWORD = 'Hudoori$BioAdmin#2026!xK9mQ2';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash(PLATFORM_ADMIN_PASSWORD, 12);

  const existing = await prisma.user.findFirst({
    where: { login: PLATFORM_ADMIN_LOGIN, companyId: null },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, role: UserRole.PLATFORM_ADMIN, active: true },
    });
  } else {
    await prisma.user.create({
      data: {
        login: PLATFORM_ADMIN_LOGIN,
        email: PLATFORM_ADMIN_LOGIN,
        name: 'Hudoori Multi Platform Admin',
        passwordHash,
        role: UserRole.PLATFORM_ADMIN,
        companyId: null,
      },
    });
  }

  // BioTime/Odoo config rows are created per company when Super Admin adds a company.
  // Do not seed global config — there is no company-less BioTime/Odoo in multi.

  console.log('Seed complete');
  console.log(`Platform admin: ${PLATFORM_ADMIN_LOGIN}`);
  console.log('Create companies via Super Admin portal, then fill BioTime/Odoo per company.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
