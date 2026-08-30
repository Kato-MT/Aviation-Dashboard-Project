import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { LIVE_TEST_HTTP_ORIGIN, LIVE_TEST_WEBSOCKET_ORIGIN } from './testOrigin';

interface WorkspaceExpectation {
  hash: '#live' | '#replay' | '#lab' | '#evidence';
  label: 'Live Airspace' | 'Synthetic Replay' | 'Diagnostics Lab' | 'Evidence';
  mainId: 'airspace-main' | 'replay-main' | 'lab-main' | 'evidence-main';
  title: RegExp;
  heading?: string;
}

interface PublicRollbackFile {
  path: string;
  bytes: number;
  sha256: string;
  candidatePaths: string[];
}

interface CandidateProvenance {
  candidateId: string;
  application: {
    applicationVersion: string;
    releaseSha: string;
    buildTarget: 'mock-staging';
    providerMode: 'mock';
  };
  mapManifest: {
    id: string;
    payload: { candidatePath: string };
  };
  rollback: {
    releaseTag: 'v2.2.0';
    publicFiles: PublicRollbackFile[];
  };
}

interface MapAsset {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

interface RetainedMapManifest {
  id: string;
  assets: MapAsset[];
}

interface RetainedRuntimePolicy {
  target: 'mock-staging';
  headers: {
    profile: 'mock-staging';
    contentType: 'required-per-route';
    static: Record<string, string>;
    worker: Record<string, string>;
    strictTransportSecurity: 'deferred-until-approved-https-target';
  };
}

interface WebSocketHandshakeResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
}

interface SecurityPolicyViolationRecord {
  blockedUri: string;
  effectiveDirective: string;
  violatedDirective: string;
}

type SecurityAuditedWindow = Window & {
  __m34SecurityPolicyViolations?: SecurityPolicyViolationRecord[];
};

const configuredCandidate = process.env.M34_CANDIDATE_DIRECTORY?.trim();
if (!configuredCandidate) {
  throw new Error('M34_CANDIDATE_DIRECTORY is required for M3.4 browser acceptance.');
}
const candidateDirectory = resolve(configuredCandidate);
const provenance = JSON.parse(
  readFileSync(join(candidateDirectory, 'evidence', 'provenance.json'), 'utf8'),
) as CandidateProvenance;
const mapManifest = JSON.parse(
  readFileSync(join(candidateDirectory, 'evidence', 'map-manifest.json'), 'utf8'),
) as RetainedMapManifest;
const runtimePolicy = JSON.parse(
  readFileSync(join(candidateDirectory, 'artifact', 'client', 'runtime-policy.json'), 'utf8'),
) as RetainedRuntimePolicy;

const WORKSPACES = [
  {
    hash: '#live',
    label: 'Live Airspace',
    mainId: 'airspace-main',
    title: /^Live Airspace \| Flight Diagnostics Workbench$/u,
  },
  {
    hash: '#replay',
    label: 'Synthetic Replay',
    mainId: 'replay-main',
    title: /^Synthetic Replay \| Flight Diagnostics Workbench$/u,
    heading: 'Provider outage and recovery',
  },
  {
    hash: '#lab',
    label: 'Diagnostics Lab',
    mainId: 'lab-main',
    title: /^Diagnostics Lab \| Flight Diagnostics Workbench$/u,
    heading: 'Telemetry monitor',
  },
  {
    hash: '#evidence',
    label: 'Evidence',
    mainId: 'evidence-main',
    title: /^Evidence \| Flight Diagnostics Workbench$/u,
    heading: 'What this build is, what it uses, and what remains open',
  },
] as const satisfies readonly WorkspaceExpectation[];

const HISTORY_TRANSITIONS = [
  [WORKSPACES[0], WORKSPACES[1]],
  [WORKSPACES[1], WORKSPACES[2]],
  [WORKSPACES[2], WORKSPACES[3]],
] as const;

