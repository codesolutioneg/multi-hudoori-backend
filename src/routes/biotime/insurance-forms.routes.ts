import { Router } from 'express';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { writeAudit } from '../../services/auditLog.service';
import { AppError } from '../../utils/errors';
import {
  deleteEstablishment,
  generateInsuranceFormPdfBase64,
  getInsuranceForm,
  listEstablishments,
  listInsuranceForms,
  lookupEmployeeForInsuranceForm,
  normalizeFormType,
  saveInsuranceForm,
  upsertEstablishment,
} from '../../services/insuranceForms.service';

const router = Router();

router.post(
  '/insurance-forms/establishments/list',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const activeOnly = Boolean(p(req).activeOnly);
    const items = await listEstablishments(activeOnly);
    jsonRpcSuccess(res, biotimeOk({ items }), req.rpcId);
  }),
);

router.post(
  '/insurance-forms/establishments/save',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    try {
      const params = p(req);
      const row = await upsertEstablishment({
        id: params.id ? String(params.id) : undefined,
        name: String(params.name ?? ''),
        insuranceNumber: params.insuranceNumber?.toString(),
        office: params.office?.toString(),
        address: params.address?.toString(),
        buildingNumber: params.buildingNumber?.toString(),
        street: params.street?.toString(),
        village: params.village?.toString(),
        district: params.district?.toString(),
        governorate: params.governorate?.toString(),
        establishmentType: params.establishmentType?.toString(),
        phone: params.phone?.toString(),
        active: params.active !== false && params.active !== 'false',
        sequence: params.sequence != null ? Number(params.sequence) : undefined,
      });
      await writeAudit({
        req,
        module: 'insurance_forms',
        action: params.id ? 'insurance_establishment.update' : 'insurance_establishment.create',
        summary: `منشأة تأمينية: ${row.name}`,
        route: '/insurance-forms/establishments/save',
      });
      jsonRpcSuccess(res, biotimeOk({ establishment: row }), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Save failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/insurance-forms/establishments/delete',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    try {
      const id = String(p(req).id ?? '');
      if (!id) {
        jsonRpcSuccess(res, biotimeFail('id مطلوب', 'VALIDATION'), req.rpcId);
        return;
      }
      await deleteEstablishment(id);
      await writeAudit({
        req,
        module: 'insurance_forms',
        action: 'insurance_establishment.delete',
        summary: `حذف منشأة تأمينية ${id}`,
        route: '/insurance-forms/establishments/delete',
      });
      jsonRpcSuccess(res, biotimeOk({ deleted: true }), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Delete failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/insurance-forms/lookup-employee',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    try {
      const query = String(p(req).query ?? p(req).q ?? '');
      const employee = await lookupEmployeeForInsuranceForm(query);
      jsonRpcSuccess(res, biotimeOk({ employee }), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Lookup failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/insurance-forms/list',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    let formType;
    try {
      formType = params.formType ? normalizeFormType(params.formType) : undefined;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Invalid type';
      jsonRpcSuccess(res, biotimeFail(message, 'VALIDATION'), req.rpcId);
      return;
    }
    const result = await listInsuranceForms({
      formType,
      search: params.search?.toString(),
      limit: params.limit != null ? Number(params.limit) : undefined,
      offset: params.offset != null ? Number(params.offset) : undefined,
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  }),
);

router.post(
  '/insurance-forms/get',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    try {
      const id = String(p(req).id ?? '');
      const form = await getInsuranceForm(id);
      jsonRpcSuccess(res, biotimeOk({ form }), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Get failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/insurance-forms/save',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    try {
      const params = p(req);
      const user = (req as { user?: { id?: string; name?: string; email?: string } }).user;
      const payload =
        params.payload && typeof params.payload === 'object'
          ? (params.payload as Record<string, unknown>)
          : {};
      const form = await saveInsuranceForm({
        id: params.id ? String(params.id) : undefined,
        formType: params.formType,
        employeeId: params.employeeId?.toString(),
        establishmentId: params.establishmentId?.toString(),
        payload,
        createdByUserId: String(user?.id ?? ''),
        createdByName: user?.name || user?.email || null,
      });
      await writeAudit({
        req,
        module: 'insurance_forms',
        action: params.id ? 'insurance_form.update' : 'insurance_form.create',
        summary: `استمارة ${form.formTypeLabel} — ${form.employeeName}`,
        route: '/insurance-forms/save',
        entityId: form.id,
        entityLabel: `${form.formTypeLabel} / ${form.employeeName}`,
      });
      jsonRpcSuccess(res, biotimeOk({ form }), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Save failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

router.post(
  '/insurance-forms/pdf',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    try {
      const id = String(p(req).id ?? '');
      const file = await generateInsuranceFormPdfBase64(id);
      await writeAudit({
        req,
        module: 'insurance_forms',
        action: 'insurance_form.pdf',
        summary: `تنزيل PDF ${file.formTypeLabel} — ${file.employeeName}`,
        route: '/insurance-forms/pdf',
        entityId: file.id,
        entityLabel: `${file.formTypeLabel} / ${file.employeeName}`,
      });
      jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'PDF failed';
      const code = e instanceof AppError ? e.errorCode : 'ACTION_ERROR';
      jsonRpcSuccess(res, biotimeFail(message, code), req.rpcId);
    }
  }),
);

export default router;
