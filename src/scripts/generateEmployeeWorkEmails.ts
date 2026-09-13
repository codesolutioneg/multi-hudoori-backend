/**
 * Backfill empty employee work emails as name@vicanza.com + first-time password.
 *
 * Dry-run (default):
 *   DOTENV_CONFIG_PATH=.env.dev npx ts-node -r dotenv/config --transpile-only \
 *     src/scripts/generateEmployeeWorkEmails.ts
 *
 * Apply:
 *   ... generateEmployeeWorkEmails.ts --apply
 *
 * Also fills missing passwords for employees who already have a workEmail.
 */
import { prisma } from '../prisma/client';
import {
  buildEmailLocalPart,
  generateWorkEmailPassword,
  isBlankEmail,
  toVicanzaEmail,
} from '../services/employeeWorkEmail.service';
import { syncEmployeeLoginFromWorkEmail } from '../services/employeeLogin.service';

const APPLY = process.argv.includes('--apply');

async function existingEmailSet(): Promise<Set<string>> {
  const rows = await prisma.employeeProfile.findMany({
    where: { workEmail: { not: null } },
    select: { workEmail: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    const e = r.workEmail?.trim().toLowerCase();
    if (e) set.add(e);
  }
  return set;
}

function uniqueEmail(
  baseLocal: string,
  taken: Set<string>,
  code: string | null | undefined,
): string {
  let local = baseLocal;
  let candidate = toVicanzaEmail(local).toLowerCase();
  if (!taken.has(candidate)) return toVicanzaEmail(local);

  const codeSuffix = String(code ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (codeSuffix) {
    local = `${baseLocal}.${codeSuffix}`.slice(0, 48);
    candidate = toVicanzaEmail(local).toLowerCase();
    if (!taken.has(candidate)) return toVicanzaEmail(local);
  }

  for (let n = 2; n < 5000; n++) {
    local = `${baseLocal}${n}`.slice(0, 48);
    candidate = toVicanzaEmail(local).toLowerCase();
    if (!taken.has(candidate)) return toVicanzaEmail(local);
  }
  throw new Error(`Could not allocate unique email for ${baseLocal}`);
}

async function main() {
  const taken = await existingEmailSet();

  const employees = await prisma.employeeProfile.findMany({
    where: {
      OR: [
        { workEmail: null },
        { workEmail: '' },
        { workEmailPassword: null },
        { workEmailPassword: '' },
      ],
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      code: true,
      workEmail: true,
      workEmailPassword: true,
      active: true,
    },
    orderBy: [{ name: 'asc' }],
  });

  let emailFilled = 0;
  let passwordFilled = 0;
  let loginSynced = 0;
  const samples: string[] = [];

  for (const emp of employees) {
    const name = emp.displayName?.trim() || emp.name.trim();
    const data: { workEmail?: string; workEmailPassword?: string } = {};

    if (isBlankEmail(emp.workEmail)) {
      const local = buildEmailLocalPart({ name, code: emp.code });
      const email = uniqueEmail(local, taken, emp.code);
      data.workEmail = email;
      taken.add(email.toLowerCase());
      emailFilled += 1;
    }

    if (isBlankEmail(emp.workEmailPassword)) {
      // Only assign a password when there will be (or already is) an email.
      const willHaveEmail = !isBlankEmail(data.workEmail ?? emp.workEmail);
      if (willHaveEmail) {
        data.workEmailPassword = generateWorkEmailPassword();
        passwordFilled += 1;
      }
    }

    if (!Object.keys(data).length) continue;

    const line = `${emp.code ?? '—'} | ${name} | ${data.workEmail ?? emp.workEmail ?? ''} | ${
      data.workEmailPassword ? '(new password)' : '(keep password)'
    }`;
    if (samples.length < 15) samples.push(line);

    if (APPLY) {
      await prisma.employeeProfile.update({ where: { id: emp.id }, data });
      const loginResult = await syncEmployeeLoginFromWorkEmail(emp.id);
      if (loginResult.action === 'created' || loginResult.action === 'updated' || loginResult.action === 'linked') {
        loginSynced += 1;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'apply' : 'dry-run',
        candidates: employees.length,
        emailFilled,
        passwordFilled,
        loginSynced: APPLY ? loginSynced : undefined,
        samples,
      },
      null,
      2,
    ),
  );
  if (!APPLY) {
    console.log('\nRe-run with --apply to write changes.');
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
