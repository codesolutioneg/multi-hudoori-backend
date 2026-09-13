/**
 * Seed a realistic dataset for load testing and mint a token for the runner.
 *
 *   node tests/load/seed.mjs [--employees 300] [--days 30]
 *
 * Prints a JSON line with the ids the load scripts need. Safe to re-run: it
 * removes its own `LOAD-` prefixed rows first and leaves other data alone.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const EMPLOYEES = arg('employees', 300);
const DAYS = arg('days', 30);
const PREFIX = 'LOAD-';
const LOGIN = 'loadtest@hudoori.local';
const PASSWORD = 'LoadTest#2026';
const TOKEN = 'load-test-token';

async function cleanup() {
  const employees = await prisma.employeeProfile.findMany({
    where: { code: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = employees.map((e) => e.id);
  if (ids.length) {
    await prisma.payrollLine.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.transaction.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.shiftGridLine.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.shiftAssignment.deleteMany({ where: { employeeId: { in: ids } } });
    await prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } });
  }
  await prisma.payroll.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.shiftGrid.deleteMany({ where: { name: { startsWith: PREFIX } } });
  if (ids.length) await prisma.employeeProfile.deleteMany({ where: { id: { in: ids } } });
  await prisma.shift.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function main() {
  await cleanup();

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { login: LOGIN },
    update: { passwordHash, role: 'HR_MANAGER', active: true },
    create: { login: LOGIN, name: 'Load Test HR', passwordHash, role: 'HR_MANAGER' },
  });

  await prisma.apiToken.deleteMany({ where: { token: TOKEN } });
  await prisma.apiToken.create({
    data: {
      token: TOKEN,
      userId: user.id,
      deviceInfo: 'load-test',
      expiryDate: new Date(Date.now() + 7 * 86400000),
    },
  });

  const shift = await prisma.shift.create({
    data: {
      name: `${PREFIX}Morning`,
      code: 'LDM',
      startTime: '08:00',
      endTime: '17:00',
      gracePeriodIn: 20,
      gracePeriodOut: 15,
    },
  });

  const dateFrom = new Date(Date.UTC(2026, 5, 1));
  const dateTo = new Date(Date.UTC(2026, 5, DAYS));

  const grid = await prisma.shiftGrid.create({
    data: { name: `${PREFIX}Grid`, dateFrom, dateTo, selectionMethod: 'manual' },
  });

  const payroll = await prisma.payroll.create({
    data: { name: `${PREFIX}Payroll`, dateFrom, dateTo },
  });

  console.error(`seeding ${EMPLOYEES} employees x ${DAYS} days…`);
  let txId = 9_000_000;
  const employeeIds = [];

  for (let i = 0; i < EMPLOYEES; i++) {
    const code = `${PREFIX}${String(i).padStart(4, '0')}`;
    const employee = await prisma.employeeProfile.create({
      data: { name: `Load Employee ${i}`, code, basicSalary: 3000 + (i % 50) * 100 },
    });
    employeeIds.push(employee.id);

    await prisma.shiftAssignment.create({
      data: {
        employeeId: employee.id,
        shiftId: shift.id,
        dateFrom,
        assignmentType: 'permanent',
        active: true,
      },
    });

    const gridLines = [];
    const punches = [];
    for (let d = 1; d <= DAYS; d++) {
      const date = new Date(Date.UTC(2026, 5, d));
      gridLines.push({ gridId: grid.id, employeeId: employee.id, date, shiftId: shift.id });
      punches.push(
        {
          employeeId: employee.id,
          empCode: code,
          biotimeTransactionId: txId++,
          punchTime: new Date(Date.UTC(2026, 5, d, 5, 0)),
          punchState: '0',
        },
        {
          employeeId: employee.id,
          empCode: code,
          biotimeTransactionId: txId++,
          punchTime: new Date(Date.UTC(2026, 5, d, 14, 0)),
          punchState: '1',
        },
      );
    }
    await prisma.shiftGridLine.createMany({ data: gridLines });
    await prisma.transaction.createMany({ data: punches });

    await prisma.payrollLine.create({
      data: {
        payrollId: payroll.id,
        employeeId: employee.id,
        sequence: i + 1,
        employeeCode: code,
        basicSalary: employee.basicSalary,
        workingDays: DAYS,
        workDaysSalary: employee.basicSalary,
        totalEarnings: employee.basicSalary,
        grossSalary: employee.basicSalary,
        totalDeductions: 0,
        netSalary: employee.basicSalary,
      },
    });

    if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${EMPLOYEES}`);
  }

  console.log(
    JSON.stringify({
      token: TOKEN,
      login: LOGIN,
      password: PASSWORD,
      gridId: grid.id,
      payrollId: payroll.id,
      employeeId: employeeIds[0],
      employees: EMPLOYEES,
      days: DAYS,
      dateFrom: dateFrom.toISOString().slice(0, 10),
      dateTo: dateTo.toISOString().slice(0, 10),
    }),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