function sha256(contents: Uint8Array | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function cspDirectiveSources(policy: string, directiveName: string): string[] {
  const directive = policy
    .split(';')
    .map((entry) => entry.trim().split(/\s+/u))
    .find(([name]) => name?.toLowerCase() === directiveName);
  expect(directive, `CSP must declare ${directiveName}.`).toBeDefined();
  return directive?.slice(1) ?? [];
}

function expectBlobSources(policy: string, policyLabel: string): void {
  expect(
    cspDirectiveSources(policy, 'worker-src'),
    `${policyLabel} worker-src must allow blob workers.`,
  ).toContain('blob:');
  expect(
    cspDirectiveSources(policy, 'img-src'),
    `${policyLabel} img-src must allow blob images.`,
  ).toContain('blob:');
}

function exactRetainedBytes(relativePath: string): Buffer {
  return readFileSync(join(candidateDirectory, ...relativePath.split('/')));
}

function firstBytes(path: string, length: number): Buffer {
  const descriptor = openSync(path, 'r');
  try {
    const result = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, result, 0, length, 0);
    return result.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function encodedAssetPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function normalizedHeaders(
  headers: Readonly<Record<string, string | number | boolean>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
}

function expectSecurityProfile(
  actualHeaders: Readonly<Record<string, string>>,
  profile: 'static' | 'worker',
  responseLabel: string,
): void {
  const expectedHeaders = runtimePolicy.headers[profile];
  for (const [name, value] of Object.entries(expectedHeaders)) {
    expect(
      actualHeaders[name],
      `${responseLabel} must carry the compiled ${profile} ${name} header.`,
    ).toBe(value);
  }
  expect(
    actualHeaders['strict-transport-security'],
    `${responseLabel} must not invent HSTS for the retained loopback candidate.`,
  ).toBeUndefined();
}

function expectStaticCacheHeader(
  headers: Readonly<Record<string, string>>,
  responseLabel: string,
): void {
  expect(
    headers['cache-control'],
    `${responseLabel} must preserve the retained asset service cache policy.`,
  ).toBeTruthy();
}

function retainedClientFiles(root = join(candidateDirectory, 'artifact', 'client')): string[] {
  const visit = (directory: string, prefix: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return visit(join(directory, entry.name), relativePath);
      return entry.isFile() ? [relativePath] : [];
    });
  return visit(root, '');
}

async function installNetworkAudit(context: BrowserContext, page: Page) {
  const externalBrowserRequests: string[] = [];
  const externalBrowserSockets: string[] = [];
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.origin !== LIVE_TEST_WEBSOCKET_ORIGIN) externalBrowserSockets.push(socket.url());
  });
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin !== LIVE_TEST_HTTP_ORIGIN
    ) {
      externalBrowserRequests.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket(
    (url) => url.origin !== LIVE_TEST_WEBSOCKET_ORIGIN,
    async (socket) => {
      externalBrowserSockets.push(socket.url());
      await socket.close({ code: 1008, reason: 'M34 external WebSocket blocked' });
    },
  );
  return {
    async expectNone(request: APIRequestContext): Promise<void> {
      expect(externalBrowserRequests).toEqual([]);
      expect(externalBrowserSockets).toEqual([]);
      const response = await request.get('/__m34/runtime-egress');
      expect(response.ok()).toBe(true);
      expect(await response.json()).toEqual({ blockedAttempts: 0 });
    },
  };
}

function shellNavigation(page: Page) {
  return page.getByRole('navigation', { name: 'Workbench navigation' });
}

async function expectFourWorkspaceShell(page: Page) {
  await expect(page.locator('.live-app-header')).toBeVisible();
  await expect(shellNavigation(page).getByRole('link')).toHaveText([
    'Live Airspace',
    'Synthetic Replay',
    'Diagnostics Lab',
    'Evidence',
  ]);
}

