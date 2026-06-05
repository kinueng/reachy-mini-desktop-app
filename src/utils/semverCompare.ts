/**
 * Tiny semver comparison utility.
 *
 * The desktop app already pulls in dozens of dependencies for the UI; we
 * deliberately avoid adding `semver` (~25 KB) just to compare three integers.
 * Logic mirrors the parser used in `uv-wrapper/src/lib.rs::get_installed_version`
 * so the two stay in sync semantically:
 *
 *   - We only look at the first three numeric segments (`MAJOR.MINOR.PATCH`).
 *   - Anything after a non-digit in the patch (`1.7.0rc1`, `1.7.0.dev0`,
 *     `1.7.0+build.5`, `1.7.0-rc.1`) is stripped before parsing, so a
 *     pre-release is treated as the matching stable release for the purpose
 *     of "is this version too old?". That matches the daemon's
 *     `_semver_version` parser on `pre_release=False`.
 *   - Any unparseable input returns `null` from `parseVersion()` and makes
 *     `isVersionBelow()` return `false` (fail-open, never block on garbage).
 */

export type SemverTuple = readonly [number, number, number];

/**
 * Parse a version string into `[major, minor, patch]`.
 * Returns `null` if the string doesn't expose at least three numeric segments.
 */
export function parseVersion(version: string | null | undefined): SemverTuple | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;

  // Strip a leading "v" so both "1.7.0" and "v1.7.0" parse the same.
  const normalized =
    trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed;

  const segments = normalized.split('.');
  if (segments.length < 3) return null;

  const major = parseLeadingDigits(segments[0]);
  const minor = parseLeadingDigits(segments[1]);
  const patch = parseLeadingDigits(segments[2]);

  if (major === null || minor === null || patch === null) return null;
  return [major, minor, patch] as const;
}

/**
 * Compare two version strings the way semver would, ignoring pre-release tags.
 * Returns `-1` when `a < b`, `0` when equal, `1` when `a > b`. Returns `null`
 * if either side is unparseable.
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined
): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Returns `true` iff `current` is strictly older than `min`.
 *
 * Designed to gate features behind a minimum version. Fails open: when either
 * side is unparseable we return `false` so we never lock the user out because
 * of an unrecognised version string from a custom build.
 */
export function isVersionBelow(current: string | null | undefined, min: string): boolean {
  const cmp = compareVersions(current, min);
  if (cmp === null) return false;
  return cmp < 0;
}

function parseLeadingDigits(segment: string | undefined): number | null {
  if (!segment) return null;
  const digits = segment.match(/^\d+/);
  if (!digits) return null;
  const n = Number(digits[0]);
  return Number.isFinite(n) ? n : null;
}
