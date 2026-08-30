import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { platform as hostPlatform } from 'node:os';
import { createInterface } from 'node:readline';

export type WorkerdMemoryStatus = 'available' | 'unavailable' | 'error' | 'closed';

export type WorkerdMemoryErrorCode =
  | 'DISCOVERY_FAILED'
  | 'DISCOVERY_TIMEOUT'
  | 'INVALID_PROCESS_TREE'
  | 'SESSION_START_FAILED'
  | 'SESSION_START_TIMEOUT'
  | 'SAMPLE_FAILED'
  | 'SAMPLE_TIMEOUT'
  | 'INVALID_SAMPLE_OUTPUT'
  | 'SAMPLER_BUSY'
  | 'SAMPLER_CLOSED'
  | 'CLOSE_FAILED'
  | 'CLOSE_TIMEOUT';

export interface WorkerdMemoryErrorInfo {
  code: WorkerdMemoryErrorCode;
  message: string;
}

export interface WorkerdMemoryTiming {
  startedAtMonotonicMs: number;
  completedAtMonotonicMs: number;
  durationMs: number;
}

export interface WorkerdMemoryDiscovery extends WorkerdMemoryTiming {
  status: Exclude<WorkerdMemoryStatus, 'closed'>;
  pids: readonly number[];
  error: WorkerdMemoryErrorInfo | null;
  message: string;
}

export interface WorkerdMemorySample extends WorkerdMemoryTiming {
  status: WorkerdMemoryStatus;
  pids: readonly number[];
  rssBytes: number | null;
  error: WorkerdMemoryErrorInfo | null;
  message: string;
}

export interface WorkerdMemoryCloseResult extends WorkerdMemoryTiming {
  status: 'closed' | 'error';
  pids: readonly number[];
  error: WorkerdMemoryErrorInfo | null;
  message: string;
}

export interface WorkerdMemorySampler {
  readonly discovery: WorkerdMemoryDiscovery;
  sample(): Promise<WorkerdMemorySample>;
  close(): Promise<WorkerdMemoryCloseResult>;
}

export interface ProcessTreeEntry {
  pid: number;
  parentPid: number;
  name: string;
}

export interface ProcessRssEntry {
  pid: number;
  rssBytes: number;
  name: string;
}

export interface ParsedRssSnapshot {
  pids: readonly number[];
  rssBytes: number;
  processes: readonly ProcessRssEntry[];
}

export interface CommandInvocation {
  file: string;
  args: readonly string[];
  timeoutMs: number;
  windowsHide: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;

export interface LineRequestSession {
  request(line: string, timeoutMs: number): Promise<string>;
  close(timeoutMs: number): Promise<void>;
}

export interface WindowsLineSessionSpec {
  file: string;
  args: readonly string[];
  windowsHide: true;
  startupTimeoutMs: number;
  expectedPids: readonly number[];
}

export type WindowsLineSessionFactory = (
  specification: WindowsLineSessionSpec,
) => Promise<LineRequestSession>;

export interface WorkerdMemorySamplerDependencies {
  platform: NodeJS.Platform;
  rootPid: number;
  now: () => number;
  runCommand: CommandRunner;
  createWindowsLineSession: WindowsLineSessionFactory;
}

export interface WorkerdMemorySamplerOptions {
  discoveryTimeoutMs?: number;
  sampleTimeoutMs?: number;
  closeTimeoutMs?: number;
  dependencies?: Partial<WorkerdMemorySamplerDependencies>;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_SAMPLE_TIMEOUT_MS = 2_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1_024;

type InternalErrorCode =
  WorkerdMemoryErrorCode | 'COMMAND_FAILED' | 'COMMAND_TIMEOUT' | 'PROTOCOL_ERROR';

export class WorkerdMemorySamplerModuleError extends Error {
  override readonly name = 'WorkerdMemorySamplerModuleError';

