import { logger } from '../utils/logger';
import { notifyEmployeeRequestDecision } from './appNotification.service';

function fire(promise: Promise<unknown>): void {
  void promise.catch((err) => logger.warn({ err }, 'Request notification side effect failed'));
}

function rejectionReasonWhenDenied(
  approved: boolean,
  r: { rejectionReason?: string | null },
): string | null | undefined {
  return approved ? undefined : r.rejectionReason;
}

export function notifyLeaveDecision(
  r: {
    id: string;
    employeeId: string;
    dateFrom: Date;
    dateTo: Date;
    rejectionReason?: string | null;
  },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'leave',
      requestId: r.id,
      detail: `${r.dateFrom.toISOString().slice(0, 10)} → ${r.dateTo.toISOString().slice(0, 10)}`,
      rejectionReason: rejectionReasonWhenDenied(approved, r),
    }),
  );
}

export function notifyLoanDecision(
  r: { id: string; employeeId: string; amount: number; rejectionReason?: string | null },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'loan',
      requestId: r.id,
      detail: `${r.amount} جنيه`,
      rejectionReason: rejectionReasonWhenDenied(approved, r),
    }),
  );
}

export function notifyShiftChangeDecision(
  r: { id: string; employeeId: string; rejectionReason?: string | null },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'shiftChange',
      requestId: r.id,
      rejectionReason: rejectionReasonWhenDenied(approved, r),
    }),
  );
}

export function notifySalaryDecision(
  r: { id: string; employeeId: string; amount: number; rejectionReason?: string | null },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'salary',
      requestId: r.id,
      detail: `${r.amount} جنيه`,
      rejectionReason: rejectionReasonWhenDenied(approved, r),
    }),
  );
}

export function notifyCertificateDecision(
  r: { id: string; employeeId: string; rejectionReason?: string | null },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'certificate',
      requestId: r.id,
      rejectionReason: rejectionReasonWhenDenied(approved, r),
    }),
  );
}

export function notifyAttendanceEditDecision(
  r: { id: string; employeeId: string; date: Date; rejectionReason?: string | null },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'attendanceEdit',
      requestId: r.id,
      detail: r.date.toISOString().slice(0, 10),
      rejectionReason: rejectionReasonWhenDenied(approved, r),
    }),
  );
}

export type AdvanceNotifyDecision = 'approved' | 'rejected' | 'branch_approved';

export function notifyAdvanceDecision(
  r: { id: string; employeeId: string; amount: number; rejectionReason?: string | null },
  decision: AdvanceNotifyDecision,
): void {
  if (decision === 'branch_approved') {
    fire(
      notifyEmployeeRequestDecision({
        employeeId: r.employeeId,
        approved: true,
        requestKind: 'advance',
        requestId: r.id,
        detail: `${r.amount} جنيه — بانتظار موافقة الموارد البشرية`,
        title: 'موافقة مدير الفرع على طلب السلفة',
      }),
    );
    return;
  }
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved: decision === 'approved',
      requestKind: 'advance',
      requestId: r.id,
      detail: `${r.amount} جنيه`,
      rejectionReason: decision === 'rejected' ? r.rejectionReason : undefined,
    }),
  );
}
