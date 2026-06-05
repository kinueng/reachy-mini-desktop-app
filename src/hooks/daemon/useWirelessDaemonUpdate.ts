/**
 * useWirelessDaemonUpdate
 *
 * Orchestrates the forced wireless-daemon update flow against a remote host:
 *
 *   1. Pre-check: confirm the daemon can talk to PyPI (`GET /update/available`).
 *      If it can't, fail fast with a clear "no internet on the robot" error
 *      rather than starting a download that will time out two minutes later.
 *   2. Trigger:   `POST /update/start` to spawn a background install job.
 *   3. Stream:    open `WS /update/ws/logs?job_id=...` and forward every line
 *                 into the slice's log buffer.
 *   4. Restart:   the daemon ends the update by `systemctl restart`, which
 *                 closes the WS. Poll `/api/daemon/status` until it answers
 *                 again (budget = `RESTART_BUDGET_MS`, ~60s).
 *   5. Verify:    re-read the version from `/api/daemon/status` and confirm
 *                 it's now ≥ `MIN_WIRELESS_DAEMON_VERSION`. If not (PyPI
 *                 itself is stale, install rolled back, ...), surface a clear
 *                 error so the user can retry or cancel.
 *
 * The hook is intentionally not a singleton: it's mounted by the dedicated
 * view, which guarantees a single in-flight job at a time. All cleanup
 * (timers, WebSocket, AbortController) happens on unmount or when the user
 * cancels.
 *
 * Talks to the remote host directly (port 8000). Bypasses the local proxy
 * because at this point we haven't called `connect(WIFI, host)` yet, so
 * the proxy isn't bound to anything.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import useAppStore from '../../store/useAppStore';
import { fetchWithTimeout } from '../../config/daemon';
import { isVersionBelow } from '../../utils/semverCompare';
import { telemetry } from '../../utils/telemetry';
import type { FullAppState } from '../../store/useStore';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

const PRECHECK_TIMEOUT_MS = 8000;
const START_TIMEOUT_MS = 8000;
const STATUS_TIMEOUT_MS = 3000;
/** Budget for the daemon to come back after `systemctl restart`. */
const RESTART_BUDGET_MS = 60_000;
/** How often we poll `/api/daemon/status` while waiting for the restart. */
const RESTART_POLL_INTERVAL_MS = 2000;
/** How long we wait BEFORE the first poll, to let `systemctl` actually stop. */
const RESTART_GRACE_MS = 1500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AvailableResponse {
  update?: {
    reachy_mini?: {
      is_available?: boolean;
      current_version?: string;
      available_version?: string;
    };
  };
}

interface StartResponse {
  job_id?: string;
}

interface StatusResponse {
  state?: string;
  status?: string;
  version?: string;
  [key: string]: unknown;
}

