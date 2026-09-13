import type { CustodyType, EmployeeCustody } from '@prisma/client';

export function custodyTypeJson(row: CustodyType) {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? '',
    active: row.active,
    sequence: row.sequence,
  };
}

export function employeeCustodyJson(row: EmployeeCustody & { custodyType?: CustodyType }) {
  return {
    id: row.id,
    custodyTypeId: row.custodyTypeId,
    name: row.custodyType?.name ?? '',
    code: row.custodyType?.code ?? '',
    provided: row.provided,
  };
}
