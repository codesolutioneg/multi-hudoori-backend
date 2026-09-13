import { RequestState } from '@prisma/client';
import { prisma } from '../prisma/client';
import { ForbiddenError } from '../utils/errors';

async function employeeForUser(userId: string) {
  const profile = await prisma.employeeProfile.findFirst({ where: { userId } });
  if (!profile) throw new ForbiddenError('Employee profile required', 'ACCESS_DENIED');
  return profile;
}

export function leaveRequestJson(r: {
  id: string;
  leaveType: string;
  dateFrom: Date;
  dateTo: Date;
  reason: string;
  state: RequestState;
  rejectionReason: string | null;
  createdAt: Date;
  employee?: { id: string; name: string; code: string | null };
}) {
  return {
    id: r.id,
    leaveType: r.leaveType,
    dateFrom: r.dateFrom.toISOString().slice(0, 10),
    dateTo: r.dateTo.toISOString().slice(0, 10),
    reason: r.reason,
    state: r.state,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    employee: r.employee
      ? { id: r.employee.id, name: r.employee.name, code: r.employee.code }
      : undefined,
  };
}

export function loanRequestJson(r: {
  id: string;
  amount: number;
  repaymentMonths: number;
  reason: string;
  state: RequestState;
  rejectionReason: string | null;
  createdAt: Date;
  employee?: { id: string; name: string; code: string | null };
}) {
  return {
    id: r.id,
    amount: r.amount,
    repaymentMonths: r.repaymentMonths,
    reason: r.reason,
    state: r.state,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    employee: r.employee
      ? { id: r.employee.id, name: r.employee.name, code: r.employee.code }
      : undefined,
  };
}

export function shiftChangeRequestJson(r: {
  id: string;
  dateFrom: Date;
  dateTo: Date;
  reason: string;
  state: RequestState;
  rejectionReason: string | null;
  createdAt: Date;
  currentShiftId: string | null;
  newShiftId: string;
  employee?: { id: string; name: string; code: string | null };
  currentShift?: { id: string; name: string } | null;
  newShift?: { id: string; name: string };
}) {
  return {
    id: r.id,
    dateFrom: r.dateFrom.toISOString().slice(0, 10),
    dateTo: r.dateTo.toISOString().slice(0, 10),
    reason: r.reason,
    state: r.state,
    rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    currentShiftId: r.currentShiftId,
    newShiftId: r.newShiftId,
    currentShift: r.currentShift,
    newShift: r.newShift,
    employee: r.employee
      ? { id: r.employee.id, name: r.employee.name, code: r.employee.code }
      : undefined,
  };
}

export async function createLeaveRequest(userId: string, data: {
  leaveType: string;
  dateFrom: string;
  dateTo: string;
  reason: string;
}) {
  const employee = await employeeForUser(userId);
  return prisma.leaveRequest.create({
    data: {
      employeeId: employee.id,
      leaveType: data.leaveType,
      dateFrom: new Date(data.dateFrom),
      dateTo: new Date(data.dateTo),
      reason: data.reason,
      state: RequestState.pending,
    },
    include: { employee: true },
  });
}

export async function createLoanRequest(userId: string, data: {
  amount: number;
  repaymentMonths: number;
  reason: string;
}) {
  const employee = await employeeForUser(userId);
  return prisma.loanRequest.create({
    data: {
      employeeId: employee.id,
      amount: data.amount,
      repaymentMonths: data.repaymentMonths,
      reason: data.reason,
      state: RequestState.pending,
    },
    include: { employee: true },
  });
}

export async function createShiftChangeRequest(userId: string, data: {
  newShiftId: string;
  currentShiftId?: string;
  dateFrom: string;
  dateTo: string;
  reason: string;
}) {
  const employee = await employeeForUser(userId);
  return prisma.shiftChangeRequest.create({
    data: {
      employeeId: employee.id,
      newShiftId: data.newShiftId,
      currentShiftId: data.currentShiftId,
      dateFrom: new Date(data.dateFrom),
      dateTo: new Date(data.dateTo),
      reason: data.reason,
      state: RequestState.pending,
    },
    include: { employee: true, currentShift: true, newShift: true },
  });
}

export function salaryRequestJson(r: {
  id: string; amount: number; reason: string; state: RequestState;
  rejectionReason: string | null; createdAt: Date;
  employee?: { id: string; name: string; code: string | null };
}) {
  return {
    id: r.id, amount: r.amount, reason: r.reason, state: r.state,
    rejectionReason: r.rejectionReason, createdAt: r.createdAt.toISOString(),
    employee: r.employee ? { id: r.employee.id, name: r.employee.name, code: r.employee.code } : undefined,
  };
}

export function certificateRequestJson(r: {
  id: string; certificateType: string; reason: string; state: RequestState;
  rejectionReason: string | null; createdAt: Date;
  employee?: { id: string; name: string; code: string | null };
}) {
  return {
    id: r.id, certificateType: r.certificateType, reason: r.reason, state: r.state,
    rejectionReason: r.rejectionReason, createdAt: r.createdAt.toISOString(),
    employee: r.employee ? { id: r.employee.id, name: r.employee.name, code: r.employee.code } : undefined,
  };
}

