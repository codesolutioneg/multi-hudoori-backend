/**
 * k6 load profile for the Hudoori API: ramping VUs with per-endpoint budgets.
 *
 *   node tests/load/seed.mjs > tests/load/.fixture.json
 *   k6 run -e BASE_URL=http://localhost:3000 tests/load/k6-api.js
 *
 * Pass -e SMOKE=1 for a 30-second single-VU sanity run.
 * The autocannon runner (npm run load) covers the same endpoints without
 * needing the k6 binary; use this one for ramping profiles and CI dashboards.
 */
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SMOKE = __ENV.SMOKE === '1';

// eslint-disable-next-line no-undef
const fixture = JSON.parse(open('./.fixture.json'));

const latency = {
  employeesList: new Trend('hudoori_employees_list', true),
  shiftGridGet: new Trend('hudoori_shift_grid_get', true),
  payrollGet: new Trend('hudoori_payroll_get', true),
  dashboard: new Trend('hudoori_dashboard_stats', true),
};

export const options = SMOKE
  ? { vus: 1, duration: '30s' }
  : {
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 30 },
        { duration: '30s', target: 60 },
        { duration: '1m', target: 60 },
        { duration: '30s', target: 0 },
      ],
      thresholds: {
        http_req_failed: ['rate<0.01'],
        'http_req_duration{kind:read}': ['p(95)<1500', 'p(99)<3000'],
        hudoori_employees_list: ['p(99)<1000'],
        hudoori_shift_grid_get: ['p(99)<3000'],
        hudoori_payroll_get: ['p(99)<2000'],
        hudoori_dashboard_stats: ['p(99)<1500'],
      },
    };

function rpc(path, params, trend) {
  const res = http.post(
    `${BASE_URL}${path}`,
    JSON.stringify({ jsonrpc: '2.0', params, id: 1 }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${fixture.token}`,
      },
      tags: { kind: 'read', endpoint: path },
    },
  );
  if (trend) trend.add(res.timings.duration);
  check(res, {
    'http 200': (r) => r.status === 200,
    'rpc success': (r) => {
      try {
        return r.json('result.success') === true;
      } catch {
        return false;
      }
    },
  });
  return res;
}

export default function () {
  group('dashboard', () => {
    rpc('/api/biotime/me', {}, null);
    rpc('/api/biotime/dashboard/stats', {}, latency.dashboard);
  });

  group('employees', () => {
    rpc('/api/biotime/employees/list', { limit: 30 }, latency.employeesList);
    rpc('/api/biotime/employees/list', { search: 'Load Employee 1', limit: 30 }, null);
  });

  group('shift grid', () => {
    rpc('/api/biotime/shift-grid/list', { limit: 20 }, null);
    rpc(
      '/api/biotime/shift-grid/get',
      { id: fixture.gridId, employeeLimit: 40, employeeOffset: 0 },
      latency.shiftGridGet,
    );
  });

  group('payroll', () => {
    rpc('/api/biotime/payroll/list', { limit: 30 }, null);
    rpc(
      '/api/biotime/payroll/get',
      { id: fixture.payrollId, lineLimit: 40, lineOffset: 0 },
      latency.payrollGet,
    );
  });

  sleep(1);
}
