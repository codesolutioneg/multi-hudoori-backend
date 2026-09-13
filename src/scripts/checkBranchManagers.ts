/**
 * Who would sign off advance requests at every branch today.
 *
 * Run before rolling the feature out: any branch listed without an approver has
 * employees who cannot raise a request until HR names someone in settings.
 */
import { prisma } from '../prisma/client';
import { resolveBranchManager } from '../services/branchManager.service';

async function main() {
  const locations = await prisma.location.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, _count: { select: { employees: true } } },
  });

  const gaps: string[] = [];
  for (const loc of locations) {
    const m = await resolveBranchManager(loc.id);
    const status = !m
      ? 'NO MANAGER'
      : !m.userId
        ? `${m.employeeName} (${m.source}) — NO LOGIN`
        : `${m.employeeName} (${m.source})`;
    if (!m?.userId) gaps.push(loc.name);
    console.log(`${loc.name.padEnd(12)} ${String(loc._count.employees).padStart(4)} emp  ${status}`);
  }

  console.log(
    gaps.length
      ? `\n${gaps.length} branch(es) cannot raise advance requests: ${gaps.join(', ')}`
      : '\nEvery branch has an approver.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
