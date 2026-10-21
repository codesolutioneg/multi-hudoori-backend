import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';

type Tx = Prisma.TransactionClient;

export type PullExclusionInput = {
  biotimeEmpId?: number | null;
  empCode?: string | null;
  employeeName?: string | null;
  deletedEmployeeId: string;
};

function normalizeCode(code?: string | null): string | null {
  const trimmed = String(code ?? '').trim();
  return trimmed || null;
}

/** Remember a hard-deleted employee so BioTime pull will not recreate them. */
export async function recordBioTimePullExclusion(
  tx: Tx | typeof prisma,
  input: PullExclusionInput,
): Promise<void> {
  const biotimeEmpId =
    input.biotimeEmpId != null && Number.isFinite(Number(input.biotimeEmpId))
      ? Number(input.biotimeEmpId)
      : null;
  const empCode = normalizeCode(input.empCode);
  if (biotimeEmpId == null && !empCode) return;

  const or: Prisma.BioTimePullExclusionWhereInput[] = [];
  if (biotimeEmpId != null) or.push({ biotimeEmpId });
  if (empCode) or.push({ empCode });

  const existing = await tx.bioTimePullExclusion.findFirst({
    where: { OR: or },
    select: { id: true, biotimeEmpId: true, empCode: true },
  });

  const data = {
    biotimeEmpId: biotimeEmpId ?? existing?.biotimeEmpId ?? null,
    empCode: empCode ?? existing?.empCode ?? null,
    employeeName: input.employeeName?.trim() || null,
    deletedEmployeeId: input.deletedEmployeeId,
  };

  if (existing) {
    await tx.bioTimePullExclusion.update({ where: { id: existing.id }, data });
    return;
  }

  await tx.bioTimePullExclusion.create({ data });
}

/** True when pull must skip creating this BioTime employee. */
export async function isBioTimePullExcluded(
  biotimeEmpId: number | undefined,
  empCode: string,
): Promise<boolean> {
  const code = normalizeCode(empCode);
  const or: Prisma.BioTimePullExclusionWhereInput[] = [];
  if (biotimeEmpId != null && Number.isFinite(biotimeEmpId)) {
    or.push({ biotimeEmpId });
  }
  if (code) or.push({ empCode: code });
  if (!or.length) return false;

  const hit = await prisma.bioTimePullExclusion.findFirst({
    where: { OR: or },
    select: { id: true },
  });
  return Boolean(hit);
}
