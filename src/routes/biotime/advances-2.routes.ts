import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler";
import {
  jsonRpcSuccess,
  biotimeOk,
  biotimeFail,
} from "../../middlewares/jsonRpc";
import { requireAuth, requireHr } from "../../middlewares/auth";
import { p, parseRpcBool } from "./route-helpers";
import * as advanceLoanImportService from "../../services/advanceLoanImport.service";
import * as advancesExcelService from "../../services/advancesExcel.service";
import { NotFoundError, AppError } from "../../utils/errors";
import {
  exportPayrollXlsx,
  exportCashFawryXlsx,
  exportFileResponse,
} from "../../services/payrollExport.service";
import { writeAudit } from "../../services/auditLog.service";
import { prisma } from "../../prisma/client";
import { sendLoanImportNotifications } from "../../services/loanImportNotification.service";
import * as odooLoanAccounts from "../../services/odoo/odooLoanAccounts.service";

const router = Router();

function optionalIsoDate(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

router.post(
  "/advances/loan-import/get",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const id = String(p(req).importId ?? p(req).id ?? "");
    const batch = await advanceLoanImportService.getAdvanceLoanImport(id);
    jsonRpcSuccess(res, biotimeOk({ import: batch }), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/delete-draft",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    const result =
      await advanceLoanImportService.deleteAdvanceLoanImportDraft(importId);
    await writeAudit({
      req,
      module: "advances",
      action: "advances.loan_import.delete_draft",
      entityType: "AdvanceLoanImport",
      entityId: importId,
      summary: `حذف مسودة استيراد سلف: ${importId}`,
      route: "/advances/loan-import/delete-draft",
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/apply-eligibility",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const importId = String(params.importId ?? params.id ?? "");
    const eligibilityFile = String(
      params.eligibilityFile ?? params.file ?? params.base64 ?? "",
    );
    if (!eligibilityFile.trim()) {
      throw new AppError("ارفع شيت الاستحقاق", 400, "VALIDATION_ERROR");
    }
    const batch = await advanceLoanImportService.applyEligibilitySheetToImport(
      importId,
      eligibilityFile,
    );
    jsonRpcSuccess(res, biotimeOk({ import: batch }), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/preview",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const importId = String(params.importId ?? "");
    const loanFile = String(
      params.loanFile ?? params.file ?? params.base64 ?? "",
    );
    if (!loanFile.trim())
      throw new AppError("ارفع ملف السلف", 400, "VALIDATION_ERROR");
    const batch = await advanceLoanImportService.previewAdvanceLoanImport({
      importId,
      loanFileBase64: loanFile,
      eligibilityFileBase64: params.eligibilityFile
        ? String(params.eligibilityFile)
        : params.eligibilityBase64
          ? String(params.eligibilityBase64)
          : undefined,
      dateFrom: optionalIsoDate(params.dateFrom),
      dateTo: optionalIsoDate(params.dateTo),
    });
    jsonRpcSuccess(res, biotimeOk({ import: batch }), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/merge-loan",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const importId = String(params.importId ?? params.id ?? "");
    const loanFile = String(
      params.loanFile ?? params.file ?? params.base64 ?? "",
    );
    if (!importId.trim())
      throw new AppError("معرّف الاستيراد مطلوب", 400, "VALIDATION_ERROR");
    if (!loanFile.trim())
      throw new AppError("ارفع ملف السلف", 400, "VALIDATION_ERROR");
    const result =
      await advanceLoanImportService.mergeAdvanceLoanImportFromLoanFile({
        importId,
        loanFileBase64: loanFile,
        dateFrom: optionalIsoDate(params.dateFrom),
        dateTo: optionalIsoDate(params.dateTo),
      });
    await writeAudit({
      req,
      module: "advances",
      action: "advances.loan_import.merge_loan",
      entityType: "AdvanceLoanImport",
      entityId: importId,
      summary: `إعادة دمج شيت السلف: ${result.reference ?? importId}`,
      counts: { updated: result.merge.updated, created: result.merge.added },
      route: "/advances/loan-import/merge-loan",
    });
    jsonRpcSuccess(
      res,
      biotimeOk({ import: result, merge: result.merge }),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/loan-import/lines/update",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const lineId = String(params.lineId ?? params.id ?? "");
    const line = await advanceLoanImportService.updateAdvanceLoanImportLine(
      lineId,
      {
        approvedAmount:
          params.approvedAmount != null
            ? Number(params.approvedAmount)
            : undefined,
        toApprove:
          params.toApprove != null ? Boolean(params.toApprove) : undefined,
        rowReason:
          params.rowReason != null ? String(params.rowReason) : undefined,
        employeeId: params.employeeId ? String(params.employeeId) : undefined,
      },
    );
    jsonRpcSuccess(res, biotimeOk({ line }), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/lines/add-manual",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const line = await advanceLoanImportService.addManualLoanImportLine({
      importId: String(params.importId ?? ""),
      employeeId: String(params.employeeId ?? ""),
      requestedAmount: Number(params.requestedAmount ?? params.amount ?? 0),
      approvedAmount:
        params.approvedAmount != null
          ? Number(params.approvedAmount)
          : undefined,
      rowReason: params.rowReason ? String(params.rowReason) : undefined,
      dateFrom: optionalIsoDate(params.dateFrom),
      dateTo: optionalIsoDate(params.dateTo),
    });
    jsonRpcSuccess(res, biotimeOk({ line }), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/approve",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    const result =
      await advanceLoanImportService.approveAdvanceLoanImport(importId);
    await writeAudit({
      req,
      module: "advances",
      action: "advances.loan_import.approve",
      entityType: "AdvanceLoanImport",
      entityId: importId,
      summary: `اعتماد استيراد سلف: ${importId}`,
      counts: { created: result.created },
      route: "/advances/loan-import/approve",
    });
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/send-to-odoo-accounts",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    if (!importId)
      throw new AppError("معرّف الاستيراد مطلوب", 400, "VALIDATION_ERROR");
    const result =
      await odooLoanAccounts.sendLoanImportToOdooAccounts(importId);
    let email;
    try {
      email = await sendLoanImportNotifications(importId);
    } catch (error) {
      email = {
        sent: false,
        sentBranches: 0,
        sentRecipients: [],
        failures: [
          {
            branchName: "غير محدد",
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    const response = { ...result, email };
    await writeAudit({
      req,
      module: "advances",
      action: "advances.loan_import.send_odoo_accounts",
      entityType: "AdvanceLoanImport",
      entityId: importId,
      summary: `إرسال السلف للحسابات في Odoo: ${result.name}`,
      payload: response as unknown as Record<string, unknown>,
      route: "/advances/loan-import/send-to-odoo-accounts",
    });
    jsonRpcSuccess(res, biotimeOk(response), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/resend-notification-email",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    if (!importId)
      throw new AppError("معرّف الاستيراد مطلوب", 400, "VALIDATION_ERROR");
    const email = await sendLoanImportNotifications(importId);
    await writeAudit({
      req,
      module: "advances",
      action: "advances.loan_import.resend_notification_email",
      entityType: "AdvanceLoanImport",
      entityId: importId,
      summary: `إعادة إرسال إشعار السلف بالبريد: ${email.sent ? "نجح" : "فشل"}`,
      payload: email as unknown as Record<string, unknown>,
      route: "/advances/loan-import/resend-notification-email",
    });
    jsonRpcSuccess(res, biotimeOk({ email }), req.rpcId);
  }),
);

router.post(
  "/advances/loan-import/export-review",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    const base64 =
      await advanceLoanImportService.exportAdvanceLoanImportReview(importId);
    jsonRpcSuccess(
      res,
      biotimeOk(
        exportFileResponse(base64, `loan_import_review_${importId}.xlsx`),
      ),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/loan-import/export-accounts-sheet",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    const result = await odooLoanAccounts.exportLoanAccountsSheet(importId);
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...exportFileResponse(result.base64, result.filename),
        cashAmount: result.cashAmount,
        fawryAmount: result.fawryAmount,
        cashRows: result.cashRows,
        fawryRows: result.fawryRows,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/loan-import/export-accounts-period",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const dateFrom = String(p(req).dateFrom ?? "");
    const dateTo = String(p(req).dateTo ?? "");
    if (!dateFrom || !dateTo) {
      throw new AppError("dateFrom و dateTo مطلوبان", 400, "VALIDATION");
    }
    const result = await odooLoanAccounts.exportLoanAccountsSheetsForPeriod(
      new Date(`${dateFrom.slice(0, 10)}T00:00:00.000Z`),
      new Date(`${dateTo.slice(0, 10)}T00:00:00.000Z`),
    );
    jsonRpcSuccess(
      res,
      biotimeOk({
        ...exportFileResponse(result.base64, result.filename),
        mimeType: result.mimeType,
        fileCount: result.fileCount,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/loan-import/eligibility-from-loan",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const loanFile = String(
      params.loanFile ?? params.file ?? params.base64 ?? "",
    );
    if (!loanFile.trim())
      throw new AppError("ارفع ملف السلف أولاً", 400, "VALIDATION_ERROR");
    const { base64, filename, count } =
      await advanceLoanImportService.exportEligibilitySheetFromLoanFile(
        loanFile,
        {
          sourceGridId: params.sourceGridId
            ? String(params.sourceGridId)
            : null,
        },
      );
    jsonRpcSuccess(
      res,
      biotimeOk({ ...exportFileResponse(base64, filename), count }),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/loan-import/export-eligibility",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const importId = String(p(req).importId ?? p(req).id ?? "");
    const { base64, filename, count } =
      await advanceLoanImportService.exportEligibilitySheetFromImport(importId);
    jsonRpcSuccess(
      res,
      biotimeOk({ ...exportFileResponse(base64, filename), count }),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/export/import-template",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const isTips = String(params.kind ?? "").trim().toLowerCase() === "tip";
    const dateFrom = optionalIsoDate(params.dateFrom);
    const dateTo = optionalIsoDate(params.dateTo);
    if (isTips && (!dateFrom || !dateTo)) {
      throw new AppError(
        "حدد فترة أيام العمل من وإلى قبل تنزيل القالب",
        400,
        "VALIDATION_ERROR",
      );
    }
    const blank =
      parseRpcBool(params.blank) ||
      String(params.template ?? "").trim().toLowerCase() === "multiple";
    if (blank) {
      const result = await advancesExcelService.exportAdvancesImportTemplateXlsx({
        blank: true,
        kind: isTips ? "tip" : "loan",
        filenamePrefix: isTips ? "tips_import" : undefined,
        dateFrom,
        dateTo,
      });
      if (!result) {
        throw new AppError("تعذر إنشاء القالب الفارغ", 400, "VALIDATION_ERROR");
      }
      jsonRpcSuccess(
        res,
        biotimeOk({
          file: result.base64,
          base64: result.base64,
          filename: result.filename,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          count: result.count,
          fileCount: 1,
          skipped: [],
        }),
        req.rpcId,
      );
      return;
    }
    const fromArray = Array.isArray(params.locationIds)
      ? params.locationIds
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const single = params.locationId ? String(params.locationId).trim() : "";
    const locationIds = fromArray.length ? fromArray : single ? [single] : [];
    if (!locationIds.length) {
      throw new AppError("اختر فرع واحد على الأقل", 400, "VALIDATION_ERROR");
    }
    let jobTitleNames: string[] | undefined;
    if (isTips) {
      const config = await prisma.bioTimeConfig.findFirst({
        select: { tipJobTitleIds: true },
      });
      const ids = config?.tipJobTitleIds ?? [];
      if (!ids.length) {
        throw new AppError(
          "اختَر الوظائف المسموح لها بالـ tips من الإعدادات أولاً",
          400,
          "VALIDATION_ERROR",
        );
      }
      const titles = await prisma.jobTitle.findMany({
        where: { id: { in: ids }, active: true },
        select: { name: true },
      });
      jobTitleNames = titles.map((t) => t.name).filter(Boolean);
      if (!jobTitleNames.length) {
        throw new AppError(
          "لا توجد مسميات وظيفية مطابقة لإعدادات tips",
          400,
          "VALIDATION_ERROR",
        );
      }
    }
    const result =
      await advancesExcelService.exportAdvancesImportTemplatesForLocations(
        locationIds,
        isTips
          ? {
              jobTitleNames,
              filenamePrefix: "tips_import",
              kind: "tip",
              dateFrom,
              dateTo,
            }
          : undefined,
      );
    jsonRpcSuccess(
      res,
      biotimeOk({
        file: result.base64,
        base64: result.base64,
        filename: result.filename,
        mimeType: result.mimeType,
        count: result.count,
        fileCount: result.fileCount,
        skipped: result.skipped,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/export/eligibility-template",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const { base64, filename } =
      await advancesExcelService.exportAdvancesEligibilityTemplateXlsx();
    jsonRpcSuccess(
      res,
      biotimeOk(exportFileResponse(base64, filename)),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/export/short",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const { base64, filename } =
      await advancesExcelService.exportShortAdvancesXlsx();
    jsonRpcSuccess(
      res,
      biotimeOk(exportFileResponse(base64, filename)),
      req.rpcId,
    );
  }),
);

router.post(
  "/advances/export/long",
  requireAuth,
  requireHr,
  asyncHandler(async (req, res) => {
    const { base64, filename } =
      await advancesExcelService.exportLongAdvancesXlsx();
    jsonRpcSuccess(
      res,
      biotimeOk(exportFileResponse(base64, filename)),
      req.rpcId,
    );
  }),
);

// --- Portal requests (leave / loan / shift change) ---

export default router;
