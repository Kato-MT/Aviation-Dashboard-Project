import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import manifest from '../../maps/manifest.json';

interface ObjectMetadata {
  size: number;
  customMetadata?: Record<string, string>;
}
interface UploadOptions {
  customMetadata: Record<string, string>;
  httpMetadata: { contentType: string; cacheControl: string };
}
interface UploadedPart {
  partNumber: number;
  etag: string;
}
interface LocalMapBucket {
  head(key: string): Promise<ObjectMetadata | null>;
  put(key: string, value: Uint8Array, options: UploadOptions): Promise<unknown>;
  createMultipartUpload(
    key: string,
    options: UploadOptions,
  ): Promise<{
    uploadPart(partNumber: number, value: Uint8Array): Promise<UploadedPart>;
    complete(parts: UploadedPart[]): Promise<unknown>;
    abort(): Promise<void>;
  }>;
}

process.env.WRANGLER_SEND_METRICS = 'false';
const { getPlatformProxy } = await import('wrangler');
const platform = await getPlatformProxy<{ MAP_ASSETS: LocalMapBucket }>({
  configPath: resolve('tools/maps/wrangler.seed.json'),
  envFiles: [],
  remoteBindings: false,
  // The Vite plugin adds /v3 to its persistState path, while this API does not.
  persist: { path: resolve('.wrangler/live-local/v3') },
});
const bucket = platform.env.MAP_ASSETS;
let added = 0;
try {
  for (const asset of manifest.assets) {
    const path = resolve('.map-data', manifest.id, asset.path);
    assert.equal((await stat(path)).size, asset.bytes);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), asset.sha256, `Local asset digest differs: ${asset.path}`);
    const key = `${manifest.id}/${asset.path}`;
    const previous = await bucket.head(key);
    if (previous) {
      assert.equal(
        previous.size,
        asset.bytes,
        'An immutable map key already contains different bytes.',
      );
      assert.equal(previous.customMetadata?.sha256, asset.sha256);
      continue;
    }
    const options: UploadOptions = {
      customMetadata: { sha256: asset.sha256, mapId: manifest.id },
      httpMetadata: {
        contentType: asset.contentType,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    };
    if (asset.bytes <= 8 * 1024 * 1024) {
      await bucket.put(key, await readFile(path), options);
    } else {
      const upload = await bucket.createMultipartUpload(key, options);
      const file = await open(path, 'r');
      try {
        const parts: UploadedPart[] = [];
        for (let offset = 0; offset < asset.bytes; offset += 8 * 1024 * 1024) {
          const length = Math.min(8 * 1024 * 1024, asset.bytes - offset);
          const bytes = new Uint8Array(length);
          assert.equal((await file.read(bytes, 0, length, offset)).bytesRead, length);
          parts.push(await upload.uploadPart(parts.length + 1, bytes));
        }
        await upload.complete(parts);
      } catch (error) {
        await upload.abort();
        throw error;
      } finally {
        await file.close();
      }
    }
    const stored = await bucket.head(key);
    assert.equal(stored?.size, asset.bytes);
    assert.equal(stored?.customMetadata?.sha256, asset.sha256);
    added++;
  }
  console.log(
    `Local R2 map seed verified: ${manifest.assets.length} assets, ${added} added. Only .wrangler/live-local was changed; no remote bucket or account was accessed.`,
  );
} finally {
  await platform.dispose();
}
