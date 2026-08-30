import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { convertV4MiniflareOptions } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  candidateServerEnvironment,
  createVerifiedCandidateSnapshot,
  retainedMiniflareAssets,
  verifyRetainedMapPayload,
  type RetainedMapManifest,
} from '../../tools/live/serveCandidate';
import type { RetainedCandidateProvenance, SourceIdentity } from '../../tools/live/retainCandidate';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('retained-candidate server boundary', () => {
  it('binds assets to the retained user Worker without rewriting HTML compatibility URLs', () => {
    const converted = convertV4MiniflareOptions({
      workers: [
        {
          name: 'retained-worker',
          script: 'export default { fetch() { return new Response("worker"); } };',
          modules: true,
          assets: retainedMiniflareAssets({
            directory: process.cwd(),
            binding: 'ASSETS',
            runWorkerFirst: ['/*'],
            htmlHandling: 'none',
          }),
        },
      ],
    });
    const worker = converted.workers[0]?.config;
    expect(worker?.name).toBe('retained-worker');
    expect(worker?.env?.ASSETS).toEqual({ type: 'assets' });
    expect(worker?.assets).toMatchObject({
      directory: process.cwd(),
      hasUserWorker: true,
      htmlHandling: 'none',
      notFoundHandling: 'none',
      runWorkerFirst: ['/*'],
    });
  });

  it('requires an explicit retained candidate and a bounded local port', () => {
    expect(() => candidateServerEnvironment({})).toThrow('M34_CANDIDATE_DIRECTORY is required');
    expect(() =>
      candidateServerEnvironment({
        M34_CANDIDATE_DIRECTORY: 'candidate',
        LIVE_TEST_PORT: '80',
      }),
    ).toThrow('LIVE_TEST_PORT is invalid');
    expect(() =>
      candidateServerEnvironment({
        M34_CANDIDATE_DIRECTORY: 'candidate',
        LIVE_TEST_PORT: '4274',
      }),
    ).toThrow('M34_EXPECTED_SELECTION_SHA256 or M34_EXPECTED_CANDIDATE_ID is required');
    expect(
      candidateServerEnvironment({
        M34_CANDIDATE_DIRECTORY: 'candidate',
        LIVE_TEST_PORT: '4274',
        M34_EXPECTED_SOURCE_HEAD: 'abc123',
        M34_EXPECTED_SELECTION_SHA256: 'a'.repeat(64),
      }),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 4274,
      expectedSourceHead: 'abc123',
      expectedSelectionRecordSha256: 'a'.repeat(64),
    });
  });

  it.each(['source', 'snapshot'] as const)(
    'rejects a %s mutation while creating the private execution snapshot',
    async (mutation) => {
      const directory = await mkdtemp(join(tmpdir(), 'fdw-candidate-copy-test-'));
      temporaryDirectories.push(directory);
      const candidateDirectory = join(directory, 'candidate');
      await mkdir(candidateDirectory);
      await writeFile(join(candidateDirectory, 'payload.txt'), 'selected bytes');
      const provenance = {
        candidateId: `mock-staging-${'1'.repeat(24)}`,
      } as RetainedCandidateProvenance;
      const verifyCandidate = vi.fn(async () => provenance);
      const source = {
        head: 'b'.repeat(40),
        contentSha256: 'c'.repeat(64),
      } as SourceIdentity;

      await expect(
        createVerifiedCandidateSnapshot(
          {
            candidateDirectory,
            expectedSelectionRecordSha256: 'a'.repeat(64),
            host: '127.0.0.1',
            port: 4274,
          },
          source,
          {
            verifyCandidate,
            copyCandidate: async (selected, snapshot) => {
              await cp(selected, snapshot, { recursive: true });
              await writeFile(
                join(mutation === 'source' ? selected : snapshot, 'payload.txt'),
                `${mutation} mutation`,
              );
            },
          },
        ),
      ).rejects.toThrow('changed while it was copied');
    },
  );

  it('accepts only retained map bytes matching the manifest identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fdw-map-payload-test-'));
    temporaryDirectories.push(directory);
    const contents = Buffer.from('exact retained map bytes');
    const manifest: RetainedMapManifest = {
      schemaVersion: 'map-assets.v1',
      id: 'test-map',
      totalBytes: contents.byteLength,
      assets: [
        {
          path: 'basemap.pmtiles',
          bytes: contents.byteLength,
          sha256: createHash('sha256').update(contents).digest('hex'),
          contentType: 'application/octet-stream',
        },
      ],
    };
    const path = join(directory, 'basemap.pmtiles');
    await writeFile(path, contents);
    await expect(verifyRetainedMapPayload(directory, manifest)).resolves.toBeUndefined();

    await writeFile(path, Buffer.alloc(contents.byteLength, 0x78));
    await expect(verifyRetainedMapPayload(directory, manifest)).rejects.toThrow('wrong SHA-256');
  });
});
