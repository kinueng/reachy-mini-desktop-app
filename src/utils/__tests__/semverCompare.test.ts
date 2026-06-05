import { describe, it, expect } from 'vitest';
import { parseVersion, compareVersions, isVersionBelow } from '../semverCompare';

describe('parseVersion', () => {
  it('parses a plain X.Y.Z', () => {
    expect(parseVersion('1.7.1')).toEqual([1, 7, 1]);
    expect(parseVersion('0.0.0')).toEqual([0, 0, 0]);
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30]);
  });

  it('strips a leading "v" or "V"', () => {
    expect(parseVersion('v1.7.1')).toEqual([1, 7, 1]);
    expect(parseVersion('V2.0.0')).toEqual([2, 0, 0]);
  });

  it('strips non-numeric suffixes from the patch (PEP 440 style)', () => {
    expect(parseVersion('1.7.0rc1')).toEqual([1, 7, 0]);
    expect(parseVersion('1.7.0.dev0')).toEqual([1, 7, 0]);
    expect(parseVersion('1.7.0+build.5')).toEqual([1, 7, 0]);
    expect(parseVersion('1.7.0-rc.1')).toEqual([1, 7, 0]);
  });

  it('returns null for unparseable input (fail-open)', () => {
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('   ')).toBeNull();
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('1.7')).toBeNull();
    expect(parseVersion('1')).toBeNull();
    expect(parseVersion('a.b.c')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('returns -1 / 0 / 1 like Array#sort', () => {
    expect(compareVersions('1.7.0', '1.7.1')).toBe(-1);
    expect(compareVersions('1.7.1', '1.7.1')).toBe(0);
    expect(compareVersions('1.7.2', '1.7.1')).toBe(1);
  });

  it('compares major then minor then patch', () => {
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.8.0', '1.7.99')).toBe(1);
    expect(compareVersions('1.7.0', '1.6.99')).toBe(1);
  });

  it('treats pre-releases as their stable counterpart', () => {
    expect(compareVersions('1.7.0rc1', '1.7.0')).toBe(0);
    expect(compareVersions('1.7.0rc1', '1.7.1')).toBe(-1);
  });

  it('returns null when either side is unparseable', () => {
    expect(compareVersions('1.7.1', null)).toBeNull();
    expect(compareVersions(null, '1.7.1')).toBeNull();
    expect(compareVersions('garbage', '1.7.1')).toBeNull();
  });
});

describe('isVersionBelow', () => {
  it('returns true when current is strictly older', () => {
    expect(isVersionBelow('1.6.0', '1.7.1')).toBe(true);
    expect(isVersionBelow('1.7.0', '1.7.1')).toBe(true);
    expect(isVersionBelow('0.9.99', '1.0.0')).toBe(true);
  });

  it('returns false when current matches min', () => {
    expect(isVersionBelow('1.7.1', '1.7.1')).toBe(false);
  });

  it('returns false when current is newer', () => {
    expect(isVersionBelow('1.7.2', '1.7.1')).toBe(false);
    expect(isVersionBelow('2.0.0', '1.7.1')).toBe(false);
  });

  it('fails open on unparseable input (never blocks the user)', () => {
    expect(isVersionBelow(null, '1.7.1')).toBe(false);
    expect(isVersionBelow('', '1.7.1')).toBe(false);
    expect(isVersionBelow('weird-build', '1.7.1')).toBe(false);
    expect(isVersionBelow('dev', '1.7.1')).toBe(false);
  });

  it('treats pre-releases as their stable counterpart (does not force update on rc)', () => {
    expect(isVersionBelow('1.7.1rc1', '1.7.1')).toBe(false);
    expect(isVersionBelow('1.7.0rc1', '1.7.1')).toBe(true);
  });
});