  constructor(
    readonly code: InternalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return String(error);
}

function operationError(
  error: unknown,
  fallbackCode: WorkerdMemoryErrorCode,
  timeoutCode: WorkerdMemoryErrorCode,
): WorkerdMemoryErrorInfo {
  if (error instanceof WorkerdMemorySamplerModuleError) {
    if (error.code === 'INVALID_PROCESS_TREE' || error.code === 'INVALID_SAMPLE_OUTPUT') {
      return { code: error.code, message: error.message };
    }
    const code =
      error.code === 'COMMAND_TIMEOUT' ||
      error.code === 'SESSION_START_TIMEOUT' ||
      error.code === 'SAMPLE_TIMEOUT' ||
      error.code === 'CLOSE_TIMEOUT'
        ? timeoutCode
        : fallbackCode;
    return { code, message: error.message };
  }
  return { code: fallbackCode, message: errorMessage(error) };
}

function timing(now: () => number, startedAtMonotonicMs: number): WorkerdMemoryTiming {
  const completedAtMonotonicMs = now();
  if (!Number.isFinite(completedAtMonotonicMs)) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      'The monotonic clock returned a non-finite completion time.',
    );
  }
  return {
    startedAtMonotonicMs,
    completedAtMonotonicMs,
    durationMs: Math.max(0, completedAtMonotonicMs - startedAtMonotonicMs),
  };
}

function startTime(now: () => number): number {
  const startedAtMonotonicMs = now();
  if (!Number.isFinite(startedAtMonotonicMs)) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      'The monotonic clock returned a non-finite start time.',
    );
  }
  return startedAtMonotonicMs;
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 60_000) {
    throw new RangeError(`${name} must be a safe integer within [100, 60000] milliseconds.`);
  }
  return resolved;
}

export function validatePid(value: unknown, label = 'PID'): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      `${label} must be a positive safe integer.`,
    );
  }
  return value;
}

function validateParentPid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_PROCESS_TREE',
      `${label} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function validateProcessTreePid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_PROCESS_TREE',
      `${label} must be a non-negative safe integer.`,
    );
  }
  return value;
}

export function normalizePidSet(
  values: readonly unknown[],
  label = 'PID set',
  allowEmpty = false,
): number[] {
  const pids = values.map((value, index) => validatePid(value, `${label}[${index}]`));
  const unique = [...new Set(pids)].sort((left, right) => left - right);
  if (unique.length !== pids.length) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      `${label} contains a duplicate PID.`,
    );
  }
  if (!allowEmpty && unique.length === 0) {
    throw new WorkerdMemorySamplerModuleError('PROTOCOL_ERROR', `${label} cannot be empty.`);
  }
  return unique;
}

function requireProcessName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_PROCESS_TREE',
      `${label} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function assertUniqueProcessTree(entries: readonly ProcessTreeEntry[]): ProcessTreeEntry[] {
  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.pid)) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_PROCESS_TREE',
        `Process tree contains duplicate PID ${entry.pid}.`,
      );
    }
    seen.add(entry.pid);
  }
  return [...entries];
}

export function parseWindowsProcessTree(stdout: string): ProcessTreeEntry[] {
  if (stdout.trim().length === 0) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_PROCESS_TREE',
      'Windows process-tree discovery returned no output.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_PROCESS_TREE',
      `Windows process-tree discovery returned invalid JSON: ${errorMessage(error)}`,
    );
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const entries = rows.map((row, index): ProcessTreeEntry => {
    if (!isRecord(row)) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_PROCESS_TREE',
        `Windows process-tree row ${index} is not an object.`,
      );
    }
    return {
      pid: validateProcessTreePid(
        Number(row.ProcessId),
        `Windows process-tree row ${index} ProcessId`,
      ),
      parentPid: validateParentPid(
        Number(row.ParentProcessId),
        `Windows process-tree row ${index} ParentProcessId`,
      ),
      name: requireProcessName(row.Name, `Windows process-tree row ${index} Name`),
    };
  });
  return assertUniqueProcessTree(entries);
}

