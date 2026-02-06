import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import Viewer3D from '../../components/viewer3d';
import useAppStore from '../../store/useAppStore';
import { invoke } from '@tauri-apps/api/core';
import { HARDWARE_ERROR_CONFIGS, getErrorMeshes } from '../../utils/hardwareErrors';
import { getTotalScanParts, mapMeshToScanPart } from '../../utils/scanParts';
import { useDaemonStartupLogs } from '../../hooks/daemon/useDaemonStartupLogs';
import LogConsole from '@components/LogConsole';
import { DAEMON_CONFIG, fetchWithTimeout, buildApiUrl } from '../../config/daemon';
import { detectMovementChanges } from '../../utils/movementDetection';
import { useAppFetching } from '../active-robot/application-store/hooks';
import { ScanErrorDisplay, ScanStepsIndicator, TipsCarousel } from './components';
import { calculatePassiveJointsAsync } from '../../utils/kinematics-wasm/useKinematicsWasm';

/**
 * Get connection-specific timeout error messages
 * @param {string} connectionMode - 'usb' | 'wifi' | 'simulation'
 * @param {number} timeoutSeconds - timeout duration
 * @param {'daemon' | 'movement'} phase - which phase timed out
 */
const getTimeoutError = (connectionMode, timeoutSeconds, phase) => {
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
const createTextShadow = bgColor => {
  const offsets = [
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

/**
 * Hardware Scan View Component
 * Displays the robot in X-ray mode with a scan effect
 * Shows scan progress and handles hardware errors
 */
function HardwareScanView({ startupError, onScanComplete: onScanCompleteCallback, startDaemon }) {
  const {
    setHardwareError,
    darkMode,
    transitionTo,
    robotStatus,
    setRobotStateFull,
    robotStateFull, // 🎯 For checking WebSocket dataVersion
    setShouldStreamRobotState, // 🎯 Start WebSocket early
    setAvailableApps,
    setInstalledApps,
    setAppsLoading,
    resetAll,
  } = useAppStore();

  // ✅ App fetching hooks for pre-loading apps before transition
  const { fetchAppsFromWebsite, fetchInstalledApps } = useAppFetching();
  const isStarting = robotStatus === 'starting';
  const {
    logs: startupLogs,
    hasError: hasStartupError,
    lastMessage,
  } = useDaemonStartupLogs(isStarting);
  const totalScanParts = getTotalScanParts(); // Static total from scan parts list
  const [scanProgress, setScanProgress] = useState({ current: 0, total: totalScanParts });
  const [currentPart, setCurrentPart] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [errorMesh, setErrorMesh] = useState(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);
  const [waitingForDaemon, setWaitingForDaemon] = useState(false);
  const [waitingForMovements, setWaitingForMovements] = useState(false);
  const [waitingForWebSocket, setWaitingForWebSocket] = useState(false); // 🎯 Wait for WebSocket stable data
  const [waitingForApps, setWaitingForApps] = useState(false); // ✅ NEW: Pre-fetch apps state
  const [daemonStep, setDaemonStep] = useState('connecting'); // 'connecting' | 'initializing' | 'detecting' | 'syncing' | 'loading_apps'
  const [daemonAttempts, setDaemonAttempts] = useState(0);
  const [movementAttempts, setMovementAttempts] = useState(0);
  const [allMeshes, setAllMeshes] = useState([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0); // ✅ Track elapsed time for progressive messages
  const elapsedSecondsRef = useRef(0); // ✅ Ref for reliable access in callbacks
  const robotRefRef = useRef(null);
  const healthCheckIntervalRef = useRef(null);
  const movementCheckIntervalRef = useRef(null);
  const elapsedTimerRef = useRef(null); // ✅ Timer for elapsed time
  const lastMovementStateRef = useRef(null); // Track last movement state to detect changes

  // ✅ Get message thresholds from config
  const { MESSAGE_THRESHOLDS } = DAEMON_CONFIG.HARDWARE_SCAN;

  // ✅ Helper to get progressive message based on elapsed time
  const getProgressiveMessage = useCallback(() => {
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
  const textShadow = useMemo(() => {
    const bgColor = darkMode ? 'rgba(26, 26, 26, 0.95)' : 'rgba(253, 252, 250, 0.85)';
    return createTextShadow(bgColor);
  }, [darkMode]);

  // Get error configuration from startupError
  const errorConfig = useMemo(() => {
    if (!startupError || typeof startupError !== 'object') return null;
    return (
      HARDWARE_ERROR_CONFIGS[
        Object.keys(HARDWARE_ERROR_CONFIGS).find(
          key => HARDWARE_ERROR_CONFIGS[key].type === startupError.type
        )
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
  const handleMeshesReady = useCallback(meshes => {
    setAllMeshes(meshes);
  }, []);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);

    try {
      // Stop daemon first
      await invoke('stop_daemon');
      await new Promise(resolve => setTimeout(resolve, 1000));

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
    } catch (err) {
      console.error('Failed to retry:', err);
      setIsRetrying(false);
      // ✅ Keep scan view active - don't reload, let the error be handled by startDaemon
      // startDaemon will set hardwareError if it fails, keeping us in scan view
    }
  }, [transitionTo, startDaemon, clearAllIntervals, setShouldStreamRobotState]);

  /**
   * Check daemon health status AND robot ready state
   * Returns { ready: boolean, hasMovements: boolean }
   * Polls /api/state/full directly (doesn't depend on useRobotState which only polls when isActive=true)
   * ✅ Also updates robotStateFull in store so it's available immediately when transitioning to active view
   */
  const checkDaemonHealth = useCallback(async () => {
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

      const stateData = await stateResponse.json();

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
        const currentState = {
          headJoints: stateData.head_joints,
          bodyYaw: stateData.body_yaw,
          antennas: stateData.antennas_position,
          timestamp: Date.now(),
          readCount: (lastMovementStateRef.current?.readCount || 0) + 1,
        };

        if (lastMovementStateRef.current) {
          // ✅ Use centralized helper for movement detection
          const changes = detectMovementChanges(
            currentState,
            lastMovementStateRef.current,
            DAEMON_CONFIG.MOVEMENT.TOLERANCE_SMALL
          );

          // ✅ Movements detected if:
          // - Any value changed (robot is moving/updating), OR
          // - We have at least 2 consecutive valid readings (data stream is active, robot might be static)
          movementsDetected = changes.anyChanged || currentState.readCount >= 2;
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
        hasMovements: hasMovements && movementsDetected,
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
          const movementStartTime = elapsedSecondsRef.current;
          const checkMovements = async () => {
            movementAttemptCount++;
            setMovementAttempts(movementAttemptCount);

            const result = await checkDaemonHealth();

            if (result.hasMovements) {
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

              console.log(
                '[HardwareScanView] 🔄 Waiting for WebSocket stable data + WASM passive joints...'
              );

              const waitForWebSocketAndWasm = async () => {
                return new Promise(resolve => {
                  const checkWebSocket = async () => {
                    const currentState = useAppStore.getState();
                    const data = currentState.robotStateFull?.data;
                    const dataVersion = data?.dataVersion;
                    const hasHeadJoints =
                      Array.isArray(data?.head_joints) && data.head_joints.length === 7;
                    const hasHeadPose =
                      Array.isArray(data?.head_pose) && data.head_pose.length === 16;

                    // Debug log every 500ms
                    const elapsed = Date.now() - wsStartTime;
                    if (elapsed % 500 < WS_CHECK_INTERVAL) {
                      console.log(
                        `[HardwareScanView] ⏳ Check: dataVersion=${dataVersion}, hasHeadJoints=${hasHeadJoints}, hasHeadPose=${hasHeadPose}`
                      );
                    }

                    // Require dataVersion >= 3 AND head_joints AND head_pose
                    if (dataVersion >= WS_STABLE_FRAMES && hasHeadJoints && hasHeadPose) {
                      // 🦀 Calculate passive_joints via WASM
                      console.log('[HardwareScanView] 🦀 Calculating passive joints via WASM...');
                      try {
                        const passiveJoints = await calculatePassiveJointsAsync(
                          data.head_joints,
                          data.head_pose
                        );

                        if (passiveJoints && passiveJoints.length === 21) {
                          // Store passive_joints in the store so Viewer3D can use them immediately
                          const { setRobotStateFull } = useAppStore.getState();
                          setRobotStateFull(prev => ({
                            ...prev,
                            data: {
                              ...prev.data,
                              passive_joints: passiveJoints,
                            },
                          }));

                          console.log(
                            `[HardwareScanView] ✅ Ready! (dataVersion=${dataVersion}, passive_joints=${passiveJoints.length})`
                          );
                          resolve();
                          return;
                        }
                      } catch (wasmErr) {
                        console.warn('[HardwareScanView] ⚠️ WASM error:', wasmErr.message);
                        // Continue anyway - Viewer3D will calculate via WASM
                      }
                    }

                    if (elapsed > WS_TIMEOUT) {
                      console.warn(
                        `[HardwareScanView] ⚠️ Timeout after ${WS_TIMEOUT}ms, proceeding anyway`
                      );
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

                // Extract results
                const availableAppsFromWebsite =
                  websiteResult.status === 'fulfilled' ? websiteResult.value || [] : [];
                const installedAppsFromDaemon =
                  installedResult.status === 'fulfilled' ? installedResult.value?.apps || [] : [];

                // Create lookup for installed apps
                const installedAppNames = new Set(
                  installedAppsFromDaemon.map(app => app.name?.toLowerCase()).filter(Boolean)
                );
                const installedAppsMap = new Map(
                  installedAppsFromDaemon.map(app => [app.name?.toLowerCase(), app])
                );

                // Add local-only installed apps
                const availableAppNames = new Set(
                  availableAppsFromWebsite.map(app => app.name?.toLowerCase())
                );
                const localOnlyApps = installedAppsFromDaemon
                  .filter(app => !availableAppNames.has(app.name?.toLowerCase()))
                  .map(app => ({
                    ...app,
                    source_kind: app.source_kind || 'local',
                    isOfficial: false,
                  }));

                const allApps = [...availableAppsFromWebsite, ...localOnlyApps];

                // Mark installed apps and merge custom_app_url
                const enrichedApps = allApps.map(app => {
                  const appNameLower = app.name?.toLowerCase();
                  const isInstalled = installedAppNames.has(appNameLower);
                  const installedAppData = installedAppsMap.get(appNameLower);

                  return {
                    ...app,
                    isInstalled,
                    ...(isInstalled &&
                      installedAppData?.extra?.custom_app_url && {
                        extra: {
                          ...app.extra,
                          custom_app_url: installedAppData.extra.custom_app_url,
                        },
                      }),
                  };
                });

                // Build installed apps list
                const installed = enrichedApps.filter(app => app.isInstalled);

                // Store in global store (will be used immediately by ActiveRobotView)
                setAvailableApps(enrichedApps);
                setInstalledApps(installed);
              } catch (err) {
                console.warn(
                  '⚠️ Failed to pre-fetch apps (will retry in ActiveRobotView):',
                  err.message
                );
              } finally {
                setAppsLoading(false);
                // ✅ FIX: Don't reset waitingForApps here - keep it true during the delay
                // Otherwise isTransitioning becomes true and steps flash back to Connect
              }

              // ✅ Give user time to see the completed state before transitioning
              // This makes the progress feel more natural and lets them see "Apps" complete
              await new Promise(resolve => setTimeout(resolve, 1200));

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
              const currentConnectionMode = useAppStore.getState().connectionMode;
              console.error(
                `❌ Movement check timeout after ${movementElapsed}s (limit: ${MOVEMENT_TIMEOUT_SECONDS}s, mode: ${currentConnectionMode})`
              );
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
          const currentConnectionMode = useAppStore.getState().connectionMode;
          console.error(
            `❌ Daemon healthcheck timeout after ${currentElapsed}s (limit: ${DAEMON_TIMEOUT_SECONDS}s, mode: ${currentConnectionMode})`
          );
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
    // ✅ Don't mark scan as complete if there's an error - stay in error state
    const currentState = useAppStore.getState();
    if (
      currentState.hardwareError ||
      (startupError && typeof startupError === 'object' && startupError.type)
    ) {
      console.warn(
        '[HardwareScanView] ⚠️ Scan visual completed but error detected, not completing scan'
      );
      return; // Don't complete scan, stay in error state
    }

    setScanProgress(prev => ({ ...prev, current: prev.total }));
    setCurrentPart(null);
    setScanComplete(true);

    // ✅ NEW: Wait for daemon healthcheck before proceeding
    // This ensures daemon is ready before fetching apps
    startDaemonHealthCheck();
  }, [startupError, startDaemonHealthCheck]);

  // Track which parts have been scanned to calculate progress
  const scannedPartsRef = useRef(new Set());
  const totalMeshesRef = useRef(0);
  const lastProgressRef = useRef({ current: 0, total: 0 });
  const lastPartRef = useRef(null);
  const meshPartCacheRef = useRef(new WeakMap()); // Cache mesh -> part mapping

  const handleScanMesh = useCallback(
    (mesh, index, total) => {
      // Store total meshes count
      totalMeshesRef.current = total;

      // ✅ Cache mesh-to-part mapping to avoid recalculating
      let partInfo = meshPartCacheRef.current.get(mesh);
      if (!partInfo) {
        partInfo = mapMeshToScanPart(mesh);
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
      const newProgress = { current: index, total: total };
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
        {startupError || scanError ? (
          <ScanErrorDisplay
            error={startupError}
            scanError={scanError}
            isRetrying={isRetrying}
            onRetry={handleRetry}
            onBack={resetAll}
            darkMode={darkMode}
          />
        ) : (
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
              scanProgress={scanProgress}
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

      {/* ✅ Daemon startup logs - fixed at the bottom, visible, scrollable */}
      {/* Always show logs if available, even if not starting (error state) */}
      {startupLogs.length > 0 && (
        <Box
          sx={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'calc(100% - 32px)',
            maxWidth: '420px',
            zIndex: 1000,
            opacity: 0.2, // Very subtle by default
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
            lines={3}
            sx={{
              bgcolor: darkMode ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.7)',
              border: `1px solid ${darkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)'}`,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          />
        </Box>
      )}
    </Box>
  );
}

export default HardwareScanView;
