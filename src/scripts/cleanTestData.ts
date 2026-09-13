/**
 * Wipe all business data from PostgreSQL.
 * Keeps:
 *   - platform admin user (bioadmin@admin.bio)
 *   - shift definitions (shifts table)
 *   - BioTime config + Odoo config
 *
 * Deletes everything else (employees, grids, payroll, attendance, other users, …).
 *
 * Usage:
 *   npm run db:clean
 *   npm run db:clean -- --yes
 *
 * Tip: stop the API first if the wipe hangs on locks:
 *   pm2 stop biotime-backend && npm run db:clean -- --yes && pm2 start biotime-backend
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as readline from 'readline';

const PLATFORM_ADMIN_LOGIN = 'bioadmin@admin.bio';
const prisma = new PrismaClient();

async function confirmProceed(): Promise<boolean> {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      'Delete ALL data except shifts + platform admin? Type YES to continue: ',
      resolve,
    );
  });
  rl.close();
  return answer.trim().toUpperCase() === 'YES';
}

async function wipe(label: string, fn: () => Promise<unknown>) {
  process.stdout.write(`  - ${label}… `);
  const result = await fn();
  const count = typeof result === 'object' && result && 'count' in result
    ? (result as { count: number }).count
    : '?';
  console.log(`ok (${count})`);
}

async function main() {
  const ok = await confirmProceed();
  if (!ok) {
    console.log('Cancelled.');
    return;
  }

  const admin = await prisma.user.findFirst({
    where: { login: PLATFORM_ADMIN_LOGIN, companyId: null },
  });
  if (!admin) {
    throw new Error(`Platform admin not found: ${PLATFORM_ADMIN_LOGIN}. Run npm run prisma:seed first.`);
  }

  const shiftsBefore = await prisma.shift.count();
  console.log(`Cleaning database… keeping ${shiftsBefore} shift(s) + platform admin.`);

  // Sequential deletes (avoids one long transaction blocking forever under load).
  // Order: children → parents. Do NOT delete shifts.
  await wipe('advanceLongPayment', () => prisma.advanceLongPayment.deleteMany());
  await wipe('advanceLoanImportLine', () => prisma.advanceLoanImportLine.deleteMany());
  await wipe('advanceLoanImport', () => prisma.advanceLoanImport.deleteMany());
  await wipe('payrollLine', () => prisma.payrollLine.deleteMany());
  await wipe('deduction', () => prisma.deduction.deleteMany());
  await wipe('advanceShort', () => prisma.advanceShort.deleteMany());
  await wipe('advanceLong', () => prisma.advanceLong.deleteMany());
  await wipe('payroll', () => prisma.payroll.deleteMany());

  await wipe('leaveRequest', () => prisma.leaveRequest.deleteMany());
  await wipe('loanRequest', () => prisma.loanRequest.deleteMany());
  await wipe('shiftChangeRequest', () => prisma.shiftChangeRequest.deleteMany());
  await wipe('salaryRequest', () => prisma.salaryRequest.deleteMany());
  await wipe('certificateRequest', () => prisma.certificateRequest.deleteMany());
  await wipe('attendanceEditRequest', () => prisma.attendanceEditRequest.deleteMany());
  await wipe('overtimeAnalysis', () => prisma.overtimeAnalysis.deleteMany());
  await wipe('hiringAppointment', () => prisma.hiringAppointment.deleteMany());

  await wipe('attendance', () => prisma.attendance.deleteMany());
  await wipe('transaction', () => prisma.transaction.deleteMany());
  await wipe('syncJob', () => prisma.syncJob.deleteMany());

  await wipe('shiftGridLine', () => prisma.shiftGridLine.deleteMany());
  await wipe('shiftAssignment', () => prisma.shiftAssignment.deleteMany());
  await wipe('shiftGrid', () => prisma.shiftGrid.deleteMany());

  await wipe('employeeCustody', () => prisma.employeeCustody.deleteMany());
  await wipe('employeeMapping', () => prisma.employeeMapping.deleteMany());
  await wipe('employeeProfile', () => prisma.employeeProfile.deleteMany());
  await wipe('departmentMapping', () => prisma.departmentMapping.deleteMany());
  await wipe('department', () => prisma.department.deleteMany());
  await wipe('device', () => prisma.device.deleteMany());
  await wipe('location', () => prisma.location.deleteMany());
  await wipe('custodyType', () => prisma.custodyType.deleteMany());
  await wipe('insuranceCompany', () => prisma.insuranceCompany.deleteMany());

  await wipe('odooSyncMap', () => prisma.odooSyncMap.deleteMany());
  await wipe('systemCounter', () => prisma.systemCounter.deleteMany());
  await wipe('apiToken (non-admin)', () => prisma.apiToken.deleteMany({ where: { userId: { not: admin.id } } }));
  await wipe('users (non-admin)', () => prisma.user.deleteMany({ where: { id: { not: admin.id } } }));

  const counts = {
    users: await prisma.user.count(),
    employees: await prisma.employeeProfile.count(),
    departments: await prisma.department.count(),
    devices: await prisma.device.count(),
    locations: await prisma.location.count(),
    shifts: await prisma.shift.count(),
    shiftGrids: await prisma.shiftGrid.count(),
    shiftAssignments: await prisma.shiftAssignment.count(),
    transactions: await prisma.transaction.count(),
    payrolls: await prisma.payroll.count(),
    deductions: await prisma.deduction.count(),
    hiringAppointments: await prisma.hiringAppointment.count(),
  };

  console.log('\n--- Database cleaned ---');
  console.log('Kept: platform admin, shifts, biotime_config, odoo_config');
  console.log('Remaining:', counts);
  console.log(`Admin: ${PLATFORM_ADMIN_LOGIN} (id: ${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
