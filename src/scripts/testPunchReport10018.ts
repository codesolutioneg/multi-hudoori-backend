import { prisma } from '../prisma/client';
import {
  computeEmployeeSummary,
  generatePunchReportLines,
  getSummaryPeriodDays,
} from '../services/punchReportLine.service';
import { getLatePolicy } from '../services/latePolicy.service';

async function main() {
  const emp = await prisma.employeeProfile.findFirst({
    where: {
      OR: [{ code: '10018' }, { mapping: { biotimeEmpCode: '10018' } }],
    },
    include: { mapping: true },
  });
  if (!emp) {
    console.log('Employee 10018 not found');
    return;
  }
  console.log('Employee:', emp.id, emp.name, emp.code, emp.mapping?.biotimeEmpCode);

  const gridLine = await prisma.shiftGridLine.findFirst({
    where: { employeeId: emp.id, date: new Date('2026-06-25') },
    include: { grid: true },
  });
  const gridLineAny = gridLine ?? (await prisma.shiftGridLine.findFirst({
    where: { employeeId: emp.id },
    orderBy: { date: 'desc' },
    include: { grid: true },
  }));
  if (!gridLineAny) {
    console.log('No grid line for employee');
    return;
  }
  const grid = gridLineAny.grid;
  console.log(
    'Grid:',
    grid.id,
    grid.name,
    grid.dateFrom.toISOString().slice(0, 10),
    grid.dateTo.toISOString().slice(0, 10),
  );

  const dateFrom = grid.dateFrom;
  const dateTo = grid.dateTo;
  const lines = await generatePunchReportLines({
    dateFrom,
    dateTo,
    shiftGridId: grid.id,
    employeeIds: [emp.id],
  });
  const empCode = emp.mapping?.biotimeEmpCode?.trim() || emp.code || '10018';
  const empLines = lines.filter((l) => l.employeeCode === empCode || l.employeeId === emp.id);
  const periodDays = getSummaryPeriodDays(dateFrom, dateTo);
  const summary = computeEmployeeSummary(empLines, periodDays, 0, await getLatePolicy());
  console.log('Summary:', JSON.stringify(summary, null, 2));
  console.log('Total lines:', empLines.length);

  const single = empLines.filter((l) => l.punchCount === 1 && !l.isOffDay && !l.isAbsent);
  console.log(`Single punch days (${single.length}):`);
  for (const l of single) {
    console.log(
      `  ${l.punchDate.toISOString().slice(0, 10)} in=${l.checkInCount} out=${l.checkOutCount} ${l.shiftName}`,
    );
  }

  const working = empLines.filter(
    (l) =>
      ((!l.isOffDay && !l.isAbsent && l.punchCount > 0) ||
        l.isAnnualLeave ||
        l.shiftName === 'إجازة مرضية'),
  );
  console.log(`Working days (${working.length}):`);
  for (const l of working) {
    console.log(
      `  ${l.punchDate.toISOString().slice(0, 10)} punches=${l.punchCount} off=${l.isOffDay} absent=${l.isAbsent} ${l.shiftName}`,
    );
  }

  const gridLines = await prisma.shiftGridLine.findMany({
    where: { gridId: grid.id, employeeId: emp.id },
    include: { shift: true },
    orderBy: { date: 'asc' },
  });
  const withShift = gridLines.filter((l) => l.shiftId);
  const noShift = gridLines.filter(
    (l) => !l.shiftId && !l.isOff && !l.isSick && !l.isAnnualLeave && !l.isExcluded,
  );
  console.log('Grid lines:', gridLines.length, 'withShift:', withShift.length, 'noShift:', noShift.length);

  console.log('All lines:');
  for (const l of empLines) {
    console.log(
      `  ${l.punchDate.toISOString().slice(0, 10)} pc=${l.punchCount} off=${l.isOffDay} abs=${l.isAbsent} annual=${l.isAnnualLeave} shift=${l.shiftName || '-'}`,
    );
  }

  const dates = ['2026-05-28', '2026-05-31', '2026-06-07', '2026-06-12', '2026-06-13'];
  for (const d of dates) {
    const gl = await prisma.shiftGridLine.findFirst({
      where: { gridId: grid.id, employeeId: emp.id, date: new Date(d) },
      include: { shift: true },
    });
    const txs = await prisma.transaction.findMany({
      where: {
        empCode: '10018',
        punchTime: { gte: new Date(`${d}T00:00:00Z`), lte: new Date(`${d}T23:59:59Z`) },
      },
      orderBy: { punchTime: 'asc' },
    });
    console.log(
      `--- ${d} grid:`,
      gl
        ? {
            off: gl.isOff,
            sick: gl.isSick,
            present: gl.isPresent,
            shift: gl.shift?.name,
            excluded: gl.isExcluded,
          }
        : null,
    );
    console.log(
      ' txs:',
      txs.map((t) => ({
        time: t.punchTime.toISOString(),
        state: t.punchState,
        sn: t.terminalSn,
        id: t.biotimeTransactionId,
      })),
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