async function expectWorkspace(
  page: Page,
  workspace: WorkspaceExpectation,
  expectedHash: string = workspace.hash,
) {
  await expect.poll(() => new URL(page.url()).hash).toBe(expectedHash);
  await expectFourWorkspaceShell(page);
  await expect(page.locator(`#${workspace.mainId}`)).toBeVisible();
  await expect(
    shellNavigation(page).getByRole('link', { name: workspace.label, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(workspace.title);
  if (workspace.heading) {
    await expect(page.getByRole('heading', { name: workspace.heading, exact: true })).toBeVisible();
  }
}

async function scriptSources(page: Page): Promise<string[]> {
  return page
    .locator('script[src]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('src') ?? ''));
}

async function expectRetainedV3Entry(page: Page) {
  const sources = await scriptSources(page);
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    const url = new URL(source, page.url());
    expect(url.origin).toBe(LIVE_TEST_HTTP_ORIGIN);
    expect(url.pathname).toMatch(/^\/assets\/[\w.-]+\.js$/u);
    expect(url.pathname).not.toContain('/src/');
    expect(url.pathname).not.toContain('@vite/client');
  }
}

function rollbackIdentity(path: string): PublicRollbackFile {
  const identity = provenance.rollback.publicFiles.find((file) => file.path === path);
  if (!identity) throw new Error(`Candidate provenance is missing rollback file ${path}.`);
  return identity;
}

function rollbackIdentityForCandidatePath(candidatePath: string): PublicRollbackFile {
  const identity = provenance.rollback.publicFiles.find((file) =>
    file.candidatePaths.includes(candidatePath),
  );
  if (!identity) {
    throw new Error(`Candidate provenance is missing rollback output ${candidatePath}.`);
  }
  return identity;
}

test('root is the exact retained mock-staging v3 client and opens Live in the four-workspace shell', async ({
  context,
  page,
  request,
}) => {
  const network = await installNetworkAudit(context, page);
  expect(provenance.application).toMatchObject({
    buildTarget: 'mock-staging',
    providerMode: 'mock',
  });
  const retainedIndex = exactRetainedBytes('artifact/client/index.html');
  const servedIndex = await request.get('/');
  expect(servedIndex.ok()).toBe(true);
  expect(Buffer.from(await servedIndex.body())).toEqual(retainedIndex);

  const requestedUrls: string[] = [];
  page.on('request', (request_) => requestedUrls.push(request_.url()));
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await expectWorkspace(page, WORKSPACES[0], '');
  await expectRetainedV3Entry(page);
  await expect(page.locator('.source-banner')).toContainText('Synthetic integration feed');
  await expect(page.locator('.source-banner')).toContainText(
    'No real aircraft provider is contacted',
  );
  await expect(page.getByRole('button', { name: 'TEST01', exact: true })).toBeVisible();
  expect(requestedUrls.some((url) => url.includes('/@vite/client'))).toBe(false);
  expect(requestedUrls.some((url) => new URL(url).pathname.startsWith('/src/'))).toBe(false);
  await network.expectNone(request);
});

test('served CSP permits the real MapLibre canvas and Campaign blob worker without browser violations', async ({
  context,
  page,
  request,
}) => {
  const network = await installNetworkAudit(context, page);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const workerUrls: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('worker', (worker) => workerUrls.push(worker.url()));
  await page.addInitScript(() => {
    const violations: SecurityPolicyViolationRecord[] = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push({
        blockedUri: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
      });
    });
    (window as SecurityAuditedWindow).__m34SecurityPolicyViolations = violations;
  });

  const response = await page.goto('/#live');
  expect(response?.ok()).toBe(true);
  if (!response) throw new Error('The retained candidate did not return an HTTP document.');
  const headerPolicy = response.headers()['content-security-policy'];
  expect(headerPolicy, 'The retained candidate must serve an HTTP CSP header.').toBeTruthy();
  expectBlobSources(headerPolicy ?? '', 'HTTP CSP');

  const metaPolicyElement = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(metaPolicyElement).toHaveCount(1);
  const metaPolicy = await metaPolicyElement.getAttribute('content');
  expect(metaPolicy, 'The retained HTML must declare a meta CSP.').toBeTruthy();
  expectBlobSources(metaPolicy ?? '', 'HTML meta CSP');

  await expectWorkspace(page, WORKSPACES[0]);
  const mapCanvas = page.locator('.maplibregl-canvas');
  await expect(mapCanvas).toBeVisible();
  expect(
    await mapCanvas.evaluate((element) => ({
      tagName: element.tagName,
      hasBackingStore:
        element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0,
    })),
  ).toEqual({ tagName: 'CANVAS', hasBackingStore: true });

  await page.goto('/#lab-campaign');
  await expect(page).toHaveURL(/#lab-campaign$/u);
  await expect(page.getByRole('heading', { name: 'Campaign', exact: true })).toBeVisible();
  const seeds = page.getByRole('textbox', { name: 'Deterministic seeds', exact: true });
  await seeds.fill('3101');
  const campaignWorkerStart = workerUrls.length;
  await page.getByRole('button', { name: 'Run Campaign', exact: true }).click();
  await expect
    .poll(() =>
      workerUrls
        .slice(campaignWorkerStart)
        .some((url) => url.startsWith(`blob:${LIVE_TEST_HTTP_ORIGIN}/`)),
    )
    .toBe(true);
  await expect(page.locator('#campaign-status')).toHaveAttribute('data-phase', 'completed', {
    timeout: 30_000,
  });

  await network.expectNone(request);
  const securityPolicyViolations = await page.evaluate(
    () => (window as SecurityAuditedWindow).__m34SecurityPolicyViolations ?? [],
  );
  expect(securityPolicyViolations).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('actual retained route classes carry the complete compiled response policy', async ({
  context,
  page,
  request,
}, testInfo) => {
  const network = await installNetworkAudit(context, page);
  expect(runtimePolicy.target).toBe(provenance.application.buildTarget);
  expect(runtimePolicy.headers.profile).toBe(provenance.application.buildTarget);
  expect(runtimePolicy.headers.contentType).toBe('required-per-route');
  expect(runtimePolicy.headers.strictTransportSecurity).toBe(
    'deferred-until-approved-https-target',
  );

  const cdp = await context.newCDPSession(page);
  const streamHandshakes: WebSocketHandshakeResponse[] = [];
  const websocketUrls = new Map<string, string>();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
    websocketUrls.set(requestId, url);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
    const handshakeUrl = websocketUrls.get(requestId);
    if (!handshakeUrl) return;
    const url = new URL(handshakeUrl);
    if (!url.pathname.endsWith('/stream')) return;
    streamHandshakes.push({
      url: handshakeUrl,
      status: response.status,
      headers: normalizedHeaders(response.headers),
    });
  });

  const htmlResponse = await page.goto('/');
  expect(htmlResponse?.status()).toBe(200);
  if (!htmlResponse) throw new Error('The retained candidate did not return its HTML document.');
  const htmlHeaders = normalizedHeaders(htmlResponse.headers());
  expectSecurityProfile(htmlHeaders, 'static', 'HTML');
  expect(htmlHeaders['content-type']).toMatch(/^text\/html(?:;\s*charset=utf-8)?$/iu);
  expectStaticCacheHeader(htmlHeaders, 'HTML');

  const sources = await scriptSources(page);
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    const scriptUrl = new URL(source, page.url());
    const scriptResponse = await request.get(scriptUrl.href);
    expect(scriptResponse.status()).toBe(200);
    const scriptHeaders = normalizedHeaders(scriptResponse.headers());
    expectSecurityProfile(scriptHeaders, 'static', `script ${scriptUrl.pathname}`);
    expect(scriptHeaders['content-type']).toMatch(
      /^(?:application|text)\/javascript(?:;\s*charset=utf-8)?$/iu,
    );
    expectStaticCacheHeader(scriptHeaders, `script ${scriptUrl.pathname}`);
  }

  const retainedWebFonts = retainedClientFiles().filter((path) =>
    /\.(?:woff2?|ttf|otf)$/iu.test(path),
  );
  if (retainedWebFonts.length === 0) {
    testInfo.annotations.push({
      type: 'webfont coverage',
      description:
        'This retained candidate has no standalone webfont; map glyph font coverage remains active below.',
    });
  }
  for (const fontPath of retainedWebFonts) {
    const fontResponse = await request.get(`/${encodedAssetPath(fontPath)}`);
    expect(fontResponse.status()).toBe(200);
    const fontHeaders = normalizedHeaders(fontResponse.headers());
    expectSecurityProfile(fontHeaders, 'static', `webfont ${fontPath}`);
    expect(fontHeaders['content-type']).toMatch(
      /^(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|font-sfnt|vnd\.ms-fontobject))(?:;|$)/iu,
    );
    expectStaticCacheHeader(fontHeaders, `webfont ${fontPath}`);
  }

  const basemap = mapManifest.assets.find((asset) => asset.path === 'basemap.pmtiles');
  if (!basemap) throw new Error('The retained manifest is missing basemap.pmtiles.');
  const basemapResponse = await request.get(
    `/map-assets/${encodeURIComponent(mapManifest.id)}/${encodedAssetPath(basemap.path)}`,
    { headers: { range: 'bytes=0-63' } },
  );
  expect(basemapResponse.status()).toBe(206);
  const basemapHeaders = normalizedHeaders(basemapResponse.headers());
  expectSecurityProfile(basemapHeaders, 'worker', 'map range');
  expect(basemapHeaders['content-type']).toBe(basemap.contentType);
  expect(basemapHeaders['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(basemapHeaders['content-range']).toBe(`bytes 0-63/${basemap.bytes}`);

  const mapFont = mapManifest.assets.find((asset) => /(?:^|\/)fonts\/.*\.pbf$/iu.test(asset.path));
  if (mapFont) {
    const rangeEnd = Math.min(31, mapFont.bytes - 1);
    const fontResponse = await request.get(
      `/map-assets/${encodeURIComponent(mapManifest.id)}/${encodedAssetPath(mapFont.path)}`,
      { headers: { range: `bytes=0-${rangeEnd}` } },
    );
    expect(fontResponse.status()).toBe(206);
    const fontHeaders = normalizedHeaders(fontResponse.headers());
    expectSecurityProfile(fontHeaders, 'worker', `map glyph font ${mapFont.path}`);
    expect(fontHeaders['content-type']).toBe(mapFont.contentType);
    expect(fontHeaders['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(fontHeaders['content-range']).toBe(`bytes 0-${rangeEnd}/${mapFont.bytes}`);
  } else {
    testInfo.annotations.push({
      type: 'map font coverage',
      description: 'This retained map manifest does not contain glyph font assets.',
    });
  }

  const apiSuccess = await request.get('/api/v1/regions');
  expect(apiSuccess.status()).toBe(200);
  const apiSuccessHeaders = normalizedHeaders(apiSuccess.headers());
  expectSecurityProfile(apiSuccessHeaders, 'worker', 'API success');
  expect(apiSuccessHeaders['content-type']).toBe('application/json; charset=utf-8');
  expect(apiSuccessHeaders['cache-control']).toBe('no-store');

  const apiError = await request.get('/api/v1/not-retained', { failOnStatusCode: false });
  expect(apiError.status()).toBe(404);
  const apiErrorHeaders = normalizedHeaders(apiError.headers());
  expectSecurityProfile(apiErrorHeaders, 'worker', 'API error');
  expect(apiErrorHeaders['content-type']).toBe('application/json; charset=utf-8');
  expect(apiErrorHeaders['cache-control']).toBe('no-store');

  const preflight = await request.fetch('/api/v1/regions', {
    method: 'OPTIONS',
    headers: { origin: LIVE_TEST_HTTP_ORIGIN },
  });
  expect(preflight.status()).toBe(204);
  const preflightHeaders = normalizedHeaders(preflight.headers());
  expectSecurityProfile(preflightHeaders, 'worker', 'API preflight');
  expect(preflightHeaders['content-type']).toBeUndefined();
  expect(preflightHeaders['cache-control']).toBe('no-store');
  expect(preflightHeaders['access-control-allow-origin']).toBe(LIVE_TEST_HTTP_ORIGIN);
  expect(preflightHeaders['access-control-allow-methods']).toBe('GET, OPTIONS');
  expect(preflightHeaders['access-control-allow-headers']).toBe('content-type');
  expect(preflightHeaders['access-control-max-age']).toBe('600');

  const websocketRejection = await request.get('/api/v1/airspace/atlanta/stream', {
    headers: { origin: LIVE_TEST_HTTP_ORIGIN },
    failOnStatusCode: false,
  });
  expect(websocketRejection.status()).toBe(426);
  const websocketRejectionHeaders = normalizedHeaders(websocketRejection.headers());
  expectSecurityProfile(websocketRejectionHeaders, 'worker', 'WebSocket rejection');
  expect(websocketRejectionHeaders['content-type']).toBe('application/json; charset=utf-8');
  expect(websocketRejectionHeaders['cache-control']).toBe('no-store');

  await expect
    .poll(() => streamHandshakes.find(({ status }) => status === 101), {
      message: 'The Live workspace must complete a retained WebSocket handshake.',
    })
    .toBeDefined();
  const websocketHandshake = streamHandshakes.find(({ status }) => status === 101);
  if (!websocketHandshake) throw new Error('The retained WebSocket handshake was not observed.');
  expect(new URL(websocketHandshake.url).origin).toBe(LIVE_TEST_WEBSOCKET_ORIGIN);
  expectSecurityProfile(websocketHandshake.headers, 'worker', 'WebSocket handshake');
  expect(websocketHandshake.headers['content-type']).toBeUndefined();
  expect(websocketHandshake.headers['cache-control']).toBe('no-store');

  await cdp.detach();
  await network.expectNone(request);
});

test('all four workspace hashes survive direct entry, reload, Back, and Forward', async ({
  context,
  page,
  request,
}) => {
  const network = await installNetworkAudit(context, page);
  for (const workspace of WORKSPACES) {
    await test.step(`direct entry and reload ${workspace.hash}`, async () => {
      await page.goto('about:blank');
      const response = await page.goto(`/${workspace.hash}`);
      expect(response?.ok()).toBe(true);
      await expectWorkspace(page, workspace);
      await page.reload();
      await expectWorkspace(page, workspace);
      if (workspace.hash === '#evidence') {
        await expect(page.locator('.evidence-release-banner')).toContainText(
          `${provenance.application.applicationVersion} · ${provenance.application.releaseSha}`,
        );
        await expect(page.locator('#evidence-build')).toContainText(
          provenance.application.buildTarget,
        );
      }
    });
  }

  await page.goto('/#live');
  await expectWorkspace(page, WORKSPACES[0]);
  for (const [previous, current] of HISTORY_TRANSITIONS) {
    await shellNavigation(page).getByRole('link', { name: current.label, exact: true }).click();
    await expectWorkspace(page, current);
    await page.goBack();
    await expectWorkspace(page, previous);
    await page.goForward();
    await expectWorkspace(page, current);
  }
  await network.expectNone(request);
});

test('retained Worker API, WebSocket, and Durable Object prove synthetic mock provenance', async ({
  context,
  page,
  request,
}) => {
  const network = await installNetworkAudit(context, page);
  const frames: Array<Record<string, unknown>> = [];
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (!url.pathname.startsWith('/api/v1/airspace/')) return;
    expect(url.origin).toBe(LIVE_TEST_WEBSOCKET_ORIGIN);
    socket.on('framereceived', ({ payload }) => {
      frames.push(JSON.parse(String(payload)) as Record<string, unknown>);
    });
  });

  const catalogResponse = await request.get('/api/v1/regions');
  expect(catalogResponse.ok()).toBe(true);
  const catalog = (await catalogResponse.json()) as Record<string, unknown>;
  expect(catalog.source).toEqual({
    target: 'mock-staging',
    mode: 'mock',
    providerId: 'synthetic-test',
    label: 'Synthetic integration feed',
    synthetic: true,
  });
  expect(catalog.applicationVersion).toBe(provenance.application.applicationVersion);
  expect(catalog.releaseSha).toBe(provenance.application.releaseSha);

  await page.goto('/#live');
  await expect(page.getByRole('button', { name: 'TEST01', exact: true })).toBeVisible();
  await expect.poll(() => frames.some((frame) => frame.type === 'hello')).toBe(true);
  await expect
    .poll(() =>
      frames.some(
        (frame) =>
          frame.type === 'delivery' &&
          Array.isArray(frame.messages) &&
          frame.messages.some(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              (message as Record<string, unknown>).type === 'airspace.snapshot',
          ),
      ),
    )
    .toBe(true);
  const hello = frames.find((frame) => frame.type === 'hello');
  expect(hello?.providerId).toBe('synthetic-test');
  expect(hello?.regionId).toBe('atlanta');
  expect(typeof hello?.feedEpoch).toBe('string');
  const snapshotDelivery = frames.find(
    (frame) =>
      frame.type === 'delivery' &&
      Array.isArray(frame.messages) &&
      frame.messages.some(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          (message as Record<string, unknown>).type === 'airspace.snapshot',
      ),
  );
  if (!snapshotDelivery || !Array.isArray(snapshotDelivery.messages)) {
    throw new Error('The retained Durable Object did not deliver an airspace snapshot.');
  }
  const snapshotMessage = (snapshotDelivery.messages as Array<Record<string, unknown>>).find(
    (message) => message.type === 'airspace.snapshot',
  );
  if (!snapshotMessage || typeof snapshotMessage.snapshot !== 'object') {
    throw new Error('The retained Durable Object delivered an invalid airspace snapshot.');
  }
  const wireSnapshot = snapshotMessage?.snapshot as Record<string, unknown>;
  expect(wireSnapshot.providerId).toBe('synthetic-test');
  expect(wireSnapshot.regionId).toBe('atlanta');
  expect(wireSnapshot.feedEpoch).toBe(hello?.feedEpoch);
  expect((wireSnapshot.aircraft as Array<Record<string, unknown>>)[0]?.callsign).toBe('TEST01');

  const snapshotResponse = await request.get('/api/v1/airspace/atlanta/snapshot');
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = (await snapshotResponse.json()) as Record<string, unknown>;
  expect(snapshot.providerId).toBe('synthetic-test');
  expect(snapshot.regionId).toBe('atlanta');
  expect(snapshot.feedEpoch).toBe(hello?.feedEpoch);
  expect((snapshot.aircraft as Array<Record<string, unknown>>)[0]?.callsign).toBe('TEST01');
  await network.expectNone(request);
});

test('v2 rollback serves the exact approved HTML and JavaScript without mounting v3', async ({
  context,
  page,
  request,
}) => {
  const network = await installNetworkAudit(context, page);
  expect(provenance.rollback.releaseTag).toBe('v2.2.0');
  const approvedIndex = rollbackIdentity('index.html');
  const htmlResponse = await request.get('/v2.html', { maxRedirects: 0 });
  expect(htmlResponse.ok()).toBe(true);
  expect(htmlResponse.headers().location).toBeUndefined();
  const html = Buffer.from(await htmlResponse.body());
  expect(html.byteLength).toBe(approvedIndex.bytes);
  expect(sha256(html)).toBe(approvedIndex.sha256);

  const legacyResponse = await request.get('/Aviation-Dashboard-Project/', { maxRedirects: 0 });
  expect(legacyResponse.ok()).toBe(true);
  expect(legacyResponse.headers().location).toBeUndefined();
  const legacyHtml = Buffer.from(await legacyResponse.body());
  expect(legacyHtml.byteLength).toBe(approvedIndex.bytes);
  expect(sha256(legacyHtml)).toBe(approvedIndex.sha256);

  const response = await page.goto('/v2.html');
  expect(response?.ok()).toBe(true);
  expect(new URL(page.url()).pathname).toBe('/v2.html');
  await expect(page.getByRole('heading', { name: 'Flight Diagnostics Workbench' })).toBeVisible();
  await expect(page.locator('#app-version')).toHaveText('v2.2.0');
  await expect(page.locator('.view-tabs [role="tab"]')).toHaveCount(5);
  await expect(page.locator('#live-root')).toHaveCount(0);
  await expect(page.locator('.live-app-header')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Workbench navigation' })).toHaveCount(0);

  const sources = (await scriptSources(page)).filter((source) => source.endsWith('.js'));
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    const url = new URL(source, page.url());
    expect(url.origin).toBe(LIVE_TEST_HTTP_ORIGIN);
    expect(url.pathname).toMatch(/^\/Aviation-Dashboard-Project\/assets\/[\w.-]+\.js$/u);
    const identity = rollbackIdentityForCandidatePath(`artifact/client${url.pathname}`);
    const scriptResponse = await request.get(url.href);
    expect(scriptResponse.ok()).toBe(true);
    const script = Buffer.from(await scriptResponse.body());
    expect(script.byteLength).toBe(identity.bytes);
    expect(sha256(script)).toBe(identity.sha256);
  }
  await network.expectNone(request);
});

test('retained map bytes support exact range reads while absent maps and assets fail closed', async ({
  context,
  page,
  request,
}) => {
  const network = await installNetworkAudit(context, page);
  expect(mapManifest.id).toBe(provenance.mapManifest.id);
  const basemap = mapManifest.assets.find((asset) => asset.path === 'basemap.pmtiles');
  if (!basemap) throw new Error('The retained manifest is missing basemap.pmtiles.');
  const payloadPath = join(
    candidateDirectory,
    ...provenance.mapManifest.payload.candidatePath.split('/'),
    ...basemap.path.split('/'),
  );
  const expectedRange = firstBytes(payloadPath, 64);
  expect(expectedRange.byteLength).toBe(64);
  const rangeResponse = await request.get(
    `/map-assets/${encodeURIComponent(mapManifest.id)}/${encodedAssetPath(basemap.path)}`,
    { headers: { range: 'bytes=0-63' } },
  );
  expect(rangeResponse.status()).toBe(206);
  expect(Buffer.from(await rangeResponse.body())).toEqual(expectedRange);
  expect(rangeResponse.headers()['content-range']).toBe(`bytes 0-63/${basemap.bytes}`);
  expect(rangeResponse.headers().etag).toBe(`"${basemap.sha256}"`);
  expect(rangeResponse.headers()['x-map-id']).toBe(mapManifest.id);

  const missingMap = await request.get(
    `/map-assets/${encodeURIComponent(mapManifest.id)}/not-retained.pmtiles`,
    { failOnStatusCode: false },
  );
  expect(missingMap.status()).toBe(404);
  expect(await missingMap.json()).toEqual({ error: 'MAP_ASSET_NOT_FOUND' });
  const missingMapId = await request.get('/map-assets/not-retained/basemap.pmtiles', {
    failOnStatusCode: false,
  });
  expect(missingMapId.status()).toBe(404);
  expect(await missingMapId.json()).toEqual({ error: 'MAP_ASSET_NOT_FOUND' });
  const missingAsset = await request.get('/assets/m34-not-retained.js', {
    failOnStatusCode: false,
  });
  expect(missingAsset.status()).toBe(404);
  const missingDocument = await request.get('/m34-not-retained', { failOnStatusCode: false });
  expect(missingDocument.status()).toBe(404);
  const redirectsMetadata = await request.get('/_redirects', { failOnStatusCode: false });
  expect(redirectsMetadata.status()).toBe(404);
  const canonicalizedRollback = await request.get('/v2', { failOnStatusCode: false });
  expect(canonicalizedRollback.status()).toBe(404);
  const canonicalizedLegacy = await request.get('/Aviation-Dashboard-Project', {
    failOnStatusCode: false,
  });
  expect(canonicalizedLegacy.status()).toBe(404);

  await page.goto('/');
  const v3Sources = await scriptSources(page);
  expect(v3Sources.length).toBeGreaterThan(0);
  for (const source of v3Sources) {
    const assetUrl = new URL(source, page.url());
    const assetResponse = await request.get(assetUrl.href);
    expect(assetResponse.ok()).toBe(true);
    expect(await assetResponse.text()).not.toMatch(/(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL\s*=/u);
    const mapResponse = await request.get(`${assetUrl.href}.map`, { failOnStatusCode: false });
    expect(mapResponse.status()).toBe(404);
  }

  await page.goto('/v2.html');
  for (const source of (await scriptSources(page)).filter((entry) => entry.endsWith('.js'))) {
    const assetUrl = new URL(source, page.url());
    const mapResponse = await request.get(`${assetUrl.href}.map`, { failOnStatusCode: false });
    expect(mapResponse.status()).toBe(404);
  }
  await network.expectNone(request);
});
