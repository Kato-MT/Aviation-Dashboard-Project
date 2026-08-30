import { describe, expect, it, vi } from 'vitest';

import {
  buildWindowsSamplerScript,
  createWorkerdMemorySampler,
  findWorkerdDescendantPids,
  isWorkerdProcessName,
  normalizePidSet,
  parsePosixProcessTree,
  parsePosixRssOutput,
  parseWindowsProcessTree,
  parseWindowsRssResponse,
  validatePid,
  WorkerdMemorySamplerModuleError,
  type CommandInvocation,
  type CommandResult,
  type LineRequestSession,
  type WindowsLineSessionSpec,
} from '../../tools/live/workerdMemorySampler';

function windowsTree(): string {
  return JSON.stringify([
    { ProcessId: 0, ParentProcessId: 0, Name: 'System Idle Process' },
    { ProcessId: 10, ParentProcessId: 1, Name: 'node.exe' },
    { ProcessId: 20, ParentProcessId: 10, Name: 'Miniflare.exe' },
    { ProcessId: 41, ParentProcessId: 20, Name: 'workerd.exe' },
    { ProcessId: 42, ParentProcessId: 20, Name: 'WORKERD.EXE' },
    { ProcessId: 50, ParentProcessId: 1, Name: 'workerd.exe' },
    { ProcessId: 60, ParentProcessId: 10, Name: 'not-workerd.exe' },
  ]);
}

function windowsResponse(requestId: string, firstRss = 1_024, secondRss = 2_048): string {
  return JSON.stringify({
    kind: 'sample',
    requestId,
    ok: true,
    rows: [
      { pid: 42, rssBytes: secondRss, name: 'workerd' },
      { pid: 41, rssBytes: firstRss, name: 'workerd' },
    ],
    errors: [],
  });
}

class FakeLineSession implements LineRequestSession {
  readonly requests: Array<{ line: string; timeoutMs: number }> = [];
  closeCalls = 0;
  requestError: Error | null = null;
  closeError: Error | null = null;

  async request(line: string, timeoutMs: number): Promise<string> {
    this.requests.push({ line, timeoutMs });
    if (this.requestError !== null) throw this.requestError;
    return windowsResponse(line);
  }

  async close(_timeoutMs: number): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== null) throw this.closeError;
  }
}

describe('workerd process discovery helpers', () => {
  it('validates positive safe PIDs and canonicalizes a unique set', () => {
    expect(validatePid(7)).toBe(7);
    expect(normalizePidSet([42, 7, 19])).toEqual([7, 19, 42]);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '7']) {
      expect(() => validatePid(invalid)).toThrow('must be a positive safe integer');
    }
    expect(() => normalizePidSet([7, 7])).toThrow('contains a duplicate PID');
    expect(() => normalizePidSet([])).toThrow('cannot be empty');
  });

  it('parses a Windows singleton or array and selects only exact descendants named workerd', () => {
    expect(
      parseWindowsProcessTree(
        JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'node.exe' }),
      ),
    ).toEqual([{ pid: 7, parentPid: 1, name: 'node.exe' }]);
    const entries = parseWindowsProcessTree(windowsTree());
    expect(entries[0]).toEqual({ pid: 0, parentPid: 0, name: 'System Idle Process' });
    expect(findWorkerdDescendantPids(entries, 10)).toEqual([41, 42]);
    expect(isWorkerdProcessName('C:\\runtime\\WORKERD.EXE')).toBe(true);
    expect(isWorkerdProcessName('/runtime/workerd')).toBe(true);
    expect(isWorkerdProcessName('not-workerd')).toBe(false);
  });

  it('parses a POSIX tree and rejects malformed, duplicate, or cyclic trees', () => {
    const entries = parsePosixProcessTree(`
      10 1 node
      20 10 miniflare
      41 20 /runtime/workerd
      50 1 workerd
    `);
    expect(findWorkerdDescendantPids(entries, 10)).toEqual([41]);
    expect(() => parsePosixProcessTree('10 broken')).toThrow('is malformed');
    expect(() => parsePosixProcessTree('10 1 node\n10 1 node')).toThrow('duplicate PID 10');
    expect(() =>
      findWorkerdDescendantPids(
        [
          { pid: 20, parentPid: 10, name: 'miniflare' },
          { pid: 10, parentPid: 20, name: 'node' },
        ],
        10,
      ),
    ).toThrow('descendant cycle at PID 10');
  });
});

