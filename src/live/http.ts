import { MAX_LIVE_MESSAGE_BYTES, isSafeInteger } from './validation';

export type LiveResponseErrorCode = 'TOO_LARGE' | 'INVALID_ENCODING' | 'TIMEOUT' | 'ABORTED';

export class LiveResponseError extends Error {
  constructor(
    readonly code: LiveResponseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LiveResponseError';
  }
}

function abortedRequest(): LiveResponseError {
  return new LiveResponseError('ABORTED', 'The live request was cancelled.');
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedRequest();
}

export function cancelLiveResponse(response: Response): void {
  if (response.body && !response.body.locked) {
    // Cleanup must not replace the original HTTP, size, or cancellation failure.
    void response.body.cancel().catch(() => undefined);
  }
}

export async function withLiveRequestDeadline<T>(
  action: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<T> {
  if (!isSafeInteger(options.timeoutMs, 1, 2_147_483_647)) {
    throw new RangeError('timeoutMs must be a positive timer-safe integer.');
  }
  checkAborted(options.signal);
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(abortedRequest());
  options.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new LiveResponseError('TIMEOUT', 'The live request timed out.')),
    options.timeoutMs,
  );
  let rejectAbort!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (options.signal?.aborted) relayAbort();
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return action(controller.signal);
    });
    return await Promise.race([operation, cancelled]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relayAbort);
    controller.signal.removeEventListener('abort', onAbort);
    // Also release a response that arrives after the operation's deadline.
    if (!controller.signal.aborted) controller.abort(abortedRequest());
  }
}

export async function readBoundedLiveText(
  response: Response,
  options: { maxBytes?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? MAX_LIVE_MESSAGE_BYTES;
  if (!isSafeInteger(maxBytes, 1, MAX_LIVE_MESSAGE_BYTES)) {
    cancelLiveResponse(response);
    throw new RangeError(
      'maxBytes must be a positive integer no greater than the live message limit.',
    );
  }
  if (options.signal?.aborted) {
    cancelLiveResponse(response);
    throw abortedRequest();
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    cancelLiveResponse(response);
    throw new LiveResponseError('TOO_LARGE', 'The live response exceeds its byte limit.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const cancelReader = (): void => {
    // Cancellation can reject when the underlying network has already failed.
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', cancelReader, { once: true });
  // One bounded buffer also prevents a million tiny chunks becoming a million retained objects.
  const buffer = new Uint8Array(maxBytes);
  let length = 0;
  let complete = false;
  try {
    while (true) {
      checkAborted(options.signal);
      const chunk = await reader.read();
      checkAborted(options.signal);
      if (chunk.done) {
        complete = true;
        break;
      }
      if (chunk.value.byteLength > maxBytes - length) {
        throw new LiveResponseError('TOO_LARGE', 'The live response exceeds its byte limit.');
      }
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        buffer.subarray(0, length),
      );
    } catch {
      throw new LiveResponseError('INVALID_ENCODING', 'The live response is not valid UTF-8.');
    }
  } finally {
    options.signal?.removeEventListener('abort', cancelReader);
    if (!complete) cancelReader();
    reader.releaseLock();
  }
}
