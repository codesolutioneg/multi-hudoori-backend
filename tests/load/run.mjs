/**
 * Load test for the hot JSON-RPC endpoints, using autocannon (no k6 needed).
 *
 *   npm run load                       # against http://localhost:3000
 *   npm run load -- --url https://…    # against a deployed instance
 *   npm run load -- --duration 30 --connections 50
 *   npm run load -- --scenario payroll-get
 *
 * Requires a running API and a seeded dataset:
 *   node tests/load/seed.mjs > tests/load/.fixture.json
 *
 * Exits non-zero when a scenario breaches its latency or error budget, so it
 * can gate a release.
 */
import autocannon from 'autocannon';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '.fixture.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const URL = arg('url', 'http://localhost:3000');
const DURATION = Number(arg('duration', 10));
const CONNECTIONS = Number(arg('connections', 20));
const ONLY = arg('scenario', null);

if (!existsSync(FIXTURE)) {
  console.error(
    `Missing ${FIXTURE}\nRun:  node tests/load/seed.mjs > tests/load/.fixture.json`,
  );
  process.exit(2);
}
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));

/**
 * p99 budgets in ms. Read-heavy list endpoints should stay interactive; the
 * report/export endpoints are allowed to be slower because they aggregate a
 * whole period.
 */
const SCENARIOS = [
  { name: 'health', method: 'GET', path: '/api/health', auth: false, body: null, p99: 150 },
  { name: 'login', path: '/api/auth/login', auth: false, body: { login: fx.login, password: fx.password }, p99: 2500 },
  { name: 'me', path: '/api/biotime/me', body: {}, p99: 400 },
  { name: 'dashboard-stats', path: '/api/biotime/dashboard/stats', body: {}, p99: 1500 },
  { name: 'employees-list', path: '/api/biotime/employees/list', body: { limit: 30 }, p99: 800 },
  { name: 'employees-search', path: '/api/biotime/employees/list', body: { search: 'Load Employee 1', limit: 30 }, p99: 1200 },
  { name: 'shift-grid-list', path: '/api/biotime/shift-grid/list', body: { limit: 20 }, p99: 800 },
  { name: 'shift-grid-get', path: '/api/biotime/shift-grid/get', body: { id: fx.gridId, employeeLimit: 40, employeeOffset: 0 }, p99: 3000 },
  { name: 'payroll-list', path: '/api/biotime/payroll/list', body: { limit: 30 }, p99: 800 },
  { name: 'payroll-get', path: '/api/biotime/payroll/get', body: { id: fx.payrollId, lineLimit: 40, lineOffset: 0 }, p99: 2000 },
  { name: 'attendance-list', path: '/api/biotime/attendance/list', body: { dateFrom: fx.dateFrom, dateTo: fx.dateTo, limit: 50 }, p99: 2000 },
  { name: 'deductions-list', path: '/api/biotime/deductions/list', body: { limit: 30 }, p99: 800 },
  { name: 'requests-pending', path: '/api/biotime/requests/pending', body: {}, p99: 1500 },
];

const MAX_ERROR_RATE = 0.01;

function fmt(n) {
  return Number(n).toFixed(1).padStart(8);
}

async function runScenario(s) {
  const result = await autocannon({
    url: `${URL}${s.path}`,
    method: s.method ?? 'POST',
    connections: CONNECTIONS,
    duration: DURATION,
    headers: {
      'Content-Type': 'application/json',
      ...(s.auth === false ? {} : { Authorization: `Bearer ${fx.token}` }),
    },
    body: s.body === null ? undefined : JSON.stringify({ jsonrpc: '2.0', params: s.body, id: 1 }),
  });

  const total = result.requests.total || 1;
  // A JSON-RPC business failure still returns HTTP 200, so non-2xx really is a fault.
  const failures = result.non2xx + result.errors + result.timeouts;
  return {
    name: s.name,
    rps: result.requests.average,
    p50: result.latency.p50,
    p99: result.latency.p99,
    max: result.latency.max,
    total,
    failures,
    errorRate: failures / total,
    budget: s.p99,
    passed: result.latency.p99 <= s.p99 && failures / total <= MAX_ERROR_RATE,
  };
}

const scenarios = ONLY ? SCENARIOS.filter((s) => s.name === ONLY) : SCENARIOS;
if (!scenarios.length) {
  console.error(`Unknown scenario "${ONLY}". Available: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

console.log(`\nLoad test → ${URL}`);
console.log(`${CONNECTIONS} connections, ${DURATION}s per scenario, ${fx.employees} employees seeded\n`);
console.log('scenario                rps      p50      p99      max   errors  budget  verdict');
console.log('─'.repeat(84));

const results = [];
for (const s of scenarios) {
  const r = await runScenario(s);
  results.push(r);
  console.log(
    `${r.name.padEnd(22)}${fmt(r.rps)}${fmt(r.p50)}${fmt(r.p99)}${fmt(r.max)}` +
      `${String(r.failures).padStart(9)}${String(r.budget).padStart(8)}  ${r.passed ? 'pass' : 'FAIL'}`,
  );
}

const failed = results.filter((r) => !r.passed);
console.log('─'.repeat(84));
if (failed.length) {
  console.log(`\n${failed.length} scenario(s) over budget:`);
  for (const r of failed) {
    const why = r.p99 > r.budget ? `p99 ${r.p99.toFixed(0)}ms > ${r.budget}ms` : `error rate ${(r.errorRate * 100).toFixed(2)}%`;
    console.log(`  ${r.name}: ${why}`);
  }
  process.exit(1);
}
console.log('\nAll scenarios within budget.');
