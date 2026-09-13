import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { ipLimiter, tokenLimiter } from './middlewares/rateLimiter';
import { jsonRpcParser } from './middlewares/jsonRpc';
import { errorHandler } from './middlewares/errorHandler';
import router from './routes';
import publicAuthenticateRoutes from './routes/publicAuthenticate.routes';
import { publicMobileOpenApi } from './docs/publicMobileOpenApi';
import { clearTenantSettingOnFinish } from './tenant/rls';

const app = express();

app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https:'],
      },
    },
  }),
);

const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (config.isDev || LOCAL_DEV_ORIGIN.test(origin) || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Id'],
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(hpp());
app.use(ipLimiter);
app.use(tokenLimiter);
app.use(jsonRpcParser);
app.use(clearTenantSettingOnFinish);

app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', service: 'biotime-backend' } });
});

app.use('/api/Authenticate', publicAuthenticateRoutes);

app.get('/api/swagger.json', (_req, res) => {
  res.json(publicMobileOpenApi);
});
app.use(
  '/api/swagger',
  swaggerUi.serve,
  swaggerUi.setup(publicMobileOpenApi, {
    customSiteTitle: 'Hudoori Multi Public Mobile APIs',
    swaggerOptions: { persistAuthorization: false },
  }),
);

app.use('/api', router);

app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Not found', error_code: 'NOT_FOUND' });
});

app.use(errorHandler);

export default app;
