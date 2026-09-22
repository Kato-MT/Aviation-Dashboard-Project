import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  acquireRunDescendantLeaseAt,
  acquireRunLockAt,
  acquireRunLockForCurrentProcessAt,
  atomicPublishPerformanceReportAt,
  cleanupPerformanceRunNamespace,
  createPerformanceRunContext,
  fullPerformanceReportSchemaIsValid,
  guardianPreStartGate,
  playwrightGuardianSpawnArguments,
  playwrightEnvironment,
  processInstanceIdFor,
  recoverStalePerformanceRunRootsAt,
  removeServerIdentityOutputsAt,
  resetPerformanceRunNamespace,
  runBrowserPerformanceWith,
  terminateGuardedProcessTree,
  type PerformanceRunDependencies,
  type PerformanceRunContext,
  type RunLock,
  type RunLockOwner,
  type RunLockRuntime,
} from '../../tools/live/runBrowserPerformance';
import {
  createCompactPerformanceFailureReceipt,
  performanceRunEnvironment,
  performanceRunPathsForId,
} from '../../tools/live/performanceContract';

const INSTANCE_A = 'a'.repeat(64);
const INSTANCE_B = 'b'.repeat(64);
const INSTANCE_C = 'c'.repeat(64);
const INSTANCE_D = 'd'.repeat(64);
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const RUNNER_MODULE_PATH = fileURLToPath(
  new URL('../../tools/live/runBrowserPerformance.ts', import.meta.url),
);
const TEST_RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const TEST_RUN_CONTEXT: PerformanceRunContext = {
  paths: performanceRunPathsForId(resolve('.'), TEST_RUN_ID),
  receipt: {
    schemaVersion: 'airspace-performance-run.v1',
    runId: TEST_RUN_ID,
    lockToken: '123e4567-e89b-42d3-a456-426614174001',
    coordinatorPid: 1,
    coordinatorProcessInstanceId: INSTANCE_A,
    createdAt: '2026-08-31T00:00:00.000Z',
  },
};

function staleOwner(pid = 101, processInstanceId = INSTANCE_A): RunLockOwner {
  return {
    schemaVersion: 'airspace-performance-run-lock.v2',
    pid,
    processInstanceId,
    token: randomUUID(),
    startedAt: '2026-08-31T00:00:00.000Z',
  };
}

function namespaceRunLock(owner = staleOwner(process.pid, INSTANCE_A)): RunLock {
  return {
    guardianIdentity: { lockPath: resolve('.tmp-tests/live-performance-run.lock'), owner },
    owns: async () => true,
    prepareFinalCommit: async () => undefined,
    release: async () => undefined,
  };
}

function fakeRuntime(
  pid: number,
  processInstanceId: string,
  processes: ReadonlyMap<number, string>,
): RunLockRuntime {
  return {
    pid,
    processInstanceId,
    now: () => new Date('2026-08-31T00:00:00.000Z'),
    processInstanceIdFor: async (targetPid) => processes.get(targetPid),
    processIsRunning: (targetPid) => processes.has(targetPid),
  };
}

function runnerDependencies(
  overrides: Partial<PerformanceRunDependencies> = {},
): PerformanceRunDependencies {
  return {
    acquireRunLock: async () => ({
      owns: async () => true,
      prepareFinalCommit: async () => undefined,
      release: async () => undefined,
    }),
    createRunContext: async () => TEST_RUN_CONTEXT,
    resetGeneratedOutputs: async () => undefined,
    runPlaywright: async () => 0,
    auditAggregateOutput: async () => ({ result: 'pass', serialized: '{}' }),
    publishAggregateOutput: async () => undefined,
    writeCompactFailureReceipt: async () => undefined,
    invalidateAggregateOutput: async () => undefined,
    cleanupGeneratedPrivateOutputs: async () => undefined,
    ...overrides,
  };
}