export function parsePosixProcessTree(stdout: string): ProcessTreeEntry[] {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_PROCESS_TREE',
      'POSIX process-tree discovery returned no output.',
    );
  }
  const entries = lines.map((line, index): ProcessTreeEntry => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u);
    if (match === null) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_PROCESS_TREE',
        `POSIX process-tree row ${index} is malformed: ${line.trim()}`,
      );
    }
    return {
      pid: validateProcessTreePid(Number(match[1]), `POSIX process-tree row ${index} PID`),
      parentPid: validateParentPid(Number(match[2]), `POSIX process-tree row ${index} parent PID`),
      name: requireProcessName(match[3], `POSIX process-tree row ${index} name`),
    };
  });
  return assertUniqueProcessTree(entries);
}

export function isWorkerdProcessName(name: string): boolean {
  const basename = name.trim().replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  return basename === 'workerd' || basename === 'workerd.exe';
}

export function findWorkerdDescendantPids(
  entries: readonly ProcessTreeEntry[],
  rootPid: number,
): number[] {
  const validatedRootPid = validatePid(rootPid, 'Root PID');
  assertUniqueProcessTree(entries);
  const children = new Map<number, ProcessTreeEntry[]>();
  for (const entry of entries) {
    const bucket = children.get(entry.parentPid) ?? [];
    bucket.push(entry);
    children.set(entry.parentPid, bucket);
  }

  const pids: number[] = [];
  const visited = new Set<number>([validatedRootPid]);
  const queue = [...(children.get(validatedRootPid) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (visited.has(entry.pid)) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_PROCESS_TREE',
        `Process tree contains a descendant cycle at PID ${entry.pid}.`,
      );
    }
    visited.add(entry.pid);
    if (isWorkerdProcessName(entry.name)) pids.push(entry.pid);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return normalizePidSet(pids, 'Discovered workerd PID set', true);
}

function samePids(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((pid, index) => pid === right[index]);
}

function safeRssBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      `${label} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function finishRssSnapshot(
  entries: readonly ProcessRssEntry[],
  expectedPids: readonly number[],
): ParsedRssSnapshot {
  const expected = normalizePidSet(expectedPids, 'Expected workerd PID set');
  const observed = normalizePidSet(
    entries.map((entry) => entry.pid),
    'Observed workerd PID set',
    true,
  );
  if (!samePids(observed, expected)) {
    const missing = expected.filter((pid) => !observed.includes(pid));
    const unexpected = observed.filter((pid) => !expected.includes(pid));
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      `Targeted workerd process set changed; missing=[${missing.join(',')}], unexpected=[${unexpected.join(',')}].`,
    );
  }
  for (const entry of entries) {
    if (!isWorkerdProcessName(entry.name)) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_SAMPLE_OUTPUT',
        `Target PID ${entry.pid} now names ${JSON.stringify(entry.name)}, not workerd.`,
      );
    }
  }
  const processes = [...entries].sort((left, right) => left.pid - right.pid);
  const rssBytes = processes.reduce((sum, entry) => {
    const next = sum + entry.rssBytes;
    if (!Number.isSafeInteger(next)) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_SAMPLE_OUTPUT',
        'Combined workerd RSS exceeds JavaScript safe-integer precision.',
      );
    }
    return next;
  }, 0);
  return { pids: observed, rssBytes, processes };
}

export function parseWindowsRssResponse(
  line: string,
  expectedRequestId: string,
  expectedPids: readonly number[],
): ParsedRssSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      `The persistent PowerShell sampler returned invalid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.kind !== 'sample') {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      'The persistent PowerShell sampler returned an invalid message kind.',
    );
  }
  if (String(parsed.requestId) !== expectedRequestId) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      `PowerShell sampler response request ${String(parsed.requestId)} did not match ${expectedRequestId}.`,
    );
  }
  if (parsed.ok !== true) {
    const reported = Array.isArray(parsed.errors)
      ? parsed.errors
          .map((entry) => {
            if (!isRecord(entry)) return JSON.stringify(entry);
            return `PID ${String(entry.pid)}: ${String(entry.message)}`;
          })
          .join('; ')
      : String(parsed.error ?? 'unspecified targeted process error');
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      `PowerShell sampler reported a targeted process error: ${reported}`,
    );
  }
  if (!Array.isArray(parsed.rows)) {
    throw new WorkerdMemorySamplerModuleError(
      'INVALID_SAMPLE_OUTPUT',
      'PowerShell sampler response rows must be an array.',
    );
  }
  const entries = parsed.rows.map((row, index): ProcessRssEntry => {
    if (!isRecord(row)) {
      throw new WorkerdMemorySamplerModuleError(
        'INVALID_SAMPLE_OUTPUT',
        `PowerShell sampler row ${index} is not an object.`,
      );
    }
    return {
      pid: validatePid(Number(row.pid), `PowerShell sampler row ${index} PID`),
      rssBytes: safeRssBytes(Number(row.rssBytes), `PowerShell sampler row ${index} RSS bytes`),
      name: requireProcessName(row.name, `PowerShell sampler row ${index} name`),
    };
  });
  return finishRssSnapshot(entries, expectedPids);
}

