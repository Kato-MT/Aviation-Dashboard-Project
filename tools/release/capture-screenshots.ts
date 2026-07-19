import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { chromium, type Page, type ViewportSize } from '@playwright/test';

import { APPLICATION_VERSION } from '../../src/core';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const outputDirectory = resolve(repositoryRoot, 'docs', 'screenshots');
const applicationUrl =
  process.env.SCREENSHOT_URL ?? 'http://127.0.0.1:4173/Aviation-Dashboard-Project/';

async function capture(
  page: Page,
  name: string,
  viewport: ViewportSize,
  tabName?: 'Diagnostics' | 'Investigation' | 'Configuration',
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto(applicationUrl, { waitUntil: 'networkidle' });
  await page.locator('#metric-accepted').waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('#metric-accepted')?.textContent?.trim() === '85',
  );
  if (tabName) {
    await page.getByRole('tab', { name: new RegExp(tabName, 'i') }).click();
    if (tabName === 'Investigation') {
      await page.getByRole('button', { name: 'Run investigation' }).click();
      await page.locator('#investigation-status').waitFor({ state: 'visible' });
      await page.waitForFunction(
        () =>
          document.querySelector('#investigation-status')?.textContent?.includes('indications') ===
          true,
      );
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.screenshot({
    path: resolve(outputDirectory, name),
    animations: 'disabled',
    fullPage: false,
  });
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await capture(page, 'workbench-desktop.png', { width: 1440, height: 1000 });
  await capture(page, 'workbench-diagnostics.png', { width: 1440, height: 1000 }, 'Diagnostics');
  await capture(
    page,
    'workbench-investigation.png',
    { width: 1440, height: 1000 },
    'Investigation',
  );
  await capture(
    page,
    'workbench-configuration.png',
    { width: 1440, height: 1000 },
    'Configuration',
  );
  await capture(page, 'workbench-mobile.png', { width: 390, height: 844 });
  await writeFile(
    resolve(outputDirectory, 'metadata.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'release-screenshots.v1',
        applicationVersion: APPLICATION_VERSION,
        browser: await browser.version(),
        source: 'included synthetic baseline',
        datasetHash: 'b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700',
        captures: [
          { file: 'workbench-desktop.png', viewport: { width: 1440, height: 1000 } },
          {
            file: 'workbench-diagnostics.png',
            viewport: { width: 1440, height: 1000 },
            view: 'Diagnostics',
          },
          {
            file: 'workbench-investigation.png',
            viewport: { width: 1440, height: 1000 },
            view: 'Investigation',
          },
          {
            file: 'workbench-configuration.png',
            viewport: { width: 1440, height: 1000 },
            view: 'Configuration',
          },
          { file: 'workbench-mobile.png', viewport: { width: 390, height: 844 } },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
} finally {
  await browser.close();
}

console.log(
  `screenshots: captured verified desktop, Investigation, and mobile views from ${applicationUrl}`,
);
