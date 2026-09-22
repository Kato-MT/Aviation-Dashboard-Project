// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { byId, downloadText, formatNumber, formatObserved, setText, slug } from '../../src/ui/dom';

describe('src/ui/dom', () => {
  describe('formatObserved', () => {
    it('returns "Not present" for empty, null, or undefined values', () => {
      expect(formatObserved(undefined)).toBe('Not present');
      expect(formatObserved(null)).toBe('Not present');
      expect(formatObserved('')).toBe('Not present');
    });

    it('returns original string when value is a non-empty string', () => {
      expect(formatObserved('hello')).toBe('hello');
      expect(formatObserved('123')).toBe('123');
    });

    it('formats finite numbers with maximum 3 fraction digits', () => {
      expect(formatObserved(123.45678)).toBe('123.457');
      expect(formatObserved(0)).toBe('0');
      expect(formatObserved(-42.1)).toBe('-42.1');
    });

    it('returns String(value) for non-finite numbers', () => {
      expect(formatObserved(Number.NaN)).toBe('NaN');
      expect(formatObserved(Number.POSITIVE_INFINITY)).toBe('Infinity');
      expect(formatObserved(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
    });

    it('returns JSON.stringify representation for valid objects and primitives', () => {
      expect(formatObserved(true)).toBe('true');
      expect(formatObserved(false)).toBe('false');
      expect(formatObserved({ a: 1, b: 'test' })).toBe('{"a":1,"b":"test"}');
      expect(formatObserved([1, 2, 3])).toBe('[1,2,3]');
    });

    it('falls back to String(value) when JSON.stringify throws (e.g. circular structure)', () => {
      const circularObj: Record<string, unknown> = { name: 'circular' };
      circularObj.self = circularObj;

      expect(formatObserved(circularObj)).toBe('[object Object]');

      const bigIntObj = { val: 123n };
      expect(formatObserved(bigIntObj)).toBe('[object Object]');
    });
  });

  describe('formatNumber', () => {
    it('returns "---" for undefined or non-finite numbers', () => {
      expect(formatNumber(undefined)).toBe('---');
      expect(formatNumber(Number.NaN)).toBe('---');
      expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('---');
    });

    it('formats numbers with default maximumFractionDigits = 1', () => {
      expect(formatNumber(12.345)).toBe('12.3');
      expect(formatNumber(100)).toBe('100');
    });

    it('respects custom maximumFractionDigits', () => {
      expect(formatNumber(12.3456, 3)).toBe('12.346');
      expect(formatNumber(12.3456, 0)).toBe('12');
    });
  });

  describe('slug', () => {
    it('converts strings to clean url-safe slug format', () => {
      expect(slug('Hello World!')).toBe('hello-world');
      expect(slug('  --Some  Special #$% String-- ')).toBe('some-special-string');
      expect(slug('A'.repeat(100))).toBe('a'.repeat(72));
    });
  });

  describe('DOM helpers', () => {
    it('byId returns element if found and throws if not found', () => {
      document.body.innerHTML = '<div id="test-div">hello</div>';
      expect(byId('test-div')).toBeInstanceOf(HTMLElement);
      expect(() => byId('non-existent')).toThrow(
        'Required interface element #non-existent was not found.',
      );
    });

    it('setText sets textContent of specified element by id', () => {
      document.body.innerHTML = '<div id="target"></div>';
      setText('target', 'Updated Content');
      expect(byId('target').textContent).toBe('Updated Content');

      setText('target', 42);
      expect(byId('target').textContent).toBe('42');
    });

    it('downloadText triggers a blob download anchor click', () => {
      const createObjectURLMock = vi.fn().mockReturnValue('blob:http://localhost/dummy');
      const revokeObjectURLMock = vi.fn();
      globalThis.URL.createObjectURL = createObjectURLMock;
      globalThis.URL.revokeObjectURL = revokeObjectURLMock;

      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      downloadText('test.json', '{"hello":"world"}', 'application/json');

      expect(createObjectURLMock).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:http://localhost/dummy');

      clickSpy.mockRestore();
    });
  });
});
