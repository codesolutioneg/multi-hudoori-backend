import { describe, it, expect, beforeAll } from 'vitest';
import { UserRole } from '@prisma/client';
import { classifyRpcSurface, rpc } from '../helpers/api';
import {
  audienceForPath,
  extractMobileApiPaths,
  isAcceptableSurfaceOutcome,
  minimalParamsForPath,
  pathsOnlyInMobile,
  roleForAudience,
} from '../helpers/mobileApiInventory';
import {
  createUser,
  ensureBioTimeConfig,
  resetDatabase,
  seedMobileRoleTrio,
  type SeededUser,
} from '../helpers/db';

describe('mobile API path inventory', () => {
  it('extracts paths from Flutter biotime_api_client.dart', () => {
    const paths = extractMobileApiPaths();
    expect(paths.length).toBeGreaterThanOrEqual(340);
    expect(paths.every((p) => p.startsWith('/api/'))).toBe(true);
  });

  it('logs mobile-only paths vs dashboard (informational)', () => {
    const onlyMobile = pathsOnlyInMobile();
    expect(onlyMobile.length).toBeLessThan(50);
  });
});

describe('mobile API surface — route reachability (E / HR / BM)', () => {
  let tokens: Partial<Record<UserRole, string>>;
  let trio: Awaited<ReturnType<typeof seedMobileRoleTrio>>;

  beforeAll(async () => {
    await resetDatabase();
    await ensureBioTimeConfig();
    trio = await seedMobileRoleTrio();
    const platformAdmin = await createUser({
      login: 'mobile-pa@test.local',
      role: UserRole.PLATFORM_ADMIN,
    });
    tokens = {
      [UserRole.EMPLOYEE]: trio.employee.token,
      [UserRole.HR_MANAGER]: trio.hr.token,
      [UserRole.BRANCH_MANAGER]: trio.branchManager.token,
      [UserRole.PLATFORM_ADMIN]: platformAdmin.token,
    };
  });

  it('every mobile client path returns JSON-RPC (not HTTP 404/500)', async () => {
    const paths = extractMobileApiPaths();
    const failures: {
      path: string;
      audience: string;
      status: number;
      kind: string;
      snippet: string;
    }[] = [];

    for (const apiPath of paths) {
      const audience = audienceForPath(apiPath);
      const role = roleForAudience(audience);
      const params = minimalParamsForPath(apiPath);
      const token = role ? tokens[role] : undefined;

      const res = await rpc(apiPath, params, token);
      const kind = classifyRpcSurface(res);
      if (!isAcceptableSurfaceOutcome(kind)) {
        failures.push({
          path: apiPath,
          audience,
          status: res.status,
          kind,
          snippet: JSON.stringify(res.body).slice(0, 280),
        });
      }
    }

    if (failures.length) {
      const report = failures
        .map(
          (f) =>
            `  ${f.path} [${f.audience}] HTTP ${f.status} ${f.kind}\n    ${f.snippet}`,
        )
        .join('\n');
      expect.fail(`${failures.length} mobile path(s) not reachable:\n${report}`);
    }
  }, 120_000);
});
