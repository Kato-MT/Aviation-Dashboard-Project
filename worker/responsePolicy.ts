export const WORKER_RESPONSE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export const COMMON_SECURITY_RESPONSE_HEADERS = Object.freeze({
  'content-security-policy': WORKER_RESPONSE_CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

export function responseHeaders(
  extra: HeadersInit = {},
  policyHeaders: Readonly<RuntimePolicyHeaderValues> = COMMON_SECURITY_RESPONSE_HEADERS,
): Headers {
  const headers = new Headers(policyHeaders);
  new Headers(extra).forEach((value, name) => headers.set(name, value));
  return headers;
}
import type { RuntimePolicyHeaderValues } from '../src/live/runtimePolicy';
