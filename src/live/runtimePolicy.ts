import { regionConfigsForLiveSource } from './regions';
import {
  describeLiveSource,
  LIVE_BUILD_TARGETS,
  type LiveBuildTarget,
  type LiveProviderMode,
  type LiveSourceDescriptor,
} from './source';
import { RUNTIME_POLICY_LIMITS, type RuntimePolicyLimits } from './runtimePolicyLimits';

export const RUNTIME_POLICY_SCHEMA_VERSION = 'runtime-policy.v1' as const;
export const RUNTIME_POLICY_MAX_ORIGINS = 8;
export const RUNTIME_POLICY_MAX_ORIGIN_LENGTH = 256;
export const RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN = 'https://api.adsb.lol';
export const RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN = 'https://mock-provider.invalid';

export const RUNTIME_POLICY_REASON_CODES = Object.freeze([
  'source-disabled',
  'terms-hold',
  'quota-hold',
  'upstream-stale',
  'admission-limited',
  'internal-fault',
  'rollback',
] as const);

export type RuntimePolicyReasonCode = (typeof RUNTIME_POLICY_REASON_CODES)[number];
export type ProviderGateClosedReason = 'source-disabled' | 'terms-hold' | 'quota-hold';
export type DeploymentClass = 'loopback' | 'isolated-cloud' | 'public';
export type SourceCapability = 'none' | 'mock-service' | 'fixed-https';
export type RuntimePolicyReleaseStatus = 'unreleased' | 'exact-release';

export interface RuntimePolicyReleaseIdentity {
  readonly applicationVersion: string;
  readonly releaseSha: string;
  readonly releaseStatus: RuntimePolicyReleaseStatus;
  readonly buildTarget: LiveBuildTarget;
}

export type RuntimePolicyProviderGate =
  | Readonly<{ status: 'closed'; reason: ProviderGateClosedReason }>
  | Readonly<{ status: 'approved'; receiptSha256: string }>;

export interface RuntimePolicyInput {
  readonly target: LiveBuildTarget;
  readonly providerMode: LiveProviderMode;
  readonly providerBaseUrl?: string | undefined;
  readonly mockBindingPresent: boolean;
  readonly allowedOrigins: readonly string[];
  readonly deploymentClass: DeploymentClass;
  readonly release: Readonly<RuntimePolicyReleaseIdentity>;
  readonly policyEpoch: string;
  readonly providerGate: RuntimePolicyProviderGate;
}

export interface RuntimePolicyBindings {
  readonly LIVE_BUILD_TARGET?: unknown;
  readonly LIVE_PROVIDER_MODE?: unknown;
  readonly LIVE_PROVIDER_BASE_URL?: unknown;
  readonly ALLOWED_ORIGINS?: unknown;
  readonly APP_VERSION?: unknown;
  readonly RELEASE_SHA?: unknown;
  readonly RUNTIME_POLICY_EPOCH?: unknown;
  readonly RUNTIME_DEPLOYMENT_CLASS?: unknown;
  readonly RUNTIME_RELEASE_STATUS?: unknown;
  readonly RUNTIME_PROVIDER_GATE_STATUS?: unknown;
  readonly RUNTIME_PROVIDER_GATE_VALUE?: unknown;
  readonly RUNTIME_POLICY_ID?: unknown;
}

export type RuntimePolicySha256 = (canonicalValue: string) => string | Promise<string>;

export type RuntimeRouteId =
  | 'api-regions'
  | 'api-health'
  | 'api-operations'
  | 'api-snapshot'
  | 'api-stream'
  | 'map-assets'
  | 'static-assets';

export interface RuntimePolicyRoute {
  readonly id: RuntimeRouteId;
  readonly matcher: 'exact' | 'regional-template' | 'prefix' | 'asset-manifest';
  readonly path: string;
  readonly methods: readonly ('GET' | 'HEAD' | 'OPTIONS')[];
  readonly query: 'forbidden';
  readonly body: 'forbidden';
  readonly upgrade: 'forbidden' | 'websocket-required';
  readonly feature: 'live-metadata' | 'live-source' | 'maps' | 'static';
  readonly enabled: boolean;
}

