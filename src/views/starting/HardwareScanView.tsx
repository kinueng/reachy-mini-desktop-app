import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import useAppStore from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  HARDWARE_ERROR_CONFIGS,
  getErrorMeshes,
  type HardwareErrorConfig as HardwareErrorConfigBase,
  type MeshLike,
  type RobotRefLike,
} from '../../utils/hardwareErrors';
import { getTotalScanParts, mapMeshToScanPart } from '../../utils/scanParts';
import { useDaemonStartupLogs } from '../../hooks/daemon/useDaemonStartupLogs';
import LogConsoleUntyped from '@components/LogConsole';
import FullscreenOverlayUntyped from '../../components/FullscreenOverlay';
import Viewer3DUntyped from '../../components/viewer3d';
import type React from 'react';

// TODO(ts): FullscreenOverlay/Viewer3D/LogConsole live outside this agent's migration
// scope; cast locally to React.FC shapes that match the runtime call signatures we use.
const FullscreenOverlay = FullscreenOverlayUntyped as unknown as React.FC<{
  open: boolean;
  onClose: () => void;
  children?: React.ReactNode;
  darkMode?: boolean;
  showCloseButton?: boolean;
  centered?: boolean;
}>;
const Viewer3D = Viewer3DUntyped as unknown as React.FC<Record<string, unknown>>;
const LogConsole = LogConsoleUntyped as unknown as React.FC<Record<string, unknown>>;
import { DAEMON_CONFIG, fetchWithTimeout, buildApiUrl } from '../../config/daemon';
import { detectMovementChanges } from '../../utils/movementDetection';
import { useAppFetching, mergeAppsData } from '../active-robot/application-store/hooks';
import { ScanErrorDisplay, ScanStepsIndicator, TipsCarousel } from './components';
import reachyBusteSvg from '../../assets/reachy-buste.svg';
import { calculatePassiveJointsAsync } from '../../utils/kinematics-wasm/useKinematicsWasm';
import type { DaemonStep } from './components/ScanStepsIndicator';
import type { FullAppState } from '../../store/useStore';

type HardwareErrorConfig = HardwareErrorConfigBase;

interface ScanPartInfo {
  family: string;
  part: string;
  [key: string]: unknown;
}

interface ScanProgress {
  current: number;
  total: number;
}

interface TimeoutError {
  type: 'timeout';
  message: string;
  messageParts: {
    text: string;
    bold: string;
    suffix: string;
  };
  details: string;
}

type ConnectionModeLike = 'usb' | 'wifi' | 'simulation' | string | null | undefined;

/**
 * Calculate passive joints via WASM and store them in the Zustand store.
 * @returns true if passive_joints were successfully computed and stored
 */
async function computeAndStorePassiveJoints(
  headJoints: number[],
  headPose: number[]
): Promise<boolean> {
  const joints = (await calculatePassiveJointsAsync(headJoints, headPose)) as number[] | null;
  if (joints && joints.length === 21) {
    const { setRobotStateFull } = useAppStore.getState();
    (setRobotStateFull as (updater: unknown) => void)(
      (prev: { data?: Record<string, unknown> } & Record<string, unknown>) => ({
        ...prev,
        data: { ...(prev.data as Record<string, unknown>), passive_joints: joints },
      })
    );
    return true;
  }
  return false;
}

/**
 * Get connection-specific timeout error messages
 */
const getTimeoutError = (
  connectionMode: ConnectionModeLike,
  timeoutSeconds: number,
  phase: 'daemon' | 'movement'
): TimeoutError => {
  const isWifi = connectionMode === 'wifi';
  const isSim = connectionMode === 'simulation';

  if (phase === 'daemon') {
    if (isWifi) {
      return {
        type: 'timeout',
        message: 'WiFi connection timed out',
        messageParts: {
          text: 'WiFi connection',
          bold: 'timed out',
          suffix: `after ${timeoutSeconds}s`,
        },
        details: 'Make sure Reachy is powered on. You can try restarting Reachy.',
      };
    }
    if (isSim) {
      return {
        type: 'timeout',
        message: 'Simulation daemon timed out',
        messageParts: {
          text: 'Simulation',
          bold: 'not responding',
          suffix: `after ${timeoutSeconds}s`,
        },
        details: 'The daemon may have crashed. Try restarting the app.',
      };
    }
    // USB
    return {
      type: 'timeout',
      message: 'USB connection timed out',
      messageParts: {
        text: 'USB connection',
        bold: 'timed out',
        suffix: `after ${timeoutSeconds}s`,
      },
      details: 'Check the USB cable is properly connected.',
    };
  }

  // Movement phase
  if (isWifi) {
    return {
      type: 'timeout',
      message: 'Robot not responding',
      messageParts: {
        text: 'Robot',
        bold: 'not responding',
        suffix: 'over WiFi',
      },
      details: 'Connection established but no data received. Try restarting Reachy.',
    };
  }
  if (isSim) {
    return {
      type: 'timeout',
      message: 'Simulation not responding',
      messageParts: {
        text: 'Simulation',
        bold: 'stuck',
        suffix: 'waiting for data',
      },
      details: 'The simulated robot is not producing movement data.',
    };
  }
  // USB
  return {
    type: 'timeout',
    message: 'Robot not responding',
    messageParts: {
      text: 'Robot',
      bold: 'not responding',
      suffix: 'over USB',
    },
    details: 'The daemon started but the robot is not sending movement data.',
  };
};

