import app from './app';
import { config } from './config';
import { bootstrapBioTimeConfigFromEnv } from './bootstrap/biotimeConfig';
import { bootstrapOdooConfigFromEnv } from './bootstrap/odooConfig';
import { startAllSchedulers } from './jobs';
import { logger } from './utils/logger';
import { prisma } from './prisma/client';

async function bootstrap() {
  try {
    await prisma.$connect();
    logger.info('Database connected');
    await bootstrapBioTimeConfigFromEnv();
    await bootstrapOdooConfigFromEnv();
  } catch (err) {
    logger.fatal({ err }, 'Database connection failed');
    process.exit(1);
  }

  app.listen(config.port, '0.0.0.0', () => {
    logger.info(`BioTime API listening on 0.0.0.0:${config.port}`);
    startAllSchedulers();
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