export type RuntimePolicyRouteResolution =
  | Readonly<{
      kind: 'route';
      route: Readonly<RuntimePolicyRoute>;
      parameters: Readonly<{ regionId?: string }>;
    }>
  | Readonly<{ kind: 'reserved'; namespace: string }>
  | Readonly<{ kind: 'unmatched' }>;

export interface RuntimePolicyRequestDescriptor {
  readonly method: string;
  readonly hasQuery: boolean;
  readonly hasBody: boolean;
  readonly upgradeHeader: string | null;
}

export type RuntimePolicyRequestViolation =
  | 'query-forbidden'
  | 'method-forbidden'
  | 'body-forbidden'
  | 'upgrade-forbidden'
  | 'upgrade-required';

export type RuntimePolicyRequestDecision =
  Readonly<{ ok: true }> | Readonly<{ ok: false; violation: RuntimePolicyRequestViolation }>;

export interface RuntimePolicyHeaderValues {
  readonly 'content-security-policy': string;
  readonly 'cross-origin-opener-policy': 'same-origin';
  readonly 'cross-origin-resource-policy': 'same-origin';
  readonly 'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()';
  readonly 'referrer-policy': 'no-referrer';
  readonly 'x-content-type-options': 'nosniff';
  readonly 'x-frame-options': 'DENY';
}

export interface RuntimePolicyFeatureGate {
  readonly enabled: boolean;
  readonly reason: ProviderGateClosedReason | null;
}

export interface RuntimePolicyV1 {
  readonly schemaVersion: typeof RUNTIME_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyEpoch: string;
  readonly target: LiveBuildTarget;
  readonly deploymentClass: DeploymentClass;
  readonly release: RuntimePolicyReleaseIdentity;
  readonly providerGate: RuntimePolicyProviderGate;
  readonly source: {
    readonly descriptor: Readonly<LiveSourceDescriptor>;
    readonly capability: SourceCapability;
    readonly providerOrigin: string | null;
    readonly providerPaths: readonly string[];
  };
  readonly origins: {
    readonly allowed: readonly string[];
    readonly websocket: readonly string[];
  };
  readonly routes: readonly RuntimePolicyRoute[];
  readonly headers: {
    readonly profile: LiveBuildTarget;
    readonly contentType: 'required-per-route';
    readonly static: RuntimePolicyHeaderValues;
    readonly worker: RuntimePolicyHeaderValues;
    readonly strictTransportSecurity: 'deferred-until-approved-https-target';
  };
  readonly featureGates: {
    readonly live: RuntimePolicyFeatureGate;
    readonly replay: RuntimePolicyFeatureGate;
    readonly lab: RuntimePolicyFeatureGate;
    readonly evidence: RuntimePolicyFeatureGate;
    readonly offline: RuntimePolicyFeatureGate;
    readonly maps: RuntimePolicyFeatureGate;
    readonly rollback: RuntimePolicyFeatureGate;
  };
  readonly admission: {
    readonly scope: 'worker-isolate';
    readonly exactGlobalAccounting: false;
    readonly exactAccountAccounting: false;
    readonly regionalLimitsRemainAuthoritative: true;
  };
  readonly limits: RuntimePolicyLimits;
  readonly artifact: {
    readonly manifestMode: 'allowlist';
    readonly allowedBindings: readonly string[];
    readonly sourceCapability: SourceCapability;
    readonly forbiddenMetadataKeys: readonly ['configPath', 'userConfigPath'];
    readonly rejectAbsolutePaths: true;
    readonly rejectLocalIdentity: true;
    readonly rejectSecrets: true;
    readonly rejectSourceMaps: true;
    readonly mutableControlPlane: false;
  };
  readonly reasonCodes: readonly RuntimePolicyReasonCode[];
}

