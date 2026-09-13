/**
 * Provision EMPLOYEE app logins from existing workEmail + workEmailPassword.
 *
 * Dry-run:
 *   set -a && source .env.dev && set +a && npx ts-node --transpile-only \
 *     src/scripts/provisionEmployeeLogins.ts
 *
 * Apply:
 *   ... provisionEmployeeLogins.ts --apply
 */
import { prisma } from '../prisma/client';
import { syncEmployeeLoginFromWorkEmail } from '../services/employeeLogin.service';

const APPLY = process.argv.includes('--apply');

async function main() {
  const employees = await prisma.employeeProfile.findMany({
    where: {
      AND: [
        { workEmail: { not: null } },
        { NOT: { workEmail: '' } },
        { workEmailPassword: { not: null } },
        { NOT: { workEmailPassword: '' } },
      ],
    },
    select: { id: true, code: true, name: true, workEmail: true, userId: true },
    orderBy: [{ name: 'asc' }],
  });

  const counts = {
    created: 0,
    updated: 0,
    linked: 0,
    deactivated: 0,
    skipped: 0,
  };
  const skipReasons: Record<string, number> = {};
  const samples: string[] = [];

  for (const emp of employees) {
    if (!APPLY) {
      if (samples.length < 10) {
        samples.push(
          `${emp.code ?? '—'} | ${emp.name} | ${emp.workEmail} | userId=${emp.userId ?? 'none'}`,
        );
      }
      continue;
    }

    const result = await syncEmployeeLoginFromWorkEmail(emp.id);
    counts[result.action] += 1;
    if (result.action === 'skipped' && result.reason) {
      skipReasons[result.reason] = (skipReasons[result.reason] ?? 0) + 1;
    }
    if (samples.length < 10) {
      samples.push(
        `${emp.code ?? '—'} | ${emp.name} | ${result.action}${result.reason ? ` (${result.reason})` : ''}`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'apply' : 'dry-run',
        candidates: employees.length,
        ...(APPLY ? { counts, skipReasons } : {}),
        samples,
      },
      null,
      2,
    ),
  );
  if (!APPLY) {
    console.log('\nRe-run with --apply to create/update User logins.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
