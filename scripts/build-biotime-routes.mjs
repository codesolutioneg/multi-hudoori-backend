#!/usr/bin/env node
/**
 * Rebuild dist/routes/biotime/index.js (esbuild bundle).
 * Keeps tenant ALS + Prisma client as shared modules (not duplicated in bundle).
 */
import { execSync } from 'node:child_process';
import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist/routes/biotime/index.js');

const external = [];
for (const p of ['', '../', '../../', '../../../', '../../../../', '../../../../../']) {
  external.push(`--external:${p}tenant/context`, `--external:${p}prisma/client`);
}

const cmd = [
  'npx esbuild src/routes/biotime/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${out}`,
  '--packages=external',
  ...external,
].join(' ');

execSync(cmd, { cwd: root, stdio: 'inherit' });

const routesDir = join(root, 'dist/routes');
mkdirSync(join(routesDir, 'tenant'), { recursive: true });
mkdirSync(join(routesDir, 'prisma'), { recursive: true });
const tenantLink = join(routesDir, 'tenant/context.js');
const prismaLink = join(routesDir, 'prisma/client.js');
if (!existsSync(tenantLink)) {
  symlinkSync('../../tenant/context.js', tenantLink);
}
if (!existsSync(prismaLink)) {
  symlinkSync('../../prisma/client.js', prismaLink);
}

console.log('Built', out);
