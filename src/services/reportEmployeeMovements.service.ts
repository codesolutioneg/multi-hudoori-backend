/**
 * Report — employee hiring additions OR exits (archive/departure) in a date range.
 *
 * Split into two HR-facing reports (إضافة vs خروج) that share this builder via
 * `mode`. One Excel row per event with employee details.
 */
import { prisma } from '../prisma/client';
import type { Prisma } from '@prisma/client';
import {
  dateOnly,
  employeeScopeWhere,
  REPORT_EMPLOYEE_INCLUDE,
  reportEmployeeCode,
  reportEmployeeName,
  yesNo,
  type EmployeeScopeFilters,
  type EmployeeWithReportRelations,
} from './hrReports.service';
import { buildReportWorkbook, type ReportFile } from './hrReportsExcel.service';

export const MOVEMENT_MODES = ['hirings', 'exits'] as const;
export type MovementMode = (typeof MOVEMENT_MODES)[number];

export function parseMovementMode(value: unknown): MovementMode {
  const raw = String(value ?? '').trim();
  return (MOVEMENT_MODES as readonly string[]).includes(raw)
    ? (raw as MovementMode)
    : 'hirings';
}

export type EmployeeMovementsReportOptions = EmployeeScopeFilters & {
  dateFrom: Date;
  dateTo: Date;
  /** hirings = تعيينات فقط؛ exits = أرشفة + مغادرة */
  mode?: MovementMode;
};

export type MovementKind = 'hired' | 'archived' | 'departed';

export type EmployeeMovementRow = {
  employeeId: string;
  kind: MovementKind;
  kindLabel: string;
  eventDate: string;
  code: string;
  name: string;
  locationName: string;
  departmentName: string;
  nationalId: string;
  isForeigner: boolean;
  hiringDate: string;
  archivedAt: string;
  archiveReason: string;
  departureDate: string;
  jobTitle: string;
  active: boolean;
};

const KIND_LABELS: Record<MovementKind, string> = {
  hired: 'تعيين',
  archived: 'أرشفة',
  departed: 'مغادرة',
};

function dayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function dayEndInclusive(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

export async function buildEmployeeMovementsReport(
  options: EmployeeMovementsReportOptions,
): Promise<EmployeeMovementRow[]> {
  const mode = options.mode ?? 'hirings';
  const from = dayStart(options.dateFrom);
  const to = dayEndInclusive(options.dateTo);

  // Always include archived for exits; hirings also include archived-if-hired-in-range.
  const baseWhere = employeeScopeWhere({
    ...options,
    includeArchived: true,
  });

  const dateOr: Prisma.EmployeeProfileWhereInput[] =
    mode === 'hirings'
      ? [{ hiringDate: { gte: from, lte: to } }]
      : [
          { archivedAt: { gte: from, lte: to } },
          { departureDate: { gte: from, lte: to } },
        ];

  const where: Prisma.EmployeeProfileWhereInput = {
    AND: [baseWhere, { OR: dateOr }],
  };

  const employees = (await prisma.employeeProfile.findMany({
    where,
    include: REPORT_EMPLOYEE_INCLUDE,
    orderBy: [{ displayName: 'asc' }, { name: 'asc' }],
  })) as EmployeeWithReportRelations[];

  const rows: EmployeeMovementRow[] = [];

  for (const emp of employees) {
    const base = {
      employeeId: emp.id,
      code: reportEmployeeCode(emp),
      name: reportEmployeeName(emp),
      locationName: emp.workLocation?.name ?? emp.location ?? '',
      departmentName: emp.department?.name ?? '',
      nationalId: emp.nationalIdConfirm?.trim() ?? '',
      isForeigner: emp.isForeigner === true,
      hiringDate: dateOnly(emp.hiringDate),
      archivedAt: emp.archivedAt ? emp.archivedAt.toISOString().slice(0, 10) : '',
      archiveReason: emp.archiveReason?.trim() ?? '',
      departureDate: dateOnly(emp.departureDate),
      jobTitle: emp.jobTitle?.trim() ?? '',
      active: emp.active,
    };

    if (mode === 'hirings') {
      const hiring = emp.hiringDate;
      if (hiring && hiring.getTime() >= from.getTime() && hiring.getTime() <= to.getTime()) {
        rows.push({
          ...base,
          kind: 'hired',
          kindLabel: KIND_LABELS.hired,
          eventDate: dateOnly(hiring),
        });
      }
      continue;
    }

    const archived = emp.archivedAt;
    if (archived && archived.getTime() >= from.getTime() && archived.getTime() <= to.getTime()) {
      rows.push({
        ...base,
        kind: 'archived',
        kindLabel: KIND_LABELS.archived,
        eventDate: archived.toISOString().slice(0, 10),
      });
    }

    const departed = emp.departureDate;
    if (departed && departed.getTime() >= from.getTime() && departed.getTime() <= to.getTime()) {
      rows.push({
        ...base,
        kind: 'departed',
        kindLabel: KIND_LABELS.departed,
        eventDate: dateOnly(departed),
      });
    }
  }

  rows.sort((a, b) => {
    const byDate = a.eventDate.localeCompare(b.eventDate);
    if (byDate !== 0) return byDate;
    return a.name.localeCompare(b.name, 'ar');
  });

  return rows;
}

export async function exportEmployeeMovementsReportXlsx(
  options: EmployeeMovementsReportOptions,
): Promise<ReportFile> {
  const mode = options.mode ?? 'hirings';
  const rows = await buildEmployeeMovementsReport(options);
  const fromLabel = options.dateFrom.toISOString().slice(0, 10);
  const toLabel = options.dateTo.toISOString().slice(0, 10);

  if (mode === 'hirings') {
    const headers = [
      'تاريخ التعيين',
      'الكود',
      'الاسم',
      'الفرع',
      'القسم',
      'الوظيفة',
      'الرقم القومي',
      'أجنبي',
      'نشط',
    ] as const;

    return buildReportWorkbook(
      [
        {
          title: 'تقرير الإضافات (التعيينات)',
          criteria: [
            `الفترة: من ${fromLabel} إلى ${toLabel}`,
            `يشمل: موظفين تاريخ تعيينهم داخل الفترة`,
            `عدد الصفوف: ${rows.length}`,
          ],
          headers,
          rows: rows.map((r) => [
            r.eventDate,
            r.code,
            r.name,
            r.locationName,
            r.departmentName,
            r.jobTitle,
            r.nationalId,
            yesNo(r.isForeigner),
            yesNo(r.active),
          ]),
          emptyMessage: 'لا توجد تعيينات في الفترة المحددة',
        },
      ],
      'report_employee_hirings',
    );
  }

  const headers = [
    'نوع الخروج',
    'تاريخ الخروج',
    'الكود',
    'الاسم',
    'الفرع',
    'القسم',
    'الوظيفة',
    'الرقم القومي',
    'أجنبي',
    'تاريخ التعيين',
    'تاريخ الأرشفة',
    'سبب الأرشفة',
    'تاريخ المغادرة',
  ] as const;

  return buildReportWorkbook(
    [
      {
        title: 'تقرير الخروج (أرشفة / مغادرة)',
        criteria: [
          `الفترة: من ${fromLabel} إلى ${toLabel}`,
          `يشمل: أرشفة أو مغادرة داخل الفترة`,
          `عدد الصفوف: ${rows.length}`,
        ],
        headers,
        rows: rows.map((r) => [
          r.kindLabel,
          r.eventDate,
          r.code,
          r.name,
          r.locationName,
          r.departmentName,
          r.jobTitle,
          r.nationalId,
          yesNo(r.isForeigner),
          r.hiringDate,
          r.archivedAt,
          r.archiveReason,
          r.departureDate,
        ]),
        alertRows: new Set(rows.map((_, i) => i)),
        emptyMessage: 'لا توجد أرشفة أو مغادرة في الفترة المحددة',
      },
    ],
    'report_employee_exits',
  );
}
