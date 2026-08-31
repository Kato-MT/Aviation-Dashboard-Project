import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');
const PRIVATE_OUTPUT = join(REPOSITORY_ROOT, '.tmp-tests', 'live-performance-private');
const CLIENT_OUTPUT = join(REPOSITORY_ROOT, '.tmp-tests', 'performance-client');
const SERVER_IDENTITY = join(
  REPOSITORY_ROOT,
  '.tmp-tests',
  `performance-server-identity-${process.env.LIVE_TEST_PORT ?? '4174'}.json`,
);
const PUBLIC_OUTPUT = join(REPOSITORY_ROOT, 'test-results', 'live-performance');

function exactChild(path: string, parent: string, label: string): string {
  const resolvedPath = resolve(path);
  const difference = relative(resolve(parent), resolvedPath);
  if (
    difference.length === 0 ||
    difference === '..' ||
    difference.startsWith(`..${sep}`) ||
    difference.startsWith('/')
  ) {
    throw new Error(`${label} is not a bounded child path.`);
  }
  return resolvedPath;
}

async function resetGeneratedOutputs(): Promise<void> {
  const privateOutput = exactChild(
    PRIVATE_OUTPUT,
    join(REPOSITORY_ROOT, '.tmp-tests'),
    'Private output',
  );
  const clientOutput = exactChild(
    CLIENT_OUTPUT,
    join(REPOSITORY_ROOT, '.tmp-tests'),
    'Client output',
  );
  const serverIdentity = exactChild(
    SERVER_IDENTITY,
    join(REPOSITORY_ROOT, '.tmp-tests'),
    'Server identity',
  );
  const publicOutput = exactChild(
    PUBLIC_OUTPUT,
    join(REPOSITORY_ROOT, 'test-results'),
    'Aggregate output',
  );
  await Promise.all([
    rm(privateOutput, { recursive: true, force: true }),
    rm(clientOutput, { recursive: true, force: true }),
    rm(serverIdentity, { force: true }),
    rm(publicOutput, { recursive: true, force: true }),
  ]);
}

async function runPlaywright(): Promise<number> {
  return new Promise((accept, reject) => {
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (
        /^VITE_/iu.test(key) ||
        /^NODE_ENV$/iu.test(key) ||
        /^PLAYWRIGHT_NO_COPY_PROMPT$/iu.test(key)
      ) {
        delete environment[key];
      }
    }
    environment.NODE_ENV = 'production';
    environment.PLAYWRIGHT_NO_COPY_PROMPT = '1';
    const child = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI, 'test', '--config', 'playwright.performance.config.ts'],
      {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error('Browser performance runner was interrupted.'));
      else accept(code ?? 1);
    });
  });
}

async function auditAggregateOutput(): Promise<'pass' | 'fail'> {
  const entries = await readdir(PUBLIC_OUTPUT, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== 'report.json' || !entries[0].isFile()) {
    throw new Error('Browser performance output is not the one-file aggregate allowlist.');
  }
  const reportPath = join(PUBLIC_OUTPUT, 'report.json');
  const status = await lstat(reportPath);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > 64 * 1024) {
    throw new Error('Browser performance aggregate report has an invalid file identity.');
  }
  const text = await readFile(reportPath, 'utf8');
  if (
    /(?:[A-Za-z]:\\|\/Users\/|\/home\/|\bPX\d{4}\b|\bcallsign\b|\bregistration\b|\blatitude\b|\blongitude\b|https?:\/\/|wss?:\/\/|authorization|bearer|api[_-]?key)/iu.test(
      text,
    )
  ) {
    throw new Error('Browser performance aggregate report contains a forbidden detail canary.');
  }
  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).schemaVersion !== 'airspace-browser-performance.v2'
  ) {
    throw new Error('Browser performance aggregate report has an invalid envelope.');
  }
  const result = String((parsed as Record<string, unknown>).result);
  if (!['pass', 'fail'].includes(result)) {
    throw new Error('Browser performance aggregate report has an invalid result.');
  }
  return result as 'pass' | 'fail';
}

async function main(): Promise<void> {
  await resetGeneratedOutputs();
  let exitCode = 1;
  let reportResult: 'pass' | 'fail' | undefined;
  let auditError: unknown;
  try {
    exitCode = await runPlaywright();
    reportResult = await auditAggregateOutput();
  } catch (error) {
    auditError = error;
    await rm(PUBLIC_OUTPUT, { recursive: true, force: true });
  } finally {
    await Promise.all([
      rm(PRIVATE_OUTPUT, { recursive: true, force: true }),
      rm(SERVER_IDENTITY, { force: true }),
    ]);
  }
  if (auditError !== undefined) throw auditError;
  if (exitCode === 0 && reportResult !== 'pass') {
    throw new Error('Browser performance report rejected an otherwise passing test run.');
  }
  if (exitCode !== 0) throw new Error('Browser performance gates failed.');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
