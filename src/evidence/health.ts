import { cancelLiveResponse, readBoundedLiveText, withLiveRequestDeadline } from '../live/http';
import { parseOperationsProjection } from '../operations/contract';
import type { EvidenceOperations } from './types';

const OPERATIONS_RESPONSE_LIMIT_BYTES = 128 * 1024;
const OPERATIONS_REQUEST_TIMEOUT_MS = 8_000;

export function parseEvidenceOperations(value: unknown): EvidenceOperations {
  return parseOperationsProjection(value);
}

export function loadEvidenceOperations(signal?: AbortSignal): Promise<EvidenceOperations> {
  return withLiveRequestDeadline(
    async (requestSignal) => {
      const response = await fetch('/api/v1/operations', {
        method: 'GET',
        signal: requestSignal,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        cancelLiveResponse(response);
        throw new Error('Operational evidence is unavailable. Static evidence remains available.');
      }
      const text = await readBoundedLiveText(response, {
        maxBytes: OPERATIONS_RESPONSE_LIMIT_BYTES,
        signal: requestSignal,
      });
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error(
          'Operational evidence returned invalid JSON. Static evidence remains available.',
        );
      }
      return parseEvidenceOperations(value);
    },
    { timeoutMs: OPERATIONS_REQUEST_TIMEOUT_MS, signal },
  );
}
