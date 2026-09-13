/**
 * «تدرج الوظائف» — the configurable seniority ladder behind the org chart.
 * A level groups several job titles that sit at the same depth; `rank` orders the
 * ladder with 1 at the top. Titles left off the ladder fall back to the built-in
 * heuristic in orgChart.service, so a partial ladder is always safe.
 */
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';

const ValidationError = class extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION');
  }
};

export type JobLevelDto = {
  id: string;
  name: string;
  nameEn: string;
  code: string;
  rank: number;
  titles: { id: string; name: string; active: boolean; employeeCount: number }[];
};

export type JobLadder = {
  levels: JobLevelDto[];
  /** Titles an admin has not placed on any level yet. */
  unassigned: { id: string; name: string; active: boolean; employeeCount: number }[];
};

/** Live headcount per job title — job titles are free text on the employee. */
async function employeeCountsByTitle(): Promise<Map<string, number>> {
  const rows = await prisma.employeeProfile.groupBy({
    by: ['jobTitle'],
    where: { active: true },
    _count: { _all: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = String(r.jobTitle ?? '').trim().toLowerCase();
    if (!key) continue;
    out.set(key, (out.get(key) ?? 0) + r._count._all);
  }
  return out;
}

export async function getJobLadder(): Promise<JobLadder> {
  const [levels, titles, counts] = await Promise.all([
    prisma.jobLevel.findMany({ orderBy: { rank: 'asc' } }),
    prisma.jobTitle.findMany({ orderBy: [{ sequence: 'asc' }, { name: 'asc' }] }),
    employeeCountsByTitle(),
  ]);

  const decorate = (t: (typeof titles)[number]) => ({
    id: t.id,
    name: t.name,
    active: t.active,
    employeeCount: counts.get(t.name.trim().toLowerCase()) ?? 0,
  });

  return {
    levels: levels.map((l) => ({
      id: l.id,
      name: l.name,
      nameEn: l.nameEn ?? '',
      code: l.code ?? '',
      rank: l.rank,
      titles: titles.filter((t) => t.levelId === l.id).map(decorate),
    })),
    unassigned: titles.filter((t) => !t.levelId).map(decorate),
  };
}

/** Appends a level at the bottom of the ladder. */
export async function createJobLevel(input: {
  name: string;
  nameEn?: string | null;
  code?: string | null;
}): Promise<JobLevelDto> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('اسم المستوى مطلوب');

  const clash = await prisma.jobLevel.findFirst({ where: { name } });
  if (clash) throw new ValidationError('يوجد مستوى بنفس الاسم');

  const last = await prisma.jobLevel.findFirst({ orderBy: { rank: 'desc' } });
  const level = await prisma.jobLevel.create({
    data: {
      name,
      nameEn: input.nameEn ? String(input.nameEn).trim() : null,
      code: input.code ? String(input.code).trim() : null,
      rank: (last?.rank ?? 0) + 1,
    },
  });
  return { id: level.id, name: level.name, nameEn: level.nameEn ?? '', code: level.code ?? '', rank: level.rank, titles: [] };
}

export async function updateJobLevel(input: {
  id: string;
  name?: string;
  nameEn?: string | null;
  code?: string | null;
}): Promise<void> {
  const id = String(input.id ?? '');
  const level = await prisma.jobLevel.findUnique({ where: { id } });
  if (!level) throw new NotFoundError('المستوى غير موجود');

  const data: { name?: string; nameEn?: string | null; code?: string | null } = {};
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new ValidationError('اسم المستوى مطلوب');
    const clash = await prisma.jobLevel.findFirst({ where: { name, id: { not: id } } });
    if (clash) throw new ValidationError('يوجد مستوى بنفس الاسم');
    data.name = name;
  }
  if (input.nameEn !== undefined) data.nameEn = input.nameEn ? String(input.nameEn).trim() : null;
  if (input.code !== undefined) data.code = input.code ? String(input.code).trim() : null;

  if (Object.keys(data).length) await prisma.jobLevel.update({ where: { id }, data });
}

/** Titles on a deleted level fall back to the built-in heuristic (FK is SET NULL). */
export async function deleteJobLevel(id: string): Promise<void> {
  const level = await prisma.jobLevel.findUnique({ where: { id } });
  if (!level) throw new NotFoundError('المستوى غير موجود');
  await prisma.jobLevel.delete({ where: { id } });
  await renumberLadder();
}

/** Reorders the whole ladder from a list of ids, top first. */
export async function reorderJobLevels(orderedIds: string[]): Promise<void> {
  const ids = orderedIds.map((x) => String(x)).filter(Boolean);
  if (!ids.length) throw new ValidationError('ترتيب المستويات مطلوب');

  const existing = await prisma.jobLevel.findMany({ select: { id: true } });
  const known = new Set(existing.map((l) => l.id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    throw new ValidationError('قائمة الترتيب لا تطابق المستويات الموجودة');
  }

  // `rank` is unique, so park everything out of range before writing final values.
  await prisma.$transaction([
    ...ids.map((id, i) =>
      prisma.jobLevel.update({ where: { id }, data: { rank: -(i + 1) } }),
    ),
    ...ids.map((id, i) =>
      prisma.jobLevel.update({ where: { id }, data: { rank: i + 1 } }),
    ),
  ]);
}

/** Moves a title onto a level, or off the ladder entirely when levelId is null. */
export async function assignTitleToLevel(
  jobTitleId: string,
  levelId: string | null,
): Promise<void> {
  const title = await prisma.jobTitle.findUnique({ where: { id: jobTitleId } });
  if (!title) throw new NotFoundError('المسمى الوظيفي غير موجود');

  if (levelId) {
    const level = await prisma.jobLevel.findUnique({ where: { id: levelId } });
    if (!level) throw new NotFoundError('المستوى غير موجود');
  }
  await prisma.jobTitle.update({ where: { id: jobTitleId }, data: { levelId } });
}

/** Keeps ranks as 1..n with no gaps after a delete. */
async function renumberLadder(): Promise<void> {
  const levels = await prisma.jobLevel.findMany({ orderBy: { rank: 'asc' }, select: { id: true, rank: true } });
  const updates = levels
    .map((l, i) => ({ id: l.id, rank: i + 1, current: l.rank }))
    .filter((l) => l.rank !== l.current);
  if (!updates.length) return;
  await prisma.$transaction([
    ...updates.map((u) => prisma.jobLevel.update({ where: { id: u.id }, data: { rank: -(u.rank) } })),
    ...updates.map((u) => prisma.jobLevel.update({ where: { id: u.id }, data: { rank: u.rank } })),
  ]);
}
