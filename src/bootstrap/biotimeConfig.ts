import { BioTimeConfig } from '@prisma/client';
import { config } from '../config';
import { prismaBase } from '../prisma/client';
import { logger } from '../utils/logger';
import { BioTimeConnector } from '../services/biotime/biotimeConnector.service';

/**
 * Multi-tenant: BioTime config is per company.
 * Env bootstrap only fills an *existing* company row when companyId is provided.
 * Never creates a global (company-less) config row.
 */
export async function ensureBioTimeConfigFromEnv(
  companyId: string,
  options?: { verifyConnection?: boolean },
): Promise<BioTimeConfig> {
  const envCfg = config.biotime;

  let row = await prismaBase.bioTimeConfig.findUnique({ where: { companyId } });
  if (!row) {
    row = await prismaBase.bioTimeConfig.create({
      data: { companyId, authType: 'jwt' },
    });
  }

  const patch: Record<string, unknown> = {};
  if (envCfg.serverIp && !row.serverIp.trim()) patch.serverIp = envCfg.serverIp;
  if (envCfg.serverIp && row.serverPort === 8090 && envCfg.serverPort !== 8090) {
    patch.serverPort = envCfg.serverPort;
  }
  if (envCfg.username && !row.username) patch.username = envCfg.username;
  if (envCfg.password && !row.password) patch.password = envCfg.password;
  if (envCfg.useHttps && !row.useHttps) patch.useHttps = envCfg.useHttps;

  if (Object.keys(patch).length > 0) {
    row = await prismaBase.bioTimeConfig.update({ where: { id: row.id }, data: patch });
    logger.info({ companyId, fields: Object.keys(patch) }, 'BioTime config applied from .env');
  }

  if (options?.verifyConnection && row.serverIp && row.username && row.password) {
    try {
      await new BioTimeConnector(row).testConnection();
      row = await prismaBase.bioTimeConfig.update({
        where: { id: row.id },
        data: { isConnected: true },
      });
      logger.info({ companyId }, 'BioTime connection verified');
    } catch (err) {
      await prismaBase.bioTimeConfig.update({
        where: { id: row.id },
        data: { isConnected: false },
      });
      logger.warn({ err, companyId }, 'BioTime connection test failed');
    }
  }

  return row;
}

/** Startup: do not create global BioTime config — companies own their connections. */
export async function bootstrapBioTimeConfigFromEnv(): Promise<void> {
  if (config.biotime.serverIp) {
    logger.info(
      'BIOTIME_SERVER_IP is set but ignored at boot in multi-tenant mode; configure per company',
    );
  }
}
