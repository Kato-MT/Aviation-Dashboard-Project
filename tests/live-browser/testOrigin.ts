function configuredPort(): number {
  const value = process.env.LIVE_TEST_PORT ?? '4174';
  if (!/^\d{4,5}$/u.test(value)) throw new Error('LIVE_TEST_PORT is invalid.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('LIVE_TEST_PORT is invalid.');
  }
  return port;
}

export const LIVE_TEST_PORT = configuredPort();
export const LIVE_TEST_HTTP_ORIGIN = `http://127.0.0.1:${LIVE_TEST_PORT}`;
export const LIVE_TEST_WEBSOCKET_ORIGIN = `ws://127.0.0.1:${LIVE_TEST_PORT}`;
