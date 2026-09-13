import { Router } from "express";
import { asyncHandler } from "../../middlewares/asyncHandler";
import {
  jsonRpcSuccess,
  biotimeOk,
  biotimeFail,
} from "../../middlewares/jsonRpc";
import {
  requireAuth,
  requireHrManager,
  requireHrOrBranchManager,
} from "../../middlewares/auth";
import { p } from "./route-helpers";
import {
  applyEmployeeLocation,
  employeesForLocation,
  resolveLocation,
  relocateEmployeesToGridLocation,
} from "../../services/location.service";
import {
  assertGridLocationAccess,
  getHrLocationScope,
  applyHrLocationScopeToEmployeeWhere,
  getHrLocationScopeFromReq,
  assertEmployeeLocationAccess,
} from "../../services/userLocationScope.service";
import {
  employeeJson,
  employeeListJson,
  configSettingsWithCounts,
  configSummaryJson,
  shiftJson,
  shiftAssignmentJson,
  deviceJson,
  departmentJson,
  attendanceJson,
  shiftGridJson,
  shiftGridLineJson,
  payrollJson,
  payrollLineJson,
  deductionJson,
  advanceShortJson,
  advanceLongJson,
  locationJson,
  insuranceCompanyJson,
  DEDUCTION_TYPES,
} from "../../services/serialize.service";
import {
  exportLocationsXlsx,
  importLocationsXlsx,
} from "../../services/locationsExcel.service";
import {
  generateDepartmentCode,
  generateInsuranceCompanyCode,
  generateLocationCode,
  generateCustodyTypeCode,
} from "../../services/settingsCode.service";
import { prisma } from "../../prisma/client";
import {
  parseLocationPunchFields,
  assertLocationPunchReady,
} from "../../services/locationPunchSettings.service";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseLoanNotificationEmails(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;\n]+/);
  const emails = [
    ...new Set(
      values.map((value) => String(value).trim().toLowerCase()).filter(Boolean),
    ),
  ];
  const invalid = emails.find((email) => !EMAIL_RE.test(email));
  if (invalid) {
    throw new Error(`INVALID_EMAIL:${invalid}`);
  }
  return emails;
}

