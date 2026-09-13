import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHr } from '../../middlewares/auth';
import { p } from './route-helpers';
import { assertGridLocationAccess, getHrLocationScope, applyHrLocationScopeToEmployeeWhere, getHrLocationScopeFromReq, assertEmployeeLocationAccess } from '../../services/userLocationScope.service';
import { employeeJson, employeeListJson, configSettingsWithCounts, configSummaryJson, shiftJson, shiftAssignmentJson, deviceJson, departmentJson, attendanceJson, shiftGridJson, shiftGridLineJson, payrollJson, payrollLineJson, deductionJson, advanceShortJson, advanceLongJson, locationJson, insuranceCompanyJson, DEDUCTION_TYPES, } from '../../services/serialize.service';
import { parseEmployeeDocumentType, readEmployeeDocument, readInsurancePrint, saveEmployeeDocument, saveInsurancePrint, } from '../../services/employeeDocuments.service';
import { prisma } from '../../prisma/client';

const router = Router();

router.post('/employees/document/upload', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.employeeId ?? '');
  const docType = parseEmployeeDocumentType(params.documentType ?? params.docType);
  const base64 = String(params.base64 ?? params.file ?? '');
  if (!docType) {
    jsonRpcSuccess(res, biotimeFail('documentType غير صالح', 'VALIDATION'), req.rpcId);
    return;
  }
  if (!base64.trim()) {
    jsonRpcSuccess(res, biotimeFail('ملف فارغ', 'VALIDATION'), req.rpcId);
    return;
  }
  const hrScope = await getHrLocationScopeFromReq(req);
  const existing = await prisma.employeeProfile.findUnique({ where: { id } });
  if (!existing) {
    jsonRpcSuccess(res, biotimeFail('Employee not found', 'NOT_FOUND'), req.rpcId);
    return;
  }
  assertEmployeeLocationAccess(hrScope, existing.locationId);
  const result = await saveEmployeeDocument(id, docType, base64, params.mimeType ? String(params.mimeType) : undefined);
  const employee = await prisma.employeeProfile.findUniqueOrThrow({
    where: { id },
    include: { department: true, mapping: true, workLocation: true },
  });
  jsonRpcSuccess(res, biotimeOk({
    employee: employeeJson(employee, true),
    relativePath: result.relativePath,
    documentType: result.documentType,
    message: 'تم رفع المستند',
  }), req.rpcId);
}));

router.post('/employees/document/get', requireAuth, requireHr, asyncHandler(async (req, res) => {
  const params = p(req);
  const id = String(params.id ?? params.employeeId ?? '');
  const docType = parseEmployeeDocumentType(params.documentType ?? params.docType);
  if (!docType) {
    jsonRpcSuccess(res, biotimeFail('documentType غير صالح', 'VALIDATION'), req.rpcId);
    return;
  }
  const file = await readEmployeeDocument(id, docType);
  if (!file) {
    jsonRpcSuccess(res, biotimeFail('لا يوجد مستند', 'NOT_FOUND'), req.rpcId);
    return;
  }
  jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
}));

export default router;