export class RuntimePolicyCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimePolicyCompilationError';
  }
}

function requiredBindingText(
  bindings: Readonly<RuntimePolicyBindings>,
  key: keyof RuntimePolicyBindings,
): string {
  const value = bindings[key];
  if (typeof value !== 'string' || value.length === 0) {
    return compilationError(`Runtime policy binding ${key} is missing or invalid.`);
  }
  return value;
}

/** Converts the one closed Worker binding vocabulary into compiler input. */
export function runtimePolicyInputFromBindings(
  bindings: Readonly<RuntimePolicyBindings>,
  mockBindingPresent: boolean,
): Readonly<RuntimePolicyInput> {
  const target = requiredBindingText(bindings, 'LIVE_BUILD_TARGET') as LiveBuildTarget;
  const providerMode = requiredBindingText(bindings, 'LIVE_PROVIDER_MODE') as LiveProviderMode;
  const gateStatus = requiredBindingText(bindings, 'RUNTIME_PROVIDER_GATE_STATUS');
  const gateValue = requiredBindingText(bindings, 'RUNTIME_PROVIDER_GATE_VALUE');
  let providerGate: RuntimePolicyProviderGate;
  if (gateStatus === 'closed') {
    providerGate = { status: 'closed', reason: gateValue as ProviderGateClosedReason };
  } else if (gateStatus === 'approved') {
    providerGate = { status: 'approved', receiptSha256: gateValue };
  } else {
    return compilationError('The runtime provider-gate status is invalid.');
  }
  return {
    target,
    providerMode,
    providerBaseUrl: requiredBindingText(bindings, 'LIVE_PROVIDER_BASE_URL'),
    mockBindingPresent,
    allowedOrigins: requiredBindingText(bindings, 'ALLOWED_ORIGINS').split(','),
    deploymentClass: requiredBindingText(bindings, 'RUNTIME_DEPLOYMENT_CLASS') as DeploymentClass,
    release: {
      applicationVersion: requiredBindingText(bindings, 'APP_VERSION'),
      releaseSha: requiredBindingText(bindings, 'RELEASE_SHA'),
      releaseStatus: requiredBindingText(
        bindings,
        'RUNTIME_RELEASE_STATUS',
      ) as RuntimePolicyReleaseStatus,
      buildTarget: target,
    },
    policyEpoch: requiredBindingText(bindings, 'RUNTIME_POLICY_EPOCH'),
    providerGate,
  };
}

/** Compiles Worker bindings once and rejects a forged or stale baked policy identity. */
export async function compileRuntimePolicyBindings(
  bindings: Readonly<RuntimePolicyBindings>,
  mockBindingPresent: boolean,
  sha256: RuntimePolicySha256 = runtimePolicySha256,
): Promise<Readonly<RuntimePolicyV1>> {
  const expectedPolicyId = requiredBindingText(bindings, 'RUNTIME_POLICY_ID');
  if (!/^[a-f0-9]{64}$/u.test(expectedPolicyId)) {
    return compilationError('The baked runtime policy ID is invalid.');
  }
  const policy = await compileRuntimePolicy(
    runtimePolicyInputFromBindings(bindings, mockBindingPresent),
    sha256,
  );
  if (policy.policyId !== expectedPolicyId) {
    return compilationError('The baked runtime policy ID does not match the compiled policy.');
  }
  return policy;
}

const DEPLOYMENT_CLASSES = Object.freeze(['loopback', 'isolated-cloud', 'public'] as const);

export const RUNTIME_POLICY_PROVIDER_MODES = Object.freeze(['disabled', 'mock', 'live'] as const);

