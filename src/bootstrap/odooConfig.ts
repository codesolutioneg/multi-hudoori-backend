import { OdooConfig } from '@prisma/client';
import { config } from '../config';
import { prismaBase } from '../prisma/client';
import { logger } from '../utils/logger';

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Multi-tenant: Odoo config is per company.
 * Never creates a global (company-less) config row.
 */
export async function ensureOdooConfigFromEnv(companyId: string): Promise<OdooConfig> {
  const envCfg = config.odoo;

  let row = await prismaBase.odooConfig.findUnique({ where: { companyId } });
  if (!row) {
    row = await prismaBase.odooConfig.create({ data: { companyId } });
  }

  const patch: Record<string, unknown> = {};
  if (envCfg.baseUrl && !row.baseUrl.trim()) patch.baseUrl = normalizeBaseUrl(envCfg.baseUrl);
  if (envCfg.database && !row.database.trim()) patch.database = envCfg.database.trim();
  if (envCfg.login && !row.login.trim()) patch.login = envCfg.login.trim();
  if (envCfg.password && !row.password) patch.password = envCfg.password;

  if (Object.keys(patch).length > 0) {
    row = await prismaBase.odooConfig.update({ where: { id: row.id }, data: patch });
    logger.info({ companyId, fields: Object.keys(patch) }, 'Odoo config applied from .env');
  }

  return row;
}

export async function bootstrapOdooConfigFromEnv(): Promise<void> {
  if (config.odoo.baseUrl) {
    logger.info(
      'ODOO_BASE_URL is set but ignored at boot in multi-tenant mode; configure per company',
    );
  }
}
