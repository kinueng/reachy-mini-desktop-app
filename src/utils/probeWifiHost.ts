import { fetchWithTimeout } from '../config/daemon';
import { MIN_WIRELESS_DAEMON_VERSION } from '../constants/daemonVersion';
import { isVersionBelow } from './semverCompare';

/**
 * Pre-flight validation for a WiFi target host, used before committing to the
 * full `startDaemon` sequence. Returns a definitive outcome so the caller can
 * decide whether to connect, force a daemon update, or surface a clear error
 * instead of waiting out the ~90s startup timeout when the address is wrong.
 *
 * Scope (minimal on purpose):
 *   - Confirm the host is reachable on port 8000.
 *   - Confirm SOMETHING Reachy-shaped is answering (a JSON body that exposes
 *     at least one of `state`, `status`, or `version`).
 *   - Capture the daemon version so the caller can decide whether to gate
 *     on `MIN_WIRELESS_DAEMON_VERSION` (`reason: 'too_old'`).
 *
 * Non-goals (intentional):
 *   - We do NOT probe `/api/state/full`. That endpoint only returns 200 once
 *     the daemon has finished initializing, so using it as a shape check would
 *     false-reject daemons in perfectly valid transitional states
 *     (`starting`, `not_initialized`, ...). Readiness is the job of the
 *     startup polling in `useDaemonLifecycle`, not of this pre-flight.
 *   - We do NOT whitelist specific state values. The daemon exposes a fluid
 *     set across versions; the only value we treat as a hard stop here is
 *     `state === 'error'`, which is a definitive "won't work" signal.
 */

const PROBE_TIMEOUT_MS = 2500;

interface DaemonStatusBody {
  state?: unknown;
  status?: unknown;
  version?: unknown;
}

function normalizeHost(host: string): string {
  const trimmed = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  return trimmed.includes(':') ? trimmed : `${trimmed}:8000`;
}

export type WifiProbeReason = 'unreachable' | 'wrong_service' | 'daemon_error' | 'too_old';

export interface WifiProbeResult {
  ok: boolean;
  /** `null` on success. Otherwise a short code for the failure class. */
  reason: null | WifiProbeReason;
  /**
   * Daemon version string as returned by `/api/daemon/status`. Always
   * populated when we got a parseable JSON body back, regardless of `ok`,
   * so that callers handling `too_old` can show "current vX.Y.Z" without
   * a second round-trip.
   */
  version: string | null;
  /**
   * Minimum version required by the desktop app, surfaced here so callers
   * don't have to reach into `constants/daemonVersion` themselves.
   */
  minVersion: string;
}

/**
 * Probe a remote host to confirm it's running a Reachy daemon. Short-timeout,
 * no retries: callers are expected to fail fast and let the user correct the
 * target. Bypasses the local_proxy on purpose - we want to validate the real
 * endpoint, not a cached proxy state.
 */
export async function probeWifiHost(host: string): Promise<WifiProbeResult> {
  const normalized = normalizeHost(host);
  const base = `http://${normalized}`;

  let statusBody: DaemonStatusBody | null = null;
  try {
    const response = await fetchWithTimeout(`${base}/api/daemon/status`, {}, PROBE_TIMEOUT_MS, {
      silent: true,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'wrong_service',
        version: null,
        minVersion: MIN_WIRELESS_DAEMON_VERSION,
      };
    }
    try {
      statusBody = (await response.json()) as DaemonStatusBody;
    } catch {
      // Non-JSON body on /api/daemon/status → definitely not a Reachy daemon.
      return {
        ok: false,
        reason: 'wrong_service',
        version: null,
        minVersion: MIN_WIRELESS_DAEMON_VERSION,
      };
    }
  } catch {
    return {
      ok: false,
      reason: 'unreachable',
      version: null,
      minVersion: MIN_WIRELESS_DAEMON_VERSION,
    };
  }

  if (!statusBody || typeof statusBody !== 'object') {
    return {
      ok: false,
      reason: 'wrong_service',
      version: null,
      minVersion: MIN_WIRELESS_DAEMON_VERSION,
    };
  }

  // Shape gate: require at least one Reachy-typical field. Kept permissive on
  // purpose - the exact field name (`state` vs `status`) and the set of valid
  // state values drift across daemon versions, so we only bail if NONE of the
  // expected fields is present.
  const hasReachyShape = 'state' in statusBody || 'status' in statusBody || 'version' in statusBody;
  if (!hasReachyShape) {
    return {
      ok: false,
      reason: 'wrong_service',
      version: null,
      minVersion: MIN_WIRELESS_DAEMON_VERSION,
    };
  }

  const version = typeof statusBody.version === 'string' ? statusBody.version : null;

  // Only one value is a hard stop: an explicit error state reported by the
  // daemon itself. Everything else is a "maybe not ready yet" that the normal
  // startup polling will resolve.
  if (statusBody.state === 'error' || statusBody.status === 'error') {
    return {
      ok: false,
      reason: 'daemon_error',
      version,
      minVersion: MIN_WIRELESS_DAEMON_VERSION,
    };
  }

  // Version gate: we have a real Reachy daemon answering, but it's older than
  // what this app supports. The caller switches to the forced-update flow
  // instead of trying to connect (which would either crash later on a missing
  // endpoint or behave subtly wrong).
  if (isVersionBelow(version, MIN_WIRELESS_DAEMON_VERSION)) {
    return {
      ok: false,
      reason: 'too_old',
      version,
      minVersion: MIN_WIRELESS_DAEMON_VERSION,
    };
  }

  return {
    ok: true,
    reason: null,
    version,
    minVersion: MIN_WIRELESS_DAEMON_VERSION,
  };
}
