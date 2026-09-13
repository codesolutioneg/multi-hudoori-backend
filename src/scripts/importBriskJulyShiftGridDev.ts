/**
 * DEV-only: create Bri.Mad July pay-period shift grid and import the
 * closed-system Excel from files_to_test. Skips unknown employee codes
 * (importShiftGridXlsx already does this). Does NOT import payroll.
 *
 *   npx ts-node --transpile-only src/scripts/importBriskJulyShiftGridDev.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client';
import { importShiftGridXlsx } from '../services/shiftGridExcel.service';

const LOC_ID = 'cmruv0w640055spj2c6u9ccj2'; // Bri.Mad
const DATE_FROM = '2026-06-26';
const DATE_TO = '2026-07-25';
const XLSX = path.resolve(
  __dirname,
  '../../files_to_test/جدول_الشيفتات_للتعديل_SG_2026_0100.xlsx',
);

async function main() {
  if (!fs.existsSync(XLSX)) {
    throw new Error(`Missing Excel: ${XLSX}`);
  }

  const loc = await prisma.location.findUnique({ where: { id: LOC_ID } });
  if (!loc) throw new Error('Bri.Mad location not found');

  let grid = await prisma.shiftGrid.findFirst({
    where: {
      locationId: LOC_ID,
      dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
      dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
    },
  });

  if (!grid) {
    grid = await prisma.shiftGrid.create({
      data: {
        name: `${loc.name} — July 2026 cycle test`,
        dateFrom: new Date(`${DATE_FROM}T00:00:00.000Z`),
        dateTo: new Date(`${DATE_TO}T00:00:00.000Z`),
        selectionMethod: 'location',
        conflictAction: 'replace',
        employeeIds: [],
        departmentIds: [],
        gridLocation: loc.name,
        locationId: LOC_ID,
        state: 'setup',
      } as Prisma.ShiftGridUncheckedCreateInput,
    });
    console.log('CREATED grid', grid.id, grid.name);
  } else {
    if (grid.state === 'confirmed') {
      throw new Error(`Grid ${grid.id} is confirmed — reopen before import`);
    }
    console.log('USING existing grid', grid.id, grid.name, grid.state);
  }

  const base64 = fs.readFileSync(XLSX).toString('base64');
  console.log('Importing…');
  const result = await importShiftGridXlsx(grid.id, base64);

  const lineStats = await prisma.shiftGridLine.groupBy({
    by: ['employeeId'],
    where: { gridId: grid.id },
    _count: true,
  });
  const filled = await prisma.shiftGridLine.count({
    where: {
      gridId: grid.id,
      OR: [
        { shiftId: { not: null } },
        { isOff: true },
        { isSick: true },
        { isAnnualLeave: true },
        { isExcluded: true },
        { isBusDelay: true },
        { isPresent: true },
        { isFinished: true },
        { isResignation: true },
        { isWorkAbsence: true },
        { isWorkInjury: true },
      ],
    },
  });

  console.log('\n=== IMPORT RESULT ===');
  console.log({
    gridId: grid.id,
    location: loc.name,
    period: `${DATE_FROM} → ${DATE_TO}`,
    updated: result.updated,
    cleared: result.cleared,
    added: result.added,
    relocated: result.relocated,
    skippedCodes: result.skippedCodes?.length ?? 0,
    skipped: result.skippedCodes,
    untrackedUsers: result.untrackedUsers,
    errors: result.errors,
    employeesOnGrid: lineStats.length,
    filledCells: filled,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
