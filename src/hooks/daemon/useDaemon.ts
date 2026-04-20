import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useShallow } from 'zustand/react/shallow';
import useAppStore from '../../store/useAppStore';
import { useLogger } from '../../utils/logging';
import {
  DAEMON_CONFIG,
  fetchWithTimeout,
  fetchWithTimeoutSkipInstall,
  buildApiUrl,
} from '../../config/daemon';
import { isSimulationMode, disableSimulationMode } from '../../utils/simulationMode';
import {
  findErrorConfig,
  createErrorFromConfig,
  type HardwareErrorConfig,
} from '../../utils/hardwareErrors';
import { useDaemonEventBus } from './useDaemonEventBus';
import { handleDaemonError } from '../../utils/daemonErrorHandler';
import { closeAllAppWindows } from '../../utils/windowManager';
import type { AppState } from '../../types/store';
import type { FullAppState } from '../../store/useStore';

// ─────────────────────────────────────────────────────────────────────────────
// Local types for daemon payloads and event bus events
// (promotable to types/daemon.ts once this hook stabilises)
// ─────────────────────────────────────────────────────────────────────────────

/** Shape of the Tauri `daemon-status-changed` event payload (from Rust). */
interface DaemonStatusChangedPayload {
  current?: string;
  previous?: string;
}

/**
 * Minimal shape of /api/daemon/status responses we care about.
 * The Python daemon may include additional fields (backend_status, version, ...).
 */
interface DaemonStatusResponse {
  state?: 'not_initialized' | 'starting' | 'running' | 'stopped' | 'stopping' | 'error';
  error?: string;
  version?: string;
  [key: string]: unknown;
}

/** Event bus payloads emitted and consumed by this hook. */
interface DaemonHardwareErrorEvent {
  errorConfig: HardwareErrorConfig;
  errorLine: string;
}

interface DaemonCrashEvent {
  status: string;
}

interface DaemonStartSuccessEvent {
  existing?: boolean;
  external?: boolean;
  wifi?: boolean;
  simMode?: boolean;
}

