/**
 * Manual overtime eligibility lines on a shift grid:
 * «إضافي يدوي (موظف + يوم)» — only listed pairs get OT on punch report.
 */
import { prisma } from '../prisma/client';
import { AppError, NotFoundError } from '../utils/errors';

type ManualOtSyncResult = {
  gridId: string;
  sourceGridCount: number;
  sourceLineCount: number;
  existingCount: number;
  addedCount: number;
};

function parseDay(raw: string | Date): Date {
  if (raw instanceof Date) {
    return new Date(`${raw.toISOString().slice(0, 10)}T00:00:00.000Z`);
  }
  const s = String(raw).trim().slice(0, 10);
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new AppError('تاريخ غير صالح', 400, 'VALIDATION');
  }
  return d;
}

/**
 * Copy missing manual-OT employee+day rows from weekly source grids into a
 * merged grid. This is additive only: deleting from a week never deletes from
 * the merged grid, and rows entered directly on the merged grid are preserved.
 */
export async function syncMergedManualOtLines(
  gridId: string,
  options: { apply?: boolean } = {},
): Promise<ManualOtSyncResult> {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    select: { id: true, dateFrom: true, dateTo: true, mergedFromGridIds: true },
  });
  if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');

  const sourceGridIds = [...new Set(grid.mergedFromGridIds.filter(Boolean))];
  if (sourceGridIds.length === 0) {
    return {
      gridId,
      sourceGridCount: 0,
      sourceLineCount: 0,
      existingCount: 0,
      addedCount: 0,
    };
  }

  const [sourceRows, existingRows] = await Promise.all([
    prisma.shiftGridManualOtLine.findMany({
      where: {
        gridId: { in: sourceGridIds },
        date: { gte: grid.dateFrom, lte: grid.dateTo },
      },
      select: { employeeId: true, date: true, note: true },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    }),
    prisma.shiftGridManualOtLine.findMany({
      where: { gridId },
      select: { employeeId: true, date: true },
    }),
  ]);

  const key = (employeeId: string, date: Date) =>
    `${employeeId}:${date.toISOString().slice(0, 10)}`;
  const existingKeys = new Set(existingRows.map((row) => key(row.employeeId, row.date)));
  const missingByKey = new Map<string, (typeof sourceRows)[number]>();
  for (const row of sourceRows) {
    const rowKey = key(row.employeeId, row.date);
    if (!existingKeys.has(rowKey)) missingByKey.set(rowKey, row);
  }
  const missing = [...missingByKey.values()];

  if (options.apply !== false && missing.length > 0) {
    await prisma.shiftGridManualOtLine.createMany({
      data: missing.map((row) => ({
        gridId,
        employeeId: row.employeeId,
        date: row.date,
        note: row.note,
      })),
      skipDuplicates: true,
    });
  }

  return {
    gridId,
    sourceGridCount: sourceGridIds.length,
    sourceLineCount: sourceRows.length,
    existingCount: existingRows.length,
    addedCount: missing.length,
  };
}

/** Backfill every merged grid; dry-run unless apply=true. */
export async function syncAllMergedManualOtLines(options: { apply?: boolean } = {}) {
  const grids = await prisma.shiftGrid.findMany({
    where: { mergedFromGridIds: { isEmpty: false } },
    select: { id: true, name: true },
    orderBy: [{ dateFrom: 'asc' }, { name: 'asc' }],
  });
  const results = [];
  for (const grid of grids) {
    results.push({
      name: grid.name,
      ...(await syncMergedManualOtLines(grid.id, options)),
    });
  }
  return {
    apply: options.apply === true,
    gridCount: grids.length,
    addedCount: results.reduce((sum, row) => sum + row.addedCount, 0),
    results,
  };
}

export function manualOtLineJson(row: {
  id: string;
  gridId: string;
  employeeId: string;
  date: Date;
  note: string | null;
  createdAt: Date;
  employee?: { id: string; name: string; code: string | null; jobTitle: string | null } | null;
}) {
  return {
    id: row.id,
    gridId: row.gridId,
    employeeId: row.employeeId,
    date: row.date.toISOString().slice(0, 10),
    note: row.note ?? '',
    createdAt: row.createdAt.toISOString(),
    employeeName: row.employee?.name ?? '',
    employeeCode: row.employee?.code ?? '',
    jobTitle: row.employee?.jobTitle ?? '',
  };
}

