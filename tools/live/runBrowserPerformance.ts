import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { RUNTIME_POLICY_LIMITS } from '../../src/live/runtimePolicyLimits';
import { runtimePolicyCanonicalJson } from '../../src/live/runtimePolicy';
import { MAX_LIVE_MESSAGE_BYTES } from '../../src/live/validation';
import {
  createCompactPerformanceFailureReceipt,
  parseMaximumPerformanceFailureEvidence,
  performanceBrowserRuntimeIdentityIsEligible,
  performanceRunEnvironment,
  performanceRunPathsForId,
  PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT,
  PERFORMANCE_INTERACTION_NAMES,
  PERFORMANCE_PROJECT_NAMES,
  PERFORMANCE_REPORT_MAX_BYTES,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  requirePerformanceRunPaths,
  type PerformanceIdentityCapture,
  type PerformanceFailureCode,
  type PerformanceFailureStage,
  type PerformanceRunPaths,
  type PerformanceServerIdentity,
} from './performanceContract';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PLAYWRIGHT_CLI = createRequire(import.meta.url).resolve('@playwright/test/cli');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const TEMPORARY_OUTPUT_ROOT = join(REPOSITORY_ROOT, '.tmp-tests');
const PERFORMANCE_RUNS_ROOT = join(TEMPORARY_OUTPUT_ROOT, 'live-performance-runs');
const LEGACY_PRIVATE_OUTPUT = join(REPOSITORY_ROOT, '.tmp-tests', 'live-performance-private');
const LEGACY_CLIENT_OUTPUT = join(REPOSITORY_ROOT, '.tmp-tests', 'performance-client');
const LEGACY_SERVER_IDENTITY = join(
  TEMPORARY_OUTPUT_ROOT,
  `performance-server-identity-${process.env.LIVE_TEST_PORT ?? '4174'}.json`,
);
const PUBLIC_OUTPUT = join(REPOSITORY_ROOT, 'test-results', 'live-performance');
const REPORT_PATH = join(PUBLIC_OUTPUT, 'report.json');
const RUN_LOCK_PATH = join(TEMPORARY_OUTPUT_ROOT, 'live-performance-run.lock');
const RUNNER_MODULE_PATH = fileURLToPath(import.meta.url);
const PERFORMANCE_IDENTITY_HELPER = fileURLToPath(
  new URL('./capturePerformanceIdentity.ts', import.meta.url),
);
const execFileAsync = promisify(execFile);
const UUID_PATTERN_SOURCE = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_PATTERN_SOURCE}$`, 'u');
const GUARDIAN_SCHEMA_VERSION = 'airspace-performance-playwright-guardian.v1' as const;
const RUN_RECEIPT_SCHEMA_VERSION = 'airspace-performance-run.v1' as const;
const GUARDIAN_RESULT_SCHEMA_VERSION = 'airspace-performance-guardian-result.v1' as const;

interface PlaywrightGuardianPayload {
  readonly schemaVersion: typeof GUARDIAN_SCHEMA_VERSION;
  readonly lockPath: string;
  readonly owner: RunLockOwner;
  readonly runId: string;
}

export interface PerformanceRunReceipt {
  readonly schemaVersion: typeof RUN_RECEIPT_SCHEMA_VERSION;
  readonly runId: string;
  readonly lockToken: string;
  readonly coordinatorPid: number;
  readonly coordinatorProcessInstanceId: string;
  readonly createdAt: string;
}

export interface PerformanceRunContext {
  readonly paths: PerformanceRunPaths;
  readonly receipt: PerformanceRunReceipt;
}

export interface RunLockOwner {
  readonly schemaVersion: 'airspace-performance-run-lock.v2';
  readonly pid: number;
  readonly processInstanceId: string;
  readonly token: string;
  readonly startedAt: string;
}

export interface RunLockGuardianIdentity {
  readonly lockPath: string;
  readonly owner: RunLockOwner;
}

export interface RunLock {
  readonly guardianIdentity?: RunLockGuardianIdentity;
  owns(): Promise<boolean>;
  prepareFinalCommit(): Promise<void>;
  release(): Promise<void>;
}

export interface RunLockRuntime {
  readonly pid: number;
  readonly processInstanceId: string;
  now(): Date;
  processInstanceIdFor(pid: number): Promise<string | undefined>;
  processIsRunning(pid: number): boolean;
  onStage?(stage: 'candidate-written' | 'stale-quarantined'): Promise<void>;
}

export interface ExclusiveRunMutex {
  owns(): boolean;
  release(): Promise<void>;
}

interface RunLockSnapshot {
  readonly identity: string;
  readonly isRegularFile: boolean;
  readonly modifiedAtMs: number;
  readonly owner: RunLockOwner | undefined;
}

export interface PerformanceRunDependencies {
  acquireRunLock(): Promise<RunLock>;
  createRunContext(runLock: RunLock): Promise<PerformanceRunContext>;
  resetGeneratedOutputs(context: PerformanceRunContext): Promise<void>;
  runPlaywright(runLock: RunLock, context: PerformanceRunContext): Promise<number>;
  auditAggregateOutput(context: PerformanceRunContext): Promise<PerformanceAuditedAggregate>;
  publishAggregateOutput(aggregate: PerformanceAuditedAggregate): Promise<void>;
  writeCompactFailureReceipt(
    stage: PerformanceFailureStage,
    code: PerformanceFailureCode,
  ): Promise<void>;
  invalidateAggregateOutput(): Promise<void>;
  cleanupGeneratedPrivateOutputs(context: PerformanceRunContext): Promise<void>;
}

export interface PerformanceAuditedAggregate {
  readonly result: 'pass' | 'fail';
  readonly serialized: string;
}

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

function systemErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function parseRunLockOwner(value: unknown): RunLockOwner | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== 'airspace-performance-run-lock.v2' ||
    !Number.isSafeInteger((value as Record<string, unknown>).pid) ||
    ((value as Record<string, unknown>).pid as number) < 1 ||
    typeof (value as Record<string, unknown>).processInstanceId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(String((value as Record<string, unknown>).processInstanceId)) ||
    typeof (value as Record<string, unknown>).token !== 'string' ||
    !UUID_PATTERN.test(String((value as Record<string, unknown>).token)) ||
    typeof (value as Record<string, unknown>).startedAt !== 'string' ||
    !Number.isFinite(Date.parse(String((value as Record<string, unknown>).startedAt)))
  ) {
    return undefined;
  }
  return value as RunLockOwner;
}

async function readRunLockOwner(path: string): Promise<RunLockOwner | undefined> {
  try {
    return parseRunLockOwner(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function lockEntryIdentity(status: Awaited<ReturnType<typeof lstat>>, content: Buffer | undefined) {
  const contentSha256 =
    content === undefined ? 'non-file' : createHash('sha256').update(content).digest('hex');
  return [status.dev, status.ino, status.mode, status.size, contentSha256].join(':');
}

async function readRunLockSnapshot(path: string): Promise<RunLockSnapshot | undefined> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const content = before.isFile() && !before.isSymbolicLink() ? await readFile(path) : undefined;
  const after = await lstat(path);
  const beforeIdentity = lockEntryIdentity(before, content);
  const afterIdentity = lockEntryIdentity(after, content);
  if (beforeIdentity !== afterIdentity) {
    throw new Error('Performance run lock changed while its identity was captured.');
  }
  let owner: RunLockOwner | undefined;
  if (content !== undefined) {
    try {
      owner = parseRunLockOwner(JSON.parse(content.toString('utf8')) as unknown);
    } catch {
      owner = undefined;
    }
  }
  return {
    identity: beforeIdentity,
    isRegularFile: before.isFile() && !before.isSymbolicLink(),
    modifiedAtMs: before.mtimeMs,
    owner,
  };
}

type RunMutexRole = 'coordinator' | 'descendant';

function mutexEndpointId(lockPath: string, role: RunMutexRole): string {
  const normalized =
    process.platform === 'win32'
      ? resolve(lockPath).replaceAll('\\', '/').toLowerCase()
      : resolve(lockPath);
  return createHash('sha256').update(`${role}\0${normalized}`).digest('hex').slice(0, 32);
}

async function acquireExclusiveRunMutex(
  lockPath: string,
  role: RunMutexRole,
): Promise<ExclusiveRunMutex> {
  if (
    process.platform === 'win32' &&
    Object.prototype.hasOwnProperty.call(process.env, 'NODE_PENDING_PIPE_INSTANCES')
  ) {
    throw new Error(
      'NODE_PENDING_PIPE_INSTANCES is not permitted for the browser performance run mutex.',
    );
  }
  const endpointId = mutexEndpointId(lockPath, role);
  const server = createServer((socket) => socket.destroy());
  let lost = false;
  try {
    await new Promise<void>((accept, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.once('listening', () => {
        server.off('error', onError);
        accept();
      });
      if (process.platform === 'win32') {
        server.listen(`\\\\.\\pipe\\airspace-performance-run-${endpointId}`);
      } else if (process.platform === 'linux') {
        server.listen({ path: `\0airspace-performance-run-${endpointId}`, exclusive: true });
      } else {
        const port = 49_152 + (Number.parseInt(endpointId.slice(0, 4), 16) % 16_384);
        server.listen({ host: '127.0.0.1', port, exclusive: true });
      }
    });
  } catch (error) {
    if (systemErrorCode(error) === 'EADDRINUSE') {
      throw new Error(
        'Another browser performance runner already owns the operating-system mutex.',
        { cause: error },
      );
    }
    throw error;
  }
  const onUnexpectedError = () => {
    lost = true;
  };
  server.on('error', onUnexpectedError);
  let released = false;
  return {
    owns() {
      return !released && !lost && server.listening;
    },
    async release() {
      if (released) return;
      await new Promise<void>((accept, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else accept();
        });
      });
      server.off('error', onUnexpectedError);
      released = true;
    },
  };
}

export async function acquireRunDescendantLeaseAt(path: string): Promise<ExclusiveRunMutex> {
  return acquireExclusiveRunMutex(resolve(path), 'descendant');
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return systemErrorCode(error) !== 'ESRCH';
  }
}

function processInstanceDigest(platform: NodeJS.Platform, value: string): string {
  return createHash('sha256').update(`${platform}\0${value.trim()}`).digest('hex');
}

export async function processInstanceIdFor(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 1) return undefined;
      const fieldsAfterCommand = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fieldsAfterCommand[19];
      return startTicks === undefined
        ? undefined
        : processInstanceDigest(process.platform, startTicks);
    }
    if (process.platform === 'win32') {
      const script = `$target = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($target.StartTime.ToUniversalTime().Ticks)`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      return stdout.trim().length === 0
        ? undefined
        : processInstanceDigest(process.platform, stdout);
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout.trim().length === 0 ? undefined : processInstanceDigest(process.platform, stdout);
  } catch {
    return undefined;
  }
}

async function writeRunLockCandidate(path: string, owner: RunLockOwner): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameRunLockOwner(left: RunLockOwner | undefined, right: RunLockOwner): boolean {
  return (
    left?.token === right.token &&
    left.pid === right.pid &&
    left.processInstanceId === right.processInstanceId
  );
}

async function restoreQuarantinedRunLock(lockPath: string, quarantine: string): Promise<void> {
  try {
    await link(quarantine, lockPath);
  } catch (error) {
    if (systemErrorCode(error) === 'EEXIST') {
      throw new Error(
        'Performance run lock changed during recovery; the quarantined lock was retained.',
        { cause: error },
      );
    }
    throw error;
  }
  await rm(quarantine, { force: false });
}

async function runLockOwnerIsActive(
  owner: RunLockOwner,
  runtime: RunLockRuntime,
): Promise<boolean> {
  const runningInstance = await runtime.processInstanceIdFor(owner.pid);
  return (
    runningInstance === owner.processInstanceId ||
    (runningInstance === undefined && runtime.processIsRunning(owner.pid))
  );
}

interface RunLockOrphan {
  readonly path: string;
  readonly kind: 'candidate' | 'stale';
  readonly nameToken: string;
}

async function runLockOrphans(lockPath: string): Promise<RunLockOrphan[]> {
  const parent = dirname(lockPath);
  const lockName = basename(lockPath);
  const escapedLockName = escapedRegularExpression(lockName);
  const candidatePattern = new RegExp(
    `^${escapedLockName}\\.candidate\\.(${UUID_PATTERN_SOURCE})\\.([0-3])$`,
    'u',
  );
  const stalePattern = new RegExp(
    `^${escapedLockName}\\.stale\\.(${UUID_PATTERN_SOURCE})\\.([0-3])$`,
    'u',
  );
  const entries = await readdir(parent, { withFileTypes: true, encoding: 'utf8' });
  const orphans: RunLockOrphan[] = [];
  for (const entry of entries) {
    const candidateMatch = candidatePattern.exec(entry.name);
    const staleMatch = stalePattern.exec(entry.name);
    const match = candidateMatch ?? staleMatch;
    if (match === null) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('A browser performance run-lock orphan has an unsafe file type.');
    }
    const nameToken = match[1];
    if (nameToken === undefined) {
      throw new Error('A browser performance run-lock orphan has an invalid token.');
    }
    orphans.push({
      path: exactChild(join(parent, entry.name), parent, 'Performance run-lock orphan'),
      kind: candidateMatch === null ? 'stale' : 'candidate',
      nameToken,
    });
  }
  return orphans.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function cleanupRunLockOrphans(lockPath: string, runtime: RunLockRuntime): Promise<void> {
  for (const orphan of await runLockOrphans(lockPath)) {
    const observed = await readRunLockSnapshot(orphan.path);
    if (observed === undefined) continue;
    if (!observed.isRegularFile) {
      throw new Error('A browser performance run-lock orphan changed to an unsafe file type.');
    }
    if (
      orphan.kind === 'candidate' &&
      observed.owner !== undefined &&
      observed.owner.token !== orphan.nameToken
    ) {
      throw new Error('A browser performance run-lock candidate token does not match its receipt.');
    }
    if (observed.owner !== undefined && (await runLockOwnerIsActive(observed.owner, runtime))) {
      if (orphan.kind === 'stale' && (await readRunLockSnapshot(lockPath)) === undefined) {
        const immediatelyBeforeRestore = await readRunLockSnapshot(orphan.path);
        if (immediatelyBeforeRestore?.identity !== observed.identity) {
          throw new Error('A live quarantined run-lock receipt changed before restoration.');
        }
        await restoreQuarantinedRunLock(lockPath, orphan.path);
      }
      throw new Error('A run-lock orphan belongs to a live browser performance runner.');
    }
    const immediatelyBeforeDelete = await readRunLockSnapshot(orphan.path);
    if (immediatelyBeforeDelete?.identity !== observed.identity) {
      throw new Error('A browser performance run-lock orphan changed before deletion.');
    }
    await rm(orphan.path, { force: false });
  }
  if ((await runLockOrphans(lockPath)).length !== 0) {
    throw new Error('Browser performance run-lock orphan cleanup was incomplete.');
  }
}

function validGuardianRecoveryReceipt(value: unknown, runId: string): boolean {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== GUARDIAN_RESULT_SCHEMA_VERSION || value.runId !== runId) return false;
  if (Object.hasOwn(value, 'outcome')) {
    return (
      exactKeys(value, ['schemaVersion', 'runId', 'outcome', 'exitCode']) &&
      ['complete', 'coordinator-disconnected-before-start', 'coordinator-disconnected'].includes(
        String(value.outcome),
      ) &&
      Number.isSafeInteger(value.exitCode) &&
      (value.exitCode as number) >= 0
    );
  }
  return (
    exactKeys(value, ['schemaVersion', 'runId', 'state']) &&
    ['leased', 'started', 'complete', 'interrupted'].includes(String(value.state))
  );
}

async function readBoundedJson(path: string): Promise<unknown | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > 4096) {
      return undefined;
    }
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function recoverStalePerformanceRunRootsAt(
  runsRootInput: string,
  runtime: Pick<RunLockRuntime, 'processInstanceIdFor' | 'processIsRunning'>,
): Promise<void> {
  const runsRoot = resolve(runsRootInput);
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (systemErrorCode(error) === 'ENOENT') return [];
    throw error;
  });
  if (entries.length > 256) {
    throw new Error('Browser performance stale run-root inventory exceeds its bound.');
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name)
    ) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Browser performance stale run root has an unsafe file type.');
    }
    const root = exactChild(join(runsRoot, entry.name), runsRoot, 'Stale performance run root');
    const before = await lstat(root);
    const receiptPath = exactChild(join(root, 'run.json'), root, 'Stale performance run receipt');
    const receipt = await readPerformanceRunReceipt(receiptPath);
    if (receipt === undefined || receipt.runId !== entry.name) {
      throw new Error('Browser performance stale run root lacks an exact identity receipt.');
    }
    const activeInstance = await runtime.processInstanceIdFor(receipt.coordinatorPid);
    if (
      activeInstance === receipt.coordinatorProcessInstanceId ||
      (activeInstance === undefined && runtime.processIsRunning(receipt.coordinatorPid))
    ) {
      throw new Error('Browser performance stale run root belongs to a live coordinator.');
    }
    const state = await readBoundedJson(join(root, 'guardian', 'state.json'));
    const result = await readBoundedJson(join(root, 'guardian', 'result.json'));
    if (
      (state !== undefined && !validGuardianRecoveryReceipt(state, receipt.runId)) ||
      (result !== undefined && !validGuardianRecoveryReceipt(result, receipt.runId))
    ) {
      throw new Error('Browser performance stale guardian receipt is invalid.');
    }
    if (state !== undefined && result === undefined) {
      continue;
    }
    const immediatelyBeforeDelete = await lstat(root);
    const retainedReceipt = await readPerformanceRunReceipt(receiptPath);
    if (
      directoryIdentity(before) !== directoryIdentity(immediatelyBeforeDelete) ||
      JSON.stringify(retainedReceipt) !== JSON.stringify(receipt)
    ) {
      throw new Error('Browser performance stale run root changed before recovery.');
    }
    await rm(root, { recursive: true, force: false });
  }
}

export async function acquireRunLockAt(path: string, runtime: RunLockRuntime): Promise<RunLock> {
  const lockPath = resolve(path);
  await mkdir(dirname(lockPath), { recursive: true });
  const mutex = await acquireExclusiveRunMutex(lockPath, 'coordinator');
  let mutexAdoptedByRunLock = false;
  const owner: RunLockOwner = {
    schemaVersion: 'airspace-performance-run-lock.v2',
    pid: runtime.pid,
    processInstanceId: runtime.processInstanceId,
    token: randomUUID(),
    startedAt: runtime.now().toISOString(),
  };
  let descendantProbe: ExclusiveRunMutex | undefined;
  try {
    const acquiredDescendantProbe = await acquireRunDescendantLeaseAt(lockPath);
    descendantProbe = acquiredDescendantProbe;
    await cleanupRunLockOrphans(lockPath, runtime);
    await recoverStalePerformanceRunRootsAt(
      join(dirname(lockPath), 'live-performance-runs'),
      runtime,
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = `${lockPath}.candidate.${owner.token}.${attempt}`;
      await writeRunLockCandidate(candidate, owner);
      await runtime.onStage?.('candidate-written');
      try {
        await link(candidate, lockPath);
        await rm(candidate, { force: true });
        let released = false;
        let preparedForFinalCommit = false;
        const runLock: RunLock = {
          guardianIdentity: { lockPath, owner },
          async owns() {
            return (
              !released &&
              mutex.owns() &&
              (preparedForFinalCommit || sameRunLockOwner(await readRunLockOwner(lockPath), owner))
            );
          },
          async prepareFinalCommit() {
            if (released || preparedForFinalCommit) {
              throw new Error('Performance run lock cannot prepare its final commit twice.');
            }
            if (!mutex.owns() || !sameRunLockOwner(await readRunLockOwner(lockPath), owner)) {
              throw new Error('Performance run lock ownership changed before final commit.');
            }
            await rm(lockPath, { force: false });
            if (!mutex.owns()) {
              throw new Error('Performance run mutex was lost while preparing the final commit.');
            }
            preparedForFinalCommit = true;
          },
          async release() {
            if (released) return;
            if (
              !mutex.owns() ||
              (!preparedForFinalCommit &&
                !sameRunLockOwner(await readRunLockOwner(lockPath), owner))
            ) {
              throw new Error('Performance run lock ownership changed before release.');
            }
            if (!preparedForFinalCommit) await rm(lockPath, { force: false });
            await mutex.release();
            released = true;
          },
        };
        if (!(await runLock.owns())) {
          throw new Error('Performance run lock ownership was not established after acquisition.');
        }
        await acquiredDescendantProbe.release();
        descendantProbe = undefined;
        mutexAdoptedByRunLock = true;
        return runLock;
      } catch (error) {
        await rm(candidate, { force: true }).catch(() => undefined);
        if (systemErrorCode(error) !== 'EEXIST') throw error;
      }

      const observed = await readRunLockSnapshot(lockPath);
      if (observed === undefined) continue;
      if (observed.owner === undefined) {
        if (runtime.now().getTime() - observed.modifiedAtMs < 30_000) {
          throw new Error('Another browser performance runner owns an invalid recent run lock.');
        }
      } else {
        if (await runLockOwnerIsActive(observed.owner, runtime)) {
          throw new Error('Another browser performance runner already owns the run lock.');
        }
      }

      const immediatelyBeforeRename = await readRunLockSnapshot(lockPath);
      if (immediatelyBeforeRename?.identity !== observed.identity) {
        throw new Error('Performance run lock changed before stale-lock recovery.');
      }
      const quarantine = `${lockPath}.stale.${owner.token}.${attempt}`;
      try {
        await rename(lockPath, quarantine);
      } catch (error) {
        if (systemErrorCode(error) === 'ENOENT') continue;
        throw error;
      }
      await runtime.onStage?.('stale-quarantined');
      const quarantined = await readRunLockSnapshot(quarantine).catch(() => undefined);
      if (quarantined?.identity !== observed.identity) {
        await restoreQuarantinedRunLock(lockPath, quarantine);
        throw new Error('Performance run lock changed during stale-lock recovery.');
      }
      const immediatelyBeforeDelete = await readRunLockSnapshot(quarantine);
      if (immediatelyBeforeDelete?.identity !== observed.identity) {
        await restoreQuarantinedRunLock(lockPath, quarantine);
        throw new Error('Performance run lock changed before stale-lock quarantine deletion.');
      }
      await rm(quarantine, { recursive: true, force: false });
    }
    throw new Error('The browser performance run lock could not be acquired safely.');
  } finally {
    try {
      await descendantProbe?.release();
    } finally {
      if (!mutexAdoptedByRunLock) await mutex.release();
    }
  }
}

export async function acquireRunLockForCurrentProcessAt(path: string): Promise<RunLock> {
  const processInstanceId = await processInstanceIdFor(process.pid);
  if (processInstanceId === undefined) {
    throw new Error('Performance runner process identity is unavailable.');
  }
  return acquireRunLockAt(path, {
    pid: process.pid,
    processInstanceId,
    now: () => new Date(),
    processInstanceIdFor,
    processIsRunning,
  });
}

async function acquireRunLock(): Promise<RunLock> {
  const lockPath = exactChild(RUN_LOCK_PATH, TEMPORARY_OUTPUT_ROOT, 'Performance run lock');
  return acquireRunLockForCurrentProcessAt(lockPath);
}

export function parsePerformanceRunReceipt(value: unknown): PerformanceRunReceipt | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(
        [
          'schemaVersion',
          'runId',
          'lockToken',
          'coordinatorPid',
          'coordinatorProcessInstanceId',
          'createdAt',
        ].sort(),
      ) ||
    receipt.schemaVersion !== RUN_RECEIPT_SCHEMA_VERSION ||
    typeof receipt.runId !== 'string' ||
    typeof receipt.lockToken !== 'string' ||
    !UUID_PATTERN.test(receipt.lockToken) ||
    !Number.isSafeInteger(receipt.coordinatorPid) ||
    (receipt.coordinatorPid as number) < 1 ||
    typeof receipt.coordinatorProcessInstanceId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(receipt.coordinatorProcessInstanceId) ||
    typeof receipt.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.createdAt))
  ) {
    return undefined;
  }
  try {
    performanceRunPathsForId(REPOSITORY_ROOT, receipt.runId);
  } catch {
    return undefined;
  }
  return receipt as unknown as PerformanceRunReceipt;
}

async function readPerformanceRunReceipt(path: string): Promise<PerformanceRunReceipt | undefined> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size < 1 || status.size > 4096) {
      return undefined;
    }
    return parsePerformanceRunReceipt(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

async function writeSyncedFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createPerformanceRunContext(
  runLock: RunLock,
  runId = randomUUID(),
): Promise<PerformanceRunContext> {
  const identity = runLock.guardianIdentity;
  if (identity === undefined) {
    throw new Error('Browser performance run lock lacks a namespace identity.');
  }
  const paths = performanceRunPathsForId(REPOSITORY_ROOT, runId);
  if (resolve(paths.runsRoot) !== resolve(PERFORMANCE_RUNS_ROOT)) {
    throw new Error('Browser performance run namespace root is inconsistent.');
  }
  const receipt: PerformanceRunReceipt = {
    schemaVersion: RUN_RECEIPT_SCHEMA_VERSION,
    runId: paths.runId,
    lockToken: identity.owner.token,
    coordinatorPid: identity.owner.pid,
    coordinatorProcessInstanceId: identity.owner.processInstanceId,
    createdAt: new Date().toISOString(),
  };
  await mkdir(TEMPORARY_OUTPUT_ROOT, { recursive: true });
  const temporaryStatus = await lstat(TEMPORARY_OUTPUT_ROOT);
  if (!temporaryStatus.isDirectory() || temporaryStatus.isSymbolicLink()) {
    throw new Error('Browser performance temporary root has an unsafe identity.');
  }
  await mkdir(paths.runsRoot, { recursive: true });
  const runsStatus = await lstat(paths.runsRoot);
  if (!runsStatus.isDirectory() || runsStatus.isSymbolicLink()) {
    throw new Error('Browser performance runs root has an unsafe identity.');
  }
  let runRootCreated = false;
  try {
    await mkdir(paths.runRoot, { recursive: false });
    runRootCreated = true;
    const runStatus = await lstat(paths.runRoot);
    if (!runStatus.isDirectory() || runStatus.isSymbolicLink()) {
      throw new Error('Browser performance run root has an unsafe identity.');
    }
    await Promise.all([
      mkdir(paths.identityDirectory, { recursive: false }),
      mkdir(paths.guardianDirectory, { recursive: false }),
      mkdir(paths.stagedDirectory, { recursive: false }),
    ]);
    await writeSyncedFile(paths.runReceipt, `${JSON.stringify(receipt)}\n`);
    const retained = await readPerformanceRunReceipt(paths.runReceipt);
    if (JSON.stringify(retained) !== JSON.stringify(receipt)) {
      throw new Error('Browser performance run namespace receipt was not retained exactly.');
    }
    return { paths, receipt };
  } catch (error) {
    if (runRootCreated) {
      await rm(paths.runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

function escapedRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function serverIdentityOutputPathsAt(
  rootInput: string,
  finalName: string,
): Promise<string[]> {
  const root = resolve(rootInput);
  const temporaryPattern = new RegExp(`^${escapedRegularExpression(finalName)}\\.\\d+\\.tmp$`, 'u');
  const entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' }).catch(
    (error: unknown) => {
      if (systemErrorCode(error) === 'ENOENT') return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.name === finalName || temporaryPattern.test(entry.name))
    .map((entry) => exactChild(join(root, entry.name), root, 'Server identity output'));
}

export async function removeServerIdentityOutputsAt(
  root: string,
  finalName: string,
): Promise<void> {
  const paths = await serverIdentityOutputPathsAt(root, finalName);
  await Promise.all(paths.map((path) => rm(path, { force: true, maxRetries: 3, retryDelay: 50 })));
}

function samePerformanceRunContext(
  retained: PerformanceRunReceipt | undefined,
  context: PerformanceRunContext,
): boolean {
  return retained !== undefined && JSON.stringify(retained) === JSON.stringify(context.receipt);
}

async function assertPerformanceRunContext(context: PerformanceRunContext): Promise<void> {
  const derived = performanceRunPathsForId(REPOSITORY_ROOT, context.receipt.runId);
  if (
    JSON.stringify(derived) !== JSON.stringify(context.paths) ||
    !samePerformanceRunContext(await readPerformanceRunReceipt(context.paths.runReceipt), context)
  ) {
    throw new Error('Browser performance run namespace identity changed.');
  }
}

export async function resetPerformanceRunNamespace(context: PerformanceRunContext): Promise<void> {
  await assertPerformanceRunContext(context);
  await Promise.all([
    rm(context.paths.playwrightOutput, { recursive: true, force: true }),
    rm(context.paths.clientOutput, { recursive: true, force: true }),
    rm(context.paths.viteCache, { recursive: true, force: true }),
    rm(context.paths.identityDirectory, { recursive: true, force: true }),
    rm(context.paths.guardianDirectory, { recursive: true, force: true }),
    rm(context.paths.stagedDirectory, { recursive: true, force: true }),
  ]);
  await Promise.all([
    mkdir(context.paths.identityDirectory, { recursive: false }),
    mkdir(context.paths.guardianDirectory, { recursive: false }),
    mkdir(context.paths.stagedDirectory, { recursive: false }),
  ]);
  await assertPerformanceRunContext(context);
}

async function resetGeneratedOutputs(context: PerformanceRunContext): Promise<void> {
  const legacyPrivateOutput = exactChild(
    LEGACY_PRIVATE_OUTPUT,
    TEMPORARY_OUTPUT_ROOT,
    'Legacy private output',
  );
  const legacyClientOutput = exactChild(
    LEGACY_CLIENT_OUTPUT,
    TEMPORARY_OUTPUT_ROOT,
    'Legacy client output',
  );
  await Promise.all([
    resetPerformanceRunNamespace(context),
    rm(legacyPrivateOutput, { recursive: true, force: true }),
    rm(legacyClientOutput, { recursive: true, force: true }),
    removeServerIdentityOutputsAt(TEMPORARY_OUTPUT_ROOT, basename(LEGACY_SERVER_IDENTITY)),
  ]);
}

export async function cleanupPerformanceRunNamespace(
  context: PerformanceRunContext,
): Promise<void> {
  await assertPerformanceRunContext(context);
  await rm(context.paths.runRoot, {
    recursive: true,
    force: false,
    maxRetries: 3,
    retryDelay: 50,
  });
  try {
    await lstat(context.paths.runRoot);
    throw new Error('Browser performance run-local output cleanup was incomplete.');
  } catch (error) {
    if (systemErrorCode(error) !== 'ENOENT') throw error;
  }
}

const cleanupGeneratedPrivateOutputs = cleanupPerformanceRunNamespace;

export function playwrightEnvironment(paths: PerformanceRunPaths): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^VITE_/iu.test(key) ||
      /^AIRSPACE_PERFORMANCE_/u.test(key) ||
      /^NODE_ENV$/iu.test(key) ||
      /^PLAYWRIGHT_NO_COPY_PROMPT$/iu.test(key)
    ) {
      delete environment[key];
    }
  }
  Object.assign(environment, performanceRunEnvironment(paths));
  environment.NODE_ENV = 'production';
  environment.PLAYWRIGHT_NO_COPY_PROMPT = '1';
  return environment;
}

function serializeGuardianPayload(
  identity: RunLockGuardianIdentity,
  paths: PerformanceRunPaths,
): string {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: GUARDIAN_SCHEMA_VERSION,
      lockPath: identity.lockPath,
      owner: identity.owner,
      runId: paths.runId,
    } satisfies PlaywrightGuardianPayload),
    'utf8',
  ).toString('base64url');
}

export function playwrightGuardianSpawnArguments(
  identity: RunLockGuardianIdentity,
  paths: PerformanceRunPaths,
): string[] {
  return [
    '--import',
    TSX_LOADER,
    RUNNER_MODULE_PATH,
    '--playwright-guardian',
    serializeGuardianPayload(identity, paths),
  ];
}

function parseGuardianPayload(value: string | undefined): PlaywrightGuardianPayload | undefined {
  if (value === undefined || value.length < 1 || value.length > 8_192) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).schemaVersion !== GUARDIAN_SCHEMA_VERSION ||
      typeof (parsed as Record<string, unknown>).lockPath !== 'string' ||
      typeof (parsed as Record<string, unknown>).runId !== 'string'
    ) {
      return undefined;
    }
    const lockPath = String((parsed as Record<string, unknown>).lockPath);
    const runId = String((parsed as Record<string, unknown>).runId);
    const owner = parseRunLockOwner((parsed as Record<string, unknown>).owner);
    if (resolve(lockPath) !== lockPath || owner === undefined) return undefined;
    performanceRunPathsForId(REPOSITORY_ROOT, runId);
    return { schemaVersion: GUARDIAN_SCHEMA_VERSION, lockPath, owner, runId };
  } catch {
    return undefined;
  }
}

async function writeRunLocalGuardianJson(
  path: string,
  paths: PerformanceRunPaths,
  value: unknown,
): Promise<void> {
  if (path !== paths.guardianState && path !== paths.guardianResult) {
    throw new Error('Playwright guardian output path is outside its run namespace.');
  }
  const directoryStatus = await lstat(paths.guardianDirectory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error('Playwright guardian directory has an unsafe identity.');
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > 4096) {
      throw new Error('Playwright guardian receipt exceeds its bounded size.');
    }
    await writeSyncedFile(temporary, serialized);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeGuardianState(
  paths: PerformanceRunPaths,
  state: 'leased' | 'started' | 'complete' | 'interrupted',
): Promise<void> {
  await writeRunLocalGuardianJson(paths.guardianState, paths, {
    schemaVersion: GUARDIAN_RESULT_SCHEMA_VERSION,
    runId: paths.runId,
    state,
  });
}

async function writeGuardianResult(
  paths: PerformanceRunPaths,
  outcome: 'complete' | 'coordinator-disconnected-before-start' | 'coordinator-disconnected',
  exitCode: number,
): Promise<void> {
  await writeRunLocalGuardianJson(paths.guardianResult, paths, {
    schemaVersion: GUARDIAN_RESULT_SCHEMA_VERSION,
    runId: paths.runId,
    outcome,
    exitCode,
  });
}

async function cleanupInterruptedRunOutputs(paths: PerformanceRunPaths): Promise<void> {
  await Promise.all([
    rm(paths.playwrightOutput, { recursive: true, force: true }),
    rm(paths.clientOutput, { recursive: true, force: true }),
    rm(paths.viteCache, { recursive: true, force: true }),
    rm(paths.identityDirectory, { recursive: true, force: true }),
    rm(paths.stagedDirectory, { recursive: true, force: true }),
  ]);
}

function directoryIdentity(status: Awaited<ReturnType<typeof lstat>>): string {
  return [status.dev, status.ino, status.mode].join(':');
}

async function assertGuardianRunNamespace(
  paths: PerformanceRunPaths,
  payload: PlaywrightGuardianPayload,
  expectedRunRootIdentity?: string,
): Promise<string> {
  const status = await lstat(paths.runRoot);
  const receipt = await readPerformanceRunReceipt(paths.runReceipt);
  const identity = directoryIdentity(status);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (expectedRunRootIdentity !== undefined && identity !== expectedRunRootIdentity) ||
    receipt?.runId !== paths.runId ||
    receipt.lockToken !== payload.owner.token ||
    receipt.coordinatorPid !== payload.owner.pid ||
    receipt.coordinatorProcessInstanceId !== payload.owner.processInstanceId
  ) {
    throw new Error('Playwright guardian run namespace identity changed.');
  }
  return identity;
}

function guardedChildExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => accept({ code, signal }));
  });
}

export interface GuardedProcessTreeRuntime {
  readonly platform: NodeJS.Platform;
  terminateWindowsTree(pid: number): Promise<void>;
  holdAfterUnverifiedWindowsTermination(error: unknown): Promise<never>;
  signalPosixGroup(processGroupId: number, signal: NodeJS.Signals | 0): void;
  wait(milliseconds: number): Promise<void>;
  holdAfterUnverifiedPosixTermination(error: unknown): Promise<never>;
}

const GUARDED_PROCESS_TREE_RUNTIME: GuardedProcessTreeRuntime = {
  platform: process.platform,
  async terminateWindowsTree(pid) {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
    });
  },
  async holdAfterUnverifiedWindowsTermination() {
    process.stderr.write(
      'Playwright guardian could not verify Windows descendant-tree termination; the lease remains held.\n',
    );
    return new Promise<never>(() => undefined);
  },
  signalPosixGroup(processGroupId, signal) {
    process.kill(-processGroupId, signal);
  },
  async wait(milliseconds) {
    await new Promise((accept) => setTimeout(accept, milliseconds));
  },
  async holdAfterUnverifiedPosixTermination() {
    process.stderr.write(
      'Playwright guardian could not verify POSIX descendant-process-group termination; the lease remains held.\n',
    );
    return new Promise<never>(() => undefined);
  },
};

async function verifyPosixProcessGroupAbsent(
  processGroupId: number,
  runtime: GuardedProcessTreeRuntime,
): Promise<void> {
  try {
    runtime.signalPosixGroup(processGroupId, 'SIGKILL');
  } catch (error) {
    if (systemErrorCode(error) === 'ESRCH') return;
    await runtime.holdAfterUnverifiedPosixTermination(error);
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      runtime.signalPosixGroup(processGroupId, 0);
    } catch (error) {
      if (systemErrorCode(error) === 'ESRCH') return;
      await runtime.holdAfterUnverifiedPosixTermination(error);
    }
    await runtime.wait(100);
  }
  await runtime.holdAfterUnverifiedPosixTermination(
    new Error('POSIX descendant process group remained present after SIGKILL.'),
  );
}

export async function terminateGuardedProcessTree(
  child: ChildProcess,
  exit: Promise<{ code: number | null; signal: string | null }>,
  runtime: GuardedProcessTreeRuntime = GUARDED_PROCESS_TREE_RUNTIME,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (runtime.platform === 'win32') {
    try {
      await runtime.terminateWindowsTree(pid);
    } catch (error) {
      await runtime.holdAfterUnverifiedWindowsTermination(error);
    }
  } else {
    try {
      runtime.signalPosixGroup(pid, 'SIGTERM');
    } catch (error) {
      if (systemErrorCode(error) !== 'ESRCH') {
        await runtime.holdAfterUnverifiedPosixTermination(error);
      }
    }
  }
  const exited = await Promise.race([
    exit.then(() => true),
    new Promise<false>((accept) => setTimeout(() => accept(false), 5_000)),
  ]);
  if (!exited && runtime.platform !== 'win32') {
    try {
      runtime.signalPosixGroup(pid, 'SIGKILL');
    } catch (error) {
      if (systemErrorCode(error) !== 'ESRCH') {
        await runtime.holdAfterUnverifiedPosixTermination(error);
      }
    }
  }
  const killed =
    exited ||
    (await Promise.race([
      exit.then(() => true),
      new Promise<false>((accept) => setTimeout(() => accept(false), 5_000)),
    ]));
  if (!killed) {
    process.stderr.write('Playwright guardian could not confirm descendant-tree termination.\n');
    await new Promise<never>(() => undefined);
  }
  if (runtime.platform !== 'win32') {
    await verifyPosixProcessGroupAbsent(pid, runtime);
  }
}

export function guardianPreStartDecision(state: {
  readonly disconnected: boolean;
  readonly connected: boolean;
  readonly currentProcessInstanceId: string | undefined;
  readonly retainedOwner: RunLockOwner | undefined;
  readonly expectedOwner: RunLockOwner;
}): 'start' | 'coordinator-disconnected' | 'ownership-lost' {
  if (state.disconnected || !state.connected) return 'coordinator-disconnected';
  if (
    state.currentProcessInstanceId !== state.expectedOwner.processInstanceId ||
    !sameRunLockOwner(state.retainedOwner, state.expectedOwner)
  ) {
    return 'ownership-lost';
  }
  return 'start';
}

export async function guardianPreStartGate(state: {
  readonly disconnected: () => boolean;
  readonly connected: () => boolean;
  readonly loadCurrentProcessInstanceId: () => Promise<string | undefined>;
  readonly loadRetainedOwner: () => Promise<RunLockOwner | undefined>;
  readonly expectedOwner: RunLockOwner;
  readonly start: () => void;
}): Promise<'started' | 'coordinator-disconnected' | 'ownership-lost'> {
  const currentProcessInstanceId = await state.loadCurrentProcessInstanceId();
  const retainedOwner = await state.loadRetainedOwner();
  const decision = guardianPreStartDecision({
    disconnected: state.disconnected(),
    connected: state.connected(),
    currentProcessInstanceId,
    retainedOwner,
    expectedOwner: state.expectedOwner,
  });
  if (decision !== 'start') return decision;
  state.start();
  return 'started';
}

async function runPlaywrightGuardian(payloadValue: string | undefined): Promise<number> {
  const payload = parseGuardianPayload(payloadValue);
  if (payload === undefined || process.ppid !== payload.owner.pid) {
    throw new Error('Playwright guardian received an invalid coordinator identity.');
  }
  const paths = requirePerformanceRunPaths(REPOSITORY_ROOT, process.env);
  if (paths.runId !== payload.runId) {
    throw new Error('Playwright guardian run namespace does not match its payload.');
  }
  const lease = await acquireRunDescendantLeaseAt(payload.lockPath);
  let disconnected = !process.connected;
  let notifyDisconnect: (() => void) | undefined;
  const coordinatorDisconnected = new Promise<'coordinator-disconnected'>((accept) => {
    notifyDisconnect = () => {
      disconnected = true;
      accept('coordinator-disconnected');
    };
    process.once('disconnect', notifyDisconnect);
    if (!process.connected) notifyDisconnect();
  });
  let guardedChild: ChildProcess | undefined;
  let guardedChildExitPromise: Promise<{ code: number | null; signal: string | null }> | undefined;
  try {
    const runRootIdentity = await assertGuardianRunNamespace(paths, payload);
    if (
      (await processInstanceIdFor(payload.owner.pid)) !== payload.owner.processInstanceId ||
      !sameRunLockOwner(await readRunLockOwner(payload.lockPath), payload.owner) ||
      disconnected ||
      !process.connected
    ) {
      throw new Error('Playwright guardian coordinator ownership was lost before child startup.');
    }
    const startCommand = new Promise<'start'>((accept) => {
      const receiveStart = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          !Array.isArray(message) &&
          (message as Record<string, unknown>).type === 'performance-guardian-start'
        ) {
          process.off('message', receiveStart);
          accept('start');
        }
      };
      process.on('message', receiveStart);
    });
    await writeGuardianState(paths, 'leased');
    await new Promise<void>((accept, reject) => {
      process.send?.({ type: 'performance-guardian-leased' }, (error) => {
        if (error) reject(error);
        else accept();
      });
    });
    const command = await Promise.race([startCommand, coordinatorDisconnected]);
    if (command === 'coordinator-disconnected' || disconnected || !process.connected) {
      await assertGuardianRunNamespace(paths, payload, runRootIdentity);
      await cleanupInterruptedRunOutputs(paths);
      await writeGuardianState(paths, 'interrupted');
      await writeGuardianResult(paths, 'coordinator-disconnected-before-start', 1);
      return 1;
    }
    await assertGuardianRunNamespace(paths, payload, runRootIdentity);
    const preStartDecision = await guardianPreStartGate({
      disconnected: () => disconnected,
      connected: () => process.connected,
      loadCurrentProcessInstanceId: () => processInstanceIdFor(payload.owner.pid),
      loadRetainedOwner: () => readRunLockOwner(payload.lockPath),
      expectedOwner: payload.owner,
      start: () => {
        guardedChild = spawn(
          process.execPath,
          [PLAYWRIGHT_CLI, 'test', '--config', 'playwright.performance.config.ts', '--retries=0'],
          {
            cwd: REPOSITORY_ROOT,
            env: playwrightEnvironment(paths),
            stdio: 'inherit',
            windowsHide: true,
            detached: process.platform !== 'win32',
          },
        );
        guardedChildExitPromise = guardedChildExit(guardedChild);
      },
    });
    if (preStartDecision === 'coordinator-disconnected') {
      await assertGuardianRunNamespace(paths, payload, runRootIdentity);
      await cleanupInterruptedRunOutputs(paths);
      await writeGuardianState(paths, 'interrupted');
      await writeGuardianResult(paths, 'coordinator-disconnected-before-start', 1);
      return 1;
    }
    if (preStartDecision === 'ownership-lost') {
      throw new Error('Playwright guardian coordinator ownership was lost before START.');
    }
    if (guardedChild === undefined || guardedChildExitPromise === undefined) {
      throw new Error('Playwright guardian did not start its guarded child.');
    }
    const exit = guardedChildExitPromise;
    await assertGuardianRunNamespace(paths, payload, runRootIdentity);
    await writeGuardianState(paths, 'started');
    await new Promise<void>((accept, reject) => {
      process.send?.({ type: 'performance-guardian-started' }, (error) => {
        if (error) reject(error);
        else accept();
      });
    });
    const outcome = await Promise.race([
      exit.then((result) => ({ type: 'child-exit' as const, result })),
      coordinatorDisconnected.then(() => ({ type: 'coordinator-disconnected' as const })),
    ]);
    if (outcome.type === 'coordinator-disconnected') {
      await terminateGuardedProcessTree(guardedChild, exit);
      await assertGuardianRunNamespace(paths, payload, runRootIdentity);
      await cleanupInterruptedRunOutputs(paths);
      await writeGuardianState(paths, 'interrupted');
      await writeGuardianResult(paths, 'coordinator-disconnected', 1);
      return 1;
    }
    if (notifyDisconnect !== undefined) process.off('disconnect', notifyDisconnect);
    const exitCode = outcome.result.signal === null ? (outcome.result.code ?? 1) : 1;
    await assertGuardianRunNamespace(paths, payload, runRootIdentity);
    await writeGuardianState(paths, 'complete');
    await writeGuardianResult(paths, 'complete', exitCode);
    await new Promise<void>((accept, reject) => {
      process.send?.({ type: 'performance-guardian-complete', exitCode }, (error) => {
        if (error) reject(error);
        else accept();
      });
    });
    return exitCode;
  } finally {
    if (notifyDisconnect !== undefined) process.off('disconnect', notifyDisconnect);
    try {
      if (
        guardedChild !== undefined &&
        guardedChildExitPromise !== undefined &&
        guardedChild.exitCode === null &&
        guardedChild.signalCode === null
      ) {
        await terminateGuardedProcessTree(guardedChild, guardedChildExitPromise);
      }
      await lease.release();
    } finally {
      if (process.connected) process.disconnect?.();
    }
  }
}

async function runPlaywright(runLock: RunLock, context: PerformanceRunContext): Promise<number> {
  const identity = runLock.guardianIdentity;
  if (identity === undefined) {
    throw new Error('Browser performance run lock lacks a Playwright guardian identity.');
  }
  return new Promise((accept, reject) => {
    let guardianLeased = false;
    let guardianStarted = false;
    let guardianCompleted = false;
    let completionExitCode: number | undefined;
    let settled = false;
    const guardian = spawn(
      process.execPath,
      playwrightGuardianSpawnArguments(identity, context.paths),
      {
        cwd: REPOSITORY_ROOT,
        env: playwrightEnvironment(context.paths),
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
        detached: true,
      },
    );
    guardian.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return;
      const type = (message as Record<string, unknown>).type;
      if (type === 'performance-guardian-leased' && !guardianLeased) {
        guardianLeased = true;
        guardian.send({ type: 'performance-guardian-start' }, (error) => {
          if (error && !settled) {
            settled = true;
            reject(error);
          }
        });
      } else if (type === 'performance-guardian-started' && guardianLeased) {
        guardianStarted = true;
      } else if (
        type === 'performance-guardian-complete' &&
        guardianLeased &&
        guardianStarted &&
        Number.isSafeInteger((message as Record<string, unknown>).exitCode)
      ) {
        guardianCompleted = true;
        completionExitCode = Number((message as Record<string, unknown>).exitCode);
      }
    });
    guardian.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    guardian.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (!guardianLeased)
        reject(new Error('Playwright guardian exited before acquiring its lease.'));
      else if (!guardianStarted)
        reject(new Error('Playwright guardian exited before confirming child startup.'));
      else if (signal !== null) reject(new Error('Browser performance guardian was interrupted.'));
      else if (!guardianCompleted || completionExitCode !== (code ?? 1))
        reject(new Error('Playwright guardian exited without a complete result handshake.'));
      else accept(code ?? 1);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function readBoundedPerformanceReport(path: string): Promise<{
  readonly serialized: string;
  readonly parsed: Record<string, unknown>;
  readonly result: 'pass' | 'fail';
}> {
  const status = await lstat(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size < 1 ||
    status.size > PERFORMANCE_REPORT_MAX_BYTES
  ) {
    throw new Error('Browser performance aggregate report has an invalid file identity.');
  }
  const text = await readFile(path, 'utf8');
  if (
    /(?:[A-Za-z]:\\|\/Users\/|\/home\/|\bPX\d{4}\b|\bcallsign\b|\bregistration\b|\blatitude\b|\blongitude\b|https?:\/\/|wss?:\/\/|authorization|bearer|api[_-]?key)/iu.test(
      text,
    )
  ) {
    throw new Error('Browser performance aggregate report contains a forbidden detail canary.');
  }
  const parsed = JSON.parse(text) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION ||
    parsed.performanceProfileId !== RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId
  ) {
    throw new Error('Browser performance aggregate report has an invalid envelope.');
  }
  const result = String(parsed.result);
  if (!['pass', 'fail'].includes(result)) {
    throw new Error('Browser performance aggregate report has an invalid result.');
  }
  return { serialized: text, parsed, result: result as 'pass' | 'fail' };
}

function parseIndependentPerformanceIdentity(
  value: unknown,
): PerformanceIdentityCapture | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'source', 'optimizedClient', 'map'])
  ) {
    return undefined;
  }
  const source = value.source;
  const client = value.optimizedClient;
  const map = value.map;
  if (
    value.schemaVersion !== 'airspace-performance-identity-capture.v2' ||
    !isRecord(source) ||
    !isRecord(client) ||
    !isRecord(map) ||
    !exactKeys(source, ['head', 'dirty', 'contentSha256']) ||
    !exactKeys(client, ['schemaVersion', 'fileCount', 'totalBytes', 'sha256']) ||
    !exactKeys(map, ['id', 'fileCount', 'totalBytes', 'sha256']) ||
    typeof source.head !== 'string' ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(source.head) ||
    typeof source.dirty !== 'boolean' ||
    typeof source.contentSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(source.contentSha256) ||
    client.schemaVersion !== 'sha256-file-inventory.v1' ||
    !Number.isSafeInteger(client.fileCount) ||
    (client.fileCount as number) < 0 ||
    !Number.isSafeInteger(client.totalBytes) ||
    (client.totalBytes as number) < 0 ||
    typeof client.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(client.sha256) ||
    typeof map.id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(map.id) ||
    !Number.isSafeInteger(map.fileCount) ||
    (map.fileCount as number) < 0 ||
    !Number.isSafeInteger(map.totalBytes) ||
    (map.totalBytes as number) < 0 ||
    typeof map.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(map.sha256)
  ) {
    return undefined;
  }
  return value as unknown as PerformanceIdentityCapture;
}

async function captureIndependentPerformanceIdentity(
  paths: PerformanceRunPaths,
): Promise<PerformanceIdentityCapture> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [TSX_CLI, PERFORMANCE_IDENTITY_HELPER],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: playwrightEnvironment(paths),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  if (stderr.trim().length > 0 || Buffer.byteLength(stdout, 'utf8') > 64 * 1024) {
    throw new Error('Independent browser performance identity capture was invalid.');
  }
  const identity = parseIndependentPerformanceIdentity(JSON.parse(stdout) as unknown);
  if (identity === undefined) {
    throw new Error('Independent browser performance identity receipt was invalid.');
  }
  return identity;
}

function parseServerIdentityForAudit(
  value: unknown,
  independent: PerformanceIdentityCapture,
): PerformanceServerIdentity | undefined {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schemaVersion', 'source', 'optimizedClient', 'map', 'policy']) ||
    value.schemaVersion !== 'airspace-performance-server.v1' ||
    JSON.stringify(value.source) !== JSON.stringify(independent.source) ||
    JSON.stringify(value.optimizedClient) !== JSON.stringify(independent.optimizedClient) ||
    JSON.stringify(value.map) !== JSON.stringify(independent.map) ||
    !isRecord(value.policy) ||
    !exactKeys(value.policy, ['limits', 'limitsSha256']) ||
    runtimePolicyCanonicalJson(value.policy.limits) !==
      runtimePolicyCanonicalJson(RUNTIME_POLICY_LIMITS) ||
    value.policy.limitsSha256 !==
      createHash('sha256').update(runtimePolicyCanonicalJson(RUNTIME_POLICY_LIMITS)).digest('hex')
  ) {
    return undefined;
  }
  return value as unknown as PerformanceServerIdentity;
}

function compactPerformanceFailureReceiptIsValid(value: Record<string, unknown>): boolean {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'performanceProfileId',
      'receiptType',
      'result',
      'completedAt',
      'failure',
      'privacy',
    ]) ||
    value.receiptType !== 'compact-failure' ||
    value.result !== 'fail' ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !isRecord(value.failure) ||
    !exactKeys(value.failure, ['schemaVersion', 'stage', 'code']) ||
    value.failure.schemaVersion !== 'airspace-browser-performance-failure.v1' ||
    !isRecord(value.privacy) ||
    !exactKeys(value.privacy, ['rawSamplesRetained', 'detailedFailureRetained']) ||
    value.privacy.rawSamplesRetained !== false ||
    value.privacy.detailedFailureRetained !== false
  ) {
    return false;
  }
  const stage = String(value.failure.stage);
  const code = String(value.failure.code);
  return (
    (stage === 'aggregate-serialization' &&
      ['AGGREGATE_SERIALIZATION_FAILED', 'AGGREGATE_EXCEEDS_64_KIB'].includes(code)) ||
    (stage === 'outer-output-audit' && code === 'AGGREGATE_OUTPUT_REJECTED') ||
    (stage === 'runner-execution' && code === 'RUNNER_EXECUTION_FAILED')
  );
}

function boundedSamples(value: unknown, length: number, maximum = 30_000): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (sample) =>
        typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample <= maximum,
    )
  );
}

function nearestRank(values: readonly number[], percentile: number): number {
  return [...values].sort((left, right) => left - right)[
    Math.ceil(values.length * percentile) - 1
  ]!;
}

function sampleStatistics(values: readonly number[], limitMs: number) {
  return {
    minimumMs: Math.min(...values),
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
    maximumMs: Math.max(...values),
    overBudgetSamples: values.filter((sample) => sample > limitMs).length,
  };
}

function statisticsMatch(
  value: unknown,
  expected: Readonly<Record<string, number>>,
  exact = true,
): boolean {
  if (!isRecord(value)) return false;
  if (exact && !exactKeys(value, Object.keys(expected))) return false;
  return Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function paintNetworkIsValid(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'coldNavigationResponseBodyBytes',
      'coldScriptResponseBodyBytes',
      'coldStyleResponseBodyBytes',
      'coldFontResponseBodyBytes',
      'coldMapResponseBodyBytes',
      'coldOtherResponseBodyBytes',
      'coldTotalResponseBodyBytes',
      'coldResponseBodyLimitBytes',
      'responseCount',
      'unmeasuredResponseCount',
    ]) ||
    value.coldResponseBodyLimitBytes !==
      RUNTIME_POLICY_LIMITS.browser.performance.responseBodyBytes ||
    value.unmeasuredResponseCount !== 0 ||
    !Number.isSafeInteger(value.responseCount) ||
    (value.responseCount as number) < 1
  ) {
    return false;
  }
  const parts = [
    value.coldNavigationResponseBodyBytes,
    value.coldScriptResponseBodyBytes,
    value.coldStyleResponseBodyBytes,
    value.coldFontResponseBodyBytes,
    value.coldMapResponseBodyBytes,
    value.coldOtherResponseBodyBytes,
  ];
  if (!parts.every((part) => Number.isSafeInteger(part) && (part as number) >= 0)) {
    return false;
  }
  const total = parts.reduce<number>((sum, part) => sum + (part as number), 0);
  return (
    value.coldTotalResponseBodyBytes === total &&
    total <= RUNTIME_POLICY_LIMITS.browser.performance.responseBodyBytes
  );
}

function maximumNetworkIsValid(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'resourceResponseBodyBytes',
      'navigationResponseBodyBytes',
      'totalResponseBodyBytes',
      'responseBodyLimitBytes',
      'responseCount',
      'unmeasuredResponseCount',
    ]) ||
    value.responseBodyLimitBytes !== RUNTIME_POLICY_LIMITS.browser.performance.responseBodyBytes ||
    value.unmeasuredResponseCount !== 0 ||
    !Number.isSafeInteger(value.resourceResponseBodyBytes) ||
    (value.resourceResponseBodyBytes as number) < 1 ||
    !Number.isSafeInteger(value.navigationResponseBodyBytes) ||
    (value.navigationResponseBodyBytes as number) < 1 ||
    !Number.isSafeInteger(value.responseCount) ||
    (value.responseCount as number) < 1
  ) {
    return false;
  }
  const total =
    (value.resourceResponseBodyBytes as number) + (value.navigationResponseBodyBytes as number);
  return (
    value.totalResponseBodyBytes === total &&
    total <= RUNTIME_POLICY_LIMITS.browser.performance.responseBodyBytes
  );
}

function paintCaseIsValid(value: unknown): boolean {
  if (!isRecord(value) || value.case !== 'paint-500') return false;
  const project = String(value.project);
  if (!PERFORMANCE_PROJECT_NAMES.includes(project as (typeof PERFORMANCE_PROJECT_NAMES)[number])) {
    return false;
  }
  const limitMs =
    project === 'performance-desktop'
      ? RUNTIME_POLICY_LIMITS.browser.performance.paintP95Ms.desktop
      : RUNTIME_POLICY_LIMITS.browser.performance.paintP95Ms.mobile;
  const raw = value.rawSamples;
  if (
    !exactKeys(value, [
      'case',
      'project',
      'performanceProfileId',
      'paintWarmups',
      'paintIterations',
      'paintBlocks',
      'paintSamplesPerBlock',
      'paintP95LimitMs',
      'rawSamples',
      'statistics',
      'blocks',
      'environmentControl',
      'runtimeIdentityId',
      'network',
      'budgetPassed',
    ]) ||
    value.performanceProfileId !== RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId ||
    value.paintWarmups !== RUNTIME_POLICY_LIMITS.browser.performance.paintWarmups ||
    value.paintIterations !== RUNTIME_POLICY_LIMITS.browser.performance.paintIterations ||
    value.paintBlocks !== RUNTIME_POLICY_LIMITS.browser.performance.paintBlocks ||
    value.paintSamplesPerBlock !== 10 ||
    value.paintP95LimitMs !== limitMs ||
    typeof value.runtimeIdentityId !== 'string' ||
    !/^runtime-[1-9]\d*$/u.test(value.runtimeIdentityId) ||
    !isRecord(raw) ||
    !exactKeys(raw, [
      'paintDurationMs',
      'domStableDurationMs',
      'mapStableDurationMs',
      'validationDurationMs',
      'wireBytes',
    ]) ||
    !boundedSamples(raw.paintDurationMs, 30) ||
    !boundedSamples(raw.domStableDurationMs, 30) ||
    !boundedSamples(raw.mapStableDurationMs, 30) ||
    !boundedSamples(raw.validationDurationMs, 30, 60_000) ||
    !boundedSamples(raw.wireBytes, 30, MAX_LIVE_MESSAGE_BYTES) ||
    !paintNetworkIsValid(value.network)
  ) {
    return false;
  }
  const aggregate = sampleStatistics(raw.paintDurationMs, limitMs);
  const budgetPassed = aggregate.p95Ms <= limitMs && aggregate.overBudgetSamples <= 1;
  if (
    value.budgetPassed !== budgetPassed ||
    !statisticsMatch(value.statistics, {
      ...aggregate,
      domStableP95Ms: nearestRank(raw.domStableDurationMs, 0.95),
      mapStableP95Ms: nearestRank(raw.mapStableDurationMs, 0.95),
      validationP95Ms: nearestRank(raw.validationDurationMs, 0.95),
      minimumWireBytes: Math.min(...raw.wireBytes),
      maximumWireBytes: Math.max(...raw.wireBytes),
    }) ||
    !Array.isArray(value.blocks) ||
    value.blocks.length !== 3
  ) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    const block = value.blocks[index];
    const samples = raw.paintDurationMs.slice(index * 10, index * 10 + 10);
    const summary = sampleStatistics(samples, limitMs);
    if (
      !isRecord(block) ||
      !exactKeys(block, [
        'block',
        'sampleStartIndex',
        'sampleCount',
        'p50Ms',
        'p95Ms',
        'maximumMs',
        'outlierCount',
      ]) ||
      block.block !== index + 1 ||
      block.sampleStartIndex !== index * 10 ||
      block.sampleCount !== 10 ||
      block.p50Ms !== summary.p50Ms ||
      block.p95Ms !== summary.p95Ms ||
      block.maximumMs !== summary.maximumMs ||
      block.outlierCount !== summary.overBudgetSamples
    ) {
      return false;
    }
  }
  const control = value.environmentControl;
  if (
    !isRecord(control) ||
    control.metric !== 'two-animation-frame-scheduling-delay' ||
    control.diagnosticOnly !== true ||
    control.comparisonEligible !== false ||
    control.baselineRunCount !== 0 ||
    control.samplesPerBlock !== 10 ||
    !Array.isArray(control.blocks) ||
    control.blocks.length !== 4
  ) {
    return false;
  }
  return control.blocks.every((block, index) => {
    if (!isRecord(block) || !boundedSamples(block.samplesMs, 10)) return false;
    const summary = sampleStatistics(block.samplesMs, Number.POSITIVE_INFINITY);
    return (
      block.block === index + 1 &&
      statisticsMatch(
        block.statistics,
        {
          minimumMs: summary.minimumMs,
          p50Ms: summary.p50Ms,
          p95Ms: summary.p95Ms,
          maximumMs: summary.maximumMs,
        },
        false,
      )
    );
  });
}

function maximumCaseIsValid(value: unknown): boolean {
  if (!isRecord(value) || value.case !== 'maximum-2000') return false;
  const project = String(value.project);
  if (!PERFORMANCE_PROJECT_NAMES.includes(project as (typeof PERFORMANCE_PROJECT_NAMES)[number])) {
    return false;
  }
  const limitMs =
    RUNTIME_POLICY_LIMITS.browser.performance.interactionP95Ms[
      project === 'performance-desktop' ? 'desktop' : 'mobile'
    ];
  const ageTickLimitMs =
    RUNTIME_POLICY_LIMITS.browser.performance.ageTickLimitMs[
      project === 'performance-desktop' ? 'desktop' : 'mobile'
    ];
  const preparation = value.preparation;
  const maximumPaint = value.maximumPaint;
  const ageTick = value.ageTick;
  if (
    !exactKeys(value, [
      'case',
      'project',
      'performanceProfileId',
      'preparation',
      'maximumPaint',
      'interactionWarmups',
      'interactionIterations',
      'interactionP95LimitMs',
      'interactionP95Ms',
      'interactions',
      'maximumInteractionMs',
      'ageTick',
      'browserJsHeapBytes',
      'browserJsHeapLimitBytes',
      'network',
      'runtimeIdentityId',
      'budgetPassed',
    ]) ||
    value.performanceProfileId !== RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId ||
    value.interactionWarmups !== RUNTIME_POLICY_LIMITS.browser.performance.interactionWarmups ||
    value.interactionIterations !==
      RUNTIME_POLICY_LIMITS.browser.performance.interactionIterations ||
    value.interactionP95LimitMs !== limitMs ||
    typeof value.runtimeIdentityId !== 'string' ||
    !/^runtime-[1-9]\d*$/u.test(value.runtimeIdentityId) ||
    !isRecord(preparation) ||
    !isRecord(maximumPaint) ||
    !isRecord(ageTick) ||
    !maximumNetworkIsValid(value.network) ||
    !isRecord(value.interactionP95Ms) ||
    !exactKeys(value.interactionP95Ms, PERFORMANCE_INTERACTION_NAMES) ||
    !isRecord(value.interactions) ||
    !exactKeys(value.interactions, PERFORMANCE_INTERACTION_NAMES) ||
    value.browserJsHeapLimitBytes !==
      RUNTIME_POLICY_LIMITS.browser.performance.browserJsHeapBytes ||
    typeof value.browserJsHeapBytes !== 'number' ||
    !Number.isFinite(value.browserJsHeapBytes) ||
    value.browserJsHeapBytes < 1 ||
    value.browserJsHeapBytes > RUNTIME_POLICY_LIMITS.browser.performance.browserJsHeapBytes
  ) {
    return false;
  }
  if (
    !exactKeys(preparation, [
      'qualityReceipts',
      'qualityEventsGenerated',
      'qualityEventsRetained',
      'qualityTailWindowVerified',
      'historyReceipts',
      'totalReceipts',
      'durationMs',
    ]) ||
    preparation.qualityReceipts !== 100 ||
    preparation.qualityEventsGenerated !== 250 ||
    preparation.qualityEventsRetained !== RUNTIME_POLICY_LIMITS.history.maximumQualityEvents ||
    preparation.qualityTailWindowVerified !== true ||
    preparation.historyReceipts !== RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    preparation.totalReceipts !== 100 + RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    typeof preparation.durationMs !== 'number' ||
    !Number.isFinite(preparation.durationMs) ||
    preparation.durationMs < 0 ||
    preparation.durationMs > 120_000 ||
    !exactKeys(maximumPaint, [
      'durationMs',
      'domStableDurationMs',
      'mapStableDurationMs',
      'validationDurationMs',
      'wireBytes',
      'wireLimitBytes',
      'maximumHistorySamples',
      'minimumHistorySamples',
      'historiesAtMaximum',
    ]) ||
    typeof maximumPaint.durationMs !== 'number' ||
    !Number.isFinite(maximumPaint.durationMs) ||
    maximumPaint.durationMs < 0 ||
    maximumPaint.durationMs > 30_000 ||
    typeof maximumPaint.domStableDurationMs !== 'number' ||
    maximumPaint.domStableDurationMs < 0 ||
    maximumPaint.domStableDurationMs > maximumPaint.durationMs ||
    typeof maximumPaint.mapStableDurationMs !== 'number' ||
    maximumPaint.mapStableDurationMs < 0 ||
    maximumPaint.mapStableDurationMs > maximumPaint.durationMs + 1 ||
    typeof maximumPaint.validationDurationMs !== 'number' ||
    maximumPaint.validationDurationMs < 0 ||
    maximumPaint.validationDurationMs > 60_000 ||
    maximumPaint.wireLimitBytes !== MAX_LIVE_MESSAGE_BYTES ||
    typeof maximumPaint.wireBytes !== 'number' ||
    maximumPaint.wireBytes < Math.floor(MAX_LIVE_MESSAGE_BYTES * 0.95) ||
    maximumPaint.wireBytes > MAX_LIVE_MESSAGE_BYTES ||
    maximumPaint.maximumHistorySamples !==
      RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    maximumPaint.minimumHistorySamples !==
      RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    maximumPaint.historiesAtMaximum !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
    !exactKeys(ageTick, [
      'durationMs',
      'limitMs',
      'jsHeapDeltaBytes',
      'jsHeapGrowthLimitBytes',
      'historiesMapPreserved',
      'trailsMapPreserved',
      'historyObjectsPreserved',
      'sampleArraysPreserved',
      'historyAircraft',
      'historySamples',
    ]) ||
    ageTick.limitMs !== ageTickLimitMs ||
    typeof ageTick.durationMs !== 'number' ||
    !Number.isFinite(ageTick.durationMs) ||
    ageTick.durationMs < 0 ||
    ageTick.durationMs > ageTickLimitMs ||
    ageTick.jsHeapGrowthLimitBytes !==
      RUNTIME_POLICY_LIMITS.browser.performance.ageTickJsHeapGrowthBytes ||
    typeof ageTick.jsHeapDeltaBytes !== 'number' ||
    !Number.isFinite(ageTick.jsHeapDeltaBytes) ||
    ageTick.jsHeapDeltaBytes < -RUNTIME_POLICY_LIMITS.browser.performance.browserJsHeapBytes ||
    ageTick.jsHeapDeltaBytes > RUNTIME_POLICY_LIMITS.browser.performance.ageTickJsHeapGrowthBytes ||
    ageTick.historiesMapPreserved !== true ||
    ageTick.trailsMapPreserved !== true ||
    ageTick.historyObjectsPreserved !== true ||
    ageTick.sampleArraysPreserved !== true ||
    ageTick.historyAircraft !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
    ageTick.historySamples !==
      RUNTIME_POLICY_LIMITS.history.maximumAircraft *
        RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft
  ) {
    return false;
  }
  let allPassed = true;
  let maximum = 0;
  for (const name of PERFORMANCE_INTERACTION_NAMES) {
    const interaction = value.interactions[name];
    if (
      !isRecord(interaction) ||
      !exactKeys(interaction, [
        'samplesMs',
        'minimumMs',
        'p50Ms',
        'p95Ms',
        'maximumMs',
        'overBudgetSamples',
        'budgetPassed',
      ]) ||
      !boundedSamples(interaction.samplesMs, 20)
    ) {
      return false;
    }
    const summary = sampleStatistics(interaction.samplesMs, limitMs);
    const passed = summary.p95Ms <= limitMs && summary.overBudgetSamples <= 1;
    maximum = Math.max(maximum, summary.maximumMs);
    allPassed &&= passed;
    if (
      interaction.minimumMs !== summary.minimumMs ||
      interaction.p50Ms !== summary.p50Ms ||
      interaction.p95Ms !== summary.p95Ms ||
      interaction.maximumMs !== summary.maximumMs ||
      interaction.overBudgetSamples !== summary.overBudgetSamples ||
      interaction.budgetPassed !== passed ||
      value.interactionP95Ms[name] !== summary.p95Ms
    ) {
      return false;
    }
  }
  return value.maximumInteractionMs === maximum && value.budgetPassed === allPassed;
}

export function fullPerformanceReportSchemaIsValid(value: Record<string, unknown>): boolean {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'performanceProfileId',
      'result',
      'completedAt',
      'source',
      'optimizedClient',
      'map',
      'policy',
      'environment',
      'measurement',
      'dataset',
      'execution',
      'privacy',
      'cases',
      'failedInteractionMeasurements',
      'failedPaintMeasurements',
      'failedCaseReceipts',
    ]) ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !isRecord(value.environment) ||
    !isRecord(value.measurement) ||
    !isRecord(value.dataset) ||
    !isRecord(value.execution) ||
    !isRecord(value.privacy) ||
    !Array.isArray(value.cases) ||
    !Array.isArray(value.failedInteractionMeasurements) ||
    !Array.isArray(value.failedPaintMeasurements) ||
    !Array.isArray(value.failedCaseReceipts) ||
    value.measurement.performanceProfileId !==
      RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId ||
    value.measurement.paintWarmups !== RUNTIME_POLICY_LIMITS.browser.performance.paintWarmups ||
    value.measurement.paintMeasuredIterations !==
      RUNTIME_POLICY_LIMITS.browser.performance.paintIterations ||
    value.measurement.paintBlocks !== RUNTIME_POLICY_LIMITS.browser.performance.paintBlocks ||
    value.measurement.interactionWarmups !==
      RUNTIME_POLICY_LIMITS.browser.performance.interactionWarmups ||
    value.measurement.interactionIterations !==
      RUNTIME_POLICY_LIMITS.browser.performance.interactionIterations ||
    value.execution.playwrightRetries !== 0 ||
    value.privacy.syntheticOnly !== true ||
    value.privacy.tracesRetained !== false ||
    value.privacy.screenshotsRetained !== false ||
    value.privacy.videosRetained !== false
  ) {
    return false;
  }
  if (
    !exactKeys(value.measurement, [
      'performanceProfileId',
      'timerStart',
      'timerEnd',
      'paintWarmups',
      'paintMeasuredIterations',
      'paintBlocks',
      'paintSamplesPerBlock',
      'paintP95Ms',
      'interactionWarmups',
      'interactionIterations',
      'interactionP95Ms',
      'paintState',
      'maximumState',
      'environmentControl',
      'environmentControlComparisonEligible',
      'environmentControlBaselineRuns',
      'heapMetric',
      'networkMetric',
      'ageTickMetric',
      'maximumInteractionWorkflow',
    ]) ||
    value.measurement.paintSamplesPerBlock !== 10 ||
    JSON.stringify(value.measurement.paintP95Ms) !==
      JSON.stringify(RUNTIME_POLICY_LIMITS.browser.performance.paintP95Ms) ||
    JSON.stringify(value.measurement.interactionP95Ms) !==
      JSON.stringify(RUNTIME_POLICY_LIMITS.browser.performance.interactionP95Ms) ||
    value.measurement.environmentControlComparisonEligible !== false ||
    value.measurement.environmentControlBaselineRuns !== 0 ||
    !exactKeys(value.dataset, [
      'id',
      'paintAircraft',
      'maximumAircraft',
      'historyWarmReceipts',
      'qualityWarmReceipts',
      'maximumWireFraction',
    ]) ||
    value.dataset.id !== 'synthetic-browser-performance-v1' ||
    value.dataset.paintAircraft !== RUNTIME_POLICY_LIMITS.history.maximumAircraft ||
    value.dataset.maximumAircraft !== RUNTIME_POLICY_LIMITS.protocol.maximumAircraft ||
    value.dataset.historyWarmReceipts !== RUNTIME_POLICY_LIMITS.history.maximumSamplesPerAircraft ||
    value.dataset.qualityWarmReceipts !== 100 ||
    value.dataset.maximumWireFraction !== 0.96 ||
    !exactKeys(value.execution, [
      'expectedCases',
      'completedCases',
      'failedCases',
      'policyViolations',
      'identityViolations',
      'environmentViolations',
      'playwrightRetries',
    ]) ||
    !exactKeys(value.privacy, [
      'syntheticOnly',
      'externalOriginsPermitted',
      'tracesRetained',
      'screenshotsRetained',
      'videosRetained',
      'detailedFailureOutputRetained',
    ]) ||
    value.privacy.externalOriginsPermitted !== 0 ||
    value.privacy.detailedFailureOutputRetained !== false ||
    !value.cases.every((caseReport) =>
      isRecord(caseReport) && caseReport.case === 'paint-500'
        ? paintCaseIsValid(caseReport)
        : maximumCaseIsValid(caseReport),
    ) ||
    !value.failedInteractionMeasurements.every(maximumCaseIsValid) ||
    !value.failedPaintMeasurements.every(paintCaseIsValid) ||
    !value.failedCaseReceipts.every(
      (receipt) => parseMaximumPerformanceFailureEvidence(receipt) !== undefined,
    )
  ) {
    return false;
  }
  const caseKeys = new Set(
    value.cases.map((caseReport) => {
      const record = caseReport as Record<string, unknown>;
      return `${String(record.project)}:${String(record.case)}`;
    }),
  );
  if (value.result === 'pass') {
    const eligibility = value.environment.eligibility;
    const projectIdentityIds = value.environment.projectRuntimeIdentityIds;
    const runtimeIdentities = value.environment.runtimeIdentities;
    return (
      value.execution.expectedCases === 4 &&
      value.execution.completedCases === 4 &&
      value.execution.failedCases === 0 &&
      value.execution.policyViolations === 0 &&
      value.execution.identityViolations === 0 &&
      value.execution.environmentViolations === 0 &&
      value.cases.length === 4 &&
      caseKeys.size === 4 &&
      PERFORMANCE_PROJECT_NAMES.every((project) =>
        ['paint-500', 'maximum-2000'].every((caseName) => caseKeys.has(`${project}:${caseName}`)),
      ) &&
      value.cases.every((caseReport) => isRecord(caseReport) && caseReport.budgetPassed === true) &&
      isRecord(eligibility) &&
      exactKeys(eligibility, ['contract', 'eligible', 'failureCodes']) &&
      JSON.stringify(eligibility.contract) ===
        JSON.stringify(PERFORMANCE_ENVIRONMENT_ELIGIBILITY_CONTRACT) &&
      eligibility.eligible === true &&
      Array.isArray(eligibility.failureCodes) &&
      eligibility.failureCodes.length === 0 &&
      Array.isArray(value.environment.projects) &&
      JSON.stringify(value.environment.projects) === JSON.stringify(PERFORMANCE_PROJECT_NAMES) &&
      isRecord(projectIdentityIds) &&
      exactKeys(projectIdentityIds, PERFORMANCE_PROJECT_NAMES) &&
      Array.isArray(runtimeIdentities) &&
      runtimeIdentities.length >= 1 &&
      runtimeIdentities.length <= 2 &&
      runtimeIdentities.every((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.id !== 'string' ||
          !/^runtime-[1-9]\d*$/u.test(entry.id)
        ) {
          return false;
        }
        return performanceBrowserRuntimeIdentityIsEligible(entry.identity);
      }) &&
      Object.values(projectIdentityIds).every(
        (id) =>
          typeof id === 'string' &&
          runtimeIdentities.some((entry) => isRecord(entry) && entry.id === id),
      ) &&
      value.cases.every(
        (caseReport) =>
          isRecord(caseReport) &&
          projectIdentityIds[String(caseReport.project)] === caseReport.runtimeIdentityId,
      ) &&
      value.failedInteractionMeasurements.length === 0 &&
      value.failedPaintMeasurements.length === 0 &&
      value.failedCaseReceipts.length === 0
    );
  }
  return value.result === 'fail';
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceCanonicalReportFile(temporary: string, reportPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(temporary, reportPath);
    return;
  }
  try {
    await lstat(reportPath);
  } catch (error) {
    if (systemErrorCode(error) !== 'ENOENT') throw error;
    await rename(temporary, reportPath);
    return;
  }
  const encodedTemporary = Buffer.from(temporary, 'utf8').toString('base64');
  const encodedReportPath = Buffer.from(reportPath, 'utf8').toString('base64');
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const script = [
      `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTemporary}'))`,
      `$destination = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedReportPath}'))`,
      '$signature = \'[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string destination, int flags);\'',
      '$native = Add-Type -MemberDefinition $signature -Name PerformanceAtomicMove -Namespace Airspace -PassThru',
      '$moved = $native::MoveFileEx($source, $destination, 9)',
      'if (-not $moved) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }',
    ].join('; ');
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      return;
    } catch (error) {
      lastError = error;
      const retained = await lstat(reportPath).catch(() => undefined);
      if (retained === undefined || !retained.isFile() || retained.isSymbolicLink()) {
        throw new Error('Windows atomic report move did not preserve its prior receipt.', {
          cause: error,
        });
      }
      await new Promise((accept) => setTimeout(accept, 20));
    }
  }
  throw new Error('Windows atomic report replacement remained unavailable.', {
    cause: lastError,
  });
}

