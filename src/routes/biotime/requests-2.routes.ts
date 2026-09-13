import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import * as requestsService from '../../services/requests.service';

const router = Router();

router.post('/requests/certificate/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const r = await requestsService.approveCertificateRequest(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.certificateRequestJson(r) }), req.rpcId);
}));

router.post('/requests/attendance-edit/approve', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const id = String(p(req).id ?? '');
  const r = await requestsService.approveAttendanceEditRequest(id, req.user!.id);
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.attendanceEditRequestJson(r) }), req.rpcId);
}));

router.post('/requests/salary/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const r = await requestsService.rejectSalaryRequest(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.salaryRequestJson(r) }), req.rpcId);
}));

router.post('/requests/certificate/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const r = await requestsService.rejectCertificateRequest(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.certificateRequestJson(r) }), req.rpcId);
}));

router.post('/requests/attendance-edit/reject', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const r = await requestsService.rejectAttendanceEditRequest(String(params.id), req.user!.id, String(params.reason ?? ''));
  jsonRpcSuccess(res, biotimeOk({ request: requestsService.attendanceEditRequestJson(r) }), req.rpcId);
}));

// --- Hiring appointments (تعيين جديد) ---

export default router;
