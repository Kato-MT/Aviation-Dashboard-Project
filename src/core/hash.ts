/** Returns a lowercase SHA-256 digest for exactly the supplied UTF-8 bytes. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi?.subtle) {
    throw new Error('SHA-256 is unavailable because this runtime does not provide Web Crypto.');
  }

  const digest = await cryptoApi.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
