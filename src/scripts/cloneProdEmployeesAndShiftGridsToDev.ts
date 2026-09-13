/**
 * Clone employees + shift grids from PROD (biotime) → DEV (biotime_dev).
 *
 * - PROD is READ-ONLY (SELECT / pg_dump only). Never writes to biotime.
 * - Wipes employees + shift grids (and dependent HR rows) on biotime_dev only.
 * - Keeps DEV admin users / locations / departments / shifts / devices.
 *
 * Usage (from bio_time_backend-dev):
 *   npx tsx src/scripts/cloneProdEmployeesAndShiftGridsToDev.ts --yes
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient, UserRole } from '@prisma/client';

function loadEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing env file: ${filePath}`);
  for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function parseDbUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

function assertSafeTargets(prodDb: string, devDb: string) {
  if (prodDb !== 'biotime') {
    throw new Error(`Refusing: expected prod DB name "biotime", got "${prodDb}"`);
  }
  if (devDb !== 'biotime_dev') {
    throw new Error(`Refusing: expected dest DB name "biotime_dev", got "${devDb}"`);
  }
}

const KEEP_USER_LOGINS = new Set(
  [
    'demo@hudoori.com',
    'm@vicanz.com',
    'm@vicansa.com',
    'eng.mostafa.elgabry@gmail.com',
    'michael.charif@vicanzgroup.com',
    'michael.charlie@vicanzagroup.com',
    'rabab.hourani@vicanzgroup.com',
    'rabab.houran@vicanzagroup.com',
    'ahmed.essam@vicanzgroup.com',
    'ahmed.essam@vicanzagroup.com',
    'atf54399@gmail.com',
    'atf343069@gmail.com',
    'bioadmin@admin.bio',
    'Zalat@steak-house.org',
    't@t.com',
  ].map((s) => s.toLowerCase()),
);

const KEEP_ROLES: UserRole[] = [
  UserRole.PLATFORM_ADMIN,
  UserRole.HR_MANAGER,
  UserRole.HR_SUPERVISOR,
  UserRole.BRANCH_MANAGER,
  UserRole.DEVICE_MANAGER,
];

function shouldKeepUser(login: string, role: UserRole): boolean {
  if (KEEP_USER_LOGINS.has(login.toLowerCase())) return true;
  return KEEP_ROLES.includes(role);
}

async function wipeLabel(label: string, fn: () => Promise<unknown>) {
  const r = await fn();
  const n = typeof r === 'object' && r && 'count' in r ? (r as { count: number }).count : '?';
  console.log(`  - ${label}: ${n}`);
}

async function wipeDevEmployeesAndGrids(dev: PrismaClient) {
  console.log('\n[1/3] Wiping employees + shift grids on DEV only…');

  await wipeLabel('advanceLongPayment', () => dev.advanceLongPayment.deleteMany());
  await wipeLabel('advanceLoanImportLine', () => dev.advanceLoanImportLine.deleteMany());
  await wipeLabel('advanceLoanImport', () => dev.advanceLoanImport.deleteMany());
  await wipeLabel('payrollLine', () => dev.payrollLine.deleteMany());
  await wipeLabel('deduction', () => dev.deduction.deleteMany());
  await wipeLabel('advanceShort', () => dev.advanceShort.deleteMany());
  await wipeLabel('advanceLong', () => {
    // payments already cleared
    return dev.advanceLong.deleteMany();
  });
  await wipeLabel('payroll', () => dev.payroll.deleteMany());

  await wipeLabel('leaveRequest', () => dev.leaveRequest.deleteMany());
  await wipeLabel('loanRequest', () => dev.loanRequest.deleteMany());
  await wipeLabel('shiftChangeRequest', () => dev.shiftChangeRequest.deleteMany());
  await wipeLabel('salaryRequest', () => dev.salaryRequest.deleteMany());
  await wipeLabel('certificateRequest', () => dev.certificateRequest.deleteMany());
  await wipeLabel('attendanceEditRequest', () => dev.attendanceEditRequest.deleteMany());
  await wipeLabel('overtimeAnalysis', () => dev.overtimeAnalysis.deleteMany());
  await wipeLabel('hiringAppointment', () =>
    // detach then delete
    (async () => {
      await dev.hiringAppointment.updateMany({ data: { employeeProfileId: null } });
      return dev.hiringAppointment.deleteMany();
    })(),
  );

  await wipeLabel('attendance', () => dev.attendance.deleteMany());
  await wipeLabel('transaction', () => {
    // clear self-FK duplicates first
    return (async () => {
      await dev.$executeRawUnsafe(`UPDATE transactions SET duplicate_of_id = NULL`);
      return dev.transaction.deleteMany();
    })();
  });

  await wipeLabel('syncJob', () => dev.syncJob.deleteMany());
  await wipeLabel('shiftGridLine', () => dev.shiftGridLine.deleteMany());
  await wipeLabel('shiftAssignment', () => dev.shiftAssignment.deleteMany());
  // break merge self-FK then delete all grids
  await wipeLabel('shiftGrid.clearMergedInto', () =>
    (async () => {
      await dev.$executeRawUnsafe(`UPDATE shift_grids SET merged_into_grid_id = NULL`);
      return { count: 0 };
    })(),
  );
  await wipeLabel('shiftGrid', () => dev.shiftGrid.deleteMany());

  await wipeLabel('employeeCustody', () => dev.employeeCustody.deleteMany());
  await wipeLabel('employeeMapping', () => dev.employeeMapping.deleteMany());
  await wipeLabel('odooSyncMap employees', () =>
    (dev as unknown as { odooSyncMap: { deleteMany: (a: object) => Promise<{ count: number }> } })
      .odooSyncMap.deleteMany({
        where: { entityType: { in: ['employee', 'employee_profile'] } },
      }),
  );

  const keepUsers = await dev.user.findMany({
    select: { id: true, login: true, role: true },
  });
  const keepUserIds = keepUsers.filter((u) => shouldKeepUser(u.login, u.role)).map((u) => u.id);
  console.log(`  keeping ${keepUserIds.length} admin users`);

  await wipeLabel('unlink kept-user employee profiles', () =>
    dev.employeeProfile.updateMany({
      where: { userId: { in: keepUserIds } },
      data: { userId: null },
    }),
  );
  await wipeLabel('employeeProfile', () => dev.employeeProfile.deleteMany());

  await wipeLabel('apiToken (non-kept)', () =>
    dev.apiToken.deleteMany({ where: { userId: { notIn: keepUserIds } } }),
  );
  await wipeLabel('users (non-kept)', () =>
    dev.user.deleteMany({ where: { id: { notIn: keepUserIds } } }),
  );
}

function dumpProdTables(prod: ReturnType<typeof parseDbUrl>, outFile: string) {
  console.log('\n[2/3] Dumping employees + shift grids from PROD (read-only)…');
  const tables = [
    'employee_profiles',
    'employee_mappings',
    'employee_custodies',
    'shift_grids',
    'shift_grid_lines',
  ];
  const args = [
    '-h',
    prod.host,
    '-p',
    prod.port,
    '-U',
    prod.user,
    '-d',
    prod.database,
    '--data-only',
    '--no-owner',
    '--no-privileges',
    '--column-inserts',
    ...tables.flatMap((t) => ['-t', t]),
    '-f',
    outFile,
  ];
  execFileSync('pg_dump', args, {
    env: { ...process.env, PGPASSWORD: prod.password },
    stdio: 'inherit',
  });
  const size = fs.statSync(outFile).size;
  console.log(`  dump written: ${outFile} (${Math.round(size / 1024)} KB)`);
}

function restoreIntoDev(dev: ReturnType<typeof parseDbUrl>, dumpFile: string) {
  console.log('\n[3/3] Restoring into DEV…');
  execFileSync(
    'psql',
    ['-h', dev.host, '-p', dev.port, '-U', dev.user, '-d', dev.database, '-v', 'ON_ERROR_STOP=1', '-f', dumpFile],
    {
      env: { ...process.env, PGPASSWORD: dev.password },
      stdio: 'inherit',
    },
  );
}

async function counts(client: PrismaClient, label: string) {
  const [employees, mappings, grids, lines] = await Promise.all([
    client.employeeProfile.count(),
    client.employeeMapping.count(),
    client.shiftGrid.count(),
    client.shiftGridLine.count(),
  ]);
  console.log(
    `${label}: employees=${employees} mappings=${mappings} grids=${grids} lines=${lines}`,
  );
  return { employees, mappings, grids, lines };
}

async function main() {
  if (!process.argv.includes('--yes') && !process.argv.includes('-y')) {
    console.error('Refusing without --yes');
    console.error('Usage: npx tsx src/scripts/cloneProdEmployeesAndShiftGridsToDev.ts --yes');
    process.exit(1);
  }

  const prodEnv = loadEnvFile('/root/hodouri/bio_time_backend/.env.prod');
  const devEnv = loadEnvFile('/root/hodouri/bio_time_backend-dev/.env.dev');
  const prodUrl = prodEnv.DATABASE_URL;
  const devUrl = devEnv.DATABASE_URL;
  if (!prodUrl || !devUrl) throw new Error('DATABASE_URL missing in env files');

  const prodDb = parseDbUrl(prodUrl);
  const devDb = parseDbUrl(devUrl);
  assertSafeTargets(prodDb.database, devDb.database);

  console.log('=== Clone PROD employees + shift grids → DEV ===');
  console.log(`PROD (read-only): ${prodDb.host}:${prodDb.port}/${prodDb.database}`);
  console.log(`DEV  (write):     ${devDb.host}:${devDb.port}/${devDb.database}`);
  console.log('PROD will NOT be modified.\n');

  const prod = new PrismaClient({ datasources: { db: { url: prodUrl } } });
  const dev = new PrismaClient({ datasources: { db: { url: devUrl } } });

  // Guard: only allow SELECT on prod via prisma for counts; never call write APIs on prod.
  const beforeProd = await counts(prod, 'PROD before');
  const beforeDev = await counts(dev, 'DEV  before');

  await wipeDevEmployeesAndGrids(dev);
  await counts(dev, 'DEV  after wipe');

  const dumpFile = path.join(os.tmpdir(), `hudoori-prod-emps-grids-${Date.now()}.sql`);
  try {
    dumpProdTables(prodDb, dumpFile);
    restoreIntoDev(devDb, dumpFile);
  } finally {
    try {
      fs.unlinkSync(dumpFile);
    } catch {
      /* ignore */
    }
  }

  const afterProd = await counts(prod, 'PROD after (must match before)');
  const afterDev = await counts(dev, 'DEV  after restore');

  if (
    afterProd.employees !== beforeProd.employees ||
    afterProd.grids !== beforeProd.grids ||
    afterProd.lines !== beforeProd.lines
  ) {
    throw new Error('PROD counts changed — abort investigation needed (should be impossible)');
  }

  if (
    afterDev.employees !== beforeProd.employees ||
    afterDev.grids !== beforeProd.grids ||
    afterDev.lines !== beforeProd.lines
  ) {
    console.warn('WARNING: DEV counts do not fully match PROD dump source.');
  } else {
    console.log('\nOK: DEV employees + shift grids match PROD.');
  }

  console.log(`(DEV started at employees=${beforeDev.employees} grids=${beforeDev.grids})`);

  await prod.$disconnect();
  await dev.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
