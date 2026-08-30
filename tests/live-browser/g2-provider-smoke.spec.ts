import { once } from 'node:events';
import { mkdir, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';

test('observes empty persistence and output surfaces in the synthetic G2 harness', async ({
  context,
  page,
}, testInfo) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    });
    response.end('<!doctype html><html><body>synthetic G2 privacy probe</body></html>');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const unexpectedEgress: string[] = [];
  const downloads: string[] = [];

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      unexpectedEgress.push(url.origin);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('download', (download) => downloads.push(download.suggestedFilename()));

  try {
    await page.goto(origin, { waitUntil: 'load' });
    const observed = await page.evaluate(async () => {
      const indexedDbDatabases =
        typeof indexedDB.databases === 'function'
          ? (await indexedDB.databases()).map(({ name }) => name ?? '<unnamed>')
          : ['<database-enumeration-unavailable>'];
      const cacheStorageKeys = await caches.keys();
      const opfsEntries: string[] = [];
      if (typeof navigator.storage.getDirectory === 'function') {
        const root = await navigator.storage.getDirectory();
        for await (const name of root.keys()) opfsEntries.push(name);
      } else {
        opfsEntries.push('<opfs-enumeration-unavailable>');
      }
      const serviceWorkers = (await navigator.serviceWorker.getRegistrations()).map(
        ({ scope }) => scope,
      );

      return {
        localStorage: Object.keys(localStorage),
        sessionStorage: Object.keys(sessionStorage),
        indexedDbDatabases,
        cacheStorageKeys,
        opfsEntries,
        serviceWorkers,
      };
    });
    const cookies = (await context.cookies([origin])).map(({ name }) => name);

    expect({ ...observed, cookies }).toEqual({
      localStorage: [],
      sessionStorage: [],
      cookies: [],
      indexedDbDatabases: [],
      cacheStorageKeys: [],
      opfsEntries: [],
      serviceWorkers: [],
    });
    expect(unexpectedEgress).toEqual([]);
    expect(downloads).toEqual([]);
    expect(requestCount).toBe(1);

    await mkdir(testInfo.outputDir, { recursive: true });
    expect(await readdir(testInfo.outputDir)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
