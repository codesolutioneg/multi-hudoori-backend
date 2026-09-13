/**
 * Server deploy workflow: optionally reset DB, then pull everything from Odoo.
 *
 * Usage (on server after deploy):
 *   npm run server:odoo-sync -- --reset --yes
 *
 * Or step by step:
 *   npm run db:reset -- --yes
 *   npm run odoo:pull
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import path from 'path';
import { prisma } from '../prisma/client';
import { pullAllFromOdoo } from '../services/odoo/odooPull.service';
import { testOdooConnection } from '../services/odoo/odooClient.service';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const doReset = hasFlag('--reset');
  const autoYes = hasFlag('--yes') || hasFlag('-y');

  console.log('=== Hudoori server Odoo sync ===\n');

  if (doReset) {
    console.log('Step 1: Reset local database…');
    const resetScript = path.join(__dirname, 'resetDatabase.ts');
    const resetCmd = `npx ts-node "${resetScript}"${autoYes ? ' --yes' : ''}`;
    execSync(resetCmd, { stdio: 'inherit', cwd: path.join(__dirname, '../..') });
  } else {
    console.log('Step 1: Skipped DB reset (add --reset to wipe business data first)\n');
  }

  console.log('\nStep 2: Test Odoo connection…');
  const conn = await testOdooConnection();
  if (!conn.ok) {
    console.error(`Odoo connection failed: ${conn.message}`);
    console.error('Set ODOO_BASE_URL, ODOO_DATABASE, ODOO_LOGIN, ODOO_PASSWORD in .env');
    process.exit(1);
  }
  console.log(`Odoo: ${conn.message}`);

  console.log('\nStep 3: Pull employees → shifts → grids → deductions → advances → payrolls…');
  const stats = await pullAllFromOdoo();

  console.log('\n--- Server Odoo sync complete ---');
  console.log(JSON.stringify(stats, null, 2));

  const [employees, grids, payrolls] = await Promise.all([
    prisma.employeeProfile.count(),
    prisma.shiftGrid.findMany({
      include: { _count: { select: { lines: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    }),
    prisma.payroll.count(),
  ]);

  console.log(`\nLocal totals: ${employees} employees, ${payrolls} payrolls`);
  if (grids.length) {
    console.log('Recent shift grids:');
    for (const g of grids) {
      console.log(
        `  ${g.name} | ${g.dateFrom.toISOString().slice(0, 10)} → ${g.dateTo.toISOString().slice(0, 10)} | ${g._count.lines} lines`,
      );
    }
  }

  if (stats.errors > 0) {
    console.error(`\nWarning: ${stats.errors} error(s) during pull — check server logs.`);
    process.exit(1);
  }
  if (stats.skipped > 0) {
    console.log(`\nNote: ${stats.skipped} record(s) skipped (usually unmatched employee). Re-run after syncing employees from BioTime if needed.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
