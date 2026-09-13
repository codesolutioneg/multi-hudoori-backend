/**
 * Provision / sync app login for branch employees from workEmail + workEmailPassword.
 * Role is always EMPLOYEE; credentials match the HR-visible email fields.
 *
 * Multi-tenant: User unique is (companyId, login) — never findUnique by login alone.
 */
import { UserRole } from '@prisma/client';
import { prisma } from '../prisma/client';
import { hashPassword } from './auth.service';
import { normalizeLoginInput } from '../utils/loginValidation';
import { getCompanyId } from '../tenant/context';

export type SyncEmployeeLoginResult = {
  action: 'created' | 'updated' | 'linked' | 'deactivated' | 'skipped';
  reason?: string;
  userId?: string;
};

function loginFromWorkEmail(workEmail: string): string {
  return normalizeLoginInput(workEmail);
}

/**
 * Ensure the employee can log in with workEmail / workEmailPassword (EMPLOYEE role).
 * Does not alter non-EMPLOYEE users (HR/admin) even if emails collide.
 */
export async function syncEmployeeLoginFromWorkEmail(
  employeeId: string,
): Promise<SyncEmployeeLoginResult> {
  const emp = await prisma.employeeProfile.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      companyId: true,
      name: true,
      displayName: true,
      workEmail: true,
      workEmailPassword: true,
      userId: true,
      locationId: true,
      active: true,
    },
  });
  if (!emp) return { action: 'skipped', reason: 'employee_not_found' };

  const companyId = emp.companyId || getCompanyId();
  if (!companyId) {
    return { action: 'skipped', reason: 'no_company' };
  }

  const email = String(emp.workEmail ?? '').trim();
  const password = String(emp.workEmailPassword ?? '').trim();
  const displayName = (emp.displayName?.trim() || emp.name.trim() || email).slice(0, 120);

  if (!email || !password) {
    if (emp.userId) {
      const linked = await prisma.user.findUnique({ where: { id: emp.userId } });
      if (linked?.role === UserRole.EMPLOYEE && linked.active) {
        await prisma.user.update({
          where: { id: linked.id },
          data: { active: false },
        });
        return { action: 'deactivated', userId: linked.id, reason: 'missing_email_or_password' };
      }
    }
    return { action: 'skipped', reason: 'missing_email_or_password' };
  }

  const login = loginFromWorkEmail(email);
  if (!login.includes('@')) {
    return { action: 'skipped', reason: 'invalid_email' };
  }

  const passwordHash = await hashPassword(password);
  const active = emp.active !== false;

  if (emp.userId) {
    const linked = await prisma.user.findUnique({ where: { id: emp.userId } });
    if (!linked) {
      await prisma.employeeProfile.update({
        where: { id: emp.id },
        data: { userId: null },
      });
    } else if (linked.role !== UserRole.EMPLOYEE) {
      return {
        action: 'skipped',
        userId: linked.id,
        reason: 'linked_non_employee_user',
      };
    } else {
      const conflict = await prisma.user.findFirst({
        where: {
          companyId,
          login,
          NOT: { id: linked.id },
        },
        select: { id: true },
      });
      if (conflict) {
        return {
          action: 'skipped',
          userId: linked.id,
          reason: 'login_taken',
        };
      }

      await prisma.user.update({
        where: { id: linked.id },
        data: {
          companyId,
          login,
          email: login,
          name: displayName,
          passwordHash,
          initialPassword: password,
          locationId: emp.locationId ?? null,
          active,
        },
      });
      return { action: 'updated', userId: linked.id };
    }
  }

  const byLogin = await prisma.user.findFirst({
    where: { companyId, login },
    include: { employeeProfile: { select: { id: true } } },
  });

  if (byLogin) {
    if (byLogin.role !== UserRole.EMPLOYEE) {
      return { action: 'skipped', userId: byLogin.id, reason: 'login_belongs_to_staff' };
    }
    if (byLogin.employeeProfile && byLogin.employeeProfile.id !== emp.id) {
      return { action: 'skipped', userId: byLogin.id, reason: 'login_linked_other_employee' };
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: byLogin.id },
        data: {
          companyId,
          email: login,
          name: displayName,
          passwordHash,
          initialPassword: password,
          locationId: emp.locationId ?? null,
          active,
        },
      }),
      prisma.employeeProfile.update({
        where: { id: emp.id },
        data: { userId: byLogin.id },
      }),
    ]);
    return { action: 'linked', userId: byLogin.id };
  }

  const user = await prisma.user.create({
    data: {
      companyId,
      login,
      email: login,
      name: displayName,
      passwordHash,
      initialPassword: password,
      role: UserRole.EMPLOYEE,
      locationId: emp.locationId ?? null,
      active,
      employeeProfile: { connect: { id: emp.id } },
    },
  });
  return { action: 'created', userId: user.id };
}