export async function atomicPublishPerformanceReportAt(
  publicOutputInput: string,
  reportPathInput: string,
  serialized: string,
): Promise<void> {
  const publicOutput = resolve(publicOutputInput);
  const reportPath = exactChild(reportPathInput, publicOutput, 'Aggregate report');
  if (basename(reportPath) !== 'report.json') {
    throw new Error('Browser performance canonical report has an invalid filename.');
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes < 1 || bytes > PERFORMANCE_REPORT_MAX_BYTES) {
    throw new Error('Browser performance report exceeds its publication size contract.');
  }
  const envelope = JSON.parse(serialized) as unknown;
  if (
    !isRecord(envelope) ||
    envelope.schemaVersion !== PERFORMANCE_REPORT_SCHEMA_VERSION ||
    envelope.performanceProfileId !==
      RUNTIME_POLICY_LIMITS.browser.performance.performanceProfileId ||
    !['pass', 'fail'].includes(String(envelope.result))
  ) {
    throw new Error('Browser performance report has an invalid publication envelope.');
  }
  if (
    (envelope.receiptType === 'compact-failure' &&
      !compactPerformanceFailureReceiptIsValid(envelope)) ||
    (envelope.receiptType !== 'compact-failure' && !fullPerformanceReportSchemaIsValid(envelope))
  ) {
    throw new Error('Browser performance report has an invalid publication schema.');
  }
  await mkdir(publicOutput, { recursive: true });
  const directoryStatus = await lstat(publicOutput);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error('Browser performance canonical output directory has an unsafe identity.');
  }
  const temporaryPattern = new RegExp(`^report\\.json\\.${UUID_PATTERN_SOURCE}\\.tmp$`, 'u');
  const backupPattern = new RegExp(`^report\\.json\\.${UUID_PATTERN_SOURCE}\\.backup$`, 'u');
  for (const entry of await readdir(publicOutput, { withFileTypes: true })) {
    if (entry.name === 'report.json') {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Browser performance canonical report has an unsafe identity.');
      }
      continue;
    }
    if (
      (!temporaryPattern.test(entry.name) && !backupPattern.test(entry.name)) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      throw new Error('Browser performance canonical output contains an unallowlisted entry.');
    }
    await rm(exactChild(join(publicOutput, entry.name), publicOutput, 'Aggregate temporary'), {
      force: false,
    });
  }
  const temporary = `${reportPath}.${randomUUID()}.tmp`;
  try {
    await writeSyncedFile(temporary, serialized);
    await replaceCanonicalReportFile(temporary, reportPath);
    await fsyncDirectory(publicOutput);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function auditAggregateOutput(
  context: PerformanceRunContext,
): Promise<PerformanceAuditedAggregate> {
  await assertPerformanceRunContext(context);
  const stagedEntries = await readdir(context.paths.stagedDirectory, { withFileTypes: true });
  if (
    stagedEntries.length !== 1 ||
    stagedEntries[0]?.name !== 'report.json' ||
    !stagedEntries[0].isFile() ||
    stagedEntries[0].isSymbolicLink()
  ) {
    throw new Error('Browser performance staged output is not the one-file allowlist.');
  }
  const staged = await readBoundedPerformanceReport(context.paths.stagedReport);
  if (staged.parsed.receiptType !== 'compact-failure') {
    if (!fullPerformanceReportSchemaIsValid(staged.parsed)) {
      throw new Error('Browser performance staged report schema is invalid.');
    }
    const independent = await captureIndependentPerformanceIdentity(context.paths);
    const serverStatus = await lstat(context.paths.serverIdentity);
    if (
      !serverStatus.isFile() ||
      serverStatus.isSymbolicLink() ||
      serverStatus.size < 1 ||
      serverStatus.size > 64 * 1024
    ) {
      throw new Error('Browser performance server identity file is invalid.');
    }
    const server = parseServerIdentityForAudit(
      JSON.parse(await readFile(context.paths.serverIdentity, 'utf8')) as unknown,
      independent,
    );
    if (
      server === undefined ||
      JSON.stringify(staged.parsed.source) !== JSON.stringify(server.source) ||
      JSON.stringify(staged.parsed.optimizedClient) !== JSON.stringify(server.optimizedClient) ||
      JSON.stringify(staged.parsed.map) !== JSON.stringify(server.map) ||
      JSON.stringify(staged.parsed.policy) !== JSON.stringify(server.policy)
    ) {
      throw new Error('Browser performance staged report identity binding failed.');
    }
  } else if (
    staged.result !== 'fail' ||
    !compactPerformanceFailureReceiptIsValid(staged.parsed) ||
    (staged.parsed.failure as Record<string, unknown>).stage !== 'aggregate-serialization'
  ) {
    throw new Error('Browser performance compact staged report must be a reporter failure.');
  }
  return { result: staged.result, serialized: staged.serialized };
}

async function publishAggregateOutput(aggregate: PerformanceAuditedAggregate): Promise<void> {
  await atomicPublishPerformanceReportAt(PUBLIC_OUTPUT, REPORT_PATH, aggregate.serialized);
  const canonical = await readBoundedPerformanceReport(REPORT_PATH);
  if (canonical.serialized !== aggregate.serialized || canonical.result !== aggregate.result) {
    throw new Error('Browser performance canonical publication changed staged bytes.');
  }
}

async function invalidateAggregateOutput(): Promise<void> {
  const publicOutput = exactChild(
    PUBLIC_OUTPUT,
    join(REPOSITORY_ROOT, 'test-results'),
    'Aggregate output',
  );
  const reportPath = exactChild(REPORT_PATH, publicOutput, 'Aggregate report');
  await rm(reportPath, { force: true });
}

async function writeCompactFailureReceipt(
  stage: PerformanceFailureStage,
  code: PerformanceFailureCode,
): Promise<void> {
  const publicOutput = exactChild(
    PUBLIC_OUTPUT,
    join(REPOSITORY_ROOT, 'test-results'),
    'Aggregate output',
  );
  const reportPath = exactChild(REPORT_PATH, publicOutput, 'Aggregate report');
  const serialized = `${JSON.stringify(
    createCompactPerformanceFailureReceipt(stage, code),
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > PERFORMANCE_REPORT_MAX_BYTES) {
    throw new Error('Compact browser performance failure receipt exceeds its size limit.');
  }
  await atomicPublishPerformanceReportAt(publicOutput, reportPath, serialized);
  if ((await readBoundedPerformanceReport(reportPath)).result !== 'fail') {
    throw new Error('Compact browser performance failure receipt was not retained as a failure.');
  }
}

async function retainFailureReceipt(
  dependencies: PerformanceRunDependencies,
  runLock: RunLock,
  stage: PerformanceFailureStage,
  code: PerformanceFailureCode,
): Promise<void> {
  await assertRunLockOwnership(runLock, `before ${stage} failure receipt`);
  try {
    await dependencies.writeCompactFailureReceipt(stage, code);
  } catch (error) {
    await assertRunLockOwnership(runLock, `before ${stage} aggregate invalidation`);
    await dependencies.invalidateAggregateOutput();
    throw error;
  }
}

async function assertRunLockOwnership(runLock: RunLock, phase: string): Promise<void> {
  if (!(await runLock.owns())) {
    throw new Error(`Browser performance run lock ownership was lost ${phase}.`);
  }
}

async function runLockOwnershipIsCurrent(runLock: RunLock): Promise<boolean> {
  try {
    return await runLock.owns();
  } catch {
    return false;
  }
}

export async function runBrowserPerformanceWith(
  dependencies: PerformanceRunDependencies,
): Promise<void> {
  const runLock = await dependencies.acquireRunLock();
  let context: PerformanceRunContext | undefined;
  let contextCleaned = false;
  let pendingError: unknown;
  try {
    await assertRunLockOwnership(runLock, 'immediately after acquisition');
    try {
      await retainFailureReceipt(
        dependencies,
        runLock,
        'runner-execution',
        'RUNNER_EXECUTION_FAILED',
      );
      await assertRunLockOwnership(runLock, 'after current-attempt marker publication');
    } catch {
      throw new Error('Browser performance current-attempt marker publication failed.');
    }
    try {
      context = await dependencies.createRunContext(runLock);
      await assertRunLockOwnership(runLock, 'after run namespace creation');
    } catch {
      await retainFailureReceipt(
        dependencies,
        runLock,
        'runner-execution',
        'RUNNER_EXECUTION_FAILED',
      );
      throw new Error('Browser performance run namespace creation failed.');
    }
    try {
      await assertRunLockOwnership(runLock, 'before generated output reset');
      await dependencies.resetGeneratedOutputs(context);
      await assertRunLockOwnership(runLock, 'after generated output reset');
    } catch {
      await retainFailureReceipt(
        dependencies,
        runLock,
        'runner-execution',
        'RUNNER_EXECUTION_FAILED',
      );
      throw new Error('Browser performance output reset failed.');
    }
    let exitCode: number;
    try {
      await assertRunLockOwnership(runLock, 'before Playwright execution');
      exitCode = await dependencies.runPlaywright(runLock, context);
      await assertRunLockOwnership(runLock, 'after Playwright execution');
    } catch {
      await retainFailureReceipt(
        dependencies,
        runLock,
        'runner-execution',
        'RUNNER_EXECUTION_FAILED',
      );
      throw new Error('Browser performance runner execution failed.');
    }
    let aggregate: PerformanceAuditedAggregate;
    try {
      await assertRunLockOwnership(runLock, 'before aggregate audit');
      aggregate = await dependencies.auditAggregateOutput(context);
      await assertRunLockOwnership(runLock, 'after aggregate audit');
    } catch {
      await retainFailureReceipt(
        dependencies,
        runLock,
        'outer-output-audit',
        'AGGREGATE_OUTPUT_REJECTED',
      );
      throw new Error('Browser performance aggregate output audit failed.');
    }
    let terminalError: Error | undefined;
    let aggregateToPublish: PerformanceAuditedAggregate | undefined = aggregate;
    if (exitCode === 0 && aggregate.result !== 'pass') {
      terminalError = new Error(
        'Browser performance report rejected an otherwise passing test run.',
      );
    }
    if (exitCode !== 0 && aggregate.result === 'pass') {
      await retainFailureReceipt(
        dependencies,
        runLock,
        'runner-execution',
        'RUNNER_EXECUTION_FAILED',
      );
      aggregateToPublish = undefined;
      terminalError = new Error(
        'Browser performance runner failed despite a passing aggregate report.',
      );
    } else if (exitCode !== 0) {
      terminalError = new Error('Browser performance gates failed.');
    }
    await assertRunLockOwnership(runLock, 'before terminal run namespace cleanup');
    await dependencies.cleanupGeneratedPrivateOutputs(context);
    contextCleaned = true;
    await assertRunLockOwnership(runLock, 'after terminal run namespace cleanup');
    await runLock.prepareFinalCommit();
    await assertRunLockOwnership(runLock, 'after final commit preparation');
    if (aggregateToPublish !== undefined) {
      try {
        await dependencies.publishAggregateOutput(aggregateToPublish);
        await assertRunLockOwnership(runLock, 'after terminal aggregate publication');
      } catch {
        await retainFailureReceipt(
          dependencies,
          runLock,
          'outer-output-audit',
          'AGGREGATE_OUTPUT_REJECTED',
        );
        throw new Error('Browser performance terminal aggregate publication failed.');
      }
    }
    if (terminalError !== undefined) throw terminalError;
  } catch (error) {
    pendingError = error;
  } finally {
    if (context !== undefined && !contextCleaned) {
      try {
        await assertRunLockOwnership(runLock, 'before generated private output cleanup');
        await dependencies.cleanupGeneratedPrivateOutputs(context);
        contextCleaned = true;
        await assertRunLockOwnership(runLock, 'after generated private output cleanup');
      } catch {
        pendingError = new Error('Browser performance generated private output cleanup failed.');
        await retainFailureReceipt(
          dependencies,
          runLock,
          'runner-execution',
          'RUNNER_EXECUTION_FAILED',
        ).catch(() => undefined);
      }
    }
    try {
      await assertRunLockOwnership(runLock, 'before release');
      await runLock.release();
    } catch {
      if (await runLockOwnershipIsCurrent(runLock)) {
        await retainFailureReceipt(
          dependencies,
          runLock,
          'runner-execution',
          'RUNNER_EXECUTION_FAILED',
        ).catch(async () => {
          if (await runLockOwnershipIsCurrent(runLock)) {
            await dependencies.invalidateAggregateOutput().catch(() => undefined);
          }
        });
      }
      pendingError = new Error('Browser performance run lock release failed.');
    }
  }
  if (pendingError !== undefined) throw pendingError;
}

async function main(): Promise<void> {
  await runBrowserPerformanceWith({
    acquireRunLock,
    createRunContext: createPerformanceRunContext,
    resetGeneratedOutputs,
    runPlaywright,
    auditAggregateOutput,
    publishAggregateOutput,
    writeCompactFailureReceipt,
    invalidateAggregateOutput,
    cleanupGeneratedPrivateOutputs,
  });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === RUNNER_MODULE_PATH) {
  const execution =
    process.argv[2] === '--playwright-guardian'
      ? runPlaywrightGuardian(process.argv[3]).then((code) => {
          process.exitCode = code;
        })
      : main();
  execution.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
