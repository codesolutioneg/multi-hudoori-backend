/** Employee insurance share is 11% of total insurance wage (الأجر التأميني). */
export const EMPLOYEE_INSURANCE_SHARE_RATE = 0.11;

export function insuranceWageFromShare(share: number | null | undefined): number {
  const n = Number(share ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n / EMPLOYEE_INSURANCE_SHARE_RATE) * 100) / 100;
}
