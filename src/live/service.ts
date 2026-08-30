import { cancelLiveResponse, readBoundedLiveText, withLiveRequestDeadline } from './http';
import { parseLiveSource, type LiveSourceDescriptor } from './source';
import { isBoundedText, isJsonRecord } from './validation';

export interface LiveServiceInfo {
  source: Readonly<LiveSourceDescriptor>;
  applicationVersion: string;
  releaseSha: string;
}

export function parseLiveServiceInfo(value: unknown): LiveServiceInfo {
  if (
    !isJsonRecord(value) ||
    value.schemaVersion !== 'airspace.v1' ||
    !isBoundedText(value.applicationVersion, 64) ||
    !isBoundedText(value.releaseSha, 64)
  ) {
    throw new Error('The service metadata is invalid. No feed was started.');
  }
  const source = parseLiveSource(value.source);
  if (!source) throw new Error('The data source could not be verified. No feed was started.');
  return {
    source,
    applicationVersion: value.applicationVersion as string,
    releaseSha: value.releaseSha as string,
  };
}

export function loadLiveServiceInfo(signal?: AbortSignal): Promise<LiveServiceInfo> {
  return withLiveRequestDeadline(
    async (requestSignal) => {
      const response = await fetch('/api/v1/regions', { signal: requestSignal, redirect: 'error' });
      if (!response.ok) {
        cancelLiveResponse(response);
        throw new Error('The live service is unavailable. No feed was started.');
      }
      const text = await readBoundedLiveText(response, {
        maxBytes: 32 * 1024,
        signal: requestSignal,
      });
      return parseLiveServiceInfo(JSON.parse(text));
    },
    { timeoutMs: 8_000, signal },
  );
}
