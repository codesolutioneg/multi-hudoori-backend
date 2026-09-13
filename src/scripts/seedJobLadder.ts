/**
 * Place every existing job title on the ladder using the heuristic the org chart
 * used before «تدرج الوظائف» existed, so turning the feature on changes nothing
 * until an admin actually drags something.
 *
 *   set -a && source .env.dev && set +a && npx ts-node --transpile-only \
 *     src/scripts/seedJobLadder.ts [--apply]
 */
import { prisma } from '../prisma/client';
import { jobTitleRank } from '../services/orgChart.service';
import { syncJobTitlesFromEmployees } from '../services/jobTitle.service';

const APPLY = process.argv.includes('--apply');

async function main() {
  if (APPLY) {
    const created = await syncJobTitlesFromEmployees();
    if (created) console.log(`  pulled ${created} new title(s) out of the employee data`);
  }

  const levels = await prisma.jobLevel.findMany({ orderBy: { rank: 'asc' } });
  if (!levels.length) {
    console.error('No job levels found — run the 20260908120000_job_levels migration first.');
    process.exit(1);
  }
  const byRank = new Map(levels.map((l) => [l.rank, l]));

  const titles = await prisma.jobTitle.findMany({ orderBy: { name: 'asc' } });
  const plan: { id: string; name: string; levelName: string; changed: boolean }[] = [];

  for (const t of titles) {
    const rank = jobTitleRank(t.name);
    const level = byRank.get(rank) ?? byRank.get(Math.max(...byRank.keys()))!;
    plan.push({
      id: t.id,
      name: t.name,
      levelName: level.name,
      changed: t.levelId !== level.id,
    });
    if (APPLY && t.levelId !== level.id) {
      await prisma.jobTitle.update({ where: { id: t.id }, data: { levelId: level.id } });
    }
  }

  const byLevel = new Map<string, string[]>();
  for (const p of plan) byLevel.set(p.levelName, [...(byLevel.get(p.levelName) ?? []), p.name]);
  for (const l of levels) {
    const names = byLevel.get(l.name) ?? [];
    console.log(`\n  ${l.rank}. ${l.name} — ${names.length} title(s)`);
    for (const n of names) console.log(`       ${n}`);
  }

  const changed = plan.filter((p) => p.changed).length;
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${changed} of ${plan.length} title(s) placed.`);
  if (!APPLY) console.log('Re-run with --apply to write.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
