import type { EmployeeProfile, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import {
  getHrLocationScope,
  hasUnrestrictedLocationAccess,
  isLocationScopedHrRole,
} from './userLocationScope.service';

export type OrgChartScope = 'company' | 'location' | 'mine';

export type OrgChartNode = {
  id: string;
  name: string;
  jobTitle: string;
  photoUrl: string;
  locationId: string | null;
  locationName: string;
  managerId: string | null;
  isSelf?: boolean;
  children: OrgChartNode[];
};

type EmpRow = EmployeeProfile & {
  workLocation?: { name: string } | null;
};

export type OrgChartResult = {
  roots: OrgChartNode[];
  employeeCount: number;
  scope: OrgChartScope;
  locationId: string | null;
  focusEmployeeId: string | null;
  canChooseScope: boolean;
  viewLabel: string;
};

function toNode(
  emp: EmpRow,
  children: OrgChartNode[] = [],
  focusEmployeeId?: string | null,
): OrgChartNode {
  return {
    id: emp.id,
    name: (emp.displayName || emp.name || '').trim() || emp.name,
    jobTitle: (emp.jobTitle ?? '').trim(),
    photoUrl: (emp.personalPhotoDocUrl ?? '').trim(),
    locationId: emp.locationId ?? null,
    locationName: emp.workLocation?.name ?? emp.location ?? '',
    managerId: emp.managerId ?? null,
    isSelf: focusEmployeeId != null && emp.id === focusEmployeeId,
    children,
  };
}

/** Strip tatweel and unify alef/ya/ta-marbuta so «مدير الفرع» matches «مدير الفرع». */
function normalizeTitle(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u0652]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Seniority ladder used when a line has no manually picked manager. Lower = more senior. */
const RANK_AREA_HEAD = 1;
const RANK_SITE_HEAD = 2;
const RANK_DEPT_HEAD = 3;
const RANK_SUPERVISOR = 4;
const RANK_STAFF = 5;

const AREA_HEAD_TITLES = new Set(['مدير منطقه']);
const SITE_HEAD_TITLES = new Set(['مدير الفرع', 'مدير المصنع']);
const SUPERVISOR_TITLES = new Set([
  'شيفت ليدر',
  'سوبر فايزر',
  'امين مخزن',
  'شيف عمومي خباز',
  'مساعد مدير خباز',
  'مساعد شيف كاترينج',
]);

export function jobTitleRank(rawTitle: string | null | undefined): number {
  const title = normalizeTitle(rawTitle);
  if (!title) return RANK_STAFF;
  if (AREA_HEAD_TITLES.has(title)) return RANK_AREA_HEAD;
  if (SITE_HEAD_TITLES.has(title)) return RANK_SITE_HEAD;
  if (SUPERVISOR_TITLES.has(title)) return RANK_SUPERVISOR;
  // Any remaining «مدير …» (مدير المخزن، مدير الحسابات، مدير مطبخ…) leads its own
  // department — this is what covers sites that have no «مدير الفرع» at all.
  if (title === 'مساعد مدير' || title.startsWith('مدير ')) return RANK_DEPT_HEAD;
  return RANK_STAFF;
}

/** Resolves a job title to its seniority rank. Lower = more senior. */
export type RankResolver = (title: string | null | undefined) => number;

/**
 * Rank resolver backed by the «تدرج الوظائف» settings. Titles that an admin has not
 * placed on a tier keep using the built-in heuristic, so the chart never regresses
 * to a flat list just because the ladder is incomplete.
 */
export async function loadRankResolver(): Promise<RankResolver> {
  const titles = await prisma.jobTitle.findMany({
    where: { levelId: { not: null } },
    select: { name: true, level: { select: { rank: true } } },
  });
  if (!titles.length) return jobTitleRank;

  const configured = new Map<string, number>();
  for (const t of titles) {
    const key = normalizeTitle(t.name);
    if (key && t.level) configured.set(key, t.level.rank);
  }
  return (raw) => configured.get(normalizeTitle(raw)) ?? jobTitleRank(raw);
}

/** The only fields derivation reads, so callers can select just these. */
export type ParentInput = {
  id: string;
  code?: string | null;
  jobTitle: string | null;
  locationId: string | null;
  departmentId: string | null;
  managerId: string | null;
};

/**
 * Effective parent per employee: the manually assigned manager when present,
 * otherwise the most senior colleague above them at the same site (preferring the
 * same department). Derivation means a newly added employee joins the chart as
 * soon as they have a site and a job title, with nothing to backfill.
 */
export function computeEffectiveParents<T extends ParentInput>(
  employees: T[],
  rankOf: RankResolver = jobTitleRank,
): Map<string, string | null> {
  const present = new Set(employees.map((e) => e.id));
  const parents = new Map<string, string | null>();

  // Pass 1 — manual placements, before anything is derived. HR put these people
  // where they are on purpose, so they are the fixed points the rest bends around.
  const manual = new Set<string>();
  for (const emp of employees) {
    if (emp.managerId && present.has(emp.managerId) && emp.managerId !== emp.id) {
      parents.set(emp.id, emp.managerId);
      manual.add(emp.id);
    }
  }

  /** Does walking up from `startId` reach `targetId`? Used to keep derivation
   *  from picking a senior who already sits below the person being placed. */
  const reaches = (startId: string, targetId: string): boolean => {
    let cursor: string | null = startId;
    let guard = 0;
    while (cursor && guard++ < 100) {
      if (cursor === targetId) return true;
      cursor = parents.get(cursor) ?? null;
    }
    return false;
  };

  const bySite = new Map<string, T[]>();
  for (const emp of employees) {
    const key = emp.locationId ?? '';
    const list = bySite.get(key) ?? [];
    list.push(emp);
    bySite.set(key, list);
  }

  // Pass 2 — derive a line for everyone else.
  for (const [siteKey, roster] of bySite) {
    // Employees without a site have no derivable line; they stay roots.
    const derivable = siteKey !== '';
    const ranked = roster
      .map((emp) => ({ emp, rank: rankOf(emp.jobTitle) }))
      .sort((a, b) => a.rank - b.rank);

    for (const { emp, rank } of ranked) {
      if (manual.has(emp.id)) continue;
      if (!derivable) {
        parents.set(emp.id, null);
        continue;
      }

      const seniors = ranked.filter(
        (c) =>
          c.rank < rank &&
          c.emp.id !== emp.id &&
          // Skip anyone already reporting into this employee — choosing them would
          // close a loop and cost someone their manual placement.
          !reaches(c.emp.id, emp.id),
      );
      if (!seniors.length) {
        parents.set(emp.id, null);
        continue;
      }
      // Prefer a senior from the same department at any level (so kitchen staff land
      // under the kitchen head instead of piling onto one shift leader), and only
      // fall back to the nearest rank across the whole site.
      const sameDept = emp.departmentId
        ? seniors.filter((c) => c.emp.departmentId === emp.departmentId)
        : [];
      const scope = sameDept.length ? sameDept : seniors;
      const closestRank = Math.max(...scope.map((c) => c.rank));
      const pool = scope.filter((c) => c.rank === closestRank);
      // Stable pick so the chart doesn't reshuffle between requests.
      const chosen = pool
        .slice()
        .sort((a, b) => (a.emp.code ?? '').localeCompare(b.emp.code ?? ''))[0]!;
      parents.set(emp.id, chosen.emp.id);
    }
  }

  // Pass 3 — safety net for a loop made entirely of manual links (HR can always
  // point two people at each other). Cut a derived link first so a manual
  // placement is never the thing that silently disappears from the chart.
  for (const emp of employees) {
    const chain: string[] = [emp.id];
    const seen = new Set<string>([emp.id]);
    let cursor = parents.get(emp.id) ?? null;
    while (cursor) {
      if (seen.has(cursor)) {
        const loop = chain.slice(chain.indexOf(cursor));
        const victim = loop.find((id) => !manual.has(id)) ?? emp.id;
        parents.set(victim, null);
        break;
      }
      seen.add(cursor);
      chain.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }

  return parents;
}

/**
 * Walk upward from `candidateManagerId` to ensure it never reaches `employeeId`
 * (which would create a cycle when assigning that manager).
 */
export async function wouldCreateManagerCycle(
  employeeId: string,
  candidateManagerId: string,
): Promise<boolean> {
  if (employeeId === candidateManagerId) return true;
  let current: string | null = candidateManagerId;
  const seen = new Set<string>();
  while (current) {
    if (current === employeeId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const row: { managerId: string | null } | null =
      await prisma.employeeProfile.findUnique({
        where: { id: current },
        select: { managerId: true },
      });
    current = row?.managerId ?? null;
  }
  return false;
}

function nestTree(
  employees: EmpRow[],
  focusEmployeeId?: string | null,
  parentOverride?: Map<string, string | null>,
  rankOf: RankResolver = jobTitleRank,
): OrgChartNode[] {
  const ids = new Set(employees.map((e) => e.id));
  const parents = parentOverride ?? computeEffectiveParents(employees, rankOf);
  const byManager = new Map<string | null, EmpRow[]>();

  for (const emp of employees) {
    const resolved = parents.get(emp.id) ?? null;
    const mid = resolved && ids.has(resolved) ? resolved : null;
    const list = byManager.get(mid) ?? [];
    list.push(emp);
    byManager.set(mid, list);
  }

  // Seniors first, then everyone holding the same title side by side, then by name.
  const orderSiblings = (a: EmpRow, b: EmpRow): number => {
    const byRank = rankOf(a.jobTitle) - rankOf(b.jobTitle);
    if (byRank !== 0) return byRank;
    const byTitle = normalizeTitle(a.jobTitle).localeCompare(
      normalizeTitle(b.jobTitle),
      'ar',
    );
    if (byTitle !== 0) return byTitle;
    return (a.name ?? '').localeCompare(b.name ?? '', 'ar');
  };

  const build = (managerKey: string | null, depth: number): OrgChartNode[] => {
    if (depth > 40) return [];
    const kids = (byManager.get(managerKey) ?? []).slice().sort(orderSiblings);
    return kids.map((emp) =>
      toNode(emp, build(emp.id, depth + 1), focusEmployeeId),
    );
  };

  return build(null, 0);
}

export async function buildOrgChartTree(params: {
  scope: OrgChartScope;
  locationId?: string | null;
}): Promise<OrgChartResult> {
  const scope = params.scope === 'location' ? 'location' : 'company';
  const locationId =
    scope === 'location' && params.locationId ? String(params.locationId) : null;

  if (scope === 'location' && !locationId) {
    return {
      roots: [],
      employeeCount: 0,
      scope,
      locationId: null,
      focusEmployeeId: null,
      canChooseScope: true,
      viewLabel: 'location',
    };
  }

  // `active` alone, like every other employee listing. `archivedAt` is kept after a
  // restore as an audit trail, so filtering on it would hide anyone ever archived.
  const where: Prisma.EmployeeProfileWhereInput = {
    active: true,
    ...(locationId ? { locationId } : {}),
  };

  const [employees, rankOf] = await Promise.all([
    prisma.employeeProfile.findMany({
      where,
      include: { workLocation: true },
      orderBy: [{ name: 'asc' }],
    }),
    loadRankResolver(),
  ]);

  return {
    roots: nestTree(employees, null, undefined, rankOf),
    employeeCount: employees.length,
    scope,
    locationId,
    focusEmployeeId: null,
    canChooseScope: true,
    viewLabel: scope,
  };
}

/** Ancestors + self + full descendant subtree (for employee self-service). */
export async function buildPersonalOrgChart(
  employeeId: string,
): Promise<OrgChartResult> {
  const self = await prisma.employeeProfile.findFirst({
    where: { id: employeeId, active: true },
    include: { workLocation: true },
  });
  if (!self) {
    return {
      roots: [],
      employeeCount: 0,
      scope: 'mine',
      locationId: null,
      focusEmployeeId: employeeId,
      canChooseScope: false,
      viewLabel: 'mine',
    };
  }

  // Effective parents are derived per site, and a manual link may cross sites, so
  // resolve against the whole active roster and then keep only this person's line.
  const [roster, rankOf] = await Promise.all([
    prisma.employeeProfile.findMany({
      where: { active: true },
      include: { workLocation: true },
      orderBy: [{ name: 'asc' }],
    }),
    loadRankResolver(),
  ]);
  const parents = computeEffectiveParents(roster, rankOf);
  const byId = new Map(roster.map((e) => [e.id, e]));

  const childrenOf = new Map<string, string[]>();
  for (const emp of roster) {
    const parentId = parents.get(emp.id) ?? null;
    if (!parentId) continue;
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), emp.id]);
  }

  const included = new Map<string, EmpRow>();
  included.set(self.id, byId.get(self.id) ?? self);

  let cursor = parents.get(self.id) ?? null;
  let guard = 0;
  while (cursor && guard++ < 40) {
    if (included.has(cursor)) break;
    const mgr = byId.get(cursor);
    if (!mgr) break;
    included.set(mgr.id, mgr);
    cursor = parents.get(mgr.id) ?? null;
  }

  const queue = [self.id];
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const childId of childrenOf.get(parentId) ?? []) {
      if (included.has(childId)) continue;
      const child = byId.get(childId);
      if (!child) continue;
      included.set(childId, child);
      queue.push(childId);
    }
  }

  const employees = [...included.values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'ar'),
  );

  return {
    roots: nestTree(employees, employeeId, parents, rankOf),
    employeeCount: employees.length,
    scope: 'mine',
    locationId: self.locationId ?? null,
    focusEmployeeId: employeeId,
    canChooseScope: false,
    viewLabel: 'mine',
  };
}

