import { prisma } from '../prisma/client';
import { addUtcDays, utcDateOnly, utcEndOfDay } from '../utils/payrollPeriod';
import { employeeListJson } from './serialize.service';

export async function countHealthCertificateAlerts(): Promise<number> {
  const cutoff = alertCutoffDate();
  return prisma.employeeProfile.count({
    where: {
      active: true,
      healthCertificate: true,
      healthCertificateExpiryDate: { not: null, lte: cutoff },
    },
  });
}

function alertCutoffDate(): Date {
  // Expiry is @db.Date (UTC midnight); compare against UTC calendar days.
  return utcEndOfDay(addUtcDays(utcDateOnly(new Date()), 15));
}

export async function listHealthCertificateAlerts() {
  const cutoff = alertCutoffDate();
  const today = utcDateOnly(new Date());

  const employees = await prisma.employeeProfile.findMany({
    where: {
      active: true,
      healthCertificate: true,
      healthCertificateExpiryDate: { not: null, lte: cutoff },
    },
    include: { department: true, mapping: true, workLocation: true },
    orderBy: { healthCertificateExpiryDate: 'asc' },
  });

  return employees.map((emp) => {
    const expiry = emp.healthCertificateExpiryDate!;
    const diffMs = utcDateOnly(expiry).getTime() - today.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return {
      ...employeeListJson(emp),
      healthCertificateIssueDate: emp.healthCertificateIssueDate?.toISOString().slice(0, 10) ?? '',
      healthCertificateExpiryDate: expiry.toISOString().slice(0, 10),
      daysRemaining,
      expired: daysRemaining <= 0,
      statusLabel: daysRemaining <= 0 ? 'منتهي' : `متبقي ${daysRemaining} يوم`,
    };
  });
}
