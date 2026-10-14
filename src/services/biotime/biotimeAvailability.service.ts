import { prisma } from '../../prisma/client';

export const BIOTIME_LOCAL_FALLBACK_MESSAGE =
  'تعذر الاتصال بسيرفر البصمة — سيتم استخدام البصمات المخزّنة محلياً';

/** True when company BioTime has a usable host (IP/hostname). */
export async function isBioTimeConfigured(): Promise<boolean> {
  const config = await prisma.bioTimeConfig.findFirst({
    select: { serverIp: true, serverPort: true },
  });
  return Boolean(config?.serverIp?.trim() && Number(config.serverPort) > 0);
}

/** Connection / URL failures where local stored punches are a safe fallback. */
export function isBioTimeUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('invalid url') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('econnaborted') ||
    msg.includes('timeout of') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('network error') ||
    msg.includes('getaddrinfo') ||
    msg.includes('certificate') ||
    msg.includes('configuration not found') ||
    msg.includes('server url is not configured') ||
    msg.includes('biotime server')
  );
}