export async function resolveOrgChartForUser(params: {
  userId: string;
  role: UserRole;
  employeeProfileId?: string | null;
  requestedScope?: string | null;
  requestedLocationId?: string | null;
}): Promise<OrgChartResult> {
  const { role } = params;
  const unrestricted = hasUnrestrictedLocationAccess(role);
  const locationScoped = isLocationScopedHrRole(role);

  if (unrestricted) {
    const scopeRaw = String(params.requestedScope ?? 'company').toLowerCase();
    if (scopeRaw === 'mine' && params.employeeProfileId) {
      return buildPersonalOrgChart(params.employeeProfileId);
    }
    const scope: OrgChartScope = scopeRaw === 'location' ? 'location' : 'company';
    const tree = await buildOrgChartTree({
      scope,
      locationId: params.requestedLocationId,
    });
    return { ...tree, canChooseScope: true };
  }

  if (locationScoped) {
    const scopedLocationId = await getHrLocationScope(params.userId, role);
    if (!scopedLocationId) {
      if (params.employeeProfileId) {
        return buildPersonalOrgChart(params.employeeProfileId);
      }
      return {
        roots: [],
        employeeCount: 0,
        scope: 'location',
        locationId: null,
        focusEmployeeId: null,
        canChooseScope: false,
        viewLabel: 'location',
      };
    }
    const tree = await buildOrgChartTree({
      scope: 'location',
      locationId: scopedLocationId,
    });
    return { ...tree, canChooseScope: false };
  }

  if (params.employeeProfileId) {
    return buildPersonalOrgChart(params.employeeProfileId);
  }

  return {
    roots: [],
    employeeCount: 0,
    scope: 'mine',
    locationId: null,
    focusEmployeeId: null,
    canChooseScope: false,
    viewLabel: 'mine',
  };
}
