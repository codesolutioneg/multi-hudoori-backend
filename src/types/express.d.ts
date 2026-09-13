import { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      rpcParams?: Record<string, unknown>;
      rpcId?: number | string;
      user?: {
        id: string;
        login: string;
        name: string;
        role: UserRole;
        email?: string | null;
        locationId?: string | null;
        companyId?: string | null;
        /** Super Admin active company from switcher header/body. */
        activeCompanyId?: string | null;
      };
    }
  }
}

export {};
