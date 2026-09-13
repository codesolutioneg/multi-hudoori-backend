import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('30d'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().min(1).default(15),
  RATE_LIMIT_MAX: z.coerce.number().min(1).default(2000),
  RATE_LIMIT_IP_MAX: z.coerce.number().min(1).default(20000),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().min(1).default(50),
  BIOTIME_USERNAME: z.string().optional(),
  BIOTIME_PASSWORD: z.string().optional(),
  SYNC_CRON_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
  SYNC_CRON_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(12),
  SYNC_CRON_EXPRESSION: z.string().default('0 5,17 * * *'),
  SYNC_CRON_TIMEZONE: z.string().default('Africa/Cairo'),
  BIOTIME_SERVER_IP: z.string().optional(),
  BIOTIME_SERVER_PORT: z.coerce.number().default(8090),
  BIOTIME_USE_HTTPS: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  ODOO_BASE_URL: z.string().optional(),
  ODOO_DATABASE: z.string().optional(),
  ODOO_LOGIN: z.string().optional(),
  ODOO_PASSWORD: z.string().optional(),
  HIRING_WEBHOOK_SECRET: z.string().optional(),
  HIRING_EMPLOYEE_DEFAULT_PASSWORD: z.string().optional(),
  APP_PUBLIC_URL: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z
    .string()
    .transform((v) => v !== 'false')
    .optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  SMTP_FROM_NAME: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessExpiry: env.JWT_ACCESS_EXPIRY,
  },
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: env.RATE_LIMIT_MAX,
    ipMax: env.RATE_LIMIT_IP_MAX,
    authMax: env.RATE_LIMIT_AUTH_MAX,
  },
  syncCron: {
    enabled: env.SYNC_CRON_ENABLED,
    /** Only drives the startup catch-up staleness check, not the cron schedule. */
    intervalHours: env.SYNC_CRON_INTERVAL_HOURS,
    expression: env.SYNC_CRON_EXPRESSION,
    timezone: env.SYNC_CRON_TIMEZONE,
  },
  biotime: {
    serverIp: env.BIOTIME_SERVER_IP ?? '',
    serverPort: env.BIOTIME_SERVER_PORT,
    useHttps: env.BIOTIME_USE_HTTPS,
    username: env.BIOTIME_USERNAME ?? '',
    password: env.BIOTIME_PASSWORD ?? '',
  },
  odoo: {
    baseUrl: env.ODOO_BASE_URL ?? '',
    database: env.ODOO_DATABASE ?? '',
    login: env.ODOO_LOGIN ?? '',
    password: env.ODOO_PASSWORD ?? '',
  },
  hiringWebhookSecret: env.HIRING_WEBHOOK_SECRET ?? '',
  hiringEmployeeDefaultPassword: env.HIRING_EMPLOYEE_DEFAULT_PASSWORD ?? '',
  appPublicUrl: env.APP_PUBLIC_URL ?? 'https://hr.hudoori.code-solution.org',
  smtp: {
    host: env.SMTP_HOST ?? '',
    port: env.SMTP_PORT ?? 465,
    secure: env.SMTP_SECURE ?? true,
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    fromEmail: env.SMTP_FROM_EMAIL ?? env.SMTP_USER ?? '',
    fromName: env.SMTP_FROM_NAME ?? 'Hudoori',
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY ?? '',
    model: env.GEMINI_MODEL,
  },
};

export const PLATFORM_ADMIN_LOGIN = 'bioadmin@admin.bio';
export const PLATFORM_ADMIN_PASSWORD = 'Hudoori$BioAdmin#2026!xK9mQ2';
/** Matches Flutter [PlatformAdminConfig.localToken] for offline dashboard access */
export const PLATFORM_ADMIN_LOCAL_TOKEN = 'platform-admin-local-session';