router.post(
  "/locations/list",
  requireAuth,
  requireHrOrBranchManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const activeOnly =
      params.activeOnly !== false && params.activeOnly !== "false";
    const locationScope = await getHrLocationScopeFromReq(req);
    const locations = await prisma.location.findMany({
      where: {
        ...(activeOnly ? { active: true } : {}),
        ...(locationScope ? { id: locationScope } : {}),
      },
      orderBy: [{ sequence: "asc" }, { name: "asc" }],
    });
    jsonRpcSuccess(
      res,
      biotimeOk({
        locations: locations.map(locationJson),
        count: locations.length,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  "/locations/create",
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const name = String(params.name ?? "").trim();
    if (!name) {
      jsonRpcSuccess(
        res,
        biotimeFail("اسم الموقع مطلوب", "VALIDATION"),
        req.rpcId,
      );
      return;
    }
    let code = params.code ? String(params.code).trim() : "";
    if (!code) code = await generateLocationCode();
    const dup = await prisma.location.findFirst({ where: { code } });
    if (dup) {
      jsonRpcSuccess(
        res,
        biotimeFail(`كود "${code}" موجود`, "DUPLICATE"),
        req.rpcId,
      );
      return;
    }
    const actualName = params.actualName != null
      ? String(params.actualName).trim() || null
      : null;
    const { patch: punchPatch, error: punchErr } = parseLocationPunchFields(params);
    if (punchErr) {
      jsonRpcSuccess(res, biotimeFail(punchErr, "VALIDATION"), req.rpcId);
      return;
    }
    const enabled = punchPatch.locationPunchEnabled === true;
    const readyErr = assertLocationPunchReady({
      enabled,
      latitude: punchPatch.latitude ?? null,
      longitude: punchPatch.longitude ?? null,
      radius: punchPatch.geofenceRadiusMeters ?? 200,
    });
    if (readyErr) {
      jsonRpcSuccess(res, biotimeFail(readyErr, "VALIDATION"), req.rpcId);
      return;
    }
    const loc = await prisma.location.create({
      data: {
        name,
        actualName,
        code,
        active: params.active !== false && params.active !== "false",
        sequence: Number(params.sequence ?? 10),
        locationPunchEnabled: punchPatch.locationPunchEnabled ?? false,
        latitude: punchPatch.latitude ?? null,
        longitude: punchPatch.longitude ?? null,
        geofenceRadiusMeters: punchPatch.geofenceRadiusMeters ?? 200,
      },
    });
    jsonRpcSuccess(res, biotimeOk({ location: locationJson(loc) }), req.rpcId);
  }),
);

router.post(
  "/locations/update",
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const id = String(params.id ?? params.locationId ?? "");
    let loanNotificationEmails: string[] | undefined;
    try {
      loanNotificationEmails = parseLoanNotificationEmails(
        params.loanNotificationEmails,
      );
    } catch (error) {
      const invalid = String(error).replace(/^Error: INVALID_EMAIL:/, "");
      jsonRpcSuccess(
        res,
        biotimeFail(`البريد الإلكتروني غير صحيح: ${invalid}`, "VALIDATION"),
        req.rpcId,
      );
      return;
    }
    if (params.code != null) {
      const code = String(params.code).trim();
      const dup = await prisma.location.findFirst({
        where: { code, NOT: { id } },
      });
      if (dup) {
        jsonRpcSuccess(
          res,
          biotimeFail(`كود "${code}" موجود`, "DUPLICATE"),
          req.rpcId,
        );
        return;
      }
    }
    const { patch: punchPatch, error: punchErr } = parseLocationPunchFields(params);
    if (punchErr) {
      jsonRpcSuccess(res, biotimeFail(punchErr, "VALIDATION"), req.rpcId);
      return;
    }

    const existing = await prisma.location.findUnique({ where: { id } });
    if (!existing) {
      jsonRpcSuccess(res, biotimeFail("الموقع غير موجود", "NOT_FOUND"), req.rpcId);
      return;
    }

    const nextEnabled =
      punchPatch.locationPunchEnabled !== undefined
        ? punchPatch.locationPunchEnabled
        : existing.locationPunchEnabled;
    const nextLat =
      punchPatch.latitude !== undefined ? punchPatch.latitude : existing.latitude;
    const nextLng =
      punchPatch.longitude !== undefined ? punchPatch.longitude : existing.longitude;
    const nextRadius =
      punchPatch.geofenceRadiusMeters !== undefined
        ? punchPatch.geofenceRadiusMeters
        : existing.geofenceRadiusMeters;

    const readyErr = assertLocationPunchReady({
      enabled: nextEnabled,
      latitude: nextLat,
      longitude: nextLng,
      radius: nextRadius,
    });
    if (readyErr) {
      jsonRpcSuccess(res, biotimeFail(readyErr, "VALIDATION"), req.rpcId);
      return;
    }

    const loc = await prisma.location.update({
      where: { id },
      data: {
        name: params.name != null ? String(params.name).trim() : undefined,
        actualName:
          params.actualName !== undefined
            ? String(params.actualName).trim() || null
            : undefined,
        code:
          params.code !== undefined
            ? params.code
              ? String(params.code).trim()
              : null
            : undefined,
        active:
          params.active !== undefined
            ? params.active === true || params.active === "true"
            : undefined,
        sequence: params.sequence != null ? Number(params.sequence) : undefined,
        loanNotificationEmails,
        locationPunchEnabled: punchPatch.locationPunchEnabled,
        latitude: punchPatch.latitude,
        longitude: punchPatch.longitude,
        geofenceRadiusMeters: punchPatch.geofenceRadiusMeters,
      },
    });
    if (params.name != null) {
      await prisma.employeeProfile.updateMany({
        where: { locationId: id },
        data: { location: loc.name },
      });
    }
    jsonRpcSuccess(res, biotimeOk({ location: locationJson(loc) }), req.rpcId);
  }),
);

router.post(
  "/locations/delete",
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const id = String(p(req).id ?? p(req).locationId ?? "");
    const inUse = await prisma.employeeProfile.count({
      where: { locationId: id },
    });
    if (inUse > 0) {
      jsonRpcSuccess(
        res,
        biotimeFail(`الموقع مستخدم من ${inUse} موظف`, "IN_USE"),
        req.rpcId,
      );
      return;
    }
    await prisma.location.delete({ where: { id } });
    jsonRpcSuccess(res, biotimeOk({ message: "Deleted" }), req.rpcId);
  }),
);

router.post(
  "/locations/employees",
  requireAuth,
  requireHrOrBranchManager,
  asyncHandler(async (req, res) => {
    const locationId = String(p(req).locationId ?? "");
    const scope = await getHrLocationScopeFromReq(req);
    if (scope && locationId !== scope) {
      jsonRpcSuccess(
        res,
        biotimeFail("Access denied", "ACCESS_DENIED"),
        req.rpcId,
      );
      return;
    }
    const employees = await employeesForLocation(locationId, true);
    jsonRpcSuccess(
      res,
      biotimeOk({
        employees: employees.map((e) => employeeListJson(e)),
        count: employees.length,
      }),
      req.rpcId,
    );
  }),
);

router.post(
  "/locations/export-xlsx",
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const file = await exportLocationsXlsx();
    jsonRpcSuccess(res, biotimeOk(file), req.rpcId);
  }),
);

router.post(
  "/locations/import-xlsx",
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const base64 = String(p(req).base64 ?? p(req).file ?? "");
    if (!base64) {
      jsonRpcSuccess(res, biotimeFail("ملف فارغ", "VALIDATION"), req.rpcId);
      return;
    }
    const result = await importLocationsXlsx(base64);
    jsonRpcSuccess(res, biotimeOk(result), req.rpcId);
  }),
);

// --- Insurance companies ---

export default router;
