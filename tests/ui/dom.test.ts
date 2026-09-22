import { describe, expect, it } from 'vitest';
import { formatNumber, formatObserved, slug } from '../../src/ui/dom';

describe('dom formatting and string utilities', () => {
  describe('formatNumber', () => {
    it('returns "---" for undefined, NaN, and non-finite numbers', () => {
      expect(formatNumber(undefined)).toBe('---');
      expect(formatNumber(NaN)).toBe('---');
      expect(formatNumber(Infinity)).toBe('---');
      expect(formatNumber(-Infinity)).toBe('---');
    });

    it('formats standard numbers with default maximumFractionDigits = 1', () => {
      expect(formatNumber(0)).toBe('0');
      expect(formatNumber(1234.56)).toBe('1,234.6');
      expect(formatNumber(-42.123)).toBe('-42.1');
      expect(formatNumber(100)).toBe('100');
    });

    it('respects custom maximumFractionDigits', () => {
      expect(formatNumber(1234.5678, 0)).toBe('1,235');
      expect(formatNumber(1234.5678, 2)).toBe('1,234.57');
      expect(formatNumber(1234.5678, 3)).toBe('1,234.568');
    });

    it('formats large numbers using en-US locale separators', () => {
      expect(formatNumber(1000000)).toBe('1,000,000');
      expect(formatNumber(1234567.89, 2)).toBe('1,234,567.89');
    });
  });

  describe('formatObserved', () => {
    it('returns "Not present" for undefined, null, or empty string', () => {
      expect(formatObserved(undefined)).toBe('Not present');
      expect(formatObserved(null)).toBe('Not present');
      expect(formatObserved('')).toBe('Not present');
    });

    it('returns string values as-is', () => {
      expect(formatObserved('nominal')).toBe('nominal');
      expect(formatObserved('123')).toBe('123');
    });

    it('formats finite numbers with up to 3 fraction digits', () => {
      expect(formatObserved(0)).toBe('0');
      expect(formatObserved(1234.56789)).toBe('1,234.568');
    });

    it('returns string representation for non-finite numbers', () => {
      expect(formatObserved(NaN)).toBe('NaN');
      expect(formatObserved(Infinity)).toBe('Infinity');
      expect(formatObserved(-Infinity)).toBe('-Infinity');
    });

    it('formats objects and arrays as JSON strings', () => {
      expect(formatObserved({ key: 'value' })).toBe('{"key":"value"}');
      expect(formatObserved([1, 2, 3])).toBe('[1,2,3]');
    });

    it('falls back to String(value) for circular objects', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(formatObserved(circular)).toBe('[object Object]');
    });
  });

  describe('slug', () => {
    it('converts text to lowercase, hyphenated, trimmed slug', () => {
      expect(slug('Hello World!')).toBe('hello-world');
      expect(slug('  --Flight #123-- ')).toBe('flight-123');
      expect(slug('Alpha & Beta / Gamma')).toBe('alpha-beta-gamma');
    });

    it('truncates slugs longer than 72 characters', () => {
      const longText = 'a'.repeat(100);
      expect(slug(longText)).toHaveLength(72);
      expect(slug(longText)).toBe('a'.repeat(72));
    });
  });
});