export interface UseDaemonResult {
  isActive: boolean;
  isStarting: boolean;
  isStopping: boolean;
  startupError: AppState['startupError'];
  startDaemon: () => Promise<void>;
  stopDaemon: () => Promise<void>;
  fetchDaemonVersion: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────

type TimeoutId = ReturnType<typeof setTimeout>;
type IntervalId = ReturnType<typeof setInterval>;

export const useDaemon = (): UseDaemonResult => {
  const logger = useLogger();
  const {
    isActive,
    isStarting,
    isStopping,
    startupError,
    transitionTo,
    setDaemonVersion,
    setHardwareError,
    setStartupTimeout,
    clearStartupTimeout,
    resetAll,
  } = useAppStore(
    useShallow((state: FullAppState) => ({
      robotStatus: state.robotStatus,
      isActive: state.isActive,
      isStarting: state.isStarting,
      isStopping: state.isStopping,
      startupError: state.startupError,
      transitionTo: state.transitionTo,
      setDaemonVersion: state.setDaemonVersion,
      setStartupError: state.setStartupError,
      setHardwareError: state.setHardwareError,
      setStartupTimeout: state.setStartupTimeout,
      clearStartupTimeout: state.clearStartupTimeout,
      resetAll: state.resetAll,
    }))
  );

  const eventBus = useDaemonEventBus();

  // Register event handlers (centralized error handling)
  useEffect(() => {
    const unsubStartSuccess = eventBus.on('daemon:start:success', data => {
      const payload = data as DaemonStartSuccessEvent | null;
      if (payload?.simMode) {
        logger.info('Daemon started in simulation mode (mockup-sim)');
      }
    });

    const unsubStartError = eventBus.on('daemon:start:error', error => {
      // `handleDaemonError` accepts `Error | string | object`; the event bus
      // carries `unknown`. The producer-side emit sites below always send one
      // of those types, so this cast is safe in practice.
      handleDaemonError('startup', error as Error | string | object);
      clearStartupTimeout();
    });

    const unsubStartTimeout = eventBus.on('daemon:start:timeout', () => {
      const currentState = useAppStore.getState();
      if (!currentState.isActive && currentState.isStarting) {
        handleDaemonError('timeout', {
          message:
            'Daemon did not become active within 30 seconds. Please check the robot connection.',
        });
      }
    });

    const unsubCrash = eventBus.on('daemon:crash', data => {
      const payload = data as DaemonCrashEvent;
      const currentState = useAppStore.getState();
      if (currentState.isStarting) {
        handleDaemonError(
          'crash',
          {
            message: `Daemon process terminated unexpectedly (status: ${payload.status})`,
          },
          { status: payload.status }
        );
        clearStartupTimeout();
      }
    });

    const unsubHardwareError = eventBus.on('daemon:hardware:error', data => {
      const payload = data as DaemonHardwareErrorEvent;
      const currentState = useAppStore.getState();
      const shouldProcess = currentState.isStarting || currentState.hardwareError;

      if (!shouldProcess) {
        return;
      }

      if (payload.errorConfig) {
        const errorObject = createErrorFromConfig(payload.errorConfig, payload.errorLine);
        setHardwareError(errorObject);
        transitionTo.starting();
        handleDaemonError('hardware', payload.errorLine, { code: payload.errorConfig.code });
      }
    });

    return () => {
      unsubStartSuccess();
      unsubStartError();
      unsubStartTimeout();
      unsubCrash();
      unsubHardwareError();
    };
  }, [eventBus, setHardwareError, transitionTo, clearStartupTimeout, logger]);

  const fetchDaemonVersion = useCallback(async (): Promise<void> => {
    try {
      const response: Response = await fetchWithTimeoutSkipInstall(
        buildApiUrl(DAEMON_CONFIG.ENDPOINTS.DAEMON_STATUS),
        {},
        DAEMON_CONFIG.TIMEOUTS.VERSION,
        { silent: true }
      );
      if (response.ok) {
        const data = (await response.json()) as DaemonStatusResponse;
        setDaemonVersion(data.version || null);
      }
    } catch (error: unknown) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'SkippedError') {
        return;
      }
    }
  }, [setDaemonVersion]);

  // Refs to store unlisten functions (avoid race conditions on cleanup)
  const unlistenDaemonStatusRef = useRef<UnlistenFn | null>(null);
  const unlistenStderrRef = useRef<UnlistenFn | null>(null);
  const unlistenStdoutRef = useRef<UnlistenFn | null>(null);
  const unlistenStderrActivityRef = useRef<UnlistenFn | null>(null);
  const lastActivityResetRef = useRef<number>(0);

  // Listen to Rust-side daemon-status-changed for instant crash detection
  useEffect(() => {
    let isMounted = true;

    const setup = async (): Promise<void> => {
      if (unlistenDaemonStatusRef.current) {
        unlistenDaemonStatusRef.current();
        unlistenDaemonStatusRef.current = null;
      }

      try {
        const unlisten = await listen<DaemonStatusChangedPayload>(
          'daemon-status-changed',
          event => {
            if (!isMounted) return;
            const { current } = event.payload || {};
            if (current === 'Crashed') {
              const currentState = useAppStore.getState();
              if (currentState.isStarting) {
                eventBus.emit('daemon:crash', { status: 'process-terminated' });
                clearStartupTimeout();
              } else if (currentState.isActive) {
                currentState.transitionTo.crashed();
              }
            }
          }
        );

        if (isMounted) {
          unlistenDaemonStatusRef.current = unlisten;
        } else {
          unlisten();
        }
      } catch {
        // Listener setup can fail outside of Tauri; nothing to do.
      }
    };

    setup();

    return () => {
      isMounted = false;
      if (unlistenDaemonStatusRef.current) {
        unlistenDaemonStatusRef.current();
        unlistenDaemonStatusRef.current = null;
      }
    };
  }, [eventBus, clearStartupTimeout]);

  // Listen to sidecar stderr events to detect known hardware errors.
  // Only matches specific patterns from HARDWARE_ERROR_CONFIGS (e.g. "No motors detected",
  // "Camera communication error"). Generic errors (RuntimeError, Exception, etc.) are NOT
  // caught here - they are detected via structured daemon status polling below.
  useEffect(() => {
    let isMounted = true;

    const setupStderrListener = async (): Promise<void> => {
      if (unlistenStderrRef.current) {
        unlistenStderrRef.current();
        unlistenStderrRef.current = null;
      }

      try {
        const unlisten = await listen<unknown>('sidecar-stderr', event => {
          if (!isMounted) return;

          const currentState = useAppStore.getState();
          const shouldProcess = currentState.isStarting || currentState.hardwareError;

          if (!shouldProcess) {
            return;
          }

          const payload = event.payload;
          const errorLine =
            typeof payload === 'string' ? payload : payload != null ? String(payload) : '';

          const errorConfig = findErrorConfig(errorLine);

          if (errorConfig) {
            eventBus.emit('daemon:hardware:error', { errorConfig, errorLine });
          }
        });

        if (isMounted) {
          unlistenStderrRef.current = unlisten;
        } else {
          unlisten();
        }
      } catch {
        // Listener setup can fail outside of Tauri; nothing to do.
      }
    };

    setupStderrListener();

    return () => {
      isMounted = false;
      if (unlistenStderrRef.current) {
        unlistenStderrRef.current();
        unlistenStderrRef.current = null;
      }
    };
  }, [eventBus]);

  // Poll /api/daemon/status during startup to detect daemon-level errors.
  // The Python daemon exposes a structured state machine (DaemonState enum):
  //   not_initialized → starting → running | error
  // When state === "error", the response includes an "error" field with
  // the actual exception message - much more reliable than parsing stderr.
  const daemonStatusPollRef = useRef<IntervalId | null>(null);

  useEffect(() => {
    if (!isStarting) {
      if (daemonStatusPollRef.current) {
        clearInterval(daemonStatusPollRef.current);
        daemonStatusPollRef.current = null;
      }
      return;
    }

    // Wait a few seconds before starting to poll (daemon needs time to start Uvicorn)
    const startDelay: TimeoutId = setTimeout(() => {
      if (!useAppStore.getState().isStarting) return;

      const pollDaemonStatus = async (): Promise<void> => {
        const state = useAppStore.getState();
        if (!state.isStarting || state.isActive) {
          if (daemonStatusPollRef.current) {
            clearInterval(daemonStatusPollRef.current);
            daemonStatusPollRef.current = null;
          }
          return;
        }

        try {
          const response: Response = await fetchWithTimeout(
            buildApiUrl(DAEMON_CONFIG.ENDPOINTS.DAEMON_STATUS),
            {},
            DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK,
            { silent: true }
          );

          if (!response.ok) return;

          const data = (await response.json()) as DaemonStatusResponse;

          if (data.state === 'error' && data.error) {
            // Check if the structured error matches a known hardware error first
            const errorConfig = findErrorConfig(data.error);
            if (errorConfig) {
              eventBus.emit('daemon:hardware:error', {
                errorConfig,
                errorLine: data.error,
              });
            } else {
              // Daemon reported a structured error (e.g. serial port, backend init failure)
              handleDaemonError('startup', { message: data.error });
              clearStartupTimeout();
            }

            if (daemonStatusPollRef.current) {
              clearInterval(daemonStatusPollRef.current);
              daemonStatusPollRef.current = null;
            }
          }
        } catch {
          // Daemon not reachable yet - expected during early startup
        }
      };

      pollDaemonStatus();
      daemonStatusPollRef.current = setInterval(pollDaemonStatus, 2000);
    }, DAEMON_CONFIG.ANIMATIONS.STARTUP_MIN_DELAY || 3000);

    return () => {
      clearTimeout(startDelay);
      if (daemonStatusPollRef.current) {
        clearInterval(daemonStatusPollRef.current);
        daemonStatusPollRef.current = null;
      }
    };
  }, [isStarting, eventBus, clearStartupTimeout]);

  // Listen to sidecar stdout/stderr events to reset timeout when we see activity.
  // Daemon logs go to stderr (Python logging), so we must listen to both.
  useEffect(() => {
    let isMounted = true;

    const resetStartupTimeoutOnActivity = (): void => {
      if (!isMounted) return;

      const currentState = useAppStore.getState();

      if (!currentState.isStarting || currentState.isActive) {
        return;
      }

      const now = Date.now();
      if (now - lastActivityResetRef.current < DAEMON_CONFIG.STARTUP.ACTIVITY_RESET_DELAY) {
        return;
      }
      lastActivityResetRef.current = now;

      clearStartupTimeout();

      const simMode = isSimulationMode();
      const startupTimeout: number = simMode
        ? DAEMON_CONFIG.STARTUP.TIMEOUT_SIMULATION
        : DAEMON_CONFIG.STARTUP.TIMEOUT_NORMAL;

      const newTimeoutId: TimeoutId = setTimeout(() => {
        const state = useAppStore.getState();
        if (!state.isActive && state.isStarting) {
          eventBus.emit('daemon:start:timeout');
        }
      }, startupTimeout);

      setStartupTimeout(newTimeoutId);
    };

    const setupListeners = async (): Promise<void> => {
      // Cleanup previous listeners
      if (unlistenStdoutRef.current) {
        unlistenStdoutRef.current();
        unlistenStdoutRef.current = null;
      }
      if (unlistenStderrActivityRef.current) {
        unlistenStderrActivityRef.current();
        unlistenStderrActivityRef.current = null;
      }

      try {
        const unlistenStdout = await listen('sidecar-stdout', resetStartupTimeoutOnActivity);
        const unlistenStderr = await listen('sidecar-stderr', resetStartupTimeoutOnActivity);

        if (isMounted) {
          unlistenStdoutRef.current = unlistenStdout;
          unlistenStderrActivityRef.current = unlistenStderr;
        } else {
          unlistenStdout();
          unlistenStderr();
        }
      } catch {
        // Listener setup can fail outside of Tauri; nothing to do.
      }
    };

    setupListeners();

    return () => {
      isMounted = false;
      if (unlistenStdoutRef.current) {
        unlistenStdoutRef.current();
        unlistenStdoutRef.current = null;
      }
      if (unlistenStderrActivityRef.current) {
        unlistenStderrActivityRef.current();
        unlistenStderrActivityRef.current = null;
      }
    };
  }, [eventBus, clearStartupTimeout, setStartupTimeout]);

  const startDaemon = useCallback(async (): Promise<void> => {
    const currentConnectionMode = useAppStore.getState().connectionMode;

    // External mode: daemon is already running externally, verify it's alive
    // and initialize if needed.
    if (currentConnectionMode === 'external') {
      eventBus.emit('daemon:start:attempt');

      await new Promise<void>(resolve =>
        setTimeout(resolve, DAEMON_CONFIG.ANIMATIONS.SPINNER_RENDER_DELAY)
      );

      try {
        const statusResponse: Response = await fetchWithTimeout(
          buildApiUrl(DAEMON_CONFIG.ENDPOINTS.DAEMON_STATUS),
          {},
          DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK,
          { label: 'External daemon status check' }
        );

        if (!statusResponse.ok) {
          throw new Error(`External daemon status check failed: ${statusResponse.status}`);
        }

        const statusData = (await statusResponse.json()) as DaemonStatusResponse;

        // Start daemon if it's in a non-active state (same logic as WiFi mode)
        if (
          statusData.state === 'not_initialized' ||
          statusData.state === 'starting' ||
          statusData.state === 'stopped' ||
          statusData.state === 'stopping'
        ) {
          try {
            await fetchWithTimeout(
              buildApiUrl('/api/daemon/start?wake_up=false'),
              { method: 'POST' },
              DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK * 2,
              { label: 'External daemon start' }
            );
          } catch {
            // Request sent, response may be delayed.
          }
        }

        eventBus.emit('daemon:start:success', { existing: true, external: true });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        eventBus.emit('daemon:start:error', new Error(`External daemon error: ${message}`));
        resetAll();
      }
      return;
    }

    // WiFi mode: daemon is remote, initialize it if needed.
    if (currentConnectionMode === 'wifi') {
      eventBus.emit('daemon:start:attempt');

      await new Promise<void>(resolve =>
        setTimeout(resolve, DAEMON_CONFIG.ANIMATIONS.SPINNER_RENDER_DELAY)
      );

      try {
        const statusResponse: Response = await fetchWithTimeout(
          buildApiUrl(DAEMON_CONFIG.ENDPOINTS.DAEMON_STATUS),
          {},
          DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK,
          { label: 'WiFi daemon status check' }
        );

        if (!statusResponse.ok) {
          throw new Error(`Daemon status check failed: ${statusResponse.status}`);
        }

        const statusData = (await statusResponse.json()) as DaemonStatusResponse;

        // Start daemon WITHOUT wake_up - robot stays sleeping
        if (
          statusData.state === 'not_initialized' ||
          statusData.state === 'starting' ||
          statusData.state === 'stopped' ||
          statusData.state === 'stopping'
        ) {
          try {
            await fetchWithTimeout(
              buildApiUrl('/api/daemon/start?wake_up=false'),
              { method: 'POST' },
              DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK * 2,
              { label: 'WiFi daemon start' }
            );
          } catch {
            // Request sent, response may be delayed.
          }
        }

        eventBus.emit('daemon:start:success', { existing: true, wifi: true });
      } catch (e: unknown) {
        // ⚠️ IMPORTANT: Emit error BEFORE resetAll() so telemetry captures the connectionMode
        const message = e instanceof Error ? e.message : String(e);
        eventBus.emit('daemon:start:error', new Error(`WiFi daemon error: ${message}`));

        // 🧹 Clean up the local proxy; otherwise it keeps routing 127.0.0.1:8000
        // to the (unreachable/stale) WiFi host and poisons any subsequent
        // connection attempt (including local sim daemon launches).
        try {
          await invoke('clear_local_proxy_target');
        } catch {
          // Best effort - nothing actionable if this fails.
        }

        resetAll();
      }
      return;
    }

    // USB / Simulation mode
    eventBus.emit('daemon:start:attempt');

    await new Promise<void>(resolve =>
      setTimeout(resolve, DAEMON_CONFIG.ANIMATIONS.SPINNER_RENDER_DELAY)
    );

    try {
      // Check if daemon already running
      try {
        const response: Response = await fetchWithTimeout(
          buildApiUrl(DAEMON_CONFIG.ENDPOINTS.STATE_FULL),
          {},
          DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK,
          { label: 'Check existing daemon' }
        );
        if (response.ok) {
          useAppStore.getState().transitionTo.ready();
          eventBus.emit('daemon:start:success', { existing: true });
          return;
        }
      } catch {
        // No daemon detected, starting new one.
      }

      const simMode = isSimulationMode();
      const { connectionMode } = useAppStore.getState();

      invoke('start_daemon', { simMode, connectionMode })
        .then(() => {
          eventBus.emit('daemon:start:success', { existing: false, simMode });
        })
        .catch((e: unknown) => {
          eventBus.emit('daemon:start:error', e);
        });

      await new Promise<void>(resolve =>
        setTimeout(resolve, DAEMON_CONFIG.ANIMATIONS.BUTTON_SPINNER_DELAY)
      );

      const startupTimeout: number = simMode
        ? DAEMON_CONFIG.STARTUP.TIMEOUT_SIMULATION
        : DAEMON_CONFIG.STARTUP.TIMEOUT_NORMAL;

      const timeoutId: TimeoutId = setTimeout(() => {
        const currentState = useAppStore.getState();
        if (!currentState.isActive && currentState.isStarting) {
          eventBus.emit('daemon:start:timeout');
        }
      }, startupTimeout);
      setStartupTimeout(timeoutId);
    } catch (e: unknown) {
      eventBus.emit('daemon:start:error', e);
    }
  }, [eventBus, setStartupTimeout, resetAll]);

  /**
   * Graceful shutdown: goto_sleep animation → disable motors → kill daemon
   */
  const performGracefulShutdown = useCallback(async (): Promise<void> => {
    try {
      const sleepResponse: Response = await fetchWithTimeout(
        buildApiUrl('/api/move/play/goto_sleep'),
        { method: 'POST' },
        DAEMON_CONFIG.TIMEOUTS.COMMAND,
        { label: 'Goto sleep animation', silent: true }
      );
      const sleepData = (await sleepResponse.json()) as { uuid?: string } | null;
      const moveUuid = sleepData?.uuid;

      // Wait for the sleep animation to finish (fixed timeout fallback)
      const waitMs = moveUuid ? 6000 : 4000;
      await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    } catch {
      // Animation may fail if robot is in a weird state - continue anyway.
      await new Promise<void>(resolve => setTimeout(resolve, 1000));
    }

    try {
      await fetchWithTimeout(
        buildApiUrl('/api/motors/set_mode/disabled'),
        { method: 'POST' },
        DAEMON_CONFIG.TIMEOUTS.COMMAND,
        { label: 'Disable motors', silent: true }
      );
      await new Promise<void>(resolve => setTimeout(resolve, 300));
    } catch {
      // Continue with shutdown even if motor disable fails.
    }
  }, []);

  const stopDaemon = useCallback(async (): Promise<void> => {
    const currentConnectionMode = useAppStore.getState().connectionMode;
    const currentIsAppRunning = useAppStore.getState().isAppRunning;

    transitionTo.stopping();
    clearStartupTimeout();
    disableSimulationMode();

    // Stop any running app and close all app windows
    if (currentIsAppRunning) {
      try {
        await fetchWithTimeout(
          buildApiUrl('/api/apps/stop-current-app'),
          { method: 'POST' },
          DAEMON_CONFIG.TIMEOUTS.APP_STOP,
          { label: 'Stop app before shutdown', silent: true }
        );
      } catch {
        // Continue with shutdown.
      }
    }
    await closeAllAppWindows();
    useAppStore.getState().closeEmbeddedApp();

    // Wait for any daemon goto_target to complete
    await new Promise<void>(resolve => setTimeout(resolve, 500));

    // External mode: sleep + disable motors, but don't stop daemon
    if (currentConnectionMode === 'external') {
      await performGracefulShutdown();
      setTimeout(() => {
        resetAll();
      }, DAEMON_CONFIG.ANIMATIONS.STOP_DAEMON_DELAY);
      return;
    }

    // WiFi mode: sleep + disable motors, then tell daemon to stop (we don't kill it)
    if (currentConnectionMode === 'wifi') {
      await performGracefulShutdown();

      try {
        await fetchWithTimeout(
          buildApiUrl('/api/daemon/stop?goto_sleep=false'),
          { method: 'POST' },
          DAEMON_CONFIG.TIMEOUTS.COMMAND,
          { label: 'Daemon stop' }
        );
      } catch {
        // Continue with reset.
      }

      // Clear the local proxy so discovery doesn't detect a stale forwarded daemon.
      try {
        await invoke('clear_local_proxy_target');
      } catch {
        // Continue with reset.
      }

      setTimeout(() => {
        resetAll();
      }, DAEMON_CONFIG.ANIMATIONS.STOP_DAEMON_DELAY);
      return;
    }

    // USB / Simulation mode: sleep + disable motors + kill daemon process
    try {
      await performGracefulShutdown();

      try {
        await fetchWithTimeout(
          buildApiUrl('/api/daemon/stop?goto_sleep=false'),
          { method: 'POST' },
          DAEMON_CONFIG.TIMEOUTS.COMMAND,
          { label: 'Daemon stop' }
        );
      } catch {
        // Continue with kill.
      }

      await invoke('stop_daemon');

      setTimeout(() => {
        resetAll();
      }, DAEMON_CONFIG.ANIMATIONS.STOP_DAEMON_DELAY);
    } catch {
      resetAll();
    }
  }, [clearStartupTimeout, resetAll, transitionTo, performGracefulShutdown]);

  return {
    isActive,
    isStarting,
    isStopping,
    startupError,
    startDaemon,
    stopDaemon,
    fetchDaemonVersion,
  };
};