export function parsePosixRssOutput(
  stdout: string,
  expectedPids: readonly number[],
): ParsedRssSnapshot {
  const entries = stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index): ProcessRssEntry => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u);
      if (match === null) {
        throw new WorkerdMemorySamplerModuleError(
          'INVALID_SAMPLE_OUTPUT',
          `Targeted ps row ${index} is malformed: ${line.trim()}`,
        );
      }
      const rssKibibytes = safeRssBytes(Number(match[2]), `Targeted ps row ${index} RSS KiB`);
      const rssBytes = rssKibibytes * 1_024;
      return {
        pid: validatePid(Number(match[1]), `Targeted ps row ${index} PID`),
        rssBytes: safeRssBytes(rssBytes, `Targeted ps row ${index} RSS bytes`),
        name: requireProcessName(match[3], `Targeted ps row ${index} name`),
      };
    });
  return finishRssSnapshot(entries, expectedPids);
}

export function buildWindowsSamplerScript(pids: readonly number[]): string {
  const validated = normalizePidSet(pids, 'PowerShell sampler PID set');
  const literal = validated.join(',');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$targetPids = @(${literal})
$ready = [ordered]@{ kind = 'ready'; pids = @($targetPids) }
[Console]::Out.WriteLine(($ready | ConvertTo-Json -Compress -Depth 5))
while (($requestLine = [Console]::In.ReadLine()) -ne $null) {
  if ($requestLine -eq 'close') { break }
  $requestId = 0L
  if (-not [long]::TryParse($requestLine, [ref]$requestId) -or $requestId -lt 1) {
    $invalid = [ordered]@{ kind = 'sample'; requestId = $requestLine; ok = $false; rows = @(); errors = @([ordered]@{ pid = 0; message = 'Invalid request identifier.' }) }
    [Console]::Out.WriteLine(($invalid | ConvertTo-Json -Compress -Depth 5))
    continue
  }
  $rows = @()
  $errors = @()
  foreach ($targetPid in $targetPids) {
    try {
      $target = Get-Process -Id $targetPid -ErrorAction Stop
      $rows += [ordered]@{ pid = [int]$target.Id; rssBytes = [long]$target.WorkingSet64; name = [string]$target.ProcessName }
    } catch {
      $errors += [ordered]@{ pid = [int]$targetPid; message = [string]$_.Exception.Message }
    }
  }
  $response = [ordered]@{ kind = 'sample'; requestId = [string]$requestId; ok = ($errors.Count -eq 0); rows = @($rows); errors = @($errors) }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
}
`.trim();
}

function parseReadyMessage(line: string, expectedPids: readonly number[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      `Persistent PowerShell sampler readiness output was invalid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(parsed) || parsed.kind !== 'ready' || !Array.isArray(parsed.pids)) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      'Persistent PowerShell sampler returned an invalid readiness message.',
    );
  }
  const observed = normalizePidSet(parsed.pids, 'PowerShell readiness PID set');
  const expected = normalizePidSet(expectedPids, 'Expected PowerShell PID set');
  if (!samePids(observed, expected)) {
    throw new WorkerdMemorySamplerModuleError(
      'PROTOCOL_ERROR',
      'Persistent PowerShell sampler readiness PID set did not match discovery.',
    );
  }
}