export interface UseWirelessDaemonUpdateResult {
  /**
   * Kick off the full update sequence. Safe to call multiple times: a no-op
   * if a job is already in flight (status !== 'idle' && !== 'error').
   */
  startUpdate: () => Promise<void>;
  /**
   * Pre-check only: ping the daemon to confirm it can reach PyPI. Used by
   * the view to disable the "Update now" button when there's no internet
   * on the robot, without committing to the full flow.
   */
  checkInternet: () => Promise<{ ok: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function normalizeBase(host: string): string {
  const trimmed = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const withPort = trimmed.includes(':') ? trimmed : `${trimmed}:8000`;
  return `http://${withPort}`;
}

function wsBase(host: string): string {
  const trimmed = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const withPort = trimmed.includes(':') ? trimmed : `${trimmed}:8000`;
  return `ws://${withPort}`;
}

export function useWirelessDaemonUpdate(): UseWirelessDaemonUpdateResult {
  const {
    wirelessUpdate,
    setWirelessUpdateStatus,
    setWirelessUpdateJobId,
    appendWirelessUpdateLog,
    setWirelessUpdateError,
    markWirelessUpdateSucceeded,
  } = useAppStore(
    useShallow((state: FullAppState) => ({
      wirelessUpdate: state.wirelessUpdate,
      setWirelessUpdateStatus: state.setWirelessUpdateStatus,
      setWirelessUpdateJobId: state.setWirelessUpdateJobId,
      appendWirelessUpdateLog: state.appendWirelessUpdateLog,
      setWirelessUpdateError: state.setWirelessUpdateError,
      markWirelessUpdateSucceeded: state.markWirelessUpdateSucceeded,
    }))
  );

  // Refs for cleanup. We intentionally keep them outside React state because
  // they don't drive renders and we want unmount to abort cleanly even if
  // the slice has already been reset.
  const wsRef = useRef<WebSocket | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelControllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount: kill the WS, abort any in-flight HTTP, clear timers.
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      cancelControllerRef.current?.abort();
      cancelControllerRef.current = null;
    };
  }, []);

  const checkInternet = useCallback<UseWirelessDaemonUpdateResult['checkInternet']>(async () => {
    const host = wirelessUpdate.targetHost;
    if (!host) return { ok: false, reason: 'no_host' };

    try {
      const response = await fetchWithTimeout(
        `${normalizeBase(host)}/update/available`,
        {},
        PRECHECK_TIMEOUT_MS,
        { silent: true, label: 'Wireless update pre-check' }
      );
      if (!response.ok) {
        return { ok: false, reason: `http_${response.status}` };
      }
      const data = (await response.json()) as AvailableResponse;
      const available = data?.update?.reachy_mini?.available_version;
      // The daemon returns "unknown" for `available_version` when it failed
      // to reach PyPI (caught ConnectionError). Treat that as "no internet".
      if (!available || available === 'unknown') {
        return { ok: false, reason: 'pypi_unreachable' };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: message };
    }
  }, [wirelessUpdate.targetHost]);

  const startUpdate = useCallback<UseWirelessDaemonUpdateResult['startUpdate']>(async () => {
    const state = useAppStore.getState().wirelessUpdate;
    const host = state.targetHost;
    const minVersion = state.minVersion;

    if (!host || !minVersion) {
      setWirelessUpdateError('Missing target host or min version');
      return;
    }
    // Re-entrancy guard: ignore double-clicks while a job is already running.
    if (state.status !== 'idle' && state.status !== 'error') {
      return;
    }

    // Reset transient state before starting a fresh attempt.
    setWirelessUpdateError(null);
    setWirelessUpdateJobId(null);
    setWirelessUpdateStatus('pre-check');

    cancelControllerRef.current?.abort();
    cancelControllerRef.current = new AbortController();
    const signal = cancelControllerRef.current.signal;

    const startedAt = Date.now();
    const fromVersion = state.currentVersion;
    const elapsedSec = (): number => Math.round((Date.now() - startedAt) / 1000);

    telemetry.wirelessUpdateStarted({
      from_version: fromVersion,
      min_version: minVersion,
    });

    // ----- 1. Pre-check ------------------------------------------------------
    const precheck = await checkInternet();
    if (!precheck.ok) {
      const human =
        precheck.reason === 'pypi_unreachable'
          ? "Robot can't reach PyPI. Connect it to a network with Internet, then retry."
          : precheck.reason === 'no_host'
            ? 'No target host - please go back and select a robot.'
            : `Pre-check failed: ${precheck.reason}`;
      setWirelessUpdateError(human);
      telemetry.wirelessUpdateFailed({
        from_version: fromVersion,
        min_version: minVersion,
        error_class: precheck.reason ?? 'precheck_unknown',
        duration_sec: elapsedSec(),
      });
      return;
    }
    if (signal.aborted) return;

    // ----- 2. Trigger update -------------------------------------------------
    setWirelessUpdateStatus('updating');
    let jobId: string | null = null;
    try {
      const response = await fetchWithTimeout(
        `${normalizeBase(host)}/update/start`,
        { method: 'POST', signal },
        START_TIMEOUT_MS,
        { silent: true, label: 'Wireless update start' }
      );
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
      }
      const data = (await response.json()) as StartResponse;
      jobId = typeof data.job_id === 'string' ? data.job_id : null;
      if (!jobId) {
        throw new Error('Daemon did not return a job_id');
      }
      setWirelessUpdateJobId(jobId);
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setWirelessUpdateError(`Could not start the update: ${message}`);
      telemetry.wirelessUpdateFailed({
        from_version: fromVersion,
        min_version: minVersion,
        error_class: 'start_failed',
        duration_sec: elapsedSec(),
      });
      return;
    }

    // ----- 3. Stream logs ----------------------------------------------------
    // The daemon kills the WS when the install completes (which itself ends
    // with `systemctl restart`), so the close event is our cue to move on.
    await new Promise<void>(resolve => {
      const ws = new WebSocket(`${wsBase(host)}/update/ws/logs?job_id=${jobId}`);
      wsRef.current = ws;

      const onAbort = (): void => {
        ws.close();
      };
      signal.addEventListener('abort', onAbort);

      ws.onmessage = (event: MessageEvent<string>) => {
        const line = typeof event.data === 'string' ? event.data : String(event.data);
        appendWirelessUpdateLog(line);
      };
      ws.onerror = () => {
        // Don't fail hard here - the daemon often errors the WS right at
        // restart time. We treat the close event as authoritative.
        appendWirelessUpdateLog('[update] log stream lost (daemon restarting?)');
      };
      ws.onclose = () => {
        signal.removeEventListener('abort', onAbort);
        wsRef.current = null;
        resolve();
      };
    });

    if (signal.aborted) return;

    // ----- 4. Wait for daemon to come back -----------------------------------
    setWirelessUpdateStatus('restarting');
    appendWirelessUpdateLog('[update] daemon restarting, waiting for it to come back...');

    // Give systemctl a moment to actually stop the process before we start
    // polling - otherwise we may catch the dying daemon and think the
    // restart never happened.
    await new Promise<void>(resolve => {
      restartTimerRef.current = setTimeout(resolve, RESTART_GRACE_MS);
    });
    if (signal.aborted) return;

    const restartStart = Date.now();
    let liveStatus: StatusResponse | null = null;
    while (Date.now() - restartStart < RESTART_BUDGET_MS) {
      if (signal.aborted) return;
      try {
        const response = await fetchWithTimeout(
          `${normalizeBase(host)}/api/daemon/status`,
          { signal },
          STATUS_TIMEOUT_MS,
          { silent: true }
        );
        if (response.ok) {
          liveStatus = (await response.json()) as StatusResponse;
          break;
        }
      } catch {
        // Expected during the restart window - swallow and retry.
      }
      await new Promise<void>(resolve => {
        restartTimerRef.current = setTimeout(resolve, RESTART_POLL_INTERVAL_MS);
      });
    }

    if (!liveStatus) {
      setWirelessUpdateError(
        'Daemon did not come back after the update. Reboot the robot manually and try again.'
      );
      telemetry.wirelessUpdateFailed({
        from_version: fromVersion,
        min_version: minVersion,
        error_class: 'restart_timeout',
        duration_sec: elapsedSec(),
      });
      return;
    }
    if (signal.aborted) return;

    // ----- 5. Verify version -------------------------------------------------
    setWirelessUpdateStatus('verifying');
    const newVersion = typeof liveStatus.version === 'string' ? liveStatus.version : null;
    appendWirelessUpdateLog(`[update] daemon is back at v${newVersion ?? 'unknown'}`);

    if (isVersionBelow(newVersion, minVersion)) {
      setWirelessUpdateError(
        `Update finished but the daemon still reports v${newVersion ?? 'unknown'} (need v${minVersion}+). PyPI may not have a fresh enough release yet.`
      );
      telemetry.wirelessUpdateFailed({
        from_version: fromVersion,
        min_version: minVersion,
        error_class: 'still_too_old',
        duration_sec: elapsedSec(),
      });
      return;
    }

    markWirelessUpdateSucceeded();
    telemetry.wirelessUpdateSucceeded({
      from_version: fromVersion,
      to_version: newVersion,
      min_version: minVersion,
      duration_sec: elapsedSec(),
    });
  }, [
    appendWirelessUpdateLog,
    checkInternet,
    markWirelessUpdateSucceeded,
    setWirelessUpdateError,
    setWirelessUpdateJobId,
    setWirelessUpdateStatus,
  ]);

  return { startUpdate, checkInternet };
}