/**
 * Generate text shadow for better readability on transparent backgrounds
 */
const createTextShadow = (bgColor: string): string => {
  const offsets: Array<[number, number]> = [
    [-4, -4],
    [4, -4],
    [-4, 4],
    [4, 4],
    [-3, -3],
    [3, -3],
    [-3, 3],
    [3, 3],
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  return offsets.map(([x, y]) => `${x}px ${y}px 0 ${bgColor}`).join(', ');
};

export interface HardwareScanViewProps {
  startupError?: unknown;
  onScanComplete?: () => void;
  startDaemon?: () => Promise<void> | void;
}

interface MovementState {
  headJoints: number[];
  bodyYaw: number;
  antennas: number[];
  timestamp: number;
  readCount: number;
}

/**
 * Hardware Scan View Component
 * Displays the robot in X-ray mode with a scan effect
 * Shows scan progress and handles hardware errors
 */
function HardwareScanView({
  startupError,
  onScanComplete: onScanCompleteCallback,
  startDaemon,
}: HardwareScanViewProps) {
  const {
    setHardwareError,
    darkMode,
    transitionTo,
    robotStatus,
    setRobotStateFull,
    setShouldStreamRobotState,
    setAvailableApps,
    setInstalledApps,
    setAppsLoading,
    resetAll,
  } = useAppStore(
    useShallow((state: FullAppState) => {
      const s = state as unknown as Record<string, unknown>;
      return {
        setHardwareError: s.setHardwareError,
        darkMode: s.darkMode,
        transitionTo: s.transitionTo,
        robotStatus: s.robotStatus,
        setRobotStateFull: s.setRobotStateFull,
        setShouldStreamRobotState: s.setShouldStreamRobotState,
        setAvailableApps: s.setAvailableApps,
        setInstalledApps: s.setInstalledApps,
        setAppsLoading: s.setAppsLoading,
        resetAll: s.resetAll,
      };
    })
  ) as {
    setHardwareError: (err: unknown) => void;
    darkMode: boolean;
    transitionTo: { ready: () => void; starting: () => void; [key: string]: () => void };
    robotStatus: string;
    setRobotStateFull: (updater: unknown) => void;
    setShouldStreamRobotState: (v: boolean) => void;
    setAvailableApps: (apps: unknown[]) => void;
    setInstalledApps: (apps: unknown[]) => void;
    setAppsLoading: (v: boolean) => void;
    resetAll: () => void;
  };

  // ✅ App fetching hooks for pre-loading apps before transition
  const { fetchAppsFromWebsite, fetchInstalledApps } = useAppFetching();
  const isStarting = robotStatus === 'starting';
  const { logs: startupLogs, lastMessage } = useDaemonStartupLogs(isStarting);
  void lastMessage;
  const totalScanParts = getTotalScanParts(); // Static total from scan parts list
  const [scanProgress, setScanProgress] = useState<ScanProgress>({
    current: 0,
    total: totalScanParts,
  });
  const [currentPart, setCurrentPart] = useState<ScanPartInfo | null>(null);
  void currentPart;
  const [scanError, setScanError] = useState<unknown>(null);
  void setScanError;
  const [errorMesh, setErrorMesh] = useState<unknown>(null);
  const [isRetrying, setIsRetrying] = useState<boolean>(false);
  const [logsExpanded, setLogsExpanded] = useState<boolean>(false);
  const [scanComplete, setScanComplete] = useState<boolean>(false);
  const [waitingForDaemon, setWaitingForDaemon] = useState<boolean>(false);
  const [waitingForMovements, setWaitingForMovements] = useState<boolean>(false);
  const [waitingForWebSocket, setWaitingForWebSocket] = useState<boolean>(false); // 🎯 Wait for WebSocket stable data
  const [waitingForApps, setWaitingForApps] = useState<boolean>(false); // ✅ NEW: Pre-fetch apps state
  const [daemonStep, setDaemonStep] = useState<DaemonStep>('connecting'); // 'connecting' | 'initializing' | 'detecting' | 'syncing' | 'loading_apps'
  const [daemonAttempts, setDaemonAttempts] = useState<number>(0);
  const [movementAttempts, setMovementAttempts] = useState<number>(0);
  const [allMeshes, setAllMeshes] = useState<MeshLike[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0); // ✅ Track elapsed time for progressive messages
  const elapsedSecondsRef = useRef<number>(0); // ✅ Ref for reliable access in callbacks
  const robotRefRef = useRef<RobotRefLike | null>(null);
  const healthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const movementCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null); // ✅ Timer for elapsed time
  const lastMovementStateRef = useRef<MovementState | null>(null); // Track last movement state to detect changes
  const healthCheckStartedRef = useRef<boolean>(false); // Guard against multiple startDaemonHealthCheck calls

  // Bootstrap state (first-run Python environment setup)
  // Start as null (unknown) - don't render Viewer3D until we know
  const [isBootstrapping, setIsBootstrapping] = useState<boolean | null>(null);
  const [bootstrapMessage, setBootstrapMessage] = useState<string>('');
  const bootstrapDecidedRef = useRef<boolean>(false);

  // Listen for bootstrap messages from sidecar stdout
  // Decides whether we're bootstrapping (first [bootstrap] message) or not (any other message)
  // WiFi mode has no local sidecar, so skip bootstrap detection entirely
  useEffect(() => {
    if (!isStarting) return;

    // WiFi mode: no local sidecar, bootstrap doesn't apply
    const currentConnectionMode = (useAppStore.getState() as { connectionMode: ConnectionModeLike })
      .connectionMode;
    if (currentConnectionMode === 'wifi') {
      setIsBootstrapping(false);
      return;
    }

    let isMounted = true;
    let unlistenStdout: (() => void) | null = null;
    let unlistenStderr: (() => void) | null = null;
    bootstrapDecidedRef.current = false;

    const setup = async () => {
      const handleOutput = (msg: string) => {
        if (!isMounted) return;

        if (msg.includes('[bootstrap]')) {
          if (msg.includes('Setup complete')) {
            setIsBootstrapping(false);
            setBootstrapMessage('');
            // Clear any errors accumulated during bootstrap - no hardware
            // communication has happened yet, so these are false positives
            const currentHwError = (useAppStore.getState() as { hardwareError: unknown })
              .hardwareError;
            if (currentHwError) {
              console.warn(
                '[bootstrap] Clearing hardwareError set during bootstrap:',
                currentHwError
              );
            }
            setHardwareError(null);
          } else {
            if (!bootstrapDecidedRef.current) {
              bootstrapDecidedRef.current = true;
            }
            setIsBootstrapping(true);
            // Extract a user-friendly message from the log
            if (msg.includes('Downloading uv')) {
              setBootstrapMessage('Downloading package manager...');
            } else if (msg.includes('Installing Python')) {
              setBootstrapMessage('Installing Python runtime...');
            } else if (msg.includes('Creating .venv')) {
              setBootstrapMessage('Creating virtual environment...');
            } else if (msg.includes('Creating apps_venv')) {
              setBootstrapMessage('Creating apps environment...');
            } else if (msg.includes('Signing')) {
              setBootstrapMessage('Signing binaries...');
            } else if (msg.includes('Pre-warming GStreamer')) {
              setBootstrapMessage('Initializing GStreamer...');
            } else if (msg.includes('Pre-warming reachy_mini')) {
              setBootstrapMessage('Pre-warming Python imports...');
            } else if (msg.includes('Installing')) {
              setBootstrapMessage('Installing reachy-mini...');
            } else {
              setBootstrapMessage('Setting up Python environment...');
            }
          }
        } else if (!bootstrapDecidedRef.current) {
          // First non-bootstrap message means bootstrap was skipped
          bootstrapDecidedRef.current = true;
          setIsBootstrapping(false);
        }
      };

      unlistenStdout = await listen('sidecar-stdout', event => {
        const payload = event.payload as unknown;
        const msg =
          typeof payload === 'string'
            ? payload
            : (payload as { toString?: () => string })?.toString?.() || '';
        handleOutput(msg);
      });
      unlistenStderr = await listen('sidecar-stderr', event => {
        const payload = event.payload as unknown;
        const msg =
          typeof payload === 'string'
            ? payload
            : (payload as { toString?: () => string })?.toString?.() || '';
        handleOutput(msg);
      });
    };

    setup();

    return () => {
      isMounted = false;
      if (unlistenStdout) unlistenStdout();
      if (unlistenStderr) unlistenStderr();
    };
  }, [isStarting]);

  // ✅ Get message thresholds from config
  const { MESSAGE_THRESHOLDS } = DAEMON_CONFIG.HARDWARE_SCAN;

  // ✅ Helper to get progressive message based on elapsed time
  const getProgressiveMessage = useCallback((): string | null => {
    if (elapsedSeconds >= MESSAGE_THRESHOLDS.VERY_LONG) {
      return 'Almost there...';
    }
    if (elapsedSeconds >= MESSAGE_THRESHOLDS.LONG_WAIT) {
      return 'Still working on it';
    }
    if (elapsedSeconds >= MESSAGE_THRESHOLDS.TAKING_TIME) {
      return 'Taking a moment';
    }
    if (elapsedSeconds >= MESSAGE_THRESHOLDS.FIRST_LAUNCH) {
      return 'First launch takes longer';
    }
    return null;
  }, [elapsedSeconds, MESSAGE_THRESHOLDS]);

  // ✅ Helper to clear all intervals (DRY)
  const clearAllIntervals = useCallback(() => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }
    if (movementCheckIntervalRef.current) {
      clearInterval(movementCheckIntervalRef.current);
      movementCheckIntervalRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  // Memoize text shadow based on dark mode
  const textShadow = useMemo<string>(() => {
    const bgColor = darkMode ? 'rgba(26, 26, 26, 0.95)' : 'rgba(253, 252, 250, 0.85)';
    return createTextShadow(bgColor);
  }, [darkMode]);
  void textShadow;

  // Get error configuration from startupError
  const errorConfig = useMemo<HardwareErrorConfig | null>(() => {
    if (!startupError || typeof startupError !== 'object') return null;
    const configs = HARDWARE_ERROR_CONFIGS as unknown as Record<string, HardwareErrorConfig>;
    return (
      configs[
        Object.keys(configs).find(
          key => configs[key].type === (startupError as { type?: string }).type
        ) as string
      ] || null
    );
  }, [startupError]);

  // Find error meshes based on configuration
  useEffect(() => {
    if (!errorConfig || !allMeshes.length) {
      setErrorMesh(null);
      return;
    }

    // Get error meshes using centralized helper
    const meshes = getErrorMeshes(errorConfig, robotRefRef.current, allMeshes);

    // Set first mesh as errorFocusMesh (Viewer3D will handle finding all related meshes)
    if (meshes && meshes.length > 0) {
      setErrorMesh(meshes[0]);
    } else {
      setErrorMesh(null);
    }
  }, [errorConfig, allMeshes]);

  // Callback when meshes are ready
  const handleMeshesReady = useCallback((meshes: MeshLike[]) => {
    setAllMeshes(meshes);
  }, []);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);

    try {
      // Stop daemon first
      await invoke('stop_daemon');
      await new Promise<void>(resolve => setTimeout(resolve, 1000));

      // Reset scan progress and visual states (but NOT hardwareError yet)
      // hardwareError will be reset by startDaemon, and re-set if error persists
      setScanError(null);
      setErrorMesh(null);
      setScanProgress({ current: 0, total: totalScanParts });
      setCurrentPart(null);
      setScanComplete(false);
      setWaitingForDaemon(false);
      setWaitingForMovements(false);
      setWaitingForWebSocket(false); // 🎯 Reset WebSocket waiting state
      setShouldStreamRobotState(false); // 🎯 Stop WebSocket streaming
      setDaemonStep('connecting');
      setDaemonAttempts(0);
      setMovementAttempts(0);
      setElapsedSeconds(0); // ✅ Reset elapsed time
      scannedPartsRef.current.clear(); // Reset scanned parts tracking
      healthCheckStartedRef.current = false; // Allow health check to run again on retry

      // Clear all intervals
      clearAllIntervals();
      lastMovementStateRef.current = null; // Reset movement tracking

      // ✅ CRITICAL: Reset hardwareError before restarting
      // Otherwise transitionTo.ready() will be blocked by the guard that checks hardwareError
      // If the error persists, it will be re-detected by the stderr listener
      setHardwareError(null);

      // If startDaemon is provided, use it instead of reloading
      if (startDaemon) {
        transitionTo.starting();
        await startDaemon();
        // ✅ startDaemon will reset hardwareError, and if error persists,
        // it will be re-detected by sidecar-stderr listener or timeout
        setIsRetrying(false);
      } else {
        // Fallback to reload if startDaemon not available
        window.location.reload();
      }
    } catch {
      setIsRetrying(false);
      // ✅ Keep scan view active - don't reload, let the error be handled by startDaemon
      // startDaemon will set hardwareError if it fails, keeping us in scan view
    }
  }, [
    transitionTo,
    startDaemon,
    clearAllIntervals,
    setShouldStreamRobotState,
    setHardwareError,
    totalScanParts,
  ]);

  /**
   * Check daemon health status AND robot ready state
   * Returns { ready: boolean, hasMovements: boolean }
   * Polls /api/state/full directly (doesn't depend on useRobotState which only polls when isActive=true)
   * ✅ Also updates robotStateFull in store so it's available immediately when transitioning to active view
   */
  const checkDaemonHealth = useCallback(async (): Promise<{
    ready: boolean;
    hasMovements: boolean;
  }> => {
    try {
      // 1. Check daemon responds
      const healthCheck = await fetchWithTimeout(
        buildApiUrl('/api/daemon/status'),
        {},
        DAEMON_CONFIG.TIMEOUTS.STARTUP_CHECK,
        { silent: true }
      );

      if (!healthCheck.ok) {
        return { ready: false, hasMovements: false };
      }

      // 2. Poll /api/state/full directly to check if control_mode is available
      // (useRobotState doesn't poll when isActive=false, so we poll here)
      const stateResponse = await fetchWithTimeout(
        buildApiUrl(
          '/api/state/full?with_control_mode=true&with_head_joints=true&with_body_yaw=true&with_antenna_positions=true'
        ),
        {},
        DAEMON_CONFIG.TIMEOUTS.STATE_FULL,
        { silent: true }
      );

      if (!stateResponse.ok) {
        return { ready: false, hasMovements: false };
      }

      const stateData = (await stateResponse.json()) as {
        control_mode?: unknown;
        head_joints?: number[];
        body_yaw?: number;
        antennas_position?: number[];
        [key: string]: unknown;
      };

      // control_mode must be defined (enabled or disabled, but not undefined)
      if (stateData.control_mode === undefined) {
        return { ready: false, hasMovements: false };
      }

      // ✅ Update robotStateFull in store so it's available immediately when transitioning to active view
      // This prevents the "Connected" state flash when arriving in ActiveRobotView
      setRobotStateFull({
        data: stateData,
        lastUpdate: Date.now(),
        error: null,
      });

      // 3. Check if movements are available (head_joints, body_yaw, antennas)
      const hasMovements =
        stateData.head_joints &&
        Array.isArray(stateData.head_joints) &&
        stateData.head_joints.length === 7 &&
        stateData.body_yaw !== undefined &&
        stateData.antennas_position &&
        Array.isArray(stateData.antennas_position) &&
        stateData.antennas_position.length === 2;

      // 4. Detect if movements are available (robot data is being updated)
      // ✅ ROBUST: Accept if values are changing OR if we have 2+ consecutive valid readings
      // (robot might be static but data stream is active)
      let movementsDetected = false;
      if (hasMovements) {
        const currentState: MovementState = {
          headJoints: stateData.head_joints as number[],
          bodyYaw: stateData.body_yaw as number,
          antennas: stateData.antennas_position as number[],
          timestamp: Date.now(),
          readCount: (lastMovementStateRef.current?.readCount || 0) + 1,
        };

        if (lastMovementStateRef.current) {
          // ✅ Use centralized helper for movement detection
          const changes = detectMovementChanges(
            currentState,
            lastMovementStateRef.current,
            DAEMON_CONFIG.MOVEMENT.TOLERANCE_SMALL
          ) as { anyChanged?: boolean };

          // ✅ Movements detected if:
          // - Any value changed (robot is moving/updating), OR
          // - We have at least 2 consecutive valid readings (data stream is active, robot might be static)
          movementsDetected = Boolean(changes.anyChanged) || currentState.readCount >= 2;
        } else {
          // First reading - store it but don't consider movements detected yet
          lastMovementStateRef.current = currentState;
          movementsDetected = false; // Need at least 2 readings
        }

        // Update last state
        lastMovementStateRef.current = currentState;
      }

      return {
        ready: true,
        hasMovements: Boolean(hasMovements) && movementsDetected,
      };
    } catch (err) {
      return { ready: false, hasMovements: false };
    }
  }, [setRobotStateFull]);

  /**
   * Start polling daemon health after scan completes
   * Waits for: 1) daemon ready with control_mode, 2) movements detected
   * Only proceed to transition when both are valid
   * ✅ If timeout reached, sets startupError instead of continuing
   */
  const startDaemonHealthCheck = useCallback(() => {
    // Clear any existing intervals
    clearAllIntervals();

    setWaitingForDaemon(true);
    setWaitingForMovements(false);
    setDaemonStep('connecting');
    setDaemonAttempts(0);
    setMovementAttempts(0);
    setElapsedSeconds(0); // ✅ Reset elapsed time
    let attemptCount = 0;
    let daemonReady = false;
    let isCheckingHealth = false; // ✅ Guard against overlapping requests

    // ✅ Use centralized config
    const { CHECK_INTERVAL, DAEMON_MAX_ATTEMPTS, MOVEMENT_MAX_ATTEMPTS } =
      DAEMON_CONFIG.HARDWARE_SCAN;
    void DAEMON_MAX_ATTEMPTS;
    void MOVEMENT_MAX_ATTEMPTS;

    // ✅ Start elapsed time counter (updates every second)
    elapsedSecondsRef.current = 0;
    elapsedTimerRef.current = setInterval(() => {
      elapsedSecondsRef.current += 1;
      setElapsedSeconds(elapsedSecondsRef.current);
    }, 1000);

    // Step 1: Wait for daemon to be ready
    const checkHealth = async () => {
      // ✅ Skip if already checking (prevents request pileup on slow WiFi)
      if (isCheckingHealth) {
        return;
      }
      isCheckingHealth = true;

      try {
        attemptCount++;
        setDaemonAttempts(attemptCount);

        const result = await checkDaemonHealth();

        if (result.ready && !daemonReady) {
          // ✅ Daemon is ready AND robot has control_mode
          daemonReady = true;

          // Move directly to healthcheck (detecting movements)
          setWaitingForDaemon(false);
          setWaitingForMovements(true);
          setDaemonStep('detecting');

          // Clear health check interval
          if (healthCheckIntervalRef.current) {
            clearInterval(healthCheckIntervalRef.current);
            healthCheckIntervalRef.current = null;
          }

          // Start checking for movements
          let movementAttemptCount = 0;
          let movementsHandled = false;
          const movementStartTime = elapsedSecondsRef.current;
          const checkMovements = async () => {
            if (movementsHandled) return;
            movementAttemptCount++;
            setMovementAttempts(movementAttemptCount);

            const result = await checkDaemonHealth();

            if (result.hasMovements) {
              movementsHandled = true;
              if (movementCheckIntervalRef.current) {
                clearInterval(movementCheckIntervalRef.current);
                movementCheckIntervalRef.current = null;
              }

              // ✅ Movements detected, now start WebSocket and wait for stable data
              setWaitingForMovements(false);
              setWaitingForWebSocket(true);
              setDaemonStep('syncing');

              // 🎯 Start WebSocket streaming early (before transitioning to ActiveRobotView)
              // This prevents the flicker when arriving in ActiveRobotView
              setShouldStreamRobotState(true);

              // 🎯 Wait for WebSocket to receive stable data AND calculate passive_joints via WASM
              // passive_joints are NOT sent by daemon - they MUST be calculated via WASM before transition
              const WS_STABLE_FRAMES = 3; // Require at least 3 frames
              const WS_CHECK_INTERVAL = 50; // Check every 50ms
              const WS_TIMEOUT = 3000; // 3 seconds max
              const wsStartTime = Date.now();

              const waitForWebSocketAndWasm = async (): Promise<void> => {
                return new Promise<void>(resolve => {
                  const checkWebSocket = async () => {
                    const currentState = useAppStore.getState() as {
                      robotStateFull?: {
                        data?: {
                          dataVersion?: number;
                          head_joints?: number[];
                          head_pose?: number[];
                        };
                      };
                    };
                    const data = currentState.robotStateFull?.data;
                    const dataVersion = data?.dataVersion;
                    const hasHeadJoints =
                      Array.isArray(data?.head_joints) && data.head_joints.length === 7;
                    const hasHeadPose =
                      Array.isArray(data?.head_pose) && data.head_pose.length === 16;
                    const elapsed = Date.now() - wsStartTime;

                    if (
                      dataVersion !== undefined &&
                      dataVersion >= WS_STABLE_FRAMES &&
                      hasHeadJoints &&
                      hasHeadPose
                    ) {
                      try {
                        if (
                          await computeAndStorePassiveJoints(
                            data!.head_joints as number[],
                            data!.head_pose as number[]
                          )
                        ) {
                          resolve();
                          return;
                        }
                      } catch {
                        // Continue - Viewer3D will calculate via WASM
                      }
                    }

                    if (elapsed > WS_TIMEOUT) {
                      if (hasHeadJoints && hasHeadPose) {
                        try {
                          await computeAndStorePassiveJoints(
                            data!.head_joints as number[],
                            data!.head_pose as number[]
                          );
                        } catch {
                          // Proceed without passive_joints - Viewer3D will calculate them
                        }
                      }
                      resolve();
                      return;
                    }

                    setTimeout(checkWebSocket, WS_CHECK_INTERVAL);
                  };
                  checkWebSocket();
                });
              };

              await waitForWebSocketAndWasm();
              setWaitingForWebSocket(false);
              clearAllIntervals();

              // ✅ NEW: Pre-fetch apps before transitioning to ActiveRobotView
              setWaitingForApps(true);
              setDaemonStep('loading_apps');

              try {
                setAppsLoading(true);

                // Fetch apps from website API + installed from daemon (2 requests only!)
                const [websiteResult, installedResult] = await Promise.allSettled([
                  fetchAppsFromWebsite(),
                  fetchInstalledApps(),
                ]);

                const availableAppsFromWebsite =
                  websiteResult.status === 'fulfilled'
                    ? (websiteResult.value as unknown[] | undefined) || []
                    : [];
                const installedAppsFromDaemon =
                  installedResult.status === 'fulfilled'
                    ? (installedResult.value as { apps?: unknown[] } | undefined)?.apps || []
                    : [];

                const { enrichedApps, installedApps: installed } = (
                  mergeAppsData as (
                    available: unknown[],
                    installed: unknown[]
                  ) => { enrichedApps: unknown[]; installedApps: unknown[] }
                )(availableAppsFromWebsite, installedAppsFromDaemon);

                setAvailableApps(enrichedApps);
                setInstalledApps(installed);

                // If website fetch failed, don't cache incomplete data.
                // ActiveRobotView will retry and get the full store catalog.
                if (availableAppsFromWebsite.length === 0 && installedAppsFromDaemon.length > 0) {
                  (
                    useAppStore.getState() as { invalidateAppsCache: () => void }
                  ).invalidateAppsCache();
                }
              } catch {
                // Apps will be fetched again in ActiveRobotView
              } finally {
                setAppsLoading(false);
                // ✅ FIX: Don't reset waitingForApps here - keep it true during the delay
                // Otherwise isTransitioning becomes true and steps flash back to Connect
              }

              // ✅ Give user time to see the completed state before transitioning
              // This makes the progress feel more natural and lets them see "Apps" complete
              await new Promise<void>(resolve => setTimeout(resolve, 1200));

              // ✅ Now reset waitingForApps right before callback (view will unmount anyway)
              setWaitingForApps(false);

              // Now we can safely call the callback
              if (onScanCompleteCallback) {
                onScanCompleteCallback();
              }
              return;
            }

            // ✅ Time-based timeout for movements
            const { MOVEMENT_TIMEOUT_SECONDS } = DAEMON_CONFIG.HARDWARE_SCAN;
            const movementElapsed = elapsedSecondsRef.current - movementStartTime;

            if (movementElapsed >= MOVEMENT_TIMEOUT_SECONDS) {
              const currentConnectionMode = (
                useAppStore.getState() as { connectionMode: ConnectionModeLike }
              ).connectionMode;
              setWaitingForMovements(false);
              clearAllIntervals();

              // Set connection-specific timeout error
              const timeoutError = getTimeoutError(
                currentConnectionMode,
                MOVEMENT_TIMEOUT_SECONDS,
                'movement'
              );
              setHardwareError(timeoutError);
              return;
            }
          };

          // Start checking movements immediately, then every interval
          checkMovements();
          movementCheckIntervalRef.current = setInterval(checkMovements, CHECK_INTERVAL);
          return;
        }

        // ✅ Time-based timeout (more reliable than attempt count with request guards)
        const currentElapsed = elapsedSecondsRef.current;
        const { DAEMON_TIMEOUT_SECONDS } = DAEMON_CONFIG.HARDWARE_SCAN;

        if (currentElapsed >= DAEMON_TIMEOUT_SECONDS && !daemonReady) {
          const currentConnectionMode = (
            useAppStore.getState() as { connectionMode: ConnectionModeLike }
          ).connectionMode;
          setWaitingForDaemon(false);
          clearAllIntervals();

          // Set connection-specific timeout error
          const timeoutError = getTimeoutError(
            currentConnectionMode,
            DAEMON_TIMEOUT_SECONDS,
            'daemon'
          );
          setHardwareError(timeoutError);
          return;
        }
      } finally {
        isCheckingHealth = false;
      }
    };

    // Start checking immediately, then every interval
    checkHealth();
    healthCheckIntervalRef.current = setInterval(checkHealth, CHECK_INTERVAL);
  }, [
    checkDaemonHealth,
    onScanCompleteCallback,
    clearAllIntervals,
    setHardwareError,
    setShouldStreamRobotState, // 🎯 Start WebSocket early
    fetchAppsFromWebsite,
    fetchInstalledApps,
    setAvailableApps,
    setInstalledApps,
    setAppsLoading,
  ]);

  const handleScanComplete = useCallback(() => {
    // Guard: only start health check flow once (ScanEffect can fire onComplete multiple times)
    if (healthCheckStartedRef.current) return;

    const currentState = useAppStore.getState() as { hardwareError?: unknown };
    if (
      currentState.hardwareError ||
      (startupError &&
        typeof startupError === 'object' &&
        (startupError as { type?: unknown }).type)
    ) {
      return;
    }

    healthCheckStartedRef.current = true;
    setScanProgress(prev => ({ ...prev, current: prev.total }));
    setCurrentPart(null);
    setScanComplete(true);

    startDaemonHealthCheck();
  }, [startupError, startDaemonHealthCheck]);

  // Track which parts have been scanned to calculate progress
  const scannedPartsRef = useRef<Set<string>>(new Set<string>());
  const totalMeshesRef = useRef<number>(0);
  const lastProgressRef = useRef<ScanProgress>({ current: 0, total: 0 });
  const lastPartRef = useRef<ScanPartInfo | null>(null);
  const meshPartCacheRef = useRef<WeakMap<object, ScanPartInfo>>(new WeakMap()); // Cache mesh -> part mapping

  const handleScanMesh = useCallback(
    (mesh: object, index: number, total: number) => {
      // Store total meshes count
      totalMeshesRef.current = total;

      // ✅ Cache mesh-to-part mapping to avoid recalculating
      let partInfo = meshPartCacheRef.current.get(mesh);
      if (!partInfo) {
        partInfo = mapMeshToScanPart(mesh) as ScanPartInfo | undefined;
        if (partInfo) {
          meshPartCacheRef.current.set(mesh, partInfo);
        }
      }

      if (partInfo) {
        // Create a unique key for this part
        const partKey = `${partInfo.family}:${partInfo.part}`;

        // Track if this is a new part
        if (!scannedPartsRef.current.has(partKey)) {
          scannedPartsRef.current.add(partKey);
        }

        // ✅ Only update currentPart if it changed (avoid unnecessary re-renders)
        if (
          !lastPartRef.current ||
          lastPartRef.current.family !== partInfo.family ||
          lastPartRef.current.part !== partInfo.part
        ) {
          setCurrentPart(partInfo);
          lastPartRef.current = partInfo;
        }
      }

      // ✅ Only update progress if it actually changed (throttle updates)
      const newProgress: ScanProgress = { current: index, total: total };
      if (
        lastProgressRef.current.current !== newProgress.current ||
        lastProgressRef.current.total !== newProgress.total
      ) {
        setScanProgress(newProgress);
        lastProgressRef.current = newProgress;
      }
    },
    [totalScanParts]
  );

  // Initialize first part when scan starts
  useEffect(() => {
    const showScan = !startupError && !scanError && !scanComplete;

    if (showScan && scannedPartsRef.current.size === 0) {
      // Show initializing message until first mesh is scanned
      setCurrentPart(null);
    }
  }, [scanComplete, startupError, scanError]);

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      clearAllIntervals();
      lastMovementStateRef.current = null;
    };
  }, [clearAllIntervals]);

  return (
    <Box
      sx={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        px: 4,
        gap: 1.5,
        bgcolor: 'transparent',
        position: 'relative', // For absolute positioning of logs
      }}
    >
      {isBootstrapping !== false ? (
        /* Bootstrap overlay (or waiting to decide): shown during first-run Python environment setup */
        <Box
          sx={{
            width: '100%',
            maxWidth: '300px',
            height: '320px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
          }}
        >
          <Box
            component="img"
            src={reachyBusteSvg}
            alt="Reachy Mini"
            sx={{
              width: 80,
              height: 'auto',
              opacity: darkMode ? 0.7 : 0.5,
              mb: 1,
            }}
          />
          {isBootstrapping === true ? (
            <Box sx={{ textAlign: 'center' }}>
              <Typography
                sx={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: darkMode ? '#f5f5f5' : '#333',
                  mb: 0.5,
                  letterSpacing: '-0.3px',
                }}
              >
                Setting things up
              </Typography>
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: 400,
                  color: darkMode ? '#999' : '#666',
                  mb: 0.5,
                }}
              >
                {bootstrapMessage || 'Preparing environment...'}
              </Typography>
              <Typography
                sx={{
                  fontSize: 11,
                  fontWeight: 400,
                  color: darkMode ? '#555' : '#aaa',
                  fontStyle: 'italic',
                }}
              >
                This only happens once
              </Typography>
              <TipsCarousel darkMode={darkMode} interval={5000} />
            </Box>
          ) : (
            <CircularProgress size={24} thickness={3} sx={{ color: darkMode ? '#555' : '#bbb' }} />
          )}
        </Box>
      ) : (
        <Box
          sx={{
            width: '100%',
            maxWidth: '300px', // Reduced by 1/3: 450px * 2/3 = 300px
            position: 'relative',
            bgcolor: 'transparent',
          }}
        >
          <Box
            sx={{
              width: '100%',
              height: '320px', // Reduced by 1/3: 480px * 2/3 = 320px
              position: 'relative',
              bgcolor: 'transparent',
            }}
          >
            <Viewer3D
              key="hardware-scan"
              isActive={false}
              antennas={[-10, -10]}
              headPose={null}
              headJoints={null}
              yawBody={null}
              initialMode="xray"
              hideControls={true}
              forceLoad={true}
              hideGrid={true}
              hideBorder={true}
              showScanEffect={!startupError && !scanError}
              usePremiumScan={false}
              onScanComplete={handleScanComplete}
              onScanMesh={handleScanMesh}
              onMeshesReady={handleMeshesReady}
              cameraPreset={errorConfig?.cameraPreset || 'scan'}
              useCinematicCamera={true}
              errorFocusMesh={errorMesh}
              backgroundColor="transparent"
              canvasScale={0.9}
              canvasTranslateX="5%"
              canvasTranslateY="10%"
            />
          </Box>
        </Box>
      )}

      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          width: '100%',
          maxWidth: '450px',
          height: '100px', // Fixed height to prevent vertical shifts between states
        }}
      >
        {!isBootstrapping && (startupError || scanError) ? (
          <ScanErrorDisplay
            error={startupError as never}
            scanError={scanError as never}
            isRetrying={isRetrying}
            onRetry={handleRetry}
            onBack={resetAll}
            darkMode={darkMode}
          />
        ) : isBootstrapping ? null : (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
              py: 0.5,
              width: '100%',
              maxWidth: '340px',
              minHeight: '90px',
              px: 1,
            }}
          >
            {/* Steps with integrated progress bar */}
            <ScanStepsIndicator
              scanComplete={scanComplete}
              waitingForDaemon={waitingForDaemon}
              waitingForMovements={waitingForMovements}
              waitingForWebSocket={waitingForWebSocket}
              waitingForApps={waitingForApps}
              daemonStep={daemonStep}
              darkMode={darkMode}
              scanProgress={scanProgress as unknown as number}
              daemonAttempts={daemonAttempts}
              movementAttempts={movementAttempts}
            />

            {/* Tips carousel */}
            <TipsCarousel darkMode={darkMode} interval={5000} />

            {/* Progressive message for long waits */}
            {(waitingForDaemon || waitingForMovements || waitingForWebSocket) &&
              getProgressiveMessage() && (
                <Typography
                  sx={{
                    fontSize: 10,
                    fontWeight: 400,
                    color: darkMode ? '#555' : '#aaa',
                    mt: 1,
                    fontStyle: 'italic',
                    textAlign: 'center',
                  }}
                >
                  {getProgressiveMessage()}
                </Typography>
              )}
          </Box>
        )}
      </Box>

      {/* ✅ Daemon startup logs - fixed at the bottom, always visible with final height */}
      <Box
        sx={{
          position: 'fixed',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'calc(100% - 32px)',
          maxWidth: '420px',
          zIndex: 1000,
          opacity: isBootstrapping ? 0.8 : 0.2, // More visible during bootstrap
          transition: 'opacity 0.3s ease-in-out',
          '&:hover': {
            opacity: 1, // Full opacity on hover
          },
        }}
      >
        <LogConsole
          logs={startupLogs}
          darkMode={darkMode}
          includeStoreLogs={true}
          compact={true}
          showTimestamp={false}
          lines={4}
          emptyMessage="Waiting for logs..."
          onExpand={() => setLogsExpanded(true)}
          sx={{
            bgcolor: darkMode ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.7)',
            border: `1px solid ${darkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)'}`,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        />
      </Box>

      {/* Fullscreen logs overlay */}
      <FullscreenOverlay
        open={logsExpanded}
        onClose={() => setLogsExpanded(false)}
        darkMode={darkMode}
        showCloseButton={true}
        centered={false}
      >
        <Box
          sx={{
            width: '100%',
            height: '85vh',
            px: 3,
            pb: 3,
            pt: '72px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <Typography
            sx={{
              fontSize: 12,
              fontWeight: 600,
              color: darkMode ? '#888' : '#999',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              flexShrink: 0,
            }}
          >
            Logs
          </Typography>
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <LogConsole
              logs={startupLogs}
              darkMode={darkMode}
              includeStoreLogs={true}
              compact={false}
              showTimestamp={true}
              height="100%"
              emptyMessage="No logs yet..."
            />
          </Box>
        </Box>
      </FullscreenOverlay>
    </Box>
  );
}

export default HardwareScanView;
