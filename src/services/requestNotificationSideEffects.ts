import { logger } from '../utils/logger';
import { notifyEmployeeRequestDecision } from './appNotification.service';

function fire(promise: Promise<unknown>): void {
  void promise.catch((err) => logger.warn({ err }, 'Request notification side effect failed'));
}

export function notifyLeaveDecision(
  r: { id: string; employeeId: string; dateFrom: Date; dateTo: Date },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'leave',
      requestId: r.id,
      detail: `${r.dateFrom.toISOString().slice(0, 10)} → ${r.dateTo.toISOString().slice(0, 10)}`,
    }),
  );
}

export function notifyLoanDecision(
  r: { id: string; employeeId: string; amount: number },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'loan',
      requestId: r.id,
      detail: `${r.amount} جنيه`,
    }),
  );
}

export function notifyShiftChangeDecision(r: { id: string; employeeId: string }, approved: boolean): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'shiftChange',
      requestId: r.id,
    }),
  );
}

export function notifySalaryDecision(
  r: { id: string; employeeId: string; amount: number },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'salary',
      requestId: r.id,
      detail: `${r.amount} جنيه`,
    }),
  );
}

export function notifyCertificateDecision(r: { id: string; employeeId: string }, approved: boolean): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'certificate',
      requestId: r.id,
    }),
  );
}

export function notifyAttendanceEditDecision(
  r: { id: string; employeeId: string; date: Date },
  approved: boolean,
): void {
  fire(
    notifyEmployeeRequestDecision({
      employeeId: r.employeeId,
      approved,
      requestKind: 'attendanceEdit',
      requestId: r.id,
      detail: r.date.toISOString().slice(0, 10),
    }),
  );
}