export async function listManualOtLines(gridId: string) {
  await syncMergedManualOtLines(gridId, { apply: true });

  const rows = await prisma.shiftGridManualOtLine.findMany({
    where: { gridId },
    include: {
      employee: { select: { id: true, name: true, code: true, jobTitle: true } },
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  return {
    lines: rows.map(manualOtLineJson),
    count: rows.length,
  };
}

/** Set of `${employeeId}:${YYYY-MM-DD}` eligible for manual OT on this grid. */
export async function loadManualOtKeySet(gridId: string): Promise<Set<string>> {
  await syncMergedManualOtLines(gridId, { apply: true });
  const rows = await prisma.shiftGridManualOtLine.findMany({
    where: { gridId },
    select: { employeeId: true, date: true },
  });
  return new Set(
    rows.map((r) => `${r.employeeId}:${r.date.toISOString().slice(0, 10)}`),
  );
}

export async function addManualOtLine(params: {
  gridId: string;
  employeeId: string;
  date: string;
  note?: string | null;
}) {
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: params.gridId },
    select: { id: true, dateFrom: true, dateTo: true, state: true },
  });
  if (!grid) throw new NotFoundError('جدول الشيفتات غير موجود');

  const day = parseDay(params.date);
  const from = grid.dateFrom.toISOString().slice(0, 10);
  const to = grid.dateTo.toISOString().slice(0, 10);
  const key = day.toISOString().slice(0, 10);
  if (key < from || key > to) {
    throw new AppError(`التاريخ لازم يكون بين ${from} و ${to}`, 400, 'VALIDATION');
  }

  const onGrid = await prisma.shiftGridLine.findFirst({
    where: { gridId: params.gridId, employeeId: params.employeeId },
    select: { id: true },
  });
  if (!onGrid) {
    throw new AppError('الموظف غير موجود في جدول الشيفتات هذا', 400, 'VALIDATION');
  }

  try {
    const row = await prisma.shiftGridManualOtLine.create({
      data: {
        gridId: params.gridId,
        employeeId: params.employeeId,
        date: day,
        note: params.note?.trim() || null,
      },
      include: {
        employee: { select: { id: true, name: true, code: true, jobTitle: true } },
      },
    });

    // If this is a weekly source already used by merged grids, make the new
    // eligibility available there immediately. This never propagates deletes.
    const targets = await prisma.shiftGrid.findMany({
      where: {
        mergedFromGridIds: { has: params.gridId },
        dateFrom: { lte: day },
        dateTo: { gte: day },
      },
      select: { id: true },
    });
    if (targets.length > 0) {
      await prisma.shiftGridManualOtLine.createMany({
        data: targets.map((target) => ({
          gridId: target.id,
          employeeId: params.employeeId,
          date: day,
          note: params.note?.trim() || null,
        })),
        skipDuplicates: true,
      });
    }

    return manualOtLineJson(row);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('Unique constraint') || msg.includes('unique')) {
      throw new AppError('السطر موجود من قبل للموظف والتاريخ نفسهما', 400, 'DUPLICATE');
    }
    throw e;
  }
}

export async function updateManualOtLine(params: {
  id: string;
  gridId: string;
  date?: string;
  note?: string | null;
}) {
  const existing = await prisma.shiftGridManualOtLine.findFirst({
    where: { id: params.id, gridId: params.gridId },
  });
  if (!existing) throw new NotFoundError('السطر غير موجود');

  const data: { date?: Date; note?: string | null } = {};
  if (params.date != null) data.date = parseDay(params.date);
  if (params.note !== undefined) data.note = params.note?.trim() || null;

  try {
    const row = await prisma.shiftGridManualOtLine.update({
      where: { id: params.id },
      data,
      include: {
        employee: { select: { id: true, name: true, code: true, jobTitle: true } },
      },
    });
    return manualOtLineJson(row);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('Unique constraint') || msg.includes('unique')) {
      throw new AppError('السطر موجود من قبل للموظف والتاريخ نفسهما', 400, 'DUPLICATE');
    }
    throw e;
  }
}

export async function deleteManualOtLine(params: { id: string; gridId: string }) {
  const existing = await prisma.shiftGridManualOtLine.findFirst({
    where: { id: params.id, gridId: params.gridId },
  });
  if (!existing) throw new NotFoundError('السطر غير موجود');
  await prisma.shiftGridManualOtLine.delete({ where: { id: params.id } });
  return { ok: true, id: params.id };
}
