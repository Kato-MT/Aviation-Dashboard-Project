export interface ByteRange {
  offset: number;
  length: number;
}

export function parseByteRange(value: string, size: number): ByteRange | undefined {
  if (!Number.isSafeInteger(size) || size < 1 || value.length > 128) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || match[0] !== value || (!match[1] && !match[2])) return undefined;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return undefined;
  if (!match[1]) {
    if (last <= 0) return undefined;
    const length = Math.min(last, size);
    return { offset: size - length, length };
  }
  if (first >= size || (match[2] && last < first)) return undefined;
  const end = match[2] ? Math.min(last, size - 1) : size - 1;
  return { offset: first, length: end - first + 1 };
}

export function etagMatches(value: string, etag: string, weak: boolean): boolean {
  if (value.length > 1024) return false;
  return value.split(',').some((part) => {
    const candidate = part.trim();
    return candidate === '*' || (weak ? candidate.replace(/^W\//u, '') : candidate) === etag;
  });
}
