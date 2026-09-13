/**
 * Persist the exact payroll Excel files that were sent to Odoo, so later
 * re-downloads return byte-identical files even if employees are archived or
 * amounts change afterwards. Snapshots are written at Odoo send time and are the
 * source of truth for the three payroll exports of a sent payroll.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export type PayrollSnapshotType = 'payroll' | 'cashFawry' | 'fawry';

type SnapshotFile = { filename: string; base64: string };

type SnapshotBundle = {
  payroll: SnapshotFile;
  cashFawry: SnapshotFile;
  fawry: SnapshotFile;
};

type Manifest = {
  payrollId: string;
  savedAt: string;
  files: Record<PayrollSnapshotType, string>;
};

const STORAGE_ROOT = path.join(process.cwd(), 'storage', 'payroll-sent');

function payrollDir(payrollId: string): string {
  return path.join(STORAGE_ROOT, payrollId);
}

/** Store the three sent files + a manifest. Best-effort: logs but never throws. */
export function savePayrollSentSnapshot(
  payrollId: string,
  bundle: SnapshotBundle,
): void {
  try {
    const dir = payrollDir(payrollId);
    fs.mkdirSync(dir, { recursive: true });
    const files: Record<PayrollSnapshotType, string> = {
      payroll: bundle.payroll.filename,
      cashFawry: bundle.cashFawry.filename,
      fawry: bundle.fawry.filename,
    };
    (Object.keys(files) as PayrollSnapshotType[]).forEach((type) => {
      const b = bundle[type];
      fs.writeFileSync(path.join(dir, `${type}.xlsx`), Buffer.from(b.base64, 'base64'));
    });
    const manifest: Manifest = {
      payrollId,
      savedAt: new Date().toISOString(),
      files,
    };
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  } catch (err) {
    logger.error({ err, payrollId }, 'Failed to save payroll sent snapshot');
  }
}

/** Read a single stored file for a sent payroll, or null when no snapshot exists. */
export function getPayrollSentSnapshot(
  payrollId: string,
  type: PayrollSnapshotType,
): SnapshotFile | null {
  try {
    const dir = payrollDir(payrollId);
    const manifestPath = path.join(dir, 'manifest.json');
    const filePath = path.join(dir, `${type}.xlsx`);
    if (!fs.existsSync(manifestPath) || !fs.existsSync(filePath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    const filename = manifest.files?.[type] ?? `${type}.xlsx`;
    const base64 = fs.readFileSync(filePath).toString('base64');
    return { filename, base64 };
  } catch (err) {
    logger.error({ err, payrollId, type }, 'Failed to read payroll sent snapshot');
    return null;
  }
}

export function hasPayrollSentSnapshot(payrollId: string): boolean {
  return fs.existsSync(path.join(payrollDir(payrollId), 'manifest.json'));
}

/**
 * Return the stored (sent) file when a snapshot exists, otherwise generate a
 * fresh export via the provided factory.
 */
export async function getSentSnapshotOrGenerate(
  payrollId: string,
  type: PayrollSnapshotType,
  generate: () => Promise<SnapshotFile>,
): Promise<SnapshotFile> {
  const snapshot = getPayrollSentSnapshot(payrollId, type);
  if (snapshot) return snapshot;
  return generate();
}
