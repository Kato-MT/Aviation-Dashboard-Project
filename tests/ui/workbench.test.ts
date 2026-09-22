import { describe, expect, it } from 'vitest';
import { sourceProfileFromJson } from '../../src/ui/workbench';

describe('sourceProfileFromJson', () => {
  it('returns undefined when JSON parsing throws an error', () => {
    expect(sourceProfileFromJson('invalid json')).toBeUndefined();
    expect(sourceProfileFromJson('{ bad json ')).toBeUndefined();
  });

  it('returns undefined when JSON payload is not an object or lacks profile property', () => {
    expect(sourceProfileFromJson('null')).toBeUndefined();
    expect(sourceProfileFromJson('123')).toBeUndefined();
    expect(sourceProfileFromJson('"string"')).toBeUndefined();
    expect(sourceProfileFromJson('[]')).toBeUndefined();
    expect(sourceProfileFromJson('{}')).toBeUndefined();
    expect(sourceProfileFromJson('{"profile": null}')).toBeUndefined();
  });

  it('returns undefined when profile id is missing, not a string, or unknown', () => {
    expect(sourceProfileFromJson('{"profile": {}}')).toBeUndefined();
    expect(sourceProfileFromJson('{"profile": {"id": 123}}')).toBeUndefined();
    expect(sourceProfileFromJson('{"profile": {"id": "unknown-profile-id"}}')).toBeUndefined();
  });

  it('returns profile when profile id is valid without version or with non-string version', () => {
    const profileNoVersion = sourceProfileFromJson('{"profile": {"id": "generic-fixed-wing"}}');
    expect(profileNoVersion).toBeDefined();
    expect(profileNoVersion?.id).toBe('generic-fixed-wing');

    const profileNumVersion = sourceProfileFromJson(
      '{"profile": {"id": "generic-fixed-wing", "version": 123}}',
    );
    expect(profileNumVersion).toBeDefined();
    expect(profileNumVersion?.id).toBe('generic-fixed-wing');
  });

  it('returns profile when profile id and version string match registered profile', () => {
    const profile = sourceProfileFromJson(
      '{"profile": {"id": "generic-fixed-wing", "version": "1.0.0"}}',
    );
    expect(profile).toBeDefined();
    expect(profile?.id).toBe('generic-fixed-wing');
    expect(profile?.version).toBe('1.0.0');
  });

  it('returns undefined when profile version string does not match registered profile version', () => {
    const profile = sourceProfileFromJson(
      '{"profile": {"id": "generic-fixed-wing", "version": "9.9.9"}}',
    );
    expect(profile).toBeUndefined();
  });
});
