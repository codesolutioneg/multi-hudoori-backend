import { prisma } from '../prisma/client';

/** Master switch from Settings → branch emails. Default on when the row is missing. */
export async function isLoanNotificationEmailEnabled(): Promise<boolean> {
  const row = await prisma.bioTimeConfig.findFirst({
    select: { loanNotificationEmailsEnabled: true },
  });
  return row?.loanNotificationEmailsEnabled !== false;
}