const ROUTE_DEFINITIONS = Object.freeze([
  {
    id: 'api-regions',
    matcher: 'exact',
    path: '/api/v1/regions',
    methods: ['GET', 'OPTIONS'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'forbidden',
    feature: 'live-metadata',
  },
  {
    id: 'api-health',
    matcher: 'exact',
    path: '/api/v1/health',
    methods: ['GET', 'OPTIONS'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'forbidden',
    feature: 'live-metadata',
  },
  {
    id: 'api-operations',
    matcher: 'exact',
    path: '/api/v1/operations',
    methods: ['GET', 'OPTIONS'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'forbidden',
    feature: 'live-metadata',
  },
  {
    id: 'api-snapshot',
    matcher: 'regional-template',
    path: '/api/v1/airspace/{regionId}/snapshot',
    methods: ['GET', 'OPTIONS'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'forbidden',
    feature: 'live-source',
  },
  {
    id: 'api-stream',
    matcher: 'regional-template',
    path: '/api/v1/airspace/{regionId}/stream',
    methods: ['GET', 'OPTIONS'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'websocket-required',
    feature: 'live-source',
  },
  {
    id: 'map-assets',
    matcher: 'prefix',
    path: '/map-assets',
    methods: ['GET', 'HEAD'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'forbidden',
    feature: 'maps',
  },
  {
    id: 'static-assets',
    matcher: 'asset-manifest',
    path: '/',
    methods: ['GET', 'HEAD'],
    query: 'forbidden',
    body: 'forbidden',
    upgrade: 'forbidden',
    feature: 'static',
  },
] as const);

function regionalTemplateMatch(
  route: Readonly<RuntimePolicyRoute>,
  pathname: string,
): Readonly<{ regionId: string }> | undefined {
  const marker = '{regionId}';
  const markerIndex = route.path.indexOf(marker);
  if (markerIndex < 0 || route.path.indexOf(marker, markerIndex + marker.length) >= 0) {
    return undefined;
  }
  const prefix = route.path.slice(0, markerIndex);
  const suffix = route.path.slice(markerIndex + marker.length);
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const regionId = pathname.slice(prefix.length, pathname.length - suffix.length);
  return /^[a-z0-9-]+$/u.test(regionId) ? { regionId } : undefined;
}

function explicitRuntimeRouteMatch(
  route: Readonly<RuntimePolicyRoute>,
  pathname: string,
): Readonly<{ regionId?: string }> | undefined {
  if (route.matcher === 'exact') return pathname === route.path ? {} : undefined;
  if (route.matcher === 'regional-template') return regionalTemplateMatch(route, pathname);
  if (route.matcher === 'prefix') {
    return pathname === route.path || pathname.startsWith(`${route.path}/`) ? {} : undefined;
  }
  return undefined;
}

function runtimeRouteNamespace(route: Readonly<RuntimePolicyRoute>): string | undefined {
  if (route.matcher === 'asset-manifest' || !route.path.startsWith('/')) return undefined;
  const separator = route.path.indexOf('/', 1);
  return separator < 0 ? route.path : route.path.slice(0, separator);
}

function reservedRuntimeNamespace(
  policy: Readonly<RuntimePolicyV1>,
  pathname: string,
): string | undefined {
  for (const route of policy.routes) {
    const namespace = runtimeRouteNamespace(route);
    if (namespace === undefined) continue;
    if (
      explicitRuntimeRouteMatch(route, pathname) !== undefined ||
      pathname === namespace ||
      pathname.startsWith(`${namespace}/`)
    ) {
      return namespace;
    }
  }
  return undefined;
}

function normalizedPathCandidate(pathname: string): string {
  const segments: string[] = [];
  for (const segment of pathname.replaceAll('\\', '/').split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function decodedReservationCandidates(pathname: string): Readonly<{
  candidates: readonly string[];
  rejectStaticFallback: boolean;
}> {
  const candidates: string[] = [];
  const normalized = normalizedPathCandidate(pathname);
  if (normalized !== pathname) candidates.push(normalized);
  let candidate = pathname;
  for (let pass = 0; pass < 16; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return { candidates, rejectStaticFallback: true };
    }
    if (decoded === candidate) return { candidates, rejectStaticFallback: false };
    candidate = decoded;
    const normalizedDecoded = normalizedPathCandidate(decoded);
    if (!candidates.includes(normalizedDecoded)) candidates.push(normalizedDecoded);
  }
  return { candidates, rejectStaticFallback: true };
}

/** Resolves one request path using only the immutable compiled route table. */
export function resolveRuntimePolicyRoute(
  policy: Readonly<RuntimePolicyV1>,
  pathname: string,
): RuntimePolicyRouteResolution {
  for (const route of policy.routes) {
    const parameters = explicitRuntimeRouteMatch(route, pathname);
    if (parameters !== undefined) {
      return { kind: 'route', route, parameters };
    }
  }
  const reservedNamespace = reservedRuntimeNamespace(policy, pathname);
  if (reservedNamespace !== undefined) {
    return { kind: 'reserved', namespace: reservedNamespace };
  }
  const decodedCandidates = decodedReservationCandidates(pathname);
  for (const decoded of decodedCandidates.candidates) {
    const namespace = reservedRuntimeNamespace(policy, decoded);
    if (namespace !== undefined) return { kind: 'reserved', namespace };
  }
  if (decodedCandidates.rejectStaticFallback) {
    return { kind: 'reserved', namespace: 'noncanonical-path' };
  }
  const staticRoute = policy.routes.find((route) => route.matcher === 'asset-manifest');
  return staticRoute === undefined
    ? { kind: 'unmatched' }
    : { kind: 'route', route: staticRoute, parameters: {} };
}

/** Applies the closed method, query, body, and upgrade contract for one compiled route. */
export function evaluateRuntimePolicyRequest(
  route: Readonly<RuntimePolicyRoute>,
  request: Readonly<RuntimePolicyRequestDescriptor>,
): RuntimePolicyRequestDecision {
  if (route.query === 'forbidden' && request.hasQuery) {
    return { ok: false, violation: 'query-forbidden' };
  }
  if (!route.methods.includes(request.method as RuntimePolicyRoute['methods'][number])) {
    return { ok: false, violation: 'method-forbidden' };
  }
  if (route.body === 'forbidden' && request.hasBody) {
    return { ok: false, violation: 'body-forbidden' };
  }
  if (request.method === 'OPTIONS') {
    return request.upgradeHeader === null
      ? { ok: true }
      : { ok: false, violation: 'upgrade-forbidden' };
  }
  if (route.upgrade === 'forbidden') {
    return request.upgradeHeader === null
      ? { ok: true }
      : { ok: false, violation: 'upgrade-forbidden' };
  }
  return request.upgradeHeader?.trim().toLowerCase() === 'websocket'
    ? { ok: true }
    : { ok: false, violation: 'upgrade-required' };
}

function compilationError(message: string): never {
  throw new RuntimePolicyCompilationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function boundedCanonicalText(value: unknown, maximum: number, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    pattern.test(value)
  );
}

function validateReleaseIdentity(
  value: unknown,
  target: LiveBuildTarget,
  deploymentClass: DeploymentClass,
): RuntimePolicyReleaseIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['applicationVersion', 'releaseSha', 'releaseStatus', 'buildTarget']) ||
    !boundedCanonicalText(value.applicationVersion, 64, /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u) ||
    (value.releaseStatus !== 'unreleased' && value.releaseStatus !== 'exact-release') ||
    value.buildTarget !== target
  ) {
    return compilationError('The release identity is invalid or does not match the build target.');
  }
  const exactSha = typeof value.releaseSha === 'string' && /^[a-f0-9]{40}$/u.test(value.releaseSha);
  const localIdentity = value.releaseSha === 'local-unreleased';
  if (
    (!exactSha && !localIdentity) ||
    (value.releaseStatus === 'exact-release' && !exactSha) ||
    (deploymentClass === 'public' && !exactSha)
  ) {
    return compilationError('The release SHA is not valid for this deployment class.');
  }
  return {
    applicationVersion: value.applicationVersion,
    releaseSha: value.releaseSha as string,
    releaseStatus: value.releaseStatus,
    buildTarget: target,
  };
}

function validateProviderGate(value: unknown): RuntimePolicyProviderGate {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return compilationError('The provider gate is invalid.');
  }
  if (
    value.status === 'closed' &&
    hasExactKeys(value, ['status', 'reason']) &&
    (value.reason === 'source-disabled' ||
      value.reason === 'terms-hold' ||
      value.reason === 'quota-hold')
  ) {
    return { status: 'closed', reason: value.reason };
  }
  if (
    value.status === 'approved' &&
    hasExactKeys(value, ['status', 'receiptSha256']) &&
    typeof value.receiptSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.receiptSha256)
  ) {
    return { status: 'approved', receiptSha256: value.receiptSha256 };
  }
  return compilationError('The provider gate is invalid.');
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function canonicalOrigins(
  value: unknown,
  deploymentClass: DeploymentClass,
): { allowed: string[]; websocket: string[] } {
  if (!Array.isArray(value) || value.length === 0 || value.length > RUNTIME_POLICY_MAX_ORIGINS) {
    return compilationError('Allowed origins must be a non-empty bounded array.');
  }
  const accepted = new Set<string>();
  for (const origin of value) {
    if (
      typeof origin !== 'string' ||
      origin.length === 0 ||
      origin.length > RUNTIME_POLICY_MAX_ORIGIN_LENGTH ||
      origin.trim() !== origin ||
      origin.includes('*')
    ) {
      return compilationError(
        'An allowed origin is empty, oversized, wildcarded, or noncanonical.',
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return compilationError('An allowed origin is not a valid URL origin.');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.origin !== origin
    ) {
      return compilationError('An allowed origin contains forbidden or noncanonical URL parts.');
    }
    const loopback = isLoopbackHost(parsed.hostname);
    if (
      (deploymentClass === 'loopback' && !loopback) ||
      (deploymentClass !== 'loopback' && loopback) ||
      (deploymentClass !== 'loopback' && parsed.protocol !== 'https:')
    ) {
      return compilationError('An allowed origin is incompatible with the deployment class.');
    }
    if (accepted.has(origin)) {
      return compilationError('Allowed origins must be duplicate-free.');
    }
    accepted.add(origin);
  }
  const allowed = [...accepted].sort();
  return {
    allowed,
    websocket: allowed.map((origin) => {
      const parsed = new URL(origin);
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return parsed.origin;
    }),
  };
}

function validateDeploymentCompatibility(
  target: LiveBuildTarget,
  deploymentClass: DeploymentClass,
): void {
  const compatible =
    (target === 'local-mock' && deploymentClass === 'loopback') ||
    ((target === 'mock-staging' || target === 'live-staging') &&
      (deploymentClass === 'loopback' || deploymentClass === 'isolated-cloud')) ||
    (target === 'production' && (deploymentClass === 'loopback' || deploymentClass === 'public'));
  if (!compatible) compilationError('The deployment class is incompatible with the build target.');
}

function validateSourceBoundary(
  input: Readonly<RuntimePolicyInput>,
  source: Readonly<LiveSourceDescriptor>,
  providerGate: RuntimePolicyProviderGate,
): void {
  const expectedOrigin = source.synthetic
    ? RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN
    : RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN;
  if (input.providerBaseUrl !== undefined && input.providerBaseUrl !== expectedOrigin) {
    compilationError('Only the fixed provider origin for this target is permitted.');
  }
  if (!source.synthetic && input.mockBindingPresent) {
    compilationError('A mock binding is forbidden in a real-source target.');
  }
  if (source.mode === 'mock' && !input.mockBindingPresent) {
    compilationError('Mock mode requires its isolated service binding.');
  }
  if (source.mode !== 'mock' && source.synthetic && input.mockBindingPresent) {
    compilationError('A disabled synthetic target cannot retain an active mock binding.');
  }
  if (source.mode === 'live' && providerGate.status !== 'approved') {
    compilationError('Live provider mode requires an approved provider-gate receipt.');
  }
  if (source.mode !== 'live' && providerGate.status !== 'closed') {
    compilationError('A non-live source cannot carry an approved real-provider gate.');
  }
  if (
    source.mode === 'mock' &&
    providerGate.status === 'closed' &&
    providerGate.reason !== 'source-disabled'
  ) {
    compilationError('Synthetic mode cannot claim a real-provider terms or quota hold.');
  }
}

function sourceCapability(source: Readonly<LiveSourceDescriptor>): SourceCapability {
  if (source.mode === 'disabled') return 'none';
  return source.mode === 'mock' ? 'mock-service' : 'fixed-https';
}

function staticContentSecurityPolicy(websocketOrigins: readonly string[]): string {
  const loopbackRollbackSource = websocketOrigins.some((origin) => {
    const hostname = new URL(origin).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  })
    ? ['ws://127.0.0.1:*']
    : [];
  const connectSources = ["'self'", ...websocketOrigins, ...loopbackRollbackSource].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSources}`,
    "worker-src 'self' blob: data:",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function workerContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function headerValues(contentSecurityPolicy: string): RuntimePolicyHeaderValues {
  return {
    'content-security-policy': contentSecurityPolicy,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function routes(liveEnabled: boolean): RuntimePolicyRoute[] {
  return ROUTE_DEFINITIONS.map((route) => ({
    ...route,
    methods: [...route.methods],
    enabled: route.feature !== 'live-source' || liveEnabled,
  }));
}

function enabledFeatureGate(): RuntimePolicyFeatureGate {
  return { enabled: true, reason: null };
}

function featureGates(
  liveEnabled: boolean,
  providerGate: RuntimePolicyProviderGate,
): RuntimePolicyV1['featureGates'] {
  const stable = enabledFeatureGate;
  return {
    live: liveEnabled
      ? stable()
      : {
          enabled: false,
          reason: providerGate.status === 'closed' ? providerGate.reason : 'source-disabled',
        },
    replay: stable(),
    lab: stable(),
    evidence: stable(),
    offline: stable(),
    maps: stable(),
    rollback: stable(),
  };
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`)
      .join(',')}}`;
  }
  return compilationError('The runtime policy contains a non-JSON value.');
}

export function runtimePolicyCanonicalJson(value: unknown): string {
  return canonicalJsonValue(value);
}

export async function runtimePolicySha256(canonicalValue: string): Promise<string> {
  const runtime = globalThis as unknown as {
    crypto?: {
      subtle?: {
        digest(algorithm: 'SHA-256', value: Uint8Array): Promise<ArrayBuffer>;
      };
    };
  };
  const subtle = runtime.crypto?.subtle;
  if (!subtle) compilationError('SHA-256 is unavailable in this runtime.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalValue));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || visited.has(value)) return value;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], visited);
  }
  return Object.freeze(value);
}

/**
 * Compiles untrusted deployment values into the one immutable policy used by later consumers.
 * The compiler performs no network or platform mutation; the hash is its only asynchronous step.
 */
export async function compileRuntimePolicy(
  input: Readonly<RuntimePolicyInput>,
  sha256: RuntimePolicySha256 = runtimePolicySha256,
): Promise<Readonly<RuntimePolicyV1>> {
  if (!LIVE_BUILD_TARGETS.includes(input.target as LiveBuildTarget)) {
    compilationError('The live build target is unknown.');
  }
  if (!RUNTIME_POLICY_PROVIDER_MODES.includes(input.providerMode as LiveProviderMode)) {
    compilationError('The provider mode is unknown.');
  }
  if (!DEPLOYMENT_CLASSES.includes(input.deploymentClass as DeploymentClass)) {
    compilationError('The deployment class is unknown.');
  }
  if (typeof input.mockBindingPresent !== 'boolean') {
    compilationError('Mock binding presence must be declared as a boolean.');
  }
  if (!boundedCanonicalText(input.policyEpoch, 64, /^[a-z0-9][a-z0-9._:-]*$/u)) {
    compilationError('The policy epoch is empty, oversized, or noncanonical.');
  }

  const target = input.target as LiveBuildTarget;
  const deploymentClass = input.deploymentClass as DeploymentClass;
  validateDeploymentCompatibility(target, deploymentClass);
  const release = validateReleaseIdentity(input.release, target, deploymentClass);
  const providerGate = validateProviderGate(input.providerGate);
  let descriptor: Readonly<LiveSourceDescriptor>;
  try {
    descriptor = describeLiveSource(target, input.providerMode);
  } catch {
    return compilationError('The target and provider mode are incompatible.');
  }
  validateSourceBoundary(input, descriptor, providerGate);
  const origins = canonicalOrigins(input.allowedOrigins, deploymentClass);
  const capability = sourceCapability(descriptor);
  const providerPaths = regionConfigsForLiveSource(descriptor).map(
    (region) =>
      `/v2/point/${region.center.latitude}/${region.center.longitude}/${region.radiusNauticalMiles}`,
  );
  const liveEnabled = descriptor.mode !== 'disabled';
  const staticHeaders = headerValues(staticContentSecurityPolicy(origins.websocket));
  const workerHeaders = headerValues(workerContentSecurityPolicy());
  const allowedBindings = ['ASSETS', 'MAP_ASSETS', 'REGION_FEEDS'];
  if (capability === 'mock-service') allowedBindings.push('MOCK_PROVIDER');

  const body: Omit<RuntimePolicyV1, 'policyId'> = {
    schemaVersion: RUNTIME_POLICY_SCHEMA_VERSION,
    policyEpoch: input.policyEpoch,
    target,
    deploymentClass,
    release,
    providerGate,
    source: {
      descriptor,
      capability,
      providerOrigin:
        capability === 'none'
          ? null
          : descriptor.synthetic
            ? RUNTIME_POLICY_MOCK_PROVIDER_ORIGIN
            : RUNTIME_POLICY_LIVE_PROVIDER_ORIGIN,
      providerPaths: capability === 'none' ? [] : providerPaths,
    },
    origins,
    routes: routes(liveEnabled),
    headers: {
      profile: target,
      contentType: 'required-per-route',
      static: { ...staticHeaders },
      worker: { ...workerHeaders },
      strictTransportSecurity: 'deferred-until-approved-https-target',
    },
    featureGates: featureGates(liveEnabled, providerGate),
    admission: {
      scope: 'worker-isolate',
      exactGlobalAccounting: false,
      exactAccountAccounting: false,
      regionalLimitsRemainAuthoritative: true,
    },
    limits: RUNTIME_POLICY_LIMITS,
    artifact: {
      manifestMode: 'allowlist',
      allowedBindings,
      sourceCapability: capability,
      forbiddenMetadataKeys: ['configPath', 'userConfigPath'],
      rejectAbsolutePaths: true,
      rejectLocalIdentity: true,
      rejectSecrets: true,
      rejectSourceMaps: true,
      mutableControlPlane: false,
    },
    reasonCodes: [...RUNTIME_POLICY_REASON_CODES],
  };
  const canonicalBody = runtimePolicyCanonicalJson(body);
  const policyId = await sha256(canonicalBody);
  if (!/^[a-f0-9]{64}$/u.test(policyId)) {
    compilationError('The SHA-256 implementation returned a noncanonical digest.');
  }
  return deepFreeze({ ...body, policyId });
}
