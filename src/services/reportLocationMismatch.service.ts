/**
 * Report — punches at a fingerprint device whose location differs from the
 * employee's assigned work location.
 *
 * Cycle already in place: Devices Settings assigns each terminal to a branch,
 * and each employee has a workLocation. This report closes the loop by joining
 * Transaction.terminalSn → Device.serialNumber → Device.locationId and
 * comparing it to EmployeeProfile.locationId.
 *
 * Useful for spotting buddy-punching (someone clocks an employee on a device
 * in a different branch from the one they are assigned to).
 */
import { prisma } from '../prisma/client';
import {
  dateOnly,
  findReportEmployees,
  identityCells,
  yesNo,
  type EmployeeScopeFilters,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile } from './hrReportsExcel.service';

export type LocationMismatchReportOptions = EmployeeScopeFilters & {
  dateFrom: Date;
  dateTo: Date;
  /**
   * When true, also surface punches on terminals that are not linked to any
   * device/location in Settings (can't compare, but still suspicious).
   */
  includeUnmappedDevices?: boolean;
};

export type LocationMismatchReportRow = {
  employeeId: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  employeeLocationId: string;
  employeeLocationName: string;
  deviceId: string;
  deviceName: string;
  deviceSn: string;
  deviceLocationId: string;
  deviceLocationName: string;
  punchCount: number;
  firstPunchAt: string;
  lastPunchAt: string;
  status: 'mismatched' | 'unmapped_device';
  statusLabel: string;
};

type AggKey = string;

type Agg = {
  employeeId: string;
  deviceId: string;
  deviceName: string;
  deviceSn: string;
  deviceLocationId: string;
  deviceLocationName: string;
  status: 'mismatched' | 'unmapped_device';
  punchCount: number;
  firstPunchAt: Date;
  lastPunchAt: Date;
};

function deviceLabel(d: {
  name: string;
  alias: string | null;
  serialNumber: string | null;
}): string {
  return (d.alias?.trim() || d.name?.trim() || d.serialNumber?.trim() || '—') as string;
}

function isoDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function buildLocationMismatchReport(
  options: LocationMismatchReportOptions,
): Promise<LocationMismatchReportRow[]> {
  const employees = await findReportEmployees(options);
  // Only employees with an assigned location can produce a clear mismatch.
  const withLocation = employees.filter((e) => Boolean(e.locationId));
  if (withLocation.length === 0) return [];

  const empById = new Map(withLocation.map((e) => [e.id, e]));
  const empByCode = new Map<string, (typeof withLocation)[number]>();
  for (const emp of withLocation) {
    for (const code of [
      emp.code,
      emp.mapping?.biotimeEmpCode,
      emp.identificationId,
      emp.barcode,
    ]) {
      const key = code?.trim();
      if (key && !empByCode.has(key)) empByCode.set(key, emp);
    }
  }

  const devices = await prisma.device.findMany({
    include: { location: { select: { id: true, name: true } } },
  });
  // Resolve a punch to its device: serial number first (unique per terminal),
  // then terminal alias/name as a fallback. The alias fallback is only trusted
  // when every device sharing that name lives in ONE location; a name reused
  // across branches is ambiguous, so we refuse to guess rather than risk
  // flagging a same-location punch as a mismatch.
  const deviceBySn = new Map<string, (typeof devices)[number]>();
  const devicesByAliasKey = new Map<string, typeof devices>();
  for (const d of devices) {
    const sn = d.serialNumber?.trim();
    if (sn) deviceBySn.set(sn.toLowerCase(), d);
    for (const label of [d.alias, d.name]) {
      const key = label?.trim().toLowerCase();
      if (!key) continue;
      const list = devicesByAliasKey.get(key) ?? [];
      list.push(d);
      devicesByAliasKey.set(key, list);
    }
  }
  const resolveByAlias = (key: string): (typeof devices)[number] | undefined => {
    const list = devicesByAliasKey.get(key);
    if (!list?.length) return undefined;
    const locationIds = new Set(list.map((d) => d.locationId ?? ''));
    return locationIds.size === 1 ? list[0] : undefined;
  };

  const employeeIds = withLocation.map((e) => e.id);
  const empCodes = [...empByCode.keys()];

  const punches = await prisma.transaction.findMany({
    where: {
      punchTime: { gte: options.dateFrom, lte: options.dateTo },
      isDuplicate: false,
      OR: [
        { employeeId: { in: employeeIds } },
        ...(empCodes.length ? [{ empCode: { in: empCodes } }] : []),
      ],
    },
    select: {
      employeeId: true,
      empCode: true,
      punchTime: true,
      terminalSn: true,
      terminalAlias: true,
    },
    orderBy: { punchTime: 'asc' },
  });

  const includeUnmapped = options.includeUnmappedDevices === true;
  const aggregations = new Map<AggKey, Agg>();

  for (const punch of punches) {
    const emp =
      (punch.employeeId ? empById.get(punch.employeeId) : undefined) ??
      (punch.empCode?.trim() ? empByCode.get(punch.empCode.trim()) : undefined);
    if (!emp?.locationId) continue;

    const sn = punch.terminalSn?.trim() ?? '';
    const alias = punch.terminalAlias?.trim() ?? '';
    const device =
      (sn ? deviceBySn.get(sn.toLowerCase()) : undefined) ??
      (alias ? resolveByAlias(alias.toLowerCase()) : undefined);
    const deviceLocationId = device?.locationId ?? '';

    let status: Agg['status'];
    if (!device || !deviceLocationId) {
      if (!includeUnmapped) continue;
      status = 'unmapped_device';
    } else if (deviceLocationId === emp.locationId) {
      continue; // same location — expected
    } else {
      status = 'mismatched';
    }

    const deviceId = device?.id ?? `unknown:${sn || punch.terminalAlias || 'none'}`;
    const deviceName = device
      ? deviceLabel(device)
      : punch.terminalAlias?.trim() || sn || 'جهاز غير معروف';
    const deviceLocationName =
      status === 'unmapped_device'
        ? device
          ? 'الجهاز بدون لوكيشن'
          : 'جهاز غير مسجّل في النظام'
        : (device?.location?.name ?? '');

    const key: AggKey = `${emp.id}|${deviceId}|${status}`;
    const existing = aggregations.get(key);
    if (existing) {
      existing.punchCount += 1;
      if (punch.punchTime < existing.firstPunchAt) existing.firstPunchAt = punch.punchTime;
      if (punch.punchTime > existing.lastPunchAt) existing.lastPunchAt = punch.punchTime;
    } else {
      aggregations.set(key, {
        employeeId: emp.id,
        deviceId,
        deviceName,
        deviceSn: sn || device?.serialNumber?.trim() || '',
        deviceLocationId,
        deviceLocationName,
        status,
        punchCount: 1,
        firstPunchAt: punch.punchTime,
        lastPunchAt: punch.punchTime,
      });
    }
  }

  const rows: LocationMismatchReportRow[] = [];
  for (const agg of aggregations.values()) {
    const emp = empById.get(agg.employeeId);
    if (!emp) continue;
    const identity = identityCells(emp);
    rows.push({
      employeeId: emp.id,
      locationName: identity[0],
      departmentName: identity[1],
      code: identity[2],
      name: identity[3],
      nationalId: identity[4],
      employeeLocationId: emp.locationId!,
      employeeLocationName: emp.workLocation?.name ?? emp.location ?? '',
      deviceId: agg.deviceId,
      deviceName: agg.deviceName,
      deviceSn: agg.deviceSn,
      deviceLocationId: agg.deviceLocationId,
      deviceLocationName: agg.deviceLocationName,
      punchCount: agg.punchCount,
      firstPunchAt: isoDateTime(agg.firstPunchAt),
      lastPunchAt: isoDateTime(agg.lastPunchAt),
      status: agg.status,
      statusLabel:
        agg.status === 'mismatched' ? 'بصم في لوكيشن مختلف' : 'جهاز بدون ربط لوكيشن',
    });
  }

  rows.sort((a, b) => {
    const byLoc = a.employeeLocationName.localeCompare(b.employeeLocationName, 'ar');
    if (byLoc !== 0) return byLoc;
    const byName = a.name.localeCompare(b.name, 'ar');
    if (byName !== 0) return byName;
    return b.punchCount - a.punchCount;
  });

  return rows;
}

const DETAIL_HEADERS = [
  '#',
  'الكود',
  'الاسم',
  'لوكيشن الموظف (المسجّل)',
  // Keep this next to the employee location — same order as the on-screen table —
  // so the wrong terminal is obvious without hunting through later columns.
  'الجهاز الذي بصم عليه الموظف',
  'لوكيشن الجهاز (مكان البصمة)',
  'عدد البصمات في الفترة',
  'الحالة',
  'القسم',
  'الرقم القومي',
  'سيريال الجهاز',
  'أول بصمة',
  'آخر بصمة',
] as const;

