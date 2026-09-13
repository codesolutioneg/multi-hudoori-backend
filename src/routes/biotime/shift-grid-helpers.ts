import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma/client';
import { parsePagination } from '../../utils/pagination';
import { shiftGridJson } from '../../services/serialize.service';
import {
  countGridSummary,
  getLatestSyncStatus,
  getShiftGridData,
  getShiftGridDataPaged,
  getShiftGridMeta,
} from '../../services/shiftGridData.service';
import { assertGridLocationAccess, getHrLocationScope } from '../../services/userLocationScope.service';
import { DEFAULT_GRID_GROUPING, type GridGrouping } from '../../services/shiftGridGrouping.service';

export type ShiftGridPayloadOptions = {
  includeData?: boolean;
  employeeLimit?: number;
  employeeOffset?: number;
  metaOnly?: boolean;
  grouping?: GridGrouping;
  req?: Request;
};

export async function enforceShiftGridAccess(req: Request, gridLocationId: string | null | undefined): Promise<void> {
  const scope = await getHrLocationScope(req.user!.id, req.user!.role);
  assertGridLocationAccess(scope, gridLocationId);
}

export async function loadShiftGridForAccess(req: Request, gridId: string) {
  const grid = await prisma.shiftGrid.findUnique({ where: { id: gridId } });
  if (!grid) return null;
  await enforceShiftGridAccess(req, grid.locationId);
  return grid;
}

export async function shiftGridPayload(gridId: string, options: ShiftGridPayloadOptions = {}) {
  const includeData = options.includeData !== false;
  const grid = await prisma.shiftGrid.findUnique({
    where: { id: gridId },
    include: { device: true, location: true },
  });
  if (!grid) return null;
  if (options.req?.user) {
    await enforceShiftGridAccess(options.req, grid.locationId);
  }
  const grouping = options.grouping ?? DEFAULT_GRID_GROUPING;
  const summary = await countGridSummary(gridId);
  const sync = await getLatestSyncStatus(gridId);
  const payload: Record<string, unknown> = {
    grid: shiftGridJson(grid, summary, sync),
  };
  if (!includeData) return payload;

  if (grid.state === 'setup') {
    const shifts = await prisma.shift.findMany({
      where: { active: true },
      orderBy: [{ code: 'asc' }, { name: 'asc' }],
    });
    payload.data = {
      dates: [],
      shifts: shifts.map((s) => ({ id: s.id, name: s.name, code: s.code ?? '' })),
      grouping,
      job_groups: {},
    };
    return payload;
  }

  if (options.metaOnly) {
    payload.data = await getShiftGridMeta(gridId, grouping);
    return payload;
  }

  const usePaging = options.employeeLimit != null || options.employeeOffset != null;

  if (usePaging) {
    const { limit, offset } = parsePagination(
      { limit: options.employeeLimit, offset: options.employeeOffset },
      { limit: 25, maxLimit: 100 },
    );
    payload.data = await getShiftGridDataPaged(gridId, limit, offset, grouping);
  } else {
    payload.data = await getShiftGridData(gridId, grouping);
  }
  return payload;
}

