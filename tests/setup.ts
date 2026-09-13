import 'dotenv/config';

/**
 * Tests MUST never use live Multi/Dev/Prod DBs.
 * dotenv may load .env (hudoori_multi_dev) — we always override that here.
 */
const FORBIDDEN_DB_NAMES = new Set([
  'biotime_dev',
  'biotime',
  'hudoori_multi_dev',
]);

const DEFAULT_TEST_URL =
  'postgresql://hudoori_multi_app:hudoori_multi_app_dev@127.0.0.1:5434/hudoori_multi_test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_URL;
process.env.MULTI_JOBS_ENABLED = process.env.MULTI_JOBS_ENABLED ?? 'false';

function databaseNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const name = u.pathname.replace(/^\//, '').split('?')[0];
    return name || null;
  } catch {
    return null;
  }
}

const dbName = databaseNameFromUrl(process.env.DATABASE_URL);
if (!dbName || FORBIDDEN_DB_NAMES.has(dbName)) {
  throw new Error(
    `Refusing to run tests against database "${dbName ?? 'unknown'}". ` +
      `Set TEST_DATABASE_URL to an isolated DB (e.g. hudoori_multi_test), never live Multi/Dev/Prod.`,
  );
}

process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET ?? 'biotime-test-access-secret-min-32-characters';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET ?? 'biotime-test-refresh-secret-min-32-characters';
process.env.SYNC_CRON_ENABLED = 'false';
