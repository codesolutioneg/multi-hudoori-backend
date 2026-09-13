/**
 * Same wipe as db:clean — keep shifts + platform admin.
 * Prefer: npm run db:clean -- --yes
 *
 * Usage:
 *   npm run db:reset
 *   npm run db:reset -- --yes
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
    rl.question('Delete ALL business data (keep shifts + admin)? Type YES to continue: ', resolve);
  });
  rl.close();
  return answer.trim().toUpperCase() === 'YES';
}

async function wipe(label: string, fn: () => Promise<{ count: number }>) {
  process.stdout.write(`  - ${label}… `);
  const result = await fn();
  console.log(`ok (${result.count})`);
}

async function main() {
  const ok = await confirmProceed();
  if (!ok) {
    console.log('Cancelled.');
    return;
  }

  const admin = await prisma.user.findUnique({ where: { login: PLATFORM_ADMIN_LOGIN } });
  if (!admin) {
    throw new Error(`Platform admin not found: ${PLATFORM_ADMIN_LOGIN}. Run: npm run setup`);
  }

  console.log('Resetting database (business data only)…');

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
  await wipe('apiToken', () => prisma.apiToken.deleteMany({ where: { userId: { not: admin.id } } }));
  await wipe('users', () => prisma.user.deleteMany({ where: { id: { not: admin.id } } }));

  const counts = {
    users: await prisma.user.count(),
    employees: await prisma.employeeProfile.count(),
    departments: await prisma.department.count(),
    devices: await prisma.device.count(),
    shifts: await prisma.shift.count(),
    shiftGrids: await prisma.shiftGrid.count(),
    payrolls: await prisma.payroll.count(),
    odooMaps: await prisma.odooSyncMap.count(),
  };

  console.log('\n--- Database reset complete ---');
  console.log('Kept: platform admin, shifts, biotime_config, odoo_config');
  console.log('Remaining counts:', counts);
  console.log(`Admin login: ${PLATFORM_ADMIN_LOGIN}`);
  console.log('\nNext step: npm run server:odoo-sync');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
