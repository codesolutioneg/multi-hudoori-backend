import { describe, expect, it } from 'vitest';
import {
  computePushFingerprint,
  diffPushSnapshots,
  evaluateBioTimePush,
  snapshotDiffToUpdatePayload,
  snapshotFromEmployee,
  snapshotFromMapping,
  type EmployeePushRow,
} from '../../src/services/biotime/employeeBiotimeFingerprint';

function row(partial: Partial<EmployeePushRow>): EmployeePushRow {
  return {
    id: 'emp-1',
    userId: null,
    name: 'Ahmed Ali',
    displayName: 'Ahmed Ali',
    code: 'E001',
    identificationId: 'E001',
    barcode: 'E001',
    departmentId: 'dept-1',
    jobTitle: 'Engineer',
    location: null,
    locationId: null,
    workPhone: '0100',
    mobilePhone: null,
    workEmail: 'ahmed@co.com',
    gender: 'male',
    basicSalary: 0,
    hiringDate: null,
    nationalIdConfirm: null,
    birthday: null,
    hasHealthCertificate: false,
    healthCertificateIssueDate: null,
    healthCertificateExpiryDate: null,
    hasMilitaryCertificate: false,
    hasCriminalRecord: false,
    skillLevel: null,
    insuranceStatus: null,
    insuranceSalary: 0,
    medicalInsuranceStatus: null,
    medicalInsuranceSalary: 0,
    hasFawryAccount: false,
    fawryAccount: null,
    hasBankAccount: false,
    bankAccount: null,
    hasWalletAccount: false,
    walletAccount: null,
    annualLeaveBalance: 0,
    casualLeaveBalance: 0,
    biotimeSynced: true,
    biotimeDeviceId: null,
    active: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
    mapping: {
      id: 'map-1',
      biotimeEmpId: 42,
      biotimeEmpCode: 'E001',
      employeeId: 'emp-1',
      firstName: 'Ahmed',
      lastName: 'Ali',
      cardNo: null,
      mobile: '0100',
      email: 'ahmed@co.com',
      hireDate: null,
      gender: 'M',
      biotimeDepartmentId: 5,
      biotimePositionId: null,
      lastSync: new Date('2025-06-01'),
      pushContentHash: null,
    },
    department: {
      id: 'dept-1',
      name: 'IT',
      code: 'IT',
      active: true,
      biotimeDeptId: 5,
      biotimeDeptCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    ...partial,
  } as EmployeePushRow;
}

describe('employeeBiotimeFingerprint', () => {
  it('skips push when hash matches stored pushContentHash', () => {
    const employee = row({});
    const hash = computePushFingerprint(snapshotFromEmployee(employee));
    employee.mapping!.pushContentHash = hash;

    const decision = evaluateBioTimePush(employee);
    expect(decision.needed).toBe(false);
    expect(decision.reason).toBe('unchanged');
  });

  it('detects delta when only mobile changes', () => {
    const employee = row({ workPhone: '0199', biotimeSynced: false });
    const baseline = snapshotFromMapping(employee);
    const current = snapshotFromEmployee(employee);
    const diff = diffPushSnapshots(current, baseline);

    expect(diff.mobile).toBe('0199');
    const payload = snapshotDiffToUpdatePayload(diff, current);
    expect(payload).toEqual({ mobile: '0199' });
    expect(payload).not.toHaveProperty('first_name');
  });

  it('does not include payroll-only fields in fingerprint', () => {
    const employee = row({ basicSalary: 99999, insuranceSalary: 88888 });
    const withSalary = computePushFingerprint(snapshotFromEmployee(employee));

    const employee2 = row({ basicSalary: 1, insuranceSalary: 2 });
    const otherSalary = computePushFingerprint(snapshotFromEmployee(employee2));

    expect(withSalary).toBe(otherSalary);
  });

  it('flags create when no biotime id but has code', () => {
    const employee = row({
      mapping: null,
      biotimeSynced: false,
    });

    const decision = evaluateBioTimePush(employee);
    expect(decision.needed).toBe(true);
    expect(decision.create).toBe(true);
  });
});
