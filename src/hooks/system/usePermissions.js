import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isMacOS } from '../../utils/platform';

/**
 * Check if we're running in E2E/automation mode
 * This bypasses permission checks as CI runners can't grant macOS permissions
 */
function isE2EMode() {
  // Check navigator.webdriver (set by some WebDrivers, but not CrabNebula)
  if (typeof navigator !== 'undefined' && navigator.webdriver) {
    console.log('[usePermissions] 🤖 E2E mode detected (navigator.webdriver)');
    return true;
  }
  // Check for CI environment variable (passed via Vite at build time)
  if (import.meta.env.VITE_E2E_MODE === 'true' || import.meta.env.VITE_CI === 'true') {
    console.log('[usePermissions] 🤖 E2E mode detected (env variable)');
    return true;
  }
  // Check localStorage flag (can be set by E2E tests)
  if (typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('__E2E_MODE__') === 'true') {
        console.log('[usePermissions] 🤖 E2E mode detected (localStorage)');
        return true;
      }
    } catch (e) {
      // localStorage might not be available
    }
  }
  // Check window flag (can be set by E2E tests)
  if (typeof window !== 'undefined' && window.__E2E_MODE__ === true) {
    console.log('[usePermissions] 🤖 E2E mode detected (window.__E2E_MODE__)');
    return true;
  }
  return false;
}

/**
 * Hook to check macOS permissions (camera, microphone, local network)
 * Uses tauri-plugin-macos-permissions plugin for camera/microphone
 * Uses custom Rust command for local network (macOS Sequoia+)
 * Checks periodically and returns the current status
 * Exposes a manual refresh function for immediate checks
 *
 * On non-macOS platforms (Windows, Linux), permissions are automatically granted
 * as these platforms handle permissions at the browser/webview level.
 *
 * In E2E mode (WebDriver), permissions are bypassed as CI runners can't grant them.
 *
 * Uses a version counter to prevent race conditions where stale
 * API responses could overwrite more recent permission states.
 */
export function usePermissions({ checkInterval = 2000 } = {}) {
  const isMac = isMacOS();
  const isE2E = isE2EMode();

  // In E2E mode, bypass permission checks (auto-grant all)
  const shouldBypassPermissions = isE2E;
  // Auto-grant on non-macOS OR in E2E mode
  const autoGrant = !isMac || shouldBypassPermissions;
  const [cameraGranted, setCameraGranted] = useState(autoGrant);
  const [microphoneGranted, setMicrophoneGranted] = useState(autoGrant);
  const [localNetworkGranted, setLocalNetworkGranted] = useState(autoGrant);
  const [isChecking, setIsChecking] = useState(!autoGrant); // Only check on macOS (non-E2E)
  const [hasChecked, setHasChecked] = useState(autoGrant); // Already "checked" on non-macOS or E2E

  // Race condition protection: track the current check version
  const checkVersionRef = useRef(0);
  const mountedRef = useRef(true);

  // Track previous state to only log changes
  const previousStateRef = useRef({ camera: null, microphone: null, localNetwork: null });

  const checkPermissions = useCallback(async () => {
    // Skip permission checks on non-macOS platforms or in E2E mode
    if (!isMac || shouldBypassPermissions || !mountedRef.current) {
      return;
    }

    // Increment version for this check - any older pending checks become stale
    const currentVersion = ++checkVersionRef.current;

    try {
      setIsChecking(true);

      // Use tauri-plugin-macos-permissions plugin for camera/microphone
      const cameraStatus = await invoke('plugin:macos-permissions|check_camera_permission');

      // 🔒 Check if this response is stale (a newer check was launched)
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      const micStatus = await invoke('plugin:macos-permissions|check_microphone_permission');

      // 🔒 Check again after mic check (another check could have started)
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      // Check local network permission (macOS Sequoia+)
      // Returns: true (granted), false (denied), null (unknown/pending)
      let localNetworkStatus = true; // Default to true for pre-Sequoia
      try {
        const result = await invoke('check_local_network_permission');
        // result is Option<bool>: true, false, or null
        if (result === true) {
          localNetworkStatus = true;
        } else if (result === false) {
          localNetworkStatus = false;
        } else {
          // null means unknown/pending - treat as not granted yet
          localNetworkStatus = false;
        }
      } catch (e) {
        // If the command fails (e.g., Swift not available), assume granted
        localNetworkStatus = true;
      }

      // 🔒 Check again after local network check
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      const cameraResult = cameraStatus === true;
      const micResult = micStatus === true;
      const localNetworkResult = localNetworkStatus === true;

      // Only log if state changed or first check
      const stateChanged =
        previousStateRef.current.camera !== cameraResult ||
        previousStateRef.current.microphone !== micResult ||
        previousStateRef.current.localNetwork !== localNetworkResult ||
        previousStateRef.current.camera === null;

      if (stateChanged) {
        previousStateRef.current = {
          camera: cameraResult,
          microphone: micResult,
          localNetwork: localNetworkResult,
        };
      }

      setCameraGranted(cameraResult);
      setMicrophoneGranted(micResult);
      setLocalNetworkGranted(localNetworkResult);
      setHasChecked(true);
    } catch (error) {
      // 🔒 Don't update state if this check is stale
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      setCameraGranted(false);
      setMicrophoneGranted(false);
      setLocalNetworkGranted(false);
      setHasChecked(true);
    } finally {
      // 🔒 Only update isChecking if this is still the current check
      if (currentVersion === checkVersionRef.current) {
        setIsChecking(false);
      }
    }
  }, [isMac, shouldBypassPermissions]);

  useEffect(() => {
    mountedRef.current = true;

    // Check immediately
    checkPermissions();

    // Check periodically
    const interval = setInterval(checkPermissions, checkInterval);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [checkInterval, checkPermissions]);

  const allGranted = cameraGranted && microphoneGranted && localNetworkGranted;

  return {
    cameraGranted,
    microphoneGranted,
    localNetworkGranted,
    allGranted,
    isChecking,
    hasChecked,
    refresh: checkPermissions, // Expose manual refresh function
  };
}