export function attendanceEditRequestJson(r: {
  id: string; date: Date; requestedCheckIn: string | null; requestedCheckOut: string | null;
  reason: string; state: RequestState; rejectionReason: string | null; createdAt: Date;
  employee?: { id: string; name: string; code: string | null };
}) {
  return {
    id: r.id, date: r.date.toISOString().slice(0, 10),
    requestedCheckIn: r.requestedCheckIn, requestedCheckOut: r.requestedCheckOut,
    reason: r.reason, state: r.state, rejectionReason: r.rejectionReason,
    createdAt: r.createdAt.toISOString(),
    employee: r.employee ? { id: r.employee.id, name: r.employee.name, code: r.employee.code } : undefined,
  };
}

export async function createSalaryRequest(userId: string, data: { amount: number; reason: string }) {
  const employee = await employeeForUser(userId);
  return prisma.salaryRequest.create({
    data: { employeeId: employee.id, amount: data.amount, reason: data.reason, state: RequestState.pending },
    include: { employee: true },
  });
}

export async function createCertificateRequest(userId: string, data: { certificateType: string; reason: string }) {
  const employee = await employeeForUser(userId);
  return prisma.certificateRequest.create({
    data: { employeeId: employee.id, certificateType: data.certificateType, reason: data.reason, state: RequestState.pending },
    include: { employee: true },
  });
}

export async function createAttendanceEditRequest(userId: string, data: {
  date: string; requestedCheckIn?: string; requestedCheckOut?: string; reason: string;
}) {
  const employee = await employeeForUser(userId);
  return prisma.attendanceEditRequest.create({
    data: {
      employeeId: employee.id,
      date: new Date(data.date),
      requestedCheckIn: data.requestedCheckIn,
      requestedCheckOut: data.requestedCheckOut,
      reason: data.reason,
      state: RequestState.pending,
    },
    include: { employee: true },
  });
}

export async function approveSalaryRequest(id: string, approverId: string) {
  return prisma.salaryRequest.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true },
  });
}

export async function rejectSalaryRequest(id: string, approverId: string, reason: string) {
  return prisma.salaryRequest.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true },
  });
}

export async function approveCertificateRequest(id: string, approverId: string) {
  return prisma.certificateRequest.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true },
  });
}

export async function rejectCertificateRequest(id: string, approverId: string, reason: string) {
  return prisma.certificateRequest.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true },
  });
}

export async function approveAttendanceEditRequest(id: string, approverId: string) {
  return prisma.attendanceEditRequest.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true },
  });
}

export async function rejectAttendanceEditRequest(id: string, approverId: string, reason: string) {
  return prisma.attendanceEditRequest.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true },
  });
}

export async function listMyRequests(userId: string) {
  const employee = await employeeForUser(userId);
  const [leave, loan, shiftChange, salary, certificate, attendanceEdit] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { employeeId: employee.id },
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.loanRequest.findMany({
      where: { employeeId: employee.id },
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.shiftChangeRequest.findMany({
      where: { employeeId: employee.id },
      include: { employee: true, currentShift: true, newShift: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.salaryRequest.findMany({
      where: { employeeId: employee.id },
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.certificateRequest.findMany({
      where: { employeeId: employee.id },
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.attendanceEditRequest.findMany({
      where: { employeeId: employee.id },
      include: { employee: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { leave, loan, shiftChange, salary, certificate, attendanceEdit };
}

export async function listPendingRequests() {
  const pending = RequestState.pending;
  const [leave, loan, shiftChange, salary, certificate, attendanceEdit] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { state: pending }, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
    prisma.loanRequest.findMany({ where: { state: pending }, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
    prisma.shiftChangeRequest.findMany({ where: { state: pending }, include: { employee: true, currentShift: true, newShift: true }, orderBy: { createdAt: 'desc' } }),
    prisma.salaryRequest.findMany({ where: { state: pending }, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
    prisma.certificateRequest.findMany({ where: { state: pending }, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
    prisma.attendanceEditRequest.findMany({ where: { state: pending }, include: { employee: true }, orderBy: { createdAt: 'desc' } }),
  ]);
  const count = leave.length + loan.length + shiftChange.length + salary.length + certificate.length + attendanceEdit.length;
  return { leave, loan, shiftChange, salary, certificate, attendanceEdit, count };
}

export async function approveLeaveRequest(id: string, approverId: string) {
  return prisma.leaveRequest.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true },
  });
}

export async function approveLoanRequest(id: string, approverId: string) {
  return prisma.loanRequest.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true },
  });
}

export async function approveShiftChangeRequest(id: string, approverId: string) {
  return prisma.shiftChangeRequest.update({
    where: { id },
    data: { state: RequestState.approved, approvedById: approverId, rejectionReason: null },
    include: { employee: true, currentShift: true, newShift: true },
  });
}

export async function rejectLeaveRequest(id: string, approverId: string, reason: string) {
  return prisma.leaveRequest.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true },
  });
}

export async function rejectLoanRequest(id: string, approverId: string, reason: string) {
  return prisma.loanRequest.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true },
  });
}

export async function rejectShiftChangeRequest(id: string, approverId: string, reason: string) {
  return prisma.shiftChangeRequest.update({
    where: { id },
    data: { state: RequestState.rejected, approvedById: approverId, rejectionReason: reason },
    include: { employee: true, currentShift: true, newShift: true },
  });
}

export async function countPendingRequests(): Promise<number> {
  const { count } = await listPendingRequests();
  return count;
}
