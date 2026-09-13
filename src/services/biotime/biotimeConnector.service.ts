import axios, { AxiosInstance } from 'axios';
import { BioTimeConfig } from '@prisma/client';
import { prisma } from '../../prisma/client';

export class BioTimeConnector {
  private baseUrl: string;
  private headers: Record<string, string> = {};
  private config: BioTimeConfig;

  constructor(config: BioTimeConfig) {
    this.config = config;
    const protocol = config.useHttps ? 'https' : 'http';
    this.baseUrl = `${protocol}://${config.serverIp}:${config.serverPort}`;
  }

  static async fromDb(): Promise<BioTimeConnector> {
    const config = await prisma.bioTimeConfig.findFirst();
    if (!config) throw new Error('BioTime configuration not found');
    const connector = new BioTimeConnector(config);
    await connector.ensureAuth();
    return connector;
  }

  private authHeader(token: string): string {
    // Odoo biotime_config._get_auth_headers uses "JWT {token}" for jwt auth type
    if (this.config.authType === 'jwt') {
      return `JWT ${token}`;
    }
    return `Token ${token}`;
  }

  private async ensureAuth(): Promise<void> {
    if (this.config.authToken && this.config.tokenExpiry && this.config.tokenExpiry > new Date()) {
      this.headers = {
        Authorization: this.authHeader(this.config.authToken),
        'Content-Type': 'application/json',
      };
      return;
    }

    const endpoint =
      this.config.authType === 'jwt' ? '/jwt-api-token-auth/' : '/api-token-auth/';
    const url = `${this.baseUrl}${endpoint}`;
    const response = await axios.post(url, {
      username: this.config.username,
      password: this.config.password,
    });

    const token = response.data.token ?? response.data.access ?? response.data.key;
    if (!token) throw new Error('BioTime auth failed: no token returned');

    const expiry = new Date();
    expiry.setHours(expiry.getHours() + 12);

    await prisma.bioTimeConfig.update({
      where: { id: this.config.id },
      data: { authToken: token, tokenExpiry: expiry, isConnected: true },
    });

    this.config.authToken = token;
    this.config.tokenExpiry = expiry;
    this.headers = {
      Authorization: this.authHeader(token),
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    data?: unknown,
    params?: Record<string, unknown>,
    timeout = 30_000,
  ): Promise<T> {
    if (endpoint.includes('/transactions/')) timeout = 45_000;

    try {
      const response = await axios.request<T>({
        method,
        url: `${this.baseUrl}${endpoint}`,
        headers: this.headers,
        data,
        params,
        timeout,
      });
      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        await prisma.bioTimeConfig.update({
          where: { id: this.config.id },
          data: { authToken: null, tokenExpiry: null },
        });
        await this.ensureAuth();
        const response = await axios.request<T>({
          method,
          url: `${this.baseUrl}${endpoint}`,
          headers: this.headers,
          data,
          params,
          timeout,
        });
        return response.data;
      }
      throw err;
    }
  }

  async testConnection(): Promise<boolean> {
    await this.ensureAuth();
    await this.getDepartments(1, 1);
    await prisma.bioTimeConfig.update({
      where: { id: this.config.id },
      data: { isConnected: true },
    });
    return true;
  }

  async getEmployees(page = 1, pageSize = 100, filters?: Record<string, unknown>) {
    return this.request<{ data: BioTimeEmployee[]; next?: string | null; count?: number }>(
      'GET',
      '/personnel/api/employees/',
      undefined,
      { page, page_size: pageSize, ...filters },
    );
  }

  async getEmployeeById(id: number) {
    return this.request<{ data: BioTimeEmployee }>('GET', `/personnel/api/employees/${id}/`);
  }

  async createEmployee(data: Record<string, unknown>) {
    return this.request('POST', '/personnel/api/employees/', data);
  }

  async updateEmployee(id: number, data: Record<string, unknown>) {
    return this.request('PATCH', `/personnel/api/employees/${id}/`, data);
  }

  async findEmployeeByCode(empCode: string, maxPages = 40): Promise<BioTimeEmployee | null> {
    const target = empCode.trim();
    if (!target) return null;

    for (let page = 1; page <= maxPages; page++) {
      const response = await this.getEmployees(page, 200, { emp_code: target });
      const rows = response.data ?? [];
      const exact = rows.find((r) => String(r.emp_code ?? '').trim() === target);
      if (exact) return exact;
      if (!rows.length || !response.next) break;
    }

    for (let page = 1; page <= maxPages; page++) {
      const response = await this.getEmployees(page, 200);
      const rows = response.data ?? [];
      const exact = rows.find((r) => String(r.emp_code ?? '').trim() === target);
      if (exact) return exact;
      if (!rows.length || !response.next) break;
    }

    return null;
  }

  async deleteEmployee(id: number) {
    return this.request('DELETE', `/personnel/api/employees/${id}/`);
  }

  async getDepartments(page = 1, pageSize = 100, filters?: Record<string, unknown>) {
    return this.request<{ data: BioTimeDepartment[]; next?: string | null }>(
      'GET',
      '/personnel/api/departments/',
      undefined,
      { page, page_size: pageSize, ...filters },
    );
  }

  async getDevices(page = 1, pageSize = 100) {
    return this.request<{ data: BioTimeTerminal[]; next?: string | null }>(
      'GET',
      '/iclock/api/terminals/',
      undefined,
      { page, page_size: pageSize },
    );
  }

  async getTransactions(page = 1, pageSize = 500, filters?: Record<string, unknown>) {
    return this.request<{ data: BioTimeTransaction[]; next?: string | null; count?: number }>(
      'GET',
      '/iclock/api/transactions/',
      undefined,
      { page, page_size: pageSize, ...filters },
    );
  }

  async getAreas() {
    return this.request('GET', '/personnel/api/areas/');
  }

  async getPositions() {
    return this.request('GET', '/personnel/api/positions/');
  }
}

export interface BioTimeEmployee {
  id: number;
  emp_code?: string;
  first_name?: string;
  last_name?: string;
  card_no?: string;
  mobile?: string;
  email?: string;
  hire_date?: string;
  gender?: string;
  department?: number | { id: number };
}

export interface BioTimeDepartment {
  id: number;
  dept_code?: string;
  dept_name?: string;
}

export interface BioTimeTerminal {
  id: number;
  alias?: string;
  sn?: string;
  ip_address?: string;
  last_activity?: string;
  push_time?: string;
  state?: number | string;
}

export interface BioTimeTransaction {
  id: number;
  emp_code?: string;
  punch_time?: string;
  punch_state?: string;
  terminal_sn?: string;
  terminal_alias?: string;
}
