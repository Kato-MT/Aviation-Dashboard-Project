import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**', 'tests/accessibility/**'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'src/core/**/*.ts',
        'src/adapters/**/*.ts',
        'src/profiles/**/*.ts',
        'src/faults/**/*.ts',
        'src/verification/**/*.ts',
        'src/export/**/*.ts',
      ],
      exclude: ['**/*.d.ts', '**/index.ts', '**/types.ts'],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