describe('targeted RSS parsers', () => {
  it('sums exact Windows target rows independent of response order', () => {
    expect(parseWindowsRssResponse(windowsResponse('7'), '7', [41, 42])).toEqual({
      pids: [41, 42],
      rssBytes: 3_072,
      processes: [
        { pid: 41, rssBytes: 1_024, name: 'workerd' },
        { pid: 42, rssBytes: 2_048, name: 'workerd' },
      ],
    });
  });

  it('rejects request mismatches, reported errors, missing targets, and changed names', () => {
    expect(() => parseWindowsRssResponse(windowsResponse('8'), '7', [41, 42])).toThrow(
      'did not match 7',
    );
    expect(() =>
      parseWindowsRssResponse(
        JSON.stringify({
          kind: 'sample',
          requestId: '7',
          ok: false,
          rows: [],
          errors: [{ pid: 41, message: 'Cannot find a process' }],
        }),
        '7',
        [41],
      ),
    ).toThrow('PID 41: Cannot find a process');
    expect(() =>
      parseWindowsRssResponse(
        JSON.stringify({
          kind: 'sample',
          requestId: '7',
          ok: true,
          rows: [{ pid: 41, rssBytes: 100, name: 'workerd' }],
        }),
        '7',
        [41, 42],
      ),
    ).toThrow('missing=[42]');
    expect(() =>
      parseWindowsRssResponse(
        JSON.stringify({
          kind: 'sample',
          requestId: '7',
          ok: true,
          rows: [{ pid: 41, rssBytes: 100, name: 'calc' }],
        }),
        '7',
        [41],
      ),
    ).toThrow('not workerd');
  });

  it('parses targeted ps KiB as bytes and requires the complete validated PID set', () => {
    expect(parsePosixRssOutput('42 4 workerd\n41 2 /runtime/workerd\n', [41, 42])).toEqual({
      pids: [41, 42],
      rssBytes: 6_144,
      processes: [
        { pid: 41, rssBytes: 2_048, name: '/runtime/workerd' },
        { pid: 42, rssBytes: 4_096, name: 'workerd' },
      ],
    });
    expect(() => parsePosixRssOutput('41 2 workerd\n', [41, 42])).toThrow('missing=[42]');
    expect(() => parsePosixRssOutput('41 2 workerd\n41 3 workerd\n', [41])).toThrow(
      'duplicate PID',
    );
    expect(() => parsePosixRssOutput('41 NaN workerd\n', [41])).toThrow('is malformed');
  });

  it('builds a fixed-target script without all-process enumeration or silent errors', () => {
    const script = buildWindowsSamplerScript([42, 41]);
    expect(script).toContain('$targetPids = @(41,42)');
    expect(script).toContain('Get-Process -Id $targetPid -ErrorAction Stop');
    expect(script).not.toContain('Get-CimInstance');
    expect(script).not.toContain('SilentlyContinue');
  });
});

