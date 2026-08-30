import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['browser/**/*.spec.ts', 'accessibility/**/*.spec.ts'],
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  outputDir: 'test-results/lab',
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/Aviation-Dashboard-Project/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:4173/Aviation-Dashboard-Project/v2.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
