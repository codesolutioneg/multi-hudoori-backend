/**
 * Pull الاستقطاعات والسلف والرواتب والشيفتات from Odoo into local PostgreSQL.
 *
 * Usage:
 *   npm run odoo:pull
 *   npm run odoo:pull -- --grids --grid-id=42
 *   npm run odoo:pull -- --shifts --assignments --payrolls
 *
 * Requires ODOO_BASE_URL, ODOO_LOGIN, ODOO_PASSWORD in .env (or odoo_config table).
 */
import 'dotenv/config';
import { prisma } from '../prisma/client';
import { pullAllFromOdoo } from '../services/odoo/odooPull.service';
import { testOdooConnection } from '../services/odoo/odooClient.service';

function parseArgs(argv: string[]) {
  const opts: {
    employees?: boolean;
    shifts?: boolean;
    assignments?: boolean;
    shiftGrids?: boolean;
    odooGridId?: number;
    gridLimit?: number;
    deductions?: boolean;
    advancesShort?: boolean;
    advancesLong?: boolean;
    payrolls?: boolean;
    listLimit?: number;
  } = {};

  for (const arg of argv) {
    if (arg === '--employees') opts.employees = true;
    else if (arg === '--shifts') opts.shifts = true;
    else if (arg === '--assignments') opts.assignments = true;
    else if (arg === '--grids') opts.shiftGrids = true;
    else if (arg === '--deductions') opts.deductions = true;
    else if (arg === '--advances-short') opts.advancesShort = true;
    else if (arg === '--advances-long') opts.advancesLong = true;
    else if (arg === '--payrolls') opts.payrolls = true;
    else if (arg.startsWith('--grid-id=')) opts.odooGridId = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--grid-limit=')) opts.gridLimit = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--limit=')) opts.listLimit = parseInt(arg.split('=')[1], 10);
    else if (arg === '--help' || arg === '-h') {
      console.log(`
Odoo pull — imports shifts, grids, payroll, deductions, advances into Hudoori DB.

Options (default: pull everything):
  --employees         Pull hr.employee profiles first (recommended)
  --shifts            Pull biotime.shift templates
  --assignments       Pull shift assignments
  --grids             Pull shift grids + lines
  --grid-id=N         Pull one Odoo shift grid by id
  --grid-limit=N      Max grids when listing (default 20)
  --deductions        Pull استقطاعات
  --advances-short    Pull سلف قصيرة
  --advances-long     Pull سلف طويلة
  --payrolls          Pull كشوف الرواتب + lines
  --limit=N           List limit for deductions/advances (default 500)
`);
      process.exit(0);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('--- Odoo pull (read from Odoo → write local DB) ---');
  const conn = await testOdooConnection();
  if (!conn.ok) {
    console.error(`Odoo connection failed: ${conn.message}`);
    console.error('Set ODOO_BASE_URL, ODOO_LOGIN, ODOO_PASSWORD in .env');
    process.exit(1);
  }
  console.log(`Odoo: ${conn.message}\n`);

  const stats = await pullAllFromOdoo(opts);

  console.log('\n--- Pull complete ---');
  console.log(JSON.stringify(stats, null, 2));

  if (stats.shiftGrids > 0) {
    const grids = await prisma.shiftGrid.findMany({
      include: { _count: { select: { lines: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });
    console.log('\nRecent shift grids (local):');
    for (const g of grids) {
      console.log(`  ${g.name} | ${g.dateFrom.toISOString().slice(0, 10)} → ${g.dateTo.toISOString().slice(0, 10)} | ${g._count.lines} lines | state=${g.state}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
