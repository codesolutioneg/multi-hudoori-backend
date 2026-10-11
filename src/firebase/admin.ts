import fs from 'fs';
import path from 'path';
import * as admin from 'firebase-admin';

let app: admin.app.App | null = null;

const DEFAULT_SERVICE_ACCOUNT_PATH = path.join(
  process.cwd(),
  'assets/fonts/odc-chat-firebase-adminsdk-ohe1t-41d6bf0369.json',
);

export function getFirebaseServiceAccountPath(): string {
  return process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() || DEFAULT_SERVICE_ACCOUNT_PATH;
}

export function getFirebaseAdminApp(): admin.app.App {
  if (app) return app;
  const filePath = getFirebaseServiceAccountPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Firebase service account not found at ${filePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };
  if (!raw.project_id || !raw.client_email || !raw.private_key) {
    throw new Error('Invalid Firebase service account JSON');
  }
  const existing = admin.apps.find((a) => a?.name === 'hudoori-multi-fcm');
  app =
    existing ??
    admin.initializeApp(
      {
        credential: admin.credential.cert({
          projectId: raw.project_id,
          clientEmail: raw.client_email,
          privateKey: raw.private_key,
        }),
      },
      'hudoori-multi-fcm',
    );
  return app;
}

export function companyTopic(companyId: string): string {
  return `company_${companyId}`;
}
