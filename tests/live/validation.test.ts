import { describe, expect, it } from 'vitest';
import { isBoundedText, isLiveIdentifier } from '../../src/live/validation';

describe('live identifier validation', () => {
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'rejects a trailing line terminator %j',
    (terminator) => {
      expect(isLiveIdentifier('adsb-lol' + terminator)).toBe(false);
    },
  );

  it.each(['a', 'adsb-lol', 'region.name_1', 'a'.repeat(64)])(
    'accepts the complete bounded identifier %s',
    (identifier) => {
      expect(isLiveIdentifier(identifier)).toBe(true);
    },
  );
});

describe('live text validation', () => {
  it.each([...Array.from({ length: 32 }, (_, code) => code), 0x7f])(
    'rejects embedded control character %i',
    (code) => {
      expect(isBoundedText(`A${String.fromCharCode(code)}B`, 16)).toBe(false);
    },
  );

  it('counts Unicode code points without rejecting printable text', () => {
    expect(isBoundedText('ABC 123', 7)).toBe(true);
    expect(isBoundedText('é'.repeat(16), 16)).toBe(true);
    expect(isBoundedText('🚁'.repeat(16), 16)).toBe(true);
    expect(isBoundedText('🚁'.repeat(17), 16)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [], '', ' ABC', 'ABC ', 'A'.repeat(17)])(
    'rejects invalid or unbounded text %j',
    (value) => {
      expect(isBoundedText(value, 16)).toBe(false);
    },
  );
});
