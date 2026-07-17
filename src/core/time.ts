export interface ParsedTimestamp {
  normalized: string;
  timestampMs: number;
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
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const timestampMs = Date.parse(trimmed);
  if (!Number.isFinite(timestampMs)) return null;
  return { normalized: new Date(timestampMs).toISOString(), timestampMs };
}