const SUMMARY_HEADERS = [
  '#',
  'لوكيشن الموظف',
  'الجهاز الذي بصم عليه الموظف',
  'لوكيشن الجهاز',
  'عدد الموظفين',
  'إجمالي البصمات',
] as const;

/** Readable wall-clock without the trailing seconds/Z noise. */
function formatPunchCell(iso: string): string {
  if (!iso) return '';
  const cleaned = iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
  // Prefer YYYY-MM-DD HH:mm
  return cleaned.length >= 16 ? cleaned.slice(0, 16) : cleaned;
}

export async function exportLocationMismatchReportXlsx(
  options: LocationMismatchReportOptions,
): Promise<ReportFile> {
  const rows = await buildLocationMismatchReport(options);
  const fromKey = dateOnly(options.dateFrom);
  const toKey = dateOnly(options.dateTo);
  const mismatchedCount = rows.filter((r) => r.status === 'mismatched').length;
  const unmappedCount = rows.filter((r) => r.status === 'unmapped_device').length;
  const totalPunches = rows.reduce((sum, r) => sum + r.punchCount, 0);

  const [locationLabel, departmentLabel] = await Promise.all([
    options.locationId
      ? prisma.location
          .findUnique({ where: { id: options.locationId }, select: { name: true } })
          .then((l) => l?.name ?? options.locationId)
      : Promise.resolve('الكل'),
    options.departmentId
      ? prisma.department
          .findUnique({ where: { id: options.departmentId }, select: { name: true } })
          .then((d) => d?.name ?? options.departmentId)
      : Promise.resolve('الكل'),
  ]);

  const criteria = [
    `الفترة: من ${fromKey} إلى ${toKey}`,
    `فلتر الموقع: ${locationLabel}`,
    `فلتر القسم: ${departmentLabel}`,
    `أجهزة بدون ربط لوكيشن: ${yesNo(Boolean(options.includeUnmappedDevices))}`,
    `المؤرشفون: ${yesNo(Boolean(options.includeArchived))}`,
    `صفوف النتائج: ${rows.length} | مختلفين: ${mismatchedCount} | أجهزة غير مربوطة: ${unmappedCount} | إجمالي البصمات: ${totalPunches}`,
  ];

  // Summary: group by employee-branch → wrong device → punch-branch.
  const summaryMap = new Map<
    string,
    {
      empLoc: string;
      deviceName: string;
      devLoc: string;
      employees: Set<string>;
      punches: number;
    }
  >();
  for (const r of rows) {
    const key = `${r.employeeLocationName}||${r.deviceName}||${r.deviceLocationName}`;
    const bucket = summaryMap.get(key) ?? {
      empLoc: r.employeeLocationName || '—',
      deviceName: r.deviceName || '—',
      devLoc: r.deviceLocationName || '—',
      employees: new Set<string>(),
      punches: 0,
    };
    bucket.employees.add(r.employeeId);
    bucket.punches += r.punchCount;
    summaryMap.set(key, bucket);
  }
  const summaryRows = [...summaryMap.values()].sort((a, b) => b.punches - a.punches);

  const filename = `report_location_mismatch_${fromKey}_${toKey}.xlsx`;

  return buildReportWorkbook(
    [
      {
        title: 'بصمة في لوكيشن مختلف',
        criteria,
        headers: DETAIL_HEADERS,
        rows: rows.map((r, i) => [
          i + 1,
          r.code,
          r.name,
          r.employeeLocationName,
          r.deviceName,
          r.deviceLocationName,
          r.punchCount,
          r.statusLabel,
          r.departmentName,
          r.nationalId,
          r.deviceSn,
          formatPunchCell(r.firstPunchAt),
          formatPunchCell(r.lastPunchAt),
        ]),
        alertRows: new Set(rows.map((_, i) => i)),
        emptyMessage: 'لا توجد بصمات في لوكيشن مختلف عن لوكيشن الموظف في الفترة المحددة',
      },
      {
        title: 'ملخص حسب الجهاز',
        criteria: [
          `نفس فترة التقرير التفصيلي: ${fromKey} → ${toKey}`,
          `عدد التركيبات (لوكيشن موظف→جهاز): ${summaryRows.length}`,
        ],
        headers: SUMMARY_HEADERS,
        rows: summaryRows.map((s, i) => [
          i + 1,
          s.empLoc,
          s.deviceName,
          s.devLoc,
          s.employees.size,
          s.punches,
        ]),
        emptyMessage: 'لا يوجد ملخص — لا نتائج في الفترة',
      },
    ],
    'report_location_mismatch',
    { filename },
  );
}