function rejectAfter<T>(milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((_accept, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
}

describe('browser performance runner failure paths', () => {
  it('captures a stable opaque identity for the current process', async () => {
    const first = await processInstanceIdFor(process.pid);
    const second = await processInstanceIdFor(process.pid);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
  });

  it('blocks child startup when disconnect arrives during final owner revalidation', async () => {
    const owner = staleOwner(process.pid, INSTANCE_A);
    let disconnected = false;
    let started = false;
    await expect(
      guardianPreStartGate({
        disconnected: () => disconnected,
        connected: () => true,
        loadCurrentProcessInstanceId: async () => owner.processInstanceId,
        loadRetainedOwner: async () => {
          await Promise.resolve();
          disconnected = true;
          return owner;
        },
        expectedOwner: owner,
        start: () => {
          started = true;
        },
      }),
    ).resolves.toBe('coordinator-disconnected');
    expect(started).toBe(false);

    disconnected = false;
    await expect(
      guardianPreStartGate({
        disconnected: () => disconnected,
        connected: () => true,
        loadCurrentProcessInstanceId: async () => owner.processInstanceId,
        loadRetainedOwner: async () => owner,
        expectedOwner: owner,
        start: () => {
          started = true;
        },
      }),
    ).resolves.toBe('started');
    expect(started).toBe(true);
  });

  it('launches the guardian without a tsx wrapper and exits after a pre-start disconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-guardian-'));
    const lockPath = join(root, 'run.lock');
    let runLock: RunLock | undefined;
    let context: PerformanceRunContext | undefined;
    let guardian: ChildProcess | undefined;
    try {
      runLock = await acquireRunLockForCurrentProcessAt(lockPath);
      context = await createPerformanceRunContext(runLock, randomUUID());
      const generatedMarkers = [
        join(context.paths.playwrightOutput, 'private.txt'),
        join(context.paths.clientOutput, 'client.txt'),
        join(context.paths.viteCache, 'cache.txt'),
      ];
      await Promise.all([
        mkdir(context.paths.playwrightOutput, { recursive: true }),
        mkdir(context.paths.clientOutput, { recursive: true }),
        mkdir(context.paths.viteCache, { recursive: true }),
      ]);
      await Promise.all(generatedMarkers.map((path) => writeFile(path, 'private\n', 'utf8')));
      expect(runLock.guardianIdentity).toBeDefined();
      const arguments_ = playwrightGuardianSpawnArguments(runLock.guardianIdentity!, context.paths);
      expect(arguments_.slice(0, 4)).toEqual([
        '--import',
        TSX_LOADER,
        RUNNER_MODULE_PATH,
        '--playwright-guardian',
      ]);
      expect(arguments_).not.toContain(TSX_CLI);

      let stderr = '';
      guardian = spawn(process.execPath, arguments_, {
        cwd: resolve('.'),
        env: playwrightEnvironment(context.paths),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
        detached: true,
      });
      guardian.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const exit = new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
        guardian!.once('error', reject);
        guardian!.once('exit', (code, signal) => accept({ code, signal }));
      });
      const leased = new Promise<void>((accept, reject) => {
        guardian!.on('message', (message: unknown) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            !Array.isArray(message) &&
            (message as Record<string, unknown>).type === 'performance-guardian-leased'
          ) {
            accept();
          }
        });
        guardian!.once('error', reject);
        guardian!.once('exit', () => reject(new Error('Guardian exited before leasing.')));
      });
      await Promise.race([
        leased,
        rejectAfter<void>(10_000, 'Guardian did not acquire its lease.'),
      ]);
      await expect(acquireRunDescendantLeaseAt(lockPath)).rejects.toThrow(
        'already owns the operating-system mutex',
      );
      guardian.disconnect();
      await expect(
        Promise.race([
          exit,
          rejectAfter(10_000, 'Guardian did not exit after coordinator disconnect.'),
        ]),
      ).resolves.toEqual({ code: 1, signal: null });
      expect(stderr).not.toContain('invalid coordinator identity');
      expect(JSON.parse(await readFile(context.paths.guardianState, 'utf8'))).toEqual({
        schemaVersion: 'airspace-performance-guardian-result.v1',
        runId: context.paths.runId,
        state: 'interrupted',
      });
      expect(JSON.parse(await readFile(context.paths.guardianResult, 'utf8'))).toEqual({
        schemaVersion: 'airspace-performance-guardian-result.v1',
        runId: context.paths.runId,
        outcome: 'coordinator-disconnected-before-start',
        exitCode: 1,
      });
      await Promise.all(
        generatedMarkers.map((path) =>
          expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }),
        ),
      );
      const releasedLease = await acquireRunDescendantLeaseAt(lockPath);
      await releasedLease.release();
    } finally {
      if (guardian !== undefined && guardian.exitCode === null && guardian.signalCode === null) {
        guardian.kill();
      }
      if (context !== undefined) {
        await cleanupPerformanceRunNamespace(context).catch(() => undefined);
      }
      await runLock?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exits promptly for a valid guardian payload whose parent PID does not match', async () => {
    const mismatchedOwner = staleOwner(process.pid + 100_000, INSTANCE_A);
    const arguments_ = playwrightGuardianSpawnArguments(
      namespaceRunLock(mismatchedOwner).guardianIdentity!,
      TEST_RUN_CONTEXT.paths,
    );
    const guardian = spawn(process.execPath, arguments_, {
      cwd: resolve('.'),
      env: playwrightEnvironment(TEST_RUN_CONTEXT.paths),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      detached: true,
    });
    let stderr = '';
    guardian.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
      guardian.once('error', reject);
      guardian.once('exit', (code, signal) => accept({ code, signal }));
    });
    try {
      await expect(
        Promise.race([exit, rejectAfter(10_000, 'Mismatched guardian did not exit promptly.')]),
      ).resolves.toEqual({ code: 1, signal: null });
      expect(stderr.trim()).toBe('Playwright guardian received an invalid coordinator identity.');
    } finally {
      if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill();
    }
  });

  it('publishes an exclusive lock and recovers a stale lock after PID reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-lock-'));
    const lockPath = join(root, 'run.lock');
    const processes = new Map<number, string>([[101, INSTANCE_A]]);
    try {
      const first = await acquireRunLockAt(lockPath, fakeRuntime(101, INSTANCE_A, processes));
      await expect(
        acquireRunLockAt(lockPath, fakeRuntime(202, INSTANCE_B, processes)),
      ).rejects.toThrow('already owns');
      await first.release();

      await writeFile(lockPath, `${JSON.stringify(staleOwner())}\n`, 'utf8');
      processes.set(101, INSTANCE_B);
      processes.set(202, INSTANCE_C);
      const recovered = await acquireRunLockAt(lockPath, fakeRuntime(202, INSTANCE_C, processes));
      expect(await recovered.owns()).toBe(true);
      await recovered.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows only one of ten simultaneous launchers to replace the same stale lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-lock-race-'));
    const lockPath = join(root, 'run.lock');
    const contenders = Array.from({ length: 10 }, (_, index) => ({
      pid: 202 + index,
      instance: (index + 1).toString(16).repeat(64),
    }));
    const processes = new Map<number, string>([
      [101, INSTANCE_B],
      ...contenders.map(({ pid, instance }) => [pid, instance] as const),
    ]);
    try {
      await writeFile(lockPath, `${JSON.stringify(staleOwner())}\n`, 'utf8');
      const results = await Promise.allSettled(
        contenders.map(({ pid, instance }) =>
          acquireRunLockAt(lockPath, fakeRuntime(pid, instance, processes)),
        ),
      );
      const winners = results.filter(
        (result): result is PromiseFulfilledResult<RunLock> => result.status === 'fulfilled',
      );
      const losers = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(9);
      expect(
        losers.every((result) => String(result.reason).includes('operating-system mutex')),
      ).toBe(true);
      expect(await winners[0]!.value.owns()).toBe(true);
      await winners[0]!.value.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes only exact stable candidate and quarantine orphans before publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-lock-orphans-'));
    const lockPath = join(root, 'run.lock');
    const canonicalOwner = staleOwner();
    const candidateOwner = staleOwner(102, INSTANCE_B);
    const staleQuarantineOwner = staleOwner(103, INSTANCE_C);
    const staleNameToken = randomUUID();
    try {
      await Promise.all([
        writeFile(lockPath, `${JSON.stringify(canonicalOwner)}\n`, 'utf8'),
        writeFile(
          `${lockPath}.candidate.${candidateOwner.token}.0`,
          `${JSON.stringify(candidateOwner)}\n`,
          'utf8',
        ),
        writeFile(
          `${lockPath}.stale.${staleNameToken}.1`,
          `${JSON.stringify(staleQuarantineOwner)}\n`,
          'utf8',
        ),
      ]);
      const processes = new Map<number, string>([[202, INSTANCE_D]]);
      const recovered = await acquireRunLockAt(lockPath, fakeRuntime(202, INSTANCE_D, processes));
      expect(await recovered.owns()).toBe(true);
      await recovered.release();
      expect((await readdir(root)).filter((name) => name.startsWith('run.lock'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['candidate-written', 'stale-quarantined'] as const)(
    'recovers cleanly after a child exits during the %s crash window',
    async (pausedStage) => {
      const root = await mkdtemp(join(tmpdir(), 'airspace-performance-crash-window-'));
      const lockPath = join(root, 'run.lock');
      if (pausedStage === 'stale-quarantined') {
        await writeFile(lockPath, `${JSON.stringify(staleOwner())}\n`, 'utf8');
      }
      const moduleUrl = pathToFileURL(resolve('tools/live/runBrowserPerformance.ts')).toString();
      const childCode = `(async () => { const module = await import(${JSON.stringify(
        moduleUrl,
      )}); const instance = await module.processInstanceIdFor(process.pid); if (!instance) throw new Error('identity unavailable'); await module.acquireRunLockAt(${JSON.stringify(
        lockPath,
      )}, { pid: process.pid, processInstanceId: instance, now: () => new Date(), processInstanceIdFor: module.processInstanceIdFor, processIsRunning: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, onStage: async (stage) => { if (stage === ${JSON.stringify(
        pausedStage,
      )}) { process.stdout.write('paused\\n'); await new Promise(() => undefined); } } }); })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });`;
      const child = spawn(process.execPath, [TSX_CLI, '-e', childCode], {
        cwd: resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      try {
        await new Promise<void>((accept, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Child did not pause at ${pausedStage}.`)),
            10_000,
          );
          child.stdout.once('data', (chunk: Buffer) => {
            clearTimeout(timeout);
            if (chunk.toString('utf8').includes('paused')) accept();
            else reject(new Error('Crash-window child emitted unexpected output.'));
          });
          child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`Crash-window child exited early with ${String(code)}.`));
          });
        });
        const childExit = new Promise<void>((accept) => child.once('exit', () => accept()));
        child.kill();
        await childExit;
        const recovered = await acquireRunLockForCurrentProcessAt(lockPath);
        expect(await recovered.owns()).toBe(true);
        await recovered.release();
        expect((await readdir(root)).filter((name) => name.startsWith('run.lock'))).toEqual([]);
      } finally {
        if (child.exitCode === null) child.kill();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps a suspended child exclusive and reclaims its receipt after termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-child-lock-'));
    const lockPath = join(root, 'run.lock');
    const moduleUrl = pathToFileURL(resolve('tools/live/runBrowserPerformance.ts')).toString();
    const childCode = `(async () => { const module = await import(${JSON.stringify(
      moduleUrl,
    )}); await module.acquireRunLockForCurrentProcessAt(${JSON.stringify(
      lockPath,
    )}); process.stdout.write('ready\\n'); setInterval(() => undefined, 1000); })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });`;
    const child = spawn(process.execPath, [TSX_CLI, '-e', childCode], {
      cwd: resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      await new Promise<void>((accept, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Child run-lock holder did not become ready.')),
          10_000,
        );
        child.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          if (chunk.toString('utf8').includes('ready')) accept();
          else reject(new Error('Child run-lock holder emitted unexpected output.'));
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Child run-lock holder exited early with ${String(code)}.`));
        });
      });
      await expect(acquireRunLockForCurrentProcessAt(lockPath)).rejects.toThrow('already owns');
      const childExit = new Promise<void>((accept) => child.once('exit', () => accept()));
      child.kill();
      await childExit;
      const recovered = await acquireRunLockForCurrentProcessAt(lockPath);
      expect(await recovered.owns()).toBe(true);
      await recovered.release();
    } finally {
      if (child.exitCode === null) child.kill();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('blocks reset while a detached descendant lease survives coordinator termination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-descendant-lease-'));
    const lockPath = join(root, 'run.lock');
    const markerPath = join(root, 'descendant-ready.txt');
    const moduleUrl = pathToFileURL(resolve('tools/live/runBrowserPerformance.ts')).toString();
    const descendantCode = `(async () => { const module = await import(${JSON.stringify(
      moduleUrl,
    )}); const fs = await import('node:fs/promises'); await module.acquireRunDescendantLeaseAt(${JSON.stringify(
      lockPath,
    )}); await fs.writeFile(${JSON.stringify(
      markerPath,
    )}, String(process.pid), 'utf8'); setInterval(() => undefined, 1000); })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });`;
    const coordinatorCode = `(async () => { const module = await import(${JSON.stringify(
      moduleUrl,
    )}); const childProcess = await import('node:child_process'); const fs = await import('node:fs/promises'); await module.acquireRunLockForCurrentProcessAt(${JSON.stringify(
      lockPath,
    )}); const descendant = childProcess.spawn(process.execPath, [${JSON.stringify(
      TSX_CLI,
    )}, '-e', ${JSON.stringify(
      descendantCode,
    )}], { detached: true, stdio: 'ignore', windowsHide: true }); descendant.unref(); for (let attempt = 0; attempt < 300; attempt += 1) { try { await fs.access(${JSON.stringify(
      markerPath,
    )}); process.stdout.write('ready:' + String(descendant.pid) + '\\n'); setInterval(() => undefined, 1000); return; } catch { await new Promise((accept) => setTimeout(accept, 50)); } } throw new Error('descendant lease did not become ready'); })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });`;
    const coordinator = spawn(process.execPath, [TSX_CLI, '-e', coordinatorCode], {
      cwd: resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let descendantPid: number | undefined;
    try {
      descendantPid = await new Promise<number>((accept, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Coordinator descendant lease did not become ready.')),
          30_000,
        );
        coordinator.stdout.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          const match = /ready:(\d+)/u.exec(chunk.toString('utf8'));
          if (match?.[1] !== undefined) accept(Number(match[1]));
          else reject(new Error('Coordinator emitted unexpected descendant output.'));
        });
        coordinator.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        coordinator.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Coordinator exited early with ${String(code)}.`));
        });
      });
      const coordinatorExit = new Promise<void>((accept) =>
        coordinator.once('exit', () => accept()),
      );
      coordinator.kill();
      await coordinatorExit;

      let resetCalls = 0;
      await expect(
        runBrowserPerformanceWith(
          runnerDependencies({
            acquireRunLock: () => acquireRunLockForCurrentProcessAt(lockPath),
            resetGeneratedOutputs: async () => {
              resetCalls += 1;
            },
          }),
        ),
      ).rejects.toThrow('operating-system mutex');
      expect(resetCalls).toBe(0);

      process.kill(descendantPid);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await processInstanceIdFor(descendantPid)) === undefined) break;
        await new Promise((accept) => setTimeout(accept, 100));
      }
      expect(await processInstanceIdFor(descendantPid)).toBeUndefined();
      const recovered = await acquireRunLockForCurrentProcessAt(lockPath);
      expect(await recovered.owns()).toBe(true);
      await recovered.release();
      expect((await readdir(root)).filter((name) => name.startsWith('run.lock'))).toEqual([]);
    } finally {
      if (coordinator.exitCode === null) coordinator.kill();
      if (
        descendantPid !== undefined &&
        (await processInstanceIdFor(descendantPid)) !== undefined
      ) {
        process.kill(descendantPid);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the descendant lease when Windows tree termination cannot be verified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-tree-kill-failure-'));
    const lockPath = join(root, 'run.lock');
    const lease = await acquireRunDescendantLeaseAt(lockPath);
    let releaseHold: ((error: Error) => void) | undefined;
    const hold = new Promise<never>((_accept, reject) => {
      releaseHold = reject;
    });
    let directKillCalls = 0;
    let resetCalls = 0;
    const fakeChild = {
      pid: 424_242,
      exitCode: null,
      signalCode: null,
      kill: () => {
        directKillCalls += 1;
        return true;
      },
    } as unknown as ChildProcess;
    const termination = (async () => {
      try {
        await terminateGuardedProcessTree(
          fakeChild,
          Promise.resolve({ code: null, signal: 'SIGKILL' }),
          {
            platform: 'win32',
            terminateWindowsTree: async () => {
              throw new Error('synthetic taskkill failure');
            },
            holdAfterUnverifiedWindowsTermination: async () => hold,
            signalPosixGroup: () => undefined,
            wait: async () => undefined,
            holdAfterUnverifiedPosixTermination: async () => hold,
          },
        );
      } finally {
        await lease.release();
      }
    })();
    try {
      await new Promise((accept) => setTimeout(accept, 25));
      await expect(
        runBrowserPerformanceWith(
          runnerDependencies({
            acquireRunLock: () => acquireRunLockForCurrentProcessAt(lockPath),
            resetGeneratedOutputs: async () => {
              resetCalls += 1;
            },
          }),
        ),
      ).rejects.toThrow('operating-system mutex');
      expect(resetCalls).toBe(0);
      expect(directKillCalls).toBe(0);
    } finally {
      releaseHold?.(new Error('release synthetic fail-closed hold'));
      await termination.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('polls until a POSIX descendant process group is absent', async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    let probes = 0;
    const fakeChild = {
      pid: 515_151,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    } as unknown as ChildProcess;
    await terminateGuardedProcessTree(
      fakeChild,
      Promise.resolve({ code: null, signal: 'SIGTERM' }),
      {
        platform: 'linux',
        terminateWindowsTree: async () => undefined,
        holdAfterUnverifiedWindowsTermination: async () => new Promise<never>(() => undefined),
        signalPosixGroup: (_processGroupId, signal) => {
          signals.push(signal);
          if (signal === 0) {
            probes += 1;
            if (probes === 3) {
              throw Object.assign(new Error('group absent'), { code: 'ESRCH' });
            }
          }
        },
        wait: async () => undefined,
        holdAfterUnverifiedPosixTermination: async () => new Promise<never>(() => undefined),
      },
    );
    expect(signals).toEqual(['SIGTERM', 'SIGKILL', 0, 0, 0]);
  });

  it.each(['kill-error', 'timeout'] as const)(
    'keeps the descendant lease when POSIX group verification ends in %s',
    async (failureMode) => {
      const root = await mkdtemp(join(tmpdir(), 'airspace-performance-posix-kill-failure-'));
      const lockPath = join(root, 'run.lock');
      const lease = await acquireRunDescendantLeaseAt(lockPath);
      let releaseHold: ((error: Error) => void) | undefined;
      const hold = new Promise<never>((_accept, reject) => {
        releaseHold = reject;
      });
      let resetCalls = 0;
      const fakeChild = {
        pid: 616_161,
        exitCode: null,
        signalCode: null,
        kill: () => true,
      } as unknown as ChildProcess;
      const termination = (async () => {
        try {
          await terminateGuardedProcessTree(
            fakeChild,
            Promise.resolve({ code: null, signal: 'SIGTERM' }),
            {
              platform: 'linux',
              terminateWindowsTree: async () => undefined,
              holdAfterUnverifiedWindowsTermination: async () => hold,
              signalPosixGroup: (_processGroupId, signal) => {
                if (failureMode === 'kill-error' && signal === 'SIGKILL') {
                  throw Object.assign(new Error('synthetic group kill failure'), { code: 'EPERM' });
                }
              },
              wait: async () => undefined,
              holdAfterUnverifiedPosixTermination: async () => hold,
            },
          );
        } finally {
          await lease.release();
        }
      })();
      try {
        await new Promise((accept) => setTimeout(accept, 25));
        await expect(
          runBrowserPerformanceWith(
            runnerDependencies({
              acquireRunLock: () => acquireRunLockForCurrentProcessAt(lockPath),
              resetGeneratedOutputs: async () => {
                resetCalls += 1;
              },
            }),
          ),
        ).rejects.toThrow('operating-system mutex');
        expect(resetCalls).toBe(0);
      } finally {
        releaseHold?.(new Error('release synthetic POSIX fail-closed hold'));
        await termination.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('does not reset or clean outputs after ownership is lost', async () => {
    let resetCalls = 0;
    let cleanupCalls = 0;
    let invalidationCalls = 0;
    await expect(
      runBrowserPerformanceWith(
        runnerDependencies({
          acquireRunLock: async () => ({
            owns: async () => false,
            prepareFinalCommit: async () => undefined,
            release: async () => {
              throw new Error('synthetic ownership loss');
            },
          }),
          resetGeneratedOutputs: async () => {
            resetCalls += 1;
          },
          cleanupGeneratedPrivateOutputs: async () => {
            cleanupCalls += 1;
          },
          invalidateAggregateOutput: async () => {
            invalidationCalls += 1;
          },
        }),
      ),
    ).rejects.toThrow('lock release failed');
    expect(resetCalls).toBe(0);
    expect(cleanupCalls).toBe(0);
    expect(invalidationCalls).toBe(0);
  });

  it('retains a compact failure receipt when reset fails', async () => {
    const events: string[] = [];
    await expect(
      runBrowserPerformanceWith(
        runnerDependencies({
          resetGeneratedOutputs: async () => {
            events.push('reset');
            throw new Error('synthetic reset failure');
          },
          writeCompactFailureReceipt: async (stage, code) => {
            events.push(`receipt:${stage}:${code}`);
          },
          cleanupGeneratedPrivateOutputs: async () => {
            events.push('cleanup');
          },
          acquireRunLock: async () => ({
            owns: async () => true,
            prepareFinalCommit: async () => undefined,
            release: async () => {
              events.push('release');
            },
          }),
        }),
      ),
    ).rejects.toThrow('output reset failed');
    expect(events).toEqual([
      'receipt:runner-execution:RUNNER_EXECUTION_FAILED',
      'reset',
      'receipt:runner-execution:RUNNER_EXECUTION_FAILED',
      'cleanup',
      'release',
    ]);
  });

  it('cannot retain a passing report when lock release fails', async () => {
    let retainedResult: 'pass' | 'fail' | 'absent' = 'pass';
    await expect(
      runBrowserPerformanceWith(
        runnerDependencies({
          acquireRunLock: async () => ({
            owns: async () => true,
            prepareFinalCommit: async () => undefined,
            release: async () => {
              throw new Error('synthetic release failure');
            },
          }),
          writeCompactFailureReceipt: async () => {
            retainedResult = 'fail';
          },
          invalidateAggregateOutput: async () => {
            retainedResult = 'absent';
          },
        }),
      ),
    ).rejects.toThrow('lock release failed');
    expect(retainedResult).toBe('fail');
  });

  it('removes a passing report if the release-failure receipt cannot be written', async () => {
    let invalidated = false;
    await expect(
      runBrowserPerformanceWith(
        runnerDependencies({
          acquireRunLock: async () => ({
            owns: async () => true,
            prepareFinalCommit: async () => undefined,
            release: async () => {
              throw new Error('synthetic release failure');
            },
          }),
          writeCompactFailureReceipt: async () => {
            throw new Error('synthetic receipt failure');
          },
          invalidateAggregateOutput: async () => {
            invalidated = true;
          },
        }),
      ),
    ).rejects.toThrow('lock release failed');
    expect(invalidated).toBe(true);
  });

  it('removes the final and PID-temporary server identities only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-identity-'));
    const finalName = 'performance-server-identity-4174.json';
    const retainedName = `${finalName}.not-a-pid.tmp`;
    try {
      await Promise.all([
        writeFile(join(root, finalName), 'final', 'utf8'),
        writeFile(join(root, `${finalName}.1234.tmp`), 'temporary', 'utf8'),
        writeFile(join(root, retainedName), 'unrelated', 'utf8'),
      ]);
      await removeServerIdentityOutputsAt(root, finalName);
      await expect(readFile(join(root, finalName), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(root, `${finalName}.1234.tmp`), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(root, retainedName), 'utf8')).resolves.toBe('unrelated');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resets and cleans only the identity-bound run namespace', async () => {
    const first = await createPerformanceRunContext(namespaceRunLock(), randomUUID());
    const second = await createPerformanceRunContext(namespaceRunLock(), randomUUID());
    try {
      await Promise.all([
        mkdir(first.paths.clientOutput, { recursive: true }),
        mkdir(second.paths.clientOutput, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(first.paths.clientOutput, 'first.txt'), 'first', 'utf8'),
        writeFile(join(second.paths.clientOutput, 'second.txt'), 'second', 'utf8'),
      ]);
      await resetPerformanceRunNamespace(first);
      await expect(
        readFile(join(first.paths.clientOutput, 'first.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(second.paths.clientOutput, 'second.txt'), 'utf8')).resolves.toBe(
        'second',
      );
      await cleanupPerformanceRunNamespace(first);
      await expect(readFile(second.paths.runReceipt, 'utf8')).resolves.toContain(
        second.paths.runId,
      );
    } finally {
      await rm(first.paths.runRoot, { recursive: true, force: true });
      await rm(second.paths.runRoot, { recursive: true, force: true });
    }
  });

  it('replaces inherited child paths with the exact run-local environment', () => {
    const paths = performanceRunPathsForId(resolve('.'), randomUUID());
    const originalRunId = process.env.AIRSPACE_PERFORMANCE_RUN_ID;
    const originalViteCanary = process.env.VITE_PERFORMANCE_SECRET_CANARY;
    try {
      process.env.AIRSPACE_PERFORMANCE_RUN_ID = 'forged';
      process.env.VITE_PERFORMANCE_SECRET_CANARY = 'forbidden';
      const environment = playwrightEnvironment(paths);
      expect(environment).toMatchObject(performanceRunEnvironment(paths));
      expect(environment.NODE_ENV).toBe('production');
      expect(environment.PLAYWRIGHT_NO_COPY_PROMPT).toBe('1');
      expect(environment.VITE_PERFORMANCE_SECRET_CANARY).toBeUndefined();
    } finally {
      if (originalRunId === undefined) delete process.env.AIRSPACE_PERFORMANCE_RUN_ID;
      else process.env.AIRSPACE_PERFORMANCE_RUN_ID = originalRunId;
      if (originalViteCanary === undefined) delete process.env.VITE_PERFORMANCE_SECRET_CANARY;
      else process.env.VITE_PERFORMANCE_SECRET_CANARY = originalViteCanary;
    }
  });

  it('publishes canonical JSON atomically so readers observe only complete old or new receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-publish-'));
    const output = join(root, 'live-performance');
    const report = join(output, 'report.json');
    const oldReceipt = `${JSON.stringify(
      createCompactPerformanceFailureReceipt(
        'runner-execution',
        'RUNNER_EXECUTION_FAILED',
        '2026-08-31T00:00:00.000Z',
      ),
    )}\n`;
    const newReceipt = `${JSON.stringify(
      createCompactPerformanceFailureReceipt(
        'outer-output-audit',
        'AGGREGATE_OUTPUT_REJECTED',
        '2026-08-31T00:00:01.000Z',
      ),
    )}\n`;
    let reading = false;
    let reader: Promise<void> | undefined;
    try {
      await atomicPublishPerformanceReportAt(output, report, oldReceipt);
      reading = true;
      const observed = new Set<string>();
      reader = (async () => {
        while (reading) {
          const parsed = JSON.parse(await readFile(report, 'utf8')) as { completedAt: string };
          observed.add(parsed.completedAt);
          await new Promise((accept) => setTimeout(accept, 0));
        }
      })();
      for (let index = 0; index < 8; index += 1) {
        await atomicPublishPerformanceReportAt(
          output,
          report,
          index % 2 === 0 ? newReceipt : oldReceipt,
        );
      }
      reading = false;
      await reader;
      expect(
        [...observed].every((value) => value.endsWith('00.000Z') || value.endsWith('01.000Z')),
      ).toBe(true);
      expect(JSON.parse(await readFile(report, 'utf8'))).toEqual(JSON.parse(oldReceipt));
      expect(await readdir(output)).toEqual(['report.json']);
    } finally {
      reading = false;
      await reader?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('contains an escaped old writer inside its abandoned namespace', async () => {
    const oldRun = await createPerformanceRunContext(namespaceRunLock(), randomUUID());
    const newRun = await createPerformanceRunContext(namespaceRunLock(), randomUUID());
    const publicationRoot = await mkdtemp(join(tmpdir(), 'airspace-performance-escaped-writer-'));
    const output = join(publicationRoot, 'live-performance');
    const report = join(output, 'report.json');
    let writerActive = true;
    try {
      await Promise.all([
        mkdir(oldRun.paths.clientOutput, { recursive: true }),
        mkdir(newRun.paths.clientOutput, { recursive: true }),
      ]);
      await writeFile(join(newRun.paths.clientOutput, 'new.txt'), 'new-run', 'utf8');
      const escapedWriter = (async () => {
        let iteration = 0;
        while (writerActive) {
          await writeFile(
            join(oldRun.paths.clientOutput, 'escaped.txt'),
            `old-${iteration}`,
            'utf8',
          );
          iteration += 1;
          await new Promise((accept) => setTimeout(accept, 1));
        }
      })();
      const receipt = `${JSON.stringify(
        createCompactPerformanceFailureReceipt(
          'runner-execution',
          'RUNNER_EXECUTION_FAILED',
          '2026-08-31T00:00:02.000Z',
        ),
      )}\n`;
      await atomicPublishPerformanceReportAt(output, report, receipt);
      await new Promise((accept) => setTimeout(accept, 10));
      writerActive = false;
      await escapedWriter;
      expect(await readFile(join(newRun.paths.clientOutput, 'new.txt'), 'utf8')).toBe('new-run');
      expect(await readFile(report, 'utf8')).toBe(receipt);
      expect(oldRun.paths.runRoot).not.toBe(newRun.paths.runRoot);
    } finally {
      writerActive = false;
      await Promise.all([
        rm(oldRun.paths.runRoot, { recursive: true, force: true }),
        rm(newRun.paths.runRoot, { recursive: true, force: true }),
        rm(publicationRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('recovers only identity-safe completed stale run roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-stale-runs-'));
    const completedRunId = randomUUID();
    const inFlightRunId = randomUUID();
    const lookalike = `${randomUUID()}-lookalike`;
    const receiptFor = (runId: string) => ({
      schemaVersion: 'airspace-performance-run.v1',
      runId,
      lockToken: randomUUID(),
      coordinatorPid: 404_404,
      coordinatorProcessInstanceId: INSTANCE_A,
      createdAt: '2026-08-31T00:00:00.000Z',
    });
    try {
      await Promise.all([
        mkdir(join(root, completedRunId, 'guardian'), { recursive: true }),
        mkdir(join(root, inFlightRunId, 'guardian'), { recursive: true }),
        mkdir(join(root, lookalike), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(root, completedRunId, 'run.json'),
          `${JSON.stringify(receiptFor(completedRunId))}\n`,
          'utf8',
        ),
        writeFile(
          join(root, completedRunId, 'guardian', 'result.json'),
          `${JSON.stringify({
            schemaVersion: 'airspace-performance-guardian-result.v1',
            runId: completedRunId,
            outcome: 'complete',
            exitCode: 0,
          })}\n`,
          'utf8',
        ),
        writeFile(
          join(root, inFlightRunId, 'run.json'),
          `${JSON.stringify(receiptFor(inFlightRunId))}\n`,
          'utf8',
        ),
        writeFile(
          join(root, inFlightRunId, 'guardian', 'state.json'),
          `${JSON.stringify({
            schemaVersion: 'airspace-performance-guardian-result.v1',
            runId: inFlightRunId,
            state: 'started',
          })}\n`,
          'utf8',
        ),
        writeFile(join(root, lookalike, 'retained.txt'), 'retained', 'utf8'),
      ]);

      await recoverStalePerformanceRunRootsAt(root, {
        processInstanceIdFor: async () => INSTANCE_B,
        processIsRunning: () => true,
      });

      await expect(readFile(join(root, completedRunId, 'run.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(root, inFlightRunId, 'run.json'), 'utf8')).resolves.toContain(
        inFlightRunId,
      );
      await expect(readFile(join(root, lookalike, 'retained.txt'), 'utf8')).resolves.toBe(
        'retained',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a malformed exact UUID stale run root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airspace-performance-malformed-run-'));
    const malformedRunId = randomUUID();
    try {
      await mkdir(join(root, malformedRunId), { recursive: true });
      await writeFile(join(root, malformedRunId, 'run.json'), '{}\n', 'utf8');
      await expect(
        recoverStalePerformanceRunRootsAt(root, {
          processInstanceIdFor: async () => undefined,
          processIsRunning: () => false,
        }),
      ).rejects.toThrow('lacks an exact identity receipt');
      await expect(readFile(join(root, malformedRunId, 'run.json'), 'utf8')).resolves.toBe('{}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes only after cleanup and final commit preparation', async () => {
    const events: string[] = [];
    await runBrowserPerformanceWith(
      runnerDependencies({
        cleanupGeneratedPrivateOutputs: async () => {
          events.push('cleanup');
        },
        publishAggregateOutput: async () => {
          events.push('publish');
        },
        acquireRunLock: async () => ({
          owns: async () => true,
          prepareFinalCommit: async () => {
            events.push('prepareFinalCommit');
          },
          release: async () => {
            events.push('release');
          },
        }),
      }),
    );

    expect(events).toEqual(['cleanup', 'prepareFinalCommit', 'publish', 'release']);
    expect(events.indexOf('publish')).toBeGreaterThan(events.indexOf('cleanup'));
  });

  it('rejects a shallow forged passing aggregate', () => {
    expect(
      fullPerformanceReportSchemaIsValid({
        schemaVersion: 'airspace-live-performance.v1',
        result: 'pass',
        budgetPassed: true,
        cases: [
          { case: 'paint-500', result: 'pass' },
          { case: 'paint-1000', result: 'pass' },
          { case: 'maximum-500', result: 'pass' },
          { case: 'maximum-1000', result: 'pass' },
        ],
      }),
    ).toBe(false);
  });
});
