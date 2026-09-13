import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import * as requestsService from '../../services/requests.service';

const router = Router();

function rejectEmployeeMutations(req: { user?: { role: UserRole } }, res: Parameters<typeof jsonRpcSuccess>[0], rpcId: unknown): boolean {
  if (req.user?.role === UserRole.EMPLOYEE) {
    jsonRpcSuccess(
      res,
      biotimeFail('حساب الموظف للعرض فقط — لا يمكن إنشاء طلبات', 'READ_ONLY'),
      rpcId as string | undefined,
    );
    return true;
  }
  return false;
}

function rejectEmployeeSelfServiceExtras(
  req: { user?: { role: UserRole } },
  res: Parameters<typeof jsonRpcSuccess>[0],
  rpcId: unknown,
): boolean {
  if (req.user?.role === UserRole.EMPLOYEE) {
    jsonRpcSuccess(
      res,
      biotimeFail('حساب الموظف يعرض الحضور والجدول فقط', 'READ_ONLY'),
      rpcId as string | undefined,
    );
    return true;
  }
  return false;
}

router.post('/requests/my', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeSelfServiceExtras(req, res, req.rpcId)) return;
  const data = await requestsService.listMyRequests(req.user!.id);
  jsonRpcSuccess(res, biotimeOk({
    leave: data.leave.map(requestsService.leaveRequestJson),
    loan: data.loan.map(requestsService.loanRequestJson),
    shiftChange: data.shiftChange.map(requestsService.shiftChangeRequestJson),
    salary: data.salary.map(requestsService.salaryRequestJson),
    certificate: data.certificate.map(requestsService.certificateRequestJson),
    attendanceEdit: data.attendanceEdit.map(requestsService.attendanceEditRequestJson),
  }), req.rpcId);
}));

router.post('/requests/pending', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const data = await requestsService.listPendingRequests();
  jsonRpcSuccess(res, biotimeOk({
    leave: data.leave.map(requestsService.leaveRequestJson),
    loan: data.loan.map(requestsService.loanRequestJson),
    shiftChange: data.shiftChange.map(requestsService.shiftChangeRequestJson),
    salary: data.salary.map(requestsService.salaryRequestJson),
    certificate: data.certificate.map(requestsService.certificateRequestJson),
    attendanceEdit: data.attendanceEdit.map(requestsService.attendanceEditRequestJson),
    count: data.count,
  }), req.rpcId);
}));

router.post('/requests/leave/create', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeMutations(req, res, req.rpcId)) return;
  const params = p(req);
  const r = await requestsService.createLeaveRequest(req.user!.id, {
    leaveType: String(params.leaveType ?? 'annual'),
    dateFrom: String(params.dateFrom),
    dateTo: String(params.dateTo),
    reason: String(params.reason ?? ''),
  });
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.leaveRequestJson(r) }), req.rpcId);
}));

router.post('/requests/loan/create', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeMutations(req, res, req.rpcId)) return;
  const params = p(req);
  const r = await requestsService.createLoanRequest(req.user!.id, {
    amount: Number(params.amount),
    repaymentMonths: Number(params.repaymentMonths ?? 1),
    reason: String(params.reason ?? ''),
  });
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.loanRequestJson(r) }), req.rpcId);
}));

router.post('/requests/shift-change/create', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeMutations(req, res, req.rpcId)) return;
  const params = p(req);
  const r = await requestsService.createShiftChangeRequest(req.user!.id, {
    newShiftId: String(params.newShiftId),
    currentShiftId: params.currentShiftId ? String(params.currentShiftId) : undefined,
    dateFrom: String(params.dateFrom),
    dateTo: String(params.dateTo),
    reason: String(params.reason ?? ''),
  });
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.shiftChangeRequestJson(r) }), req.rpcId);
}));

router.post('/requests/leave/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const r = await requestsService.approveLeaveRequest(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.leaveRequestJson(r) }), req.rpcId);
}));

router.post('/requests/loan/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const r = await requestsService.approveLoanRequest(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.loanRequestJson(r) }), req.rpcId);
}));

router.post('/requests/shift-change/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const r = await requestsService.approveShiftChangeRequest(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.shiftChangeRequestJson(r) }), req.rpcId);
}));

router.post('/requests/leave/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const r = await requestsService.rejectLeaveRequest(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.leaveRequestJson(r) }), req.rpcId);
}));

router.post('/requests/loan/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const r = await requestsService.rejectLoanRequest(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.loanRequestJson(r) }), req.rpcId);
}));

router.post('/requests/shift-change/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const r = await requestsService.rejectShiftChangeRequest(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.shiftChangeRequestJson(r) }), req.rpcId);
}));

router.post('/requests/salary/create', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeMutations(req, res, req.rpcId)) return;
  const params = p(req);
  const r = await requestsService.createSalaryRequest(req.user!.id, {
    amount: Number(params.amount),
    reason: String(params.reason ?? ''),
  });
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.salaryRequestJson(r) }), req.rpcId);
}));

router.post('/requests/certificate/create', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeMutations(req, res, req.rpcId)) return;
  const params = p(req);
  const r = await requestsService.createCertificateRequest(req.user!.id, {
    certificateType: String(params.certificateType ?? 'employment'),
    reason: String(params.reason ?? ''),
  });
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.certificateRequestJson(r) }), req.rpcId);
}));

router.post('/requests/attendance-edit/create', requireAuth, asyncHandler(async (req, res) => {
  if (rejectEmployeeMutations(req, res, req.rpcId)) return;
  const params = p(req);
  const r = await requestsService.createAttendanceEditRequest(req.user!.id, {
    date: String(params.date),
    requestedCheckIn: params.requestedCheckIn ? String(params.requestedCheckIn) : undefined,
    requestedCheckOut: params.requestedCheckOut ? String(params.requestedCheckOut) : undefined,
    reason: String(params.reason ?? ''),
  });
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.attendanceEditRequestJson(r) }), req.rpcId);
}));

router.post('/requests/salary/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const r = await requestsService.approveSalaryRequest(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.salaryRequestJson(r) }), req.rpcId);
}));

export default router;
