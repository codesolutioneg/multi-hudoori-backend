/**
 * Read-only probe: fetch sample data from BioTime server and print to console.
 * Does NOT write to PostgreSQL.
 */
import 'dotenv/config';
import { prisma } from '../prisma/client';
import { BioTimeConnector } from '../services/biotime/biotimeConnector.service';

async function main() {
  const config = await prisma.bioTimeConfig.findFirst();
  if (!config?.serverIp) {
    console.error('No BioTime config in DB. Set BIOTIME_* in .env and restart server.');
    process.exit(1);
  }
  if (!config.username || !config.password) {
    console.error('BioTime username/password missing in biotime_config.');
    process.exit(1);
  }

  console.log('--- BioTime probe (read-only, no DB sync) ---');
  console.log(`Server: ${config.serverIp}:${config.serverPort}`);
  console.log(`User: ${config.username}`);

  const connector = new BioTimeConnector(config);
  await connector.testConnection();
  console.log('Connection: OK\n');

  const [depts, employees, devices, punches] = await Promise.all([
    connector.getDepartments(1, 5),
    connector.getEmployees(1, 5),
    connector.getDevices(1, 5),
    connector.getTransactions(1, 5, {
      start_time: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
      end_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }),
  ]);

  const deptList = depts.data ?? [];
  const empList = employees.data ?? [];
  const devList = devices.data ?? [];
  const punchList = punches.data ?? [];

  console.log(`Departments (page 1, sample ${deptList.length}):`);
  deptList.forEach((d) => console.log(`  - [${d.id}] ${d.dept_code ?? ''} ${d.dept_name ?? ''}`));
  console.log(`  (more pages: ${depts.next ? 'yes' : 'no'})\n`);

  console.log(`Employees (page 1, sample ${empList.length}, total hint: ${employees.count ?? 'n/a'}):`);
  empList.forEach((e) =>
    console.log(`  - [${e.id}] ${e.emp_code ?? ''} ${e.first_name ?? ''} ${e.last_name ?? ''}`.trim()),
  );
  console.log(`  (more pages: ${employees.next ? 'yes' : 'no'})\n`);

  console.log(`Devices (page 1, sample ${devList.length}):`);
  devList.forEach((d) => console.log(`  - [${d.id}] ${d.alias ?? ''} SN:${d.sn ?? ''}`));
  console.log(`  (more pages: ${devices.next ? 'yes' : 'no'})\n`);

  console.log(`Punches last 7 days (page 1, sample ${punchList.length}):`);
  punchList.forEach((t) =>
    console.log(`  - ${t.emp_code ?? '?'} @ ${t.punch_time ?? ''} (${t.punch_state ?? ''})`),
  );
  console.log(`  (more pages: ${punches.next ? 'yes' : 'no'})\n`);

  console.log('--- Summary ---');
  console.log({
    departmentsSample: deptList.length,
    employeesSample: empList.length,
    employeeTotalHint: employees.count ?? null,
    devicesSample: devList.length,
    punchesSample: punchList.length,
  });
  console.log('\nIf counts > 0, BioTime server has data. Run Sync all in app to load into PostgreSQL.');
}

main()
  .catch((err) => {
    console.error('PROBE FAILED:', err.response?.data ?? err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
