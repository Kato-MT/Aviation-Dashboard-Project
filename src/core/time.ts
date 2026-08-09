export interface ParsedTimestamp {
  normalized: string;
  timestampMs: number;
}

const SUPPORTED_RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function maximumDayInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Parses the legacy elapsed-time format (minutes:seconds) without assuming wall-clock time.
 * The canonical timestamp is anchored to the Unix epoch solely to support ordering and rates.
 */
export function parseLegacyElapsedTimestamp(value: string): ParsedTimestamp | null {
  const match = /^(\d{1,6}):([0-5]\d(?:\.\d{1,3})?)$/.exec(value.trim());
  if (!match) return null;

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const timestampMs = Math.round((minutes * 60 + seconds) * 1_000);
  return { normalized: new Date(timestampMs).toISOString(), timestampMs };
}

export function parseIsoTimestamp(value: string): ParsedTimestamp | null {
  const match = SUPPORTED_RFC3339_DATE_TIME.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (day < 1 || day > maximumDayInMonth(year, month)) return null;

  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) return null;
  const normalized = new Date(timestampMs).toISOString();
  if (!SUPPORTED_RFC3339_DATE_TIME.test(normalized)) return null;
  return { normalized, timestampMs };
}
