/**
 * Backfill: archive active employees who have انهاء/استقاله/انقطاع on any shift grid.
 *
 *   DOTENV_CONFIG_PATH=.env.prod npx ts-node -r dotenv/config --transpile-only \
 *     src/scripts/archiveEmployeesFromShiftGridDepartures.ts --apply
 */
import { prisma } from '../prisma/client';
import { archiveEmployee } from '../services/employeeArchive.service';

const APPLY = process.argv.includes('--apply');

async function main() {
  const lines = await prisma.shiftGridLine.findMany({
    where: {
      OR: [{ isFinished: true }, { isResignation: true }, { isWorkAbsence: true }],
    },
    select: {
      employeeId: true,
      date: true,
      isFinished: true,
      isResignation: true,
      isWorkAbsence: true,
      employee: { select: { id: true, code: true, name: true, active: true } },
    },
    orderBy: [{ date: 'desc' }],
  });

  const byEmp = new Map<
    string,
    { id: string; code: string | null; name: string; kind: string; date: Date }
  >();
  for (const l of lines) {
    const e = l.employee;
    if (!e || !e.active) continue;
    if (byEmp.has(e.id)) continue;
    const kind = l.isFinished
      ? 'انهاء'
      : l.isResignation
        ? 'استقاله'
        : 'انقطاع عن العمل';
    byEmp.set(e.id, {
      id: e.id,
      code: e.code,
      name: e.name,
      kind,
      date: l.date,
    });
  }

  const targets = [...byEmp.values()].sort((a, b) =>
    String(a.code ?? '').localeCompare(String(b.code ?? ''), undefined, { numeric: true }),
  );

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? 'APPLY' : 'DRY_RUN',
        database: process.env.DATABASE_URL?.replace(/:\/\/[^@]+@/, '://***@') ?? null,
        toArchive: targets.length,
        employees: targets.map((t) => ({
          code: t.code,
          name: t.name,
          kind: t.kind,
          lastDate: t.date.toISOString().slice(0, 10),
        })),
      },
      null,
      2,
    ),
  );

  if (!APPLY) {
    console.log('Dry-run only. Re-run with --apply to archive.');
    return;
  }

  const results: Array<Record<string, unknown>> = [];
  for (const t of targets) {
    try {
      await archiveEmployee(
        t.id,
        `أوتوماتيك من جدول الشيفت: ${t.kind} (سكربت backfill)`,
        'backfill-script',
      );
      results.push({ code: t.code, name: t.name, kind: t.kind, ok: true });
    } catch (err) {
      results.push({
        code: t.code,
        name: t.name,
        kind: t.kind,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stillActive = await prisma.employeeProfile.count({
    where: { id: { in: targets.map((t) => t.id) }, active: true },
  });

  console.log(
    JSON.stringify(
      {
        archived: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        stillActiveAmongTargets: stillActive,
        results,
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
