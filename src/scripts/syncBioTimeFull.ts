/**
 * Full BioTime pull: departments → employees → devices → transactions (chunked) → locations bootstrap.
 *
 * Usage: npx ts-node src/scripts/syncBioTimeFull.ts
 */
import 'dotenv/config';
import { prisma } from '../prisma/client';
import {
  syncDepartments,
  syncEmployees,
  syncDevices,
  syncTransactions,
} from '../services/biotime/sync.service';
import { resolveLocationByName } from '../services/location.service';

function slugCode(name: string): string {
  const base = name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u0600-\u06FF_-]/g, '')
    .toUpperCase();
  return (base || 'LOC').slice(0, 50);
}

async function bootstrapLocationsFromEmployees(): Promise<{ created: number; linked: number; names: number }> {
  const rows = await prisma.employeeProfile.findMany({
    where: { NOT: { location: null } },
    select: { location: true },
  });
  const names = new Set<string>();
  for (const r of rows) {
    const n = (r.location ?? '').trim();
    if (n) names.add(n);
  }

  let created = 0;
  let linked = 0;

  for (const name of [...names].sort((a, b) => a.localeCompare(b, 'ar'))) {
    let loc = await resolveLocationByName(name);
    if (!loc) {
      let code = slugCode(name);
      const taken = await prisma.location.findFirst({ where: { code } });
      if (taken) code = `${code}_${created + 1}`;
      loc = await prisma.location.create({ data: { name, code } });
      created++;
    }

    const result = await prisma.employeeProfile.updateMany({
      where: {
        location: { equals: name, mode: 'insensitive' },
        OR: [{ locationId: null }, { locationId: { not: loc.id } }],
      },
      data: { locationId: loc.id, location: loc.name },
    });
    linked += result.count;
  }

  return { created, linked, names: names.size };
}

function* transactionChunks(from: Date, to: Date, monthsPerChunk: number): Generator<{ from: Date; to: Date }> {
  let cursor = new Date(from);
  while (cursor < to) {
    const end = new Date(cursor);
    end.setMonth(end.getMonth() + monthsPerChunk);
    const chunkTo = end > to ? to : end;
    yield { from: new Date(cursor), to: chunkTo };
    cursor = new Date(chunkTo);
    if (cursor >= to) break;
    cursor.setDate(cursor.getDate() + 1);
  }
}

async function main() {
  console.log('--- BioTime full sync ---\n');

  const departments = await syncDepartments();
  console.log(`Departments synced: ${departments}`);

  const employees = await syncEmployees();
  console.log(`Employees synced (BioTime pages): ${employees}`);

  const devices = await syncDevices();
  console.log(`Devices synced: ${devices}`);

  const rangeStart = new Date('2022-01-01T00:00:00.000Z');
  const rangeEnd = new Date();
  let totalTransactions = 0;
  let chunkIndex = 0;

  for (const chunk of transactionChunks(rangeStart, rangeEnd, 4)) {
    chunkIndex++;
    const label = `${chunk.from.toISOString().slice(0, 10)} → ${chunk.to.toISOString().slice(0, 10)}`;
    console.log(`\nTransactions chunk ${chunkIndex}: ${label}`);
    const n = await syncTransactions(chunk.from, chunk.to);
    totalTransactions += n;
    console.log(`  synced: ${n} (running total: ${totalTransactions})`);
  }

  console.log('\nBootstrapping locations from employee location strings…');
  const locStats = await bootstrapLocationsFromEmployees();
  console.log('Locations:', locStats);

  const summary = {
    departments: await prisma.department.count(),
    employees: await prisma.employeeProfile.count(),
    withMapping: await prisma.employeeMapping.count(),
    devices: await prisma.device.count(),
    transactions: await prisma.transaction.count(),
    locations: await prisma.location.count(),
    employeesWithLocationId: await prisma.employeeProfile.count({ where: { locationId: { not: null } } }),
  };

  console.log('\n--- BioTime sync complete ---');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
