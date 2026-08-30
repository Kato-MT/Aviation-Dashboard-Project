import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { G2_PLAYWRIGHT_TEMPORARY_OUTPUT } from '../../playwright.g2.config';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outputRoot = resolve(repositoryRoot, G2_PLAYWRIGHT_TEMPORARY_OUTPUT);
const expectedRelativeOutput = '.tmp-tests/g2-playwright';
const actualRelativeOutput = relative(repositoryRoot, outputRoot).replaceAll('\\', '/');

if (actualRelativeOutput !== expectedRelativeOutput) {
  throw new Error('G2 Playwright output cleanup escaped its fixed temporary root.');
}

async function removeTemporaryOutput(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
}

async function run(): Promise<number> {
  const playwrightCli = fileURLToPath(
    new URL('../../node_modules/@playwright/test/cli.js', import.meta.url),
  );
  return new Promise<number>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, 'test', '--config', 'playwright.g2.config.ts'],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    child.once('error', rejectRun);
    child.once('exit', (code) => resolveRun(code ?? 1));
  });
}

await removeTemporaryOutput();
try {
  process.exitCode = await run();
} finally {
  await removeTemporaryOutput();
}
