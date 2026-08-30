import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyBrowserBudgets } from '../../tools/live/verifyBrowserBudgets';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'browser-budgets-'));
  roots.push(root);
  const assets = join(root, 'client', 'assets');
  await mkdir(assets, { recursive: true });
  await writeFile(
    join(root, 'client', 'live.html'),
    [
      '<link rel="modulepreload" href="/assets/preloaded-one.js">',
      '<script type="module" src="/assets/shared-one.js"></script>',
      '<script type="module" src="/assets/live-main-one.js"></script>',
    ].join('\n'),
  );
  await writeFile(
    join(assets, 'live-main-one.js'),
    'import/*bundler-comment*/{e}from"./eager-one.js";const map=()=>import("./mapRenderer-one.js");export{e};\n',
  );
  await writeFile(join(assets, 'shared-one.js'), 'export const shared = true;\n');
  await mkdir(join(assets, 'nested'), { recursive: true });
  await writeFile(
    join(assets, 'eager-one.js'),
    'export{nested as e}from"./nested/eager-two.js";\n',
  );
  await writeFile(join(assets, 'nested', 'eager-two.js'), 'export const nested = true;\n');
  await writeFile(join(assets, 'preloaded-one.js'), 'export const preloaded = true;\n');
  await writeFile(
    join(assets, 'mapRenderer-one.js'),
    [
      'import "./shared-one.js";',
      'const worker = new URL("/assets/maplibre-gl-worker-one.js", import.meta.url);',
      'export { worker };',
    ].join('\n'),
  );
  await writeFile(
    join(assets, 'maplibre-gl-worker-one.js'),
    'self.onmessage=e=>void import(e.data.plugin);\n',
  );
  await writeFile(join(assets, 'nested', 'performance-one.css'), 'body{color:#000}\n');
  await writeFile(join(assets, 'nested', 'performance-one.woff2'), 'synthetic-font-fixture\n');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('connected browser budgets', () => {
  it('measures the initial shell and the transitive lazy-map graph without double counting', async () => {
    const root = await fixture();
    const report = await verifyBrowserBudgets(root, 'mock-staging');
    expect(report).toMatchObject({
      schemaVersion: 'airspace-browser-budgets.v1',
      artifact: {
        target: 'mock-staging',
        clientIdentity: {
          schemaVersion: 'sha256-file-inventory.v1',
          fileCount: 10,
        },
      },
      initialShell: { limitGzipBytes: 200 * 1024 },
      lazyMap: { limitGzipBytes: 500 * 1024 },
      styles: { totalBytes: 17, assets: [{ path: 'assets/nested/performance-one.css' }] },
      fonts: { totalBytes: 23, assets: [{ path: 'assets/nested/performance-one.woff2' }] },
    });
    expect(report.initialShell.assets.map(({ path }) => path)).toEqual([
      'assets/eager-one.js',
      'assets/live-main-one.js',
      'assets/nested/eager-two.js',
      'assets/preloaded-one.js',
      'assets/shared-one.js',
    ]);
    expect(report.lazyMap.assets.map(({ path }) => path)).toEqual([
      'assets/mapRenderer-one.js',
      'assets/maplibre-gl-worker-one.js',
    ]);
  });

  it('fails each budget independently with the measured byte count', async () => {
    const root = await fixture();
    await expect(
      verifyBrowserBudgets(root, 'mock-staging', {
        initialShellGzipBytes: 1,
        lazyMapGzipBytes: 500 * 1024,
      }),
    ).rejects.toThrow(/Initial shell is \d+ gzip bytes/u);
    await expect(
      verifyBrowserBudgets(root, 'mock-staging', {
        initialShellGzipBytes: 200 * 1024,
        lazyMapGzipBytes: 1,
      }),
    ).rejects.toThrow(/Lazy map is \d+ gzip bytes/u);
  });

  it('rejects a missing or ambiguous lazy-map graph', async () => {
    const root = await fixture();
    await writeFile(join(root, 'client', 'assets', 'live-main-one.js'), 'export {};\n');
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /exactly one generated lazy map/u,
    );
  });

  it('rejects an undeclared lazy entry graph instead of silently excluding its bytes', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'live-main-one.js'),
      [
        'const map=()=>import("./mapRenderer-one.js");',
        'const unknown=()=>import("./unmeasured-one.js");',
        'export{map,unknown};',
      ].join('\n'),
    );
    await writeFile(
      join(root, 'client', 'assets', 'unmeasured-one.js'),
      'export const unmeasured=true;\n',
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /undeclared lazy import/u,
    );
  });

  it('fails closed on a missing transitive eager dependency', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'shared-one.js'),
      'export { missing } from "./missing-one.js";\n',
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /Initial shell graph references/u,
    );
  });

  it('rejects duplicate module scripts instead of understating the shell', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'live.html'),
      [
        '<script type="module" src="/assets/live-main-one.js"></script>',
        '<script type="module" src="/assets/live-main-one.js"></script>',
      ].join('\n'),
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /duplicate-free module script set/u,
    );
  });

  it.each([
    '<script type=module src=/assets/missing-large.js></script>',
    '<link rel=modulepreload href=/assets/missing-large.js>',
  ])('does not ignore an unquoted generated HTML asset: %s', async (tag) => {
    const root = await fixture();
    const html = await readFile(join(root, 'client', 'live.html'), 'utf8');
    await writeFile(join(root, 'client', 'live.html'), `${html}\n${tag}\n`);
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /Initial shell graph references a missing/u,
    );
  });

  it('fails closed on a computed dynamic import that cannot be assigned to a budget graph', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'mapRenderer-one.js'),
      'const name="child";void import(`./${name}.js`);\n',
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /computed import that cannot be measured/u,
    );
  });

  it.each([
    'import "https://example.invalid/unmeasured.js";\n',
    'void import("https://example.invalid/unmeasured.js");\n',
  ])(
    'fails closed on a non-local module reference outside the generated byte graph',
    async (source) => {
      const root = await fixture();
      await writeFile(join(root, 'client', 'assets', 'shared-one.js'), source);
      await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
        /non-local module reference/u,
      );
    },
  );

  it('rejects a local dynamic import that is not assigned to the measured map graph', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'shared-one.js'),
      'void import("./eager-one.js");\n',
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /unassigned dynamic import/u,
    );
  });

  it('measures an additional literal worker referenced by the lazy map graph', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'mapRenderer-one.js'),
      'new Worker(new URL("/assets/extra-worker.js",import.meta.url));\n',
    );
    await writeFile(join(root, 'client', 'assets', 'extra-worker.js'), 'self.onmessage=()=>{};\n');
    const report = await verifyBrowserBudgets(root, 'mock-staging');
    expect(report.lazyMap.assets.map(({ path }) => path)).toContain('assets/extra-worker.js');
  });

  it('fails closed on a computed worker reference', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'mapRenderer-one.js'),
      'const workerUrl="/assets/extra-worker.js";new Worker(workerUrl);\n',
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /computed worker that cannot be measured/u,
    );
  });

  it("accepts only MapLibre's pinned module-worker fallback factory", async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'client', 'assets', 'mapRenderer-one.js'),
      [
        'const createWorker=(workerUrl)=>{',
        'try{return new Worker(workerUrl,{type:`module`})}',
        'catch{return new Worker(workerUrl)}',
        '};export{createWorker};',
      ].join(''),
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).resolves.toBeDefined();

    await writeFile(
      join(root, 'client', 'assets', 'mapRenderer-one.js'),
      'const one="a";const two="b";new Worker(one);new Worker(two,{type:"module"});\n',
    );
    await expect(verifyBrowserBudgets(root, 'mock-staging')).rejects.toThrow(
      /computed worker that cannot be measured/u,
    );
  });
});
