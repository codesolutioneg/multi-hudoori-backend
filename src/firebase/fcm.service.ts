import type { Message, MulticastMessage } from 'firebase-admin/messaging';
import { getFirebaseAdminApp, companyTopic } from './admin';
import { logger } from '../utils/logger';

export type FcmPayload = {
  title: string;
  body: string;
  imageUrl?: string | null;
  notificationId?: string;
  route?: string;
  data?: Record<string, string>;
};

function stringData(payload: FcmPayload): Record<string, string> {
  const base: Record<string, string> = {
    route: payload.route ?? '/notifications',
    click_action: 'notifications',
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
    ...(payload.data ?? {}),
  };
  for (const key of Object.keys(base)) {
    if (base[key] == null) delete base[key];
  }
  return base;
}

function buildNotification(payload: FcmPayload) {
  return {
    title: payload.title,
    body: payload.body,
    ...(payload.imageUrl?.trim() ? { imageUrl: payload.imageUrl.trim() } : {}),
  };
}

export async function sendToDeviceToken(token: string, payload: FcmPayload): Promise<void> {
  const message: Message = {
    token,
    notification: buildNotification(payload),
    data: stringData(payload),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };
  await getFirebaseAdminApp().messaging().send(message);
}

export async function sendToDeviceTokens(tokens: string[], payload: FcmPayload): Promise<void> {
  const unique = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
  if (!unique.length) return;
  if (unique.length === 1) {
    await sendToDeviceToken(unique[0]!, payload);
    return;
  }
  const message: MulticastMessage = {
    tokens: unique,
    notification: buildNotification(payload),
    data: stringData(payload),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };
  const res = await getFirebaseAdminApp().messaging().sendEachForMulticast(message);
  if (res.failureCount > 0) {
    logger.warn({ failureCount: res.failureCount, successCount: res.successCount }, 'FCM multicast partial failure');
  }
}

export async function sendToCompanyTopic(companyId: string, payload: FcmPayload): Promise<void> {
  const message: Message = {
    topic: companyTopic(companyId),
    notification: buildNotification(payload),
    data: stringData(payload),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };
  await getFirebaseAdminApp().messaging().send(message);
}
