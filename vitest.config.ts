import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // E2E specs share one Postgres database, so run files serially and fixtures
    // from one file never race another file's truncate.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // Operator scripts and process entrypoints: exercised by hand, not by CI
        'src/scripts/**',
        'src/server.ts',
        'src/types/**',
        'src/prisma/client.ts',
        '**/*.d.ts',
      ],
      // Floor sits just under the current numbers so a regression fails CI.
      // Ratchet upwards as coverage grows.
      thresholds: {
        lines: 52,
        statements: 52,
        functions: 60,
        branches: 58,
      },
    },
  },
});
