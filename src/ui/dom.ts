export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required interface element #${id} was not found.`);
  return element as T;
}

export function setText(id: string, value: string | number): void {
  byId(id).textContent = String(value);
}

export function formatNumber(value: number | undefined, maximumFractionDigits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return '---';
  return value.toLocaleString('en-US', { maximumFractionDigits });
}

export function formatObserved(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not present';
  if (typeof value === 'string') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? formatNumber(value, 3) : String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function downloadText(filename: string, content: string, mediaType: string): void {
  const blob = new Blob([content], { type: `${mediaType};charset=utf-8` });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  URL.revokeObjectURL(href);
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72);
}
