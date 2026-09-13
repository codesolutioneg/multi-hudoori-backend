/**
 * Prod data fix: move Order Takers from Delivery → Operation.
 *
 * Matches job titles like: اوردرتيكر / اوردر تيكر / Order Taker
 * Only updates employees currently in Delivery.
 *
 * Usage (prod):
 *   DOTENV_CONFIG_PATH=.env.prod npx ts-node -r dotenv/config --transpile-only \
 *     src/scripts/moveOrderTakersDeliveryToOperation.ts --dry-run
 *   DOTENV_CONFIG_PATH=.env.prod npx ts-node -r dotenv/config --transpile-only \
 *     src/scripts/moveOrderTakersDeliveryToOperation.ts --apply
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';

const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY || process.argv.includes('--dry-run');

/** Exact titles present (or expected) in Master Data / Hudoori. */
const ORDER_TAKER_TITLES = [
  'اوردرتيكر',
  'اوردر تيكر',
  'أوردرتيكر',
  'أوردر تيكر',
  'Order Taker',
  'OrderTaker',
  'order taker',
];

const JOB_TITLE_FILTER: Prisma.EmployeeProfileWhereInput = {
  OR: ORDER_TAKER_TITLES.map((t) => ({
    jobTitle: { equals: t, mode: 'insensitive' as const },
  })),
};

async function main() {
  const delivery = await prisma.department.findFirst({
    where: { name: { equals: 'Delivery', mode: 'insensitive' }, active: true },
  });
  const operation = await prisma.department.findFirst({
    where: { name: { equals: 'Operation', mode: 'insensitive' }, active: true },
  });

  if (!delivery) throw new Error('Department "Delivery" not found');
  if (!operation) throw new Error('Department "Operation" not found');

  const targets = await prisma.employeeProfile.findMany({
    where: {
      ...JOB_TITLE_FILTER,
      departmentId: delivery.id,
    },
    select: {
      id: true,
      code: true,
      name: true,
      jobTitle: true,
      active: true,
      location: true,
      departmentId: true,
    },
    orderBy: [{ code: 'asc' }, { name: 'asc' }],
  });

  const alreadyOperation = await prisma.employeeProfile.count({
    where: { ...JOB_TITLE_FILTER, departmentId: operation.id },
  });
  const otherDepts = await prisma.employeeProfile.findMany({
    where: {
      AND: [
        JOB_TITLE_FILTER,
        { OR: [{ departmentId: { not: delivery.id } }, { departmentId: null }] },
        { NOT: { departmentId: operation.id } },
      ],
    },
    select: {
      code: true,
      name: true,
      jobTitle: true,
      department: { select: { name: true } },
    },
  });

  console.log(
    JSON.stringify(
      {
        mode: DRY_RUN ? 'DRY_RUN' : 'APPLY',
        databaseHint: process.env.DATABASE_URL?.replace(/:\/\/[^@]+@/, '://***@') ?? null,
        delivery: { id: delivery.id, name: delivery.name },
        operation: { id: operation.id, name: operation.name },
        toMove: targets.length,
        alreadyInOperation: alreadyOperation,
        orderTakersInOtherDepts: otherDepts,
        employees: targets.map((e) => ({
          code: e.code,
          name: e.name,
          jobTitle: e.jobTitle,
          location: e.location,
          active: e.active,
        })),
      },
      null,
      2,
    ),
  );

  if (targets.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  if (DRY_RUN) {
    console.log('Dry-run only. Re-run with --apply to update.');
    return;
  }

  const result = await prisma.employeeProfile.updateMany({
    where: { id: { in: targets.map((e) => e.id) }, departmentId: delivery.id },
    data: { departmentId: operation.id },
  });

  const verify = await prisma.employeeProfile.count({
    where: { ...JOB_TITLE_FILTER, departmentId: delivery.id },
  });
  const inOp = await prisma.employeeProfile.count({
    where: { ...JOB_TITLE_FILTER, departmentId: operation.id },
  });

  console.log(
    JSON.stringify(
      {
        updated: result.count,
        remainingInDelivery: verify,
        nowInOperation: inOp,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
