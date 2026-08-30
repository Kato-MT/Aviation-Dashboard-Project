import { isCanonicalTimestamp, isSafeInteger } from './validation';

export interface RetryAfterDirective {
  retryAfterSeconds?: number;
  retryAtMs?: number;
  retryBlocked?: boolean;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const maxTimestamp = Date.parse('9999-12-31T23:59:59.999Z');
const imfDate =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/u;
const rfc850Date =
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/u;
const asctimeDate =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/u;

function parseHttpDate(value: string, receivedAtMs: number): number | undefined {
  let match: readonly string[] | null = imfDate.exec(value);
  let obsoleteYear = false;
  if (!match) {
    match = rfc850Date.exec(value);
    obsoleteYear = match !== null;
  }
  if (!match) {
    const legacy = asctimeDate.exec(value);
    if (!legacy) return undefined;
    match = [
      legacy[0]!,
      legacy[1]!,
      legacy[3]!.trim().padStart(2, '0'),
      legacy[2]!,
      legacy[5]!,
      legacy[4]!,
    ];
  }

  const fields = match;
  const month = months.indexOf(fields[3]!);
  if (month === -1) return undefined;
  const receipt = new Date(receivedAtMs);
  let year = Number(fields[4]);
  if (obsoleteYear) year += Math.floor(receipt.getUTCFullYear() / 100) * 100;
  const second = Number(fields[5]!.slice(-2));
  if (second > 60) return undefined;
  const time = fields[5]!.slice(0, -2) + String(Math.min(second, 59)).padStart(2, '0');
  const timestampForYear = (fullYear: number): string =>
    String(fullYear).padStart(4, '0') +
    '-' +
    String(month + 1).padStart(2, '0') +
    '-' +
    fields[2] +
    'T' +
    time +
    '.000Z';

  let timestamp = timestampForYear(year);
  if (!isCanonicalTimestamp(timestamp)) return undefined;
  if (obsoleteYear) {
    const futureLimit = new Date(receivedAtMs);
    futureLimit.setUTCFullYear(receipt.getUTCFullYear() + 50);
    if (Date.parse(timestamp) > futureLimit.getTime()) {
      year -= 100;
      timestamp = timestampForYear(year);
      if (!isCanonicalTimestamp(timestamp)) return undefined;
    }
  }
  const date = new Date(timestamp);
  if (weekdays[date.getUTCDay()] !== fields[1]!.slice(0, 3)) return undefined;
  // JavaScript has no leap-second representation. Waiting through the following second is conservative.
  return date.getTime() + (second === 60 ? 1_000 : 0);
}

export function parseRetryAfter(value: string | null, receivedAtMs: number): RetryAfterDirective {
  if (!isSafeInteger(receivedAtMs, 0, maxTimestamp)) {
    throw new RangeError('receivedAtMs must be a valid non-negative epoch millisecond timestamp.');
  }
  if (value === null || value.trim() === '') return {};
  const normalized = value.trim();
  let retryAtMs: number | undefined;
  if (/^\d+$/u.test(normalized)) {
    const seconds = Number(normalized);
    if (!isSafeInteger(seconds)) return { retryBlocked: true };
    retryAtMs = receivedAtMs + seconds * 1_000;
  } else {
    retryAtMs = parseHttpDate(normalized, receivedAtMs);
  }
  if (retryAtMs === undefined) return {};
  // A valid but unrepresentable future delay must not become an early automatic retry.
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs > maxTimestamp) return { retryBlocked: true };
  return { retryAtMs, retryAfterSeconds: Math.max(0, (retryAtMs - receivedAtMs) / 1_000) };
}