function appendBounded(existing: string, addition: string): string {
  const combined = existing + addition;
  return combined.length <= MAX_DIAGNOSTIC_BYTES
    ? combined
    : combined.slice(combined.length - MAX_DIAGNOSTIC_BYTES);
}

class PersistentPowerShellSession implements LineRequestSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private ready = false;
  private exited = false;
  private fatalError: Error | null = null;
  private stderr = '';
  private pending:
    | {
        resolve: (line: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private readyPromise: Promise<string>;
  private resolveReady!: (line: string) => void;
  private rejectReady!: (error: Error) => void;
  private closePromise: Promise<void> | undefined;

  constructor(specification: WindowsLineSessionSpec) {
    this.readyPromise = new Promise<string>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn(specification.file, [...specification.args], {
      windowsHide: specification.windowsHide,
      stdio: 'pipe',
    });
    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exited = true;
        resolve({ code, signal });
        if (!this.ready) {
          this.rejectReady(
            this.fatalError ??
              new WorkerdMemorySamplerModuleError(
                'SESSION_START_FAILED',
                `Persistent PowerShell sampler exited before readiness (code=${String(code)}, signal=${String(signal)}).${this.stderr.length === 0 ? '' : ` stderr=${this.stderr.trim()}`}`,
              ),
          );
        }
        this.rejectPending(
          this.fatalError ??
            new WorkerdMemorySamplerModuleError(
              'SAMPLE_FAILED',
              `Persistent PowerShell sampler exited (code=${String(code)}, signal=${String(signal)}).${this.stderr.length === 0 ? '' : ` stderr=${this.stderr.trim()}`}`,
            ),
        );
      });
    });

    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    lines.on('line', (line) => {
      if (!this.ready) {
        this.ready = true;
        this.resolveReady(line);
        return;
      }
      const pending = this.pending;
      if (pending === undefined) {
        this.failFatal(
          new WorkerdMemorySamplerModuleError(
            'PROTOCOL_ERROR',
            `Persistent PowerShell sampler emitted an unsolicited line: ${line.slice(0, 256)}`,
          ),
        );
        return;
      }
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve(line);
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = appendBounded(this.stderr, chunk);
      this.failFatal(
        new WorkerdMemorySamplerModuleError(
          'PROTOCOL_ERROR',
          `Persistent PowerShell sampler wrote to stderr: ${this.stderr.trim()}`,
        ),
      );
    });
    this.child.once('error', (error) => this.failFatal(error));
  }

  async waitUntilReady(expectedPids: readonly number[], timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const line = await Promise.race([
        this.readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new WorkerdMemorySamplerModuleError(
                'SESSION_START_TIMEOUT',
                `Persistent PowerShell sampler did not become ready within ${timeoutMs} ms.`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      parseReadyMessage(line, expectedPids);
    } catch (error) {
      this.child.kill();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  request(line: string, timeoutMs: number): Promise<string> {
    if (this.fatalError !== null) return Promise.reject(this.fatalError);
    if (this.exited) {
      return Promise.reject(
        new WorkerdMemorySamplerModuleError(
          'SAMPLE_FAILED',
          'Persistent PowerShell sampler has exited.',
        ),
      );
    }
    if (this.pending !== undefined) {
      return Promise.reject(
        new WorkerdMemorySamplerModuleError(
          'PROTOCOL_ERROR',
          'Persistent PowerShell sampler already has an in-flight request.',
        ),
      );
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        const error = new WorkerdMemorySamplerModuleError(
          'SAMPLE_TIMEOUT',
          `Persistent PowerShell sampler did not respond within ${timeoutMs} ms.`,
        );
        this.failFatal(error);
        reject(error);
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(`${line}\n`, (error) => {
        if (error === null || error === undefined) return;
        clearTimeout(timer);
        this.pending = undefined;
        this.failFatal(error);
        reject(error);
      });
    });
  }

  close(timeoutMs: number): Promise<void> {
    this.closePromise ??= this.closeOnce(timeoutMs);
    return this.closePromise;
  }

  private async closeOnce(timeoutMs: number): Promise<void> {
    if (this.exited) {
      if (this.fatalError !== null) throw this.fatalError;
      return;
    }
    if (this.pending !== undefined) {
      throw new WorkerdMemorySamplerModuleError(
        'CLOSE_FAILED',
        'Cannot close the persistent PowerShell sampler while a request is in flight.',
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write('close\n', (error) => {
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.exitPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new WorkerdMemorySamplerModuleError(
                'CLOSE_TIMEOUT',
                `Persistent PowerShell sampler did not exit within ${timeoutMs} ms.`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      if (result.code !== 0) {
        throw new WorkerdMemorySamplerModuleError(
          'CLOSE_FAILED',
          `Persistent PowerShell sampler exited during close with code=${String(result.code)}, signal=${String(result.signal)}.${this.stderr.length === 0 ? '' : ` stderr=${this.stderr.trim()}`}`,
        );
      }
    } catch (error) {
      this.child.kill();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.reject(error);
  }

  private failFatal(error: Error): void {
    if (this.fatalError !== null) return;
    this.fatalError = error;
    if (!this.ready) this.rejectReady(error);
    this.rejectPending(error);
    if (!this.exited) this.child.kill();
  }
}

export const defaultCommandRunner: CommandRunner = async (invocation): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      invocation.file,
      [...invocation.args],
      {
        windowsHide: invocation.windowsHide,
        encoding: 'utf8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) {
          reject(
            new WorkerdMemorySamplerModuleError(
              'COMMAND_FAILED',
              `Command ${invocation.file} failed: ${error.message}${stderr.trim().length === 0 ? '' : `; stderr=${stderr.trim()}`}`,
            ),
          );
          return;
        }
        if (stderr.trim().length > 0) {
          reject(
            new WorkerdMemorySamplerModuleError(
              'COMMAND_FAILED',
              `Command ${invocation.file} wrote to stderr: ${stderr.trim()}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new WorkerdMemorySamplerModuleError(
          'COMMAND_TIMEOUT',
          `Command ${invocation.file} exceeded its ${invocation.timeoutMs} ms timeout.`,
        ),
      );
    }, invocation.timeoutMs);
  });

export const defaultWindowsLineSessionFactory: WindowsLineSessionFactory = async (
  specification,
): Promise<LineRequestSession> => {
  const session = new PersistentPowerShellSession(specification);
  await session.waitUntilReady(specification.expectedPids, specification.startupTimeoutMs);
  return session;
};

function discoveryInvocation(platformName: NodeJS.Platform, timeoutMs: number): CommandInvocation {
  if (platformName === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress',
      ],
      timeoutMs,
      windowsHide: true,
    };
  }
  return {
    file: 'ps',
    args: ['-eo', 'pid=,ppid=,comm='],
    timeoutMs,
    windowsHide: false,
  };
}

function posixSampleInvocation(pids: readonly number[], timeoutMs: number): CommandInvocation {
  const validated = normalizePidSet(pids, 'Targeted ps PID set');
  return {
    file: 'ps',
    args: ['-o', 'pid=,rss=,comm=', '-p', validated.join(',')],
    timeoutMs,
    windowsHide: false,
  };
}

class WorkerdMemorySamplerImplementation implements WorkerdMemorySampler {
  private activeSample: Promise<WorkerdMemorySample> | null = null;
  private closeResult: Promise<WorkerdMemoryCloseResult> | null = null;
  private closing = false;
  private requestId = 0;

  constructor(
    readonly discovery: WorkerdMemoryDiscovery,
    private readonly platformName: NodeJS.Platform,
    private readonly now: () => number,
    private readonly runCommand: CommandRunner,
    private readonly session: LineRequestSession | null,
    private readonly sampleTimeoutMs: number,
    private readonly closeTimeoutMs: number,
  ) {}

  async sample(): Promise<WorkerdMemorySample> {
    const startedAtMonotonicMs = startTime(this.now);
    if (this.closing || this.closeResult !== null) {
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: 'closed',
        pids: this.discovery.pids,
        rssBytes: null,
        error: { code: 'SAMPLER_CLOSED', message: 'The workerd memory sampler is closed.' },
        message: 'No sample was attempted after sampler close began.',
      };
    }
    if (this.activeSample !== null) {
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: 'error',
        pids: this.discovery.pids,
        rssBytes: null,
        error: {
          code: 'SAMPLER_BUSY',
          message: 'A workerd memory sample is already in flight.',
        },
        message: 'Concurrent workerd memory samples are rejected explicitly.',
      };
    }
    if (this.discovery.status !== 'available') {
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: this.discovery.status,
        pids: this.discovery.pids,
        rssBytes: null,
        error: this.discovery.error,
        message: this.discovery.message,
      };
    }

    const operation = this.sampleAvailable(startedAtMonotonicMs);
    this.activeSample = operation;
    try {
      return await operation;
    } finally {
      if (this.activeSample === operation) this.activeSample = null;
    }
  }

  close(): Promise<WorkerdMemoryCloseResult> {
    this.closeResult ??= this.closeOnce();
    return this.closeResult;
  }

  private async sampleAvailable(startedAtMonotonicMs: number): Promise<WorkerdMemorySample> {
    try {
      let snapshot: ParsedRssSnapshot;
      if (this.platformName === 'win32') {
        if (this.session === null) {
          throw new WorkerdMemorySamplerModuleError(
            'SAMPLE_FAILED',
            'The Windows sampler has no persistent PowerShell session.',
          );
        }
        this.requestId += 1;
        if (!Number.isSafeInteger(this.requestId)) {
          throw new WorkerdMemorySamplerModuleError(
            'SAMPLE_FAILED',
            'The persistent sampler request identifier was exhausted.',
          );
        }
        const expectedRequestId = String(this.requestId);
        const line = await this.session.request(expectedRequestId, this.sampleTimeoutMs);
        snapshot = parseWindowsRssResponse(line, expectedRequestId, this.discovery.pids);
      } else {
        const result = await this.runCommand(
          posixSampleInvocation(this.discovery.pids, this.sampleTimeoutMs),
        );
        if (result.stderr.trim().length > 0) {
          throw new WorkerdMemorySamplerModuleError(
            'SAMPLE_FAILED',
            `Targeted ps wrote to stderr: ${result.stderr.trim()}`,
          );
        }
        snapshot = parsePosixRssOutput(result.stdout, this.discovery.pids);
      }
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: 'available',
        pids: snapshot.pids,
        rssBytes: snapshot.rssBytes,
        error: null,
        message: `Measured ${snapshot.pids.length} validated workerd process${snapshot.pids.length === 1 ? '' : 'es'}.`,
      };
    } catch (error) {
      const sampleError = operationError(error, 'SAMPLE_FAILED', 'SAMPLE_TIMEOUT');
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: 'error',
        pids: this.discovery.pids,
        rssBytes: null,
        error: sampleError,
        message: 'The targeted workerd RSS sample failed.',
      };
    }
  }

  private async closeOnce(): Promise<WorkerdMemoryCloseResult> {
    const startedAtMonotonicMs = startTime(this.now);
    this.closing = true;
    if (this.activeSample !== null) await this.activeSample;
    try {
      if (this.session !== null) await this.session.close(this.closeTimeoutMs);
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: 'closed',
        pids: this.discovery.pids,
        error: null,
        message: 'The workerd memory sampler closed cleanly.',
      };
    } catch (error) {
      const closeError = operationError(error, 'CLOSE_FAILED', 'CLOSE_TIMEOUT');
      return {
        ...timing(this.now, startedAtMonotonicMs),
        status: 'error',
        pids: this.discovery.pids,
        error: closeError,
        message: 'The workerd memory sampler failed to close cleanly.',
      };
    }
  }
}

export async function createWorkerdMemorySampler(
  options: WorkerdMemorySamplerOptions = {},
): Promise<WorkerdMemorySampler> {
  const discoveryTimeoutMs = positiveTimeout(
    options.discoveryTimeoutMs,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    'discoveryTimeoutMs',
  );
  const sampleTimeoutMs = positiveTimeout(
    options.sampleTimeoutMs,
    DEFAULT_SAMPLE_TIMEOUT_MS,
    'sampleTimeoutMs',
  );
  const closeTimeoutMs = positiveTimeout(
    options.closeTimeoutMs,
    DEFAULT_CLOSE_TIMEOUT_MS,
    'closeTimeoutMs',
  );
  const dependencies = options.dependencies;
  const platformName = dependencies?.platform ?? hostPlatform();
  const rootPid = validatePid(dependencies?.rootPid ?? process.pid, 'Current Node PID');
  const now = dependencies?.now ?? (() => performance.now());
  const runCommand = dependencies?.runCommand ?? defaultCommandRunner;
  const createWindowsLineSession =
    dependencies?.createWindowsLineSession ?? defaultWindowsLineSessionFactory;
  const startedAtMonotonicMs = startTime(now);

  let pids: number[] = [];
  let discovery: WorkerdMemoryDiscovery;
  try {
    const result = await runCommand(discoveryInvocation(platformName, discoveryTimeoutMs));
    if (result.stderr.trim().length > 0) {
      throw new WorkerdMemorySamplerModuleError(
        'DISCOVERY_FAILED',
        `Process-tree discovery wrote to stderr: ${result.stderr.trim()}`,
      );
    }
    const processTree =
      platformName === 'win32'
        ? parseWindowsProcessTree(result.stdout)
        : parsePosixProcessTree(result.stdout);
    pids = findWorkerdDescendantPids(processTree, rootPid);
    if (pids.length === 0) {
      discovery = {
        ...timing(now, startedAtMonotonicMs),
        status: 'unavailable',
        pids,
        error: null,
        message: `No workerd descendants were present beneath Node PID ${rootPid} during one-time discovery.`,
      };
    } else {
      discovery = {
        ...timing(now, startedAtMonotonicMs),
        status: 'available',
        pids,
        error: null,
        message: `Discovered ${pids.length} workerd descendant${pids.length === 1 ? '' : 's'} beneath Node PID ${rootPid}.`,
      };
    }
  } catch (error) {
    const discoveryError = operationError(error, 'DISCOVERY_FAILED', 'DISCOVERY_TIMEOUT');
    discovery = {
      ...timing(now, startedAtMonotonicMs),
      status: 'error',
      pids,
      error: discoveryError,
      message: 'One-time workerd process-tree discovery failed.',
    };
  }

  let session: LineRequestSession | null = null;
  if (discovery.status === 'available' && platformName === 'win32') {
    const sessionStartedAt = startTime(now);
    try {
      const script = buildWindowsSamplerScript(discovery.pids);
      session = await createWindowsLineSession({
        file: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          script,
        ],
        windowsHide: true,
        startupTimeoutMs: sampleTimeoutMs,
        expectedPids: discovery.pids,
      });
    } catch (error) {
      const sessionError = operationError(error, 'SESSION_START_FAILED', 'SESSION_START_TIMEOUT');
      discovery = {
        ...timing(now, sessionStartedAt),
        status: 'error',
        pids: discovery.pids,
        error: sessionError,
        message:
          'Workerd descendants were discovered, but the persistent PowerShell sampler failed to start.',
      };
    }
  }

  return new WorkerdMemorySamplerImplementation(
    discovery,
    platformName,
    now,
    runCommand,
    session,
    sampleTimeoutMs,
    closeTimeoutMs,
  );
}
