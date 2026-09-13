import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { jsonRpcSuccess, biotimeOk, biotimeFail } from '../../middlewares/jsonRpc';
import { requireAuth, requireHrManager } from '../../middlewares/auth';
import { p } from './route-helpers';
import { prisma } from '../../prisma/client';
import { writeAudit } from '../../services/auditLog.service';
import {
  resolveOrgChartForUser,
  wouldCreateManagerCycle,
} from '../../services/orgChart.service';

const router = Router();

// The chart exposes the whole reporting line of the company, so it is limited to
// HR managers (and the platform admin). Employees and branch managers used to see
// a scoped slice of it; that access was withdrawn deliberately.
router.post(
  '/org-chart/tree',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { employeeProfile: { select: { id: true } } },
    });

    if (!user) {
      if (req.user?.role === UserRole.PLATFORM_ADMIN) {
        const tree = await resolveOrgChartForUser({
          userId: req.user.id,
          role: UserRole.PLATFORM_ADMIN,
          employeeProfileId: null,
          requestedScope: params.scope ? String(params.scope) : 'company',
          requestedLocationId: params.locationId
            ? String(params.locationId)
            : null,
        });
        jsonRpcSuccess(res, biotimeOk(tree), req.rpcId);
        return;
      }
      jsonRpcSuccess(res, biotimeFail('User not found', 'NOT_FOUND'), req.rpcId);
      return;
    }

    const requestedScope = params.scope ? String(params.scope) : null;
    const requestedLocationId = params.locationId
      ? String(params.locationId)
      : null;

    if (
      requestedScope === 'location' &&
      !requestedLocationId &&
      (user.role === UserRole.PLATFORM_ADMIN ||
        user.role === UserRole.HR_MANAGER ||
        user.role === UserRole.HR_SUPERVISOR)
    ) {
      jsonRpcSuccess(
        res,
        biotimeFail('locationId مطلوب عند اختيار نطاق الموقع', 'VALIDATION'),
        req.rpcId,
      );
      return;
    }

    const tree = await resolveOrgChartForUser({
      userId: user.id,
      role: user.role,
      employeeProfileId: user.employeeProfile?.id ?? null,
      requestedScope,
      requestedLocationId,
    });

    jsonRpcSuccess(res, biotimeOk(tree), req.rpcId);
  }),
);

/**
 * Candidate managers for the «نقل» picker: active colleagues **at the same site**,
 * optionally filtered by name/code/title. Reporting lines are derived per site, so a
 * cross-site manager would simply be ignored whenever that branch is viewed alone —
 * offering one would be a move that silently does nothing.
 *
 * The employee themselves and anyone below them are dropped here too, so the picker
 * can only ever offer a choice that passes the cycle check on save.
 */
router.post(
  '/org-chart/manager-options',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const employeeId = String(params.employeeId ?? '');
    const search = String(params.search ?? '').trim();

    const employee = employeeId
      ? await prisma.employeeProfile.findUnique({
          where: { id: employeeId },
          select: { id: true, locationId: true },
        })
      : null;
    if (employeeId && !employee) {
      jsonRpcSuccess(res, biotimeFail('الموظف غير موجود', 'NOT_FOUND'), req.rpcId);
      return;
    }

    const candidates = await prisma.employeeProfile.findMany({
      where: {
        active: true,
        ...(employee ? { locationId: employee.locationId } : {}),
        ...(employeeId ? { id: { not: employeeId } } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
                { jobTitle: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        code: true,
        jobTitle: true,
        locationId: true,
        workLocation: { select: { name: true } },
      },
      orderBy: [{ name: 'asc' }],
      take: 60,
    });

    const allowed = [];
    for (const c of candidates) {
      if (employeeId && (await wouldCreateManagerCycle(employeeId, c.id))) continue;
      allowed.push({
        id: c.id,
        name: c.name,
        code: c.code ?? '',
        jobTitle: c.jobTitle ?? '',
        locationId: c.locationId,
        locationName: c.workLocation?.name ?? '',
      });
    }

    jsonRpcSuccess(
      res,
      biotimeOk({ managers: allowed, count: allowed.length }),
      req.rpcId,
    );
  }),
);

/** Move an employee under another manager (or detach them with managerId = null). */
router.post(
  '/org-chart/set-manager',
  requireAuth,
  requireHrManager,
  asyncHandler(async (req, res) => {
    const params = p(req);
    const employeeId = String(params.employeeId ?? '');
    const raw = params.managerId;
    const managerId =
      raw === null || raw === false || raw === '' || String(raw ?? '') === 'false'
        ? null
        : String(raw).trim();

    const employee = await prisma.employeeProfile.findUnique({
      where: { id: employeeId },
      select: { id: true, name: true, managerId: true, locationId: true },
    });
    if (!employee) {
      jsonRpcSuccess(res, biotimeFail('الموظف غير موجود', 'NOT_FOUND'), req.rpcId);
      return;
    }

    if (managerId) {
      if (managerId === employeeId) {
        jsonRpcSuccess(
          res,
          biotimeFail('لا يمكن تعيين الموظف مديرًا لنفسه', 'VALIDATION'),
          req.rpcId,
        );
        return;
      }
      const manager = await prisma.employeeProfile.findUnique({
        where: { id: managerId },
        select: { id: true, name: true, active: true, locationId: true },
      });
      if (!manager || !manager.active) {
        jsonRpcSuccess(
          res,
          biotimeFail('المدير المباشر غير موجود أو غير نشط', 'NOT_FOUND'),
          req.rpcId,
        );
        return;
      }
      // Enforced here and not only in the picker — the chart derives per site, so a
      // cross-site link would be dropped the moment that branch is viewed alone.
      if (manager.locationId !== employee.locationId) {
        jsonRpcSuccess(
          res,
          biotimeFail('النقل مسموح داخل نفس الفرع فقط', 'VALIDATION'),
          req.rpcId,
        );
        return;
      }
      if (await wouldCreateManagerCycle(employeeId, managerId)) {
        jsonRpcSuccess(
          res,
          biotimeFail('تعيين هذا المدير ينشئ حلقة في الهيكل', 'VALIDATION'),
          req.rpcId,
        );
        return;
      }
    }

    await prisma.employeeProfile.update({
      where: { id: employeeId },
      data: { managerId },
    });

    await writeAudit({
      req,
      module: 'employees',
      action: 'org_chart.set_manager',
      entityType: 'EmployeeProfile',
      entityId: employeeId,
      summary: managerId
        ? `نقل ${employee.name} في الهيكل التنظيمي`
        : `فصل ${employee.name} عن مديره في الهيكل التنظيمي`,
      payload: { from: employee.managerId, to: managerId },
      route: '/org-chart/set-manager',
    });

    jsonRpcSuccess(res, biotimeOk({ employeeId, managerId }), req.rpcId);
  }),
);

export default router;
