import fs from 'fs';
import path from 'path';

export const AUDIT_DIR = path.join(__dirname, '../../test-artifacts');
export const AUDIT_PATH = path.join(AUDIT_DIR, 'weekly-payroll-cycle-audit.md');

export type AuditSection = {
  title: string;
  lines: string[];
};

export type ButtonCoverageRow = {
  uiAction: string;
  api: string;
  status: 'pass' | 'fail' | 'skip';
  notes?: string;
};

export function writeWeeklyPayrollAudit(opts: {
  period: { from: string; to: string };
  location: { id: string; name: string; code: string };
  employees: { id: string; code: string; name: string }[];
  weeklyGrids: { id: string; name: string; from: string; to: string }[];
  merge: {
    monthlyGridId: string;
    sourceIds: string[];
    appendedGridId: string;
    lineCount: number;
  };
  punches: { count: number; via: string };
  attendance: { createdOrUpdated: number };
  money: {
    advances: { employeeCode: string; amount: number }[];
    deductions: { employeeCode: string; amount: number; type: string }[];
  };
  payroll: {
    id: string;
    lineCount: number;
    totals: { employeeCode: string; net: number; advanceShort: number; fines: number }[];
  };
  buttonCoverage?: ButtonCoverageRow[];
  extraSections?: AuditSection[];
}): string {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const sections: string[] = [
    '# Weekly payroll cycle audit',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Period',
    `- From: ${opts.period.from}`,
    `- To: ${opts.period.to}`,
    `- Payroll month start day: 26`,
    '',
    '## Location',
    `- ${opts.location.code} — ${opts.location.name} (\`${opts.location.id}\`)`,
    '',
    '## Employees',
    ...opts.employees.map((e) => `- ${e.code} ${e.name} (\`${e.id}\`)`),
    '',
    '## Weekly grids',
    ...opts.weeklyGrids.map((g) => `- ${g.name}: ${g.from} → ${g.to} (\`${g.id}\`)`),
    '',
    '## Merge / append',
    `- Monthly grid: \`${opts.merge.monthlyGridId}\``,
    `- Merged sources: ${opts.merge.sourceIds.map((id) => `\`${id}\``).join(', ')}`,
    `- Appended week: \`${opts.merge.appendedGridId}\``,
    `- Line count on monthly: ${opts.merge.lineCount}`,
    '',
    '## Punches',
    `- Count: ${opts.punches.count}`,
    `- Via: ${opts.punches.via}`,
    '',
    '## Attendance',
    `- Created/updated: ${opts.attendance.createdOrUpdated}`,
    '',
    '## Advances / deductions',
    '### Advances',
    ...opts.money.advances.map((a) => `- ${a.employeeCode}: ${a.amount}`),
    '### Deductions',
    ...opts.money.deductions.map((d) => `- ${d.employeeCode}: ${d.type} ${d.amount}`),
    '',
    '## Payroll',
    `- Id: \`${opts.payroll.id}\``,
    `- Lines: ${opts.payroll.lineCount}`,
    ...opts.payroll.totals.map(
      (t) =>
        `- ${t.employeeCode}: net=${t.net}, advanceShort=${t.advanceShort}, fines=${t.fines}`,
    ),
    '',
  ];

  if (opts.buttonCoverage?.length) {
    sections.push('## Button coverage matrix', '');
    sections.push('| UI action | API | Status | Notes |');
    sections.push('|---|---|---|---|');
    for (const row of opts.buttonCoverage) {
      sections.push(
        `| ${row.uiAction} | \`${row.api}\` | ${row.status} | ${row.notes ?? ''} |`,
      );
    }
    sections.push('');
  }

  for (const extra of opts.extraSections ?? []) {
    sections.push(`## ${extra.title}`, ...extra.lines, '');
  }

  const body = sections.join('\n');
  fs.writeFileSync(AUDIT_PATH, body, 'utf8');
  return AUDIT_PATH;
}

export function appendButtonCoverage(rows: ButtonCoverageRow[]): string {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const header = [
    '',
    '## Button coverage matrix',
    '',
    '| UI action | API | Status | Notes |',
    '|---|---|---|---|',
  ];
  const lines = rows.map(
    (row) => `| ${row.uiAction} | \`${row.api}\` | ${row.status} | ${row.notes ?? ''} |`,
  );
  const block = [...header, ...lines, ''].join('\n');
  if (fs.existsSync(AUDIT_PATH)) {
    fs.appendFileSync(AUDIT_PATH, block, 'utf8');
  } else {
    fs.writeFileSync(
      AUDIT_PATH,
      `# Weekly payroll cycle audit\n\nGenerated: ${new Date().toISOString()}\n${block}`,
      'utf8',
    );
  }
  return AUDIT_PATH;
}
