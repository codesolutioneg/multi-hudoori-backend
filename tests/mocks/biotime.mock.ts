/** Mock BioTime API responses — never hits a real BioTime server in tests */
export const MOCK_DEPARTMENTS = [
  { id: 101, dept_code: 'HR', dept_name: 'Human Resources' },
  { id: 102, dept_code: 'IT', dept_name: 'Information Technology' },
];

export const MOCK_EMPLOYEES = [
  {
    id: 1001,
    emp_code: 'E1001',
    first_name: 'Ahmed',
    last_name: 'Ali',
    department: 101,
    email: 'ahmed@test.local',
  },
  {
    id: 1002,
    emp_code: 'E1002',
    first_name: 'Sara',
    last_name: 'Hassan',
    department: 102,
  },
];

export const MOCK_DEVICES = [
  { id: 501, alias: 'Main Gate', sn: 'SN001', ip_address: '192.168.1.10' },
];

export const MOCK_TRANSACTIONS = [
  {
    id: 90001,
    emp_code: 'E1001',
    punch_time: '2026-06-01T08:05:00',
    punch_state: '0',
    terminal_sn: 'SN001',
    terminal_alias: 'Main Gate',
  },
  {
    id: 90002,
    emp_code: 'E1001',
    punch_time: '2026-06-01T17:00:00',
    punch_state: '1',
    terminal_sn: 'SN001',
    terminal_alias: 'Main Gate',
  },
];

export function createMockConnector() {
  return {
    testConnection: async () => true,
    getDepartments: async (_page = 1) => ({ data: MOCK_DEPARTMENTS, next: null }),
    getEmployees: async (_page = 1) => ({ data: MOCK_EMPLOYEES, next: null }),
    getDevices: async (_page = 1) => ({ data: MOCK_DEVICES, next: null }),
    getTransactions: async (_page = 1) => ({ data: MOCK_TRANSACTIONS, next: null }),
  };
}