describe('workerd memory sampler lifecycle', () => {
  it('discovers once, reuses one hidden Windows session, times samples, and closes once', async () => {
    const runCalls: CommandInvocation[] = [];
    const runCommand = vi.fn(async (invocation: CommandInvocation): Promise<CommandResult> => {
      runCalls.push(invocation);
      return { stdout: windowsTree(), stderr: '' };
    });
    const session = new FakeLineSession();
    let sessionSpec: WindowsLineSessionSpec | undefined;
    const createSession = vi.fn(async (specification: WindowsLineSessionSpec) => {
      sessionSpec = specification;
      return session;
    });
    let clock = 100;
    const sampler = await createWorkerdMemorySampler({
      sampleTimeoutMs: 1_500,
      dependencies: {
        platform: 'win32',
        rootPid: 10,
        now: () => {
          clock += 5;
          return clock;
        },
        runCommand,
        createWindowsLineSession: createSession,
      },
    });

    expect(sampler.discovery).toMatchObject({
      status: 'available',
      pids: [41, 42],
      durationMs: 5,
    });
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]).toMatchObject({ file: 'powershell.exe', windowsHide: true });
    expect(runCalls[0]!.args.join(' ')).toContain('Get-CimInstance Win32_Process');
    expect(sessionSpec).toMatchObject({
      file: 'powershell.exe',
      windowsHide: true,
      startupTimeoutMs: 1_500,
      expectedPids: [41, 42],
    });
    expect(sessionSpec!.args.join(' ')).not.toContain('Get-CimInstance');

    const first = await sampler.sample();
    const second = await sampler.sample();
    expect(first).toMatchObject({
      status: 'available',
      pids: [41, 42],
      rssBytes: 3_072,
      durationMs: 5,
      error: null,
    });
    expect(second).toMatchObject({ status: 'available', rssBytes: 3_072, durationMs: 5 });
    expect(session.requests).toEqual([
      { line: '1', timeoutMs: 1_500 },
      { line: '2', timeoutMs: 1_500 },
    ]);
    expect(runCalls).toHaveLength(1);

    const firstClose = await sampler.close();
    const secondClose = await sampler.close();
    expect(firstClose).toBe(secondClose);
    expect(firstClose).toMatchObject({ status: 'closed', durationMs: 5, error: null });
    expect(session.closeCalls).toBe(1);
    expect(await sampler.sample()).toMatchObject({
      status: 'closed',
      rssBytes: null,
      error: { code: 'SAMPLER_CLOSED' },
    });
  });

  it('uses lightweight targeted ps calls after one POSIX full-tree discovery', async () => {
    const calls: CommandInvocation[] = [];
    const runCommand = vi.fn(async (invocation: CommandInvocation): Promise<CommandResult> => {
      calls.push(invocation);
      if (calls.length === 1) {
        return {
          stdout: '10 1 node\n20 10 miniflare\n41 20 workerd\n42 20 workerd\n',
          stderr: '',
        };
      }
      return { stdout: '41 100 workerd\n42 200 workerd\n', stderr: '' };
    });
    const createSession = vi.fn(async (_specification: WindowsLineSessionSpec) => {
      throw new Error('Windows session must not be created on POSIX.');
    });
    const sampler = await createWorkerdMemorySampler({
      dependencies: {
        platform: 'linux',
        rootPid: 10,
        runCommand,
        createWindowsLineSession: createSession,
      },
    });

    expect((await sampler.sample()).rssBytes).toBe(300 * 1_024);
    expect((await sampler.sample()).rssBytes).toBe(300 * 1_024);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.args).toEqual(['-eo', 'pid=,ppid=,comm=']);
    expect(calls[1]!.args).toEqual(['-o', 'pid=,rss=,comm=', '-p', '41,42']);
    expect(calls[2]!.args).toEqual(['-o', 'pid=,rss=,comm=', '-p', '41,42']);
    expect(createSession).not.toHaveBeenCalled();
    await sampler.close();
  });

  it('reports discovery absence and discovery command errors without hiding either', async () => {
    const unavailable = await createWorkerdMemorySampler({
      dependencies: {
        platform: 'linux',
        rootPid: 10,
        runCommand: async () => ({ stdout: '10 1 node\n20 10 miniflare\n', stderr: '' }),
      },
    });
    expect(unavailable.discovery).toMatchObject({
      status: 'unavailable',
      pids: [],
      error: null,
    });
    expect(await unavailable.sample()).toMatchObject({
      status: 'unavailable',
      rssBytes: null,
      error: null,
    });

    const failed = await createWorkerdMemorySampler({
      dependencies: {
        platform: 'linux',
        rootPid: 10,
        runCommand: async () => {
          throw new WorkerdMemorySamplerModuleError('COMMAND_TIMEOUT', 'discovery timed out');
        },
      },
    });
    expect(failed.discovery).toMatchObject({
      status: 'error',
      error: { code: 'DISCOVERY_TIMEOUT', message: 'discovery timed out' },
    });
    expect(await failed.sample()).toMatchObject({
      status: 'error',
      rssBytes: null,
      error: { code: 'DISCOVERY_TIMEOUT' },
    });
  });

  it('turns sample and close timeouts into explicit, stable lifecycle results', async () => {
    const session = new FakeLineSession();
    session.requestError = new WorkerdMemorySamplerModuleError(
      'SAMPLE_TIMEOUT',
      'sample request timed out',
    );
    session.closeError = new WorkerdMemorySamplerModuleError(
      'CLOSE_TIMEOUT',
      'sampler close timed out',
    );
    const sampler = await createWorkerdMemorySampler({
      dependencies: {
        platform: 'win32',
        rootPid: 10,
        runCommand: async () => ({ stdout: windowsTree(), stderr: '' }),
        createWindowsLineSession: async () => session,
      },
    });

    expect(await sampler.sample()).toMatchObject({
      status: 'error',
      rssBytes: null,
      error: { code: 'SAMPLE_TIMEOUT', message: 'sample request timed out' },
    });
    const firstClose = await sampler.close();
    expect(firstClose).toMatchObject({
      status: 'error',
      error: { code: 'CLOSE_TIMEOUT', message: 'sampler close timed out' },
    });
    expect(await sampler.close()).toBe(firstClose);
    expect(session.closeCalls).toBe(1);
  });

  it('classifies malformed discovery and sample output without reducing them to generic errors', async () => {
    const malformedDiscovery = await createWorkerdMemorySampler({
      dependencies: {
        platform: 'win32',
        rootPid: 10,
        runCommand: async () => ({ stdout: '{broken', stderr: '' }),
      },
    });
    expect(malformedDiscovery.discovery).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_PROCESS_TREE' },
    });

    const session = new FakeLineSession();
    session.request = async () => '{broken';
    const malformedSample = await createWorkerdMemorySampler({
      dependencies: {
        platform: 'win32',
        rootPid: 10,
        runCommand: async () => ({ stdout: windowsTree(), stderr: '' }),
        createWindowsLineSession: async () => session,
      },
    });
    expect(await malformedSample.sample()).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_SAMPLE_OUTPUT' },
    });
    await malformedSample.close();
  });
});
