import { prisma } from '../prisma/client';
import type { JobTitle } from '@prisma/client';

export function jobTitleJson(row: JobTitle) {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? '',
    active: row.active,
    sequence: row.sequence,
  };
}

/** Upsert any job titles currently used on employees into the catalog. */
export async function syncJobTitlesFromEmployees(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT MIN(TRIM(job_title)) AS name
    FROM employee_profiles
    WHERE job_title IS NOT NULL AND TRIM(job_title) <> ''
    GROUP BY LOWER(TRIM(job_title))
  `;
  let created = 0;
  for (const row of rows) {
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    const existing = await prisma.jobTitle.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) continue;
    await prisma.jobTitle.create({
      data: { name, active: true, sequence: 10 },
    });
    created++;
  }
  return created;
}

export async function listActiveJobTitleNames(): Promise<string[]> {
  const rows = await prisma.jobTitle.findMany({
    where: { active: true },
    orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
    select: { name: true },
  });
  return rows.map((r) => r.name);
}
