import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isMacOS } from '../../utils/platform';

declare global {
  interface Window {
    __E2E_MODE__?: boolean;
  }
}

export interface UsePermissionsOptions {
  /** How often to re-check permissions (ms). Default: 2000. */
  checkInterval?: number;
}

export interface UsePermissionsResult {
  cameraGranted: boolean;
  microphoneGranted: boolean;
  localNetworkGranted: boolean;
  bluetoothGranted: boolean;
  allGranted: boolean;
  isChecking: boolean;
  hasChecked: boolean;
  refresh: () => Promise<void>;
}

/**
 * Check if we're running in E2E/automation mode. This bypasses permission
 * checks as CI runners can't grant macOS permissions.
 */
function isE2EMode(): boolean {
  // Check navigator.webdriver (set by some WebDrivers, but not CrabNebula).
  if (typeof navigator !== 'undefined' && navigator.webdriver) {
    console.log('[usePermissions] 🤖 E2E mode detected (navigator.webdriver)');
    return true;
  }
  // Check for CI environment variable (passed via Vite at build time).
  if (import.meta.env.VITE_E2E_MODE === 'true' || import.meta.env.VITE_CI === 'true') {
    console.log('[usePermissions] 🤖 E2E mode detected (env variable)');
    return true;
  }
  // Check localStorage flag (can be set by E2E tests).
  if (typeof localStorage !== 'undefined') {
    try {
      if (localStorage.getItem('__E2E_MODE__') === 'true') {
        console.log('[usePermissions] 🤖 E2E mode detected (localStorage)');
        return true;
      }
    } catch {
      // localStorage might not be available.
    }
  }
  // Check window flag (can be set by E2E tests).
  if (typeof window !== 'undefined' && window.__E2E_MODE__ === true) {
    console.log('[usePermissions] 🤖 E2E mode detected (window.__E2E_MODE__)');
    return true;
  }
  return false;
}

/**
 * Snapshot of previously observed permission states. Each slot is `null` until
 * the first successful check, then tracks the latest boolean.
 */
interface PermissionSnapshot {
  camera: boolean | null;
  microphone: boolean | null;
  localNetwork: boolean | null;
  bluetooth: boolean | null;
}

/**
 * Result returned by the `check_*_permission` Rust commands. Option<bool>
 * serialises to `true | false | null` where `null` means "not determined yet".
 */
type OptionalBoolResult = boolean | null;

/**
 * Hook to check macOS permissions (camera, microphone, local network,
 * bluetooth). Uses `tauri-plugin-macos-permissions` for
 * camera/microphone and custom Rust commands for the rest (macOS Sequoia+).
 *
 * Checks periodically and exposes a manual `refresh` for immediate checks.
 *
 * On non-macOS platforms (Windows, Linux), permissions are automatically
 * granted as these platforms handle them at the browser/webview level.
 *
 * In E2E mode (WebDriver), permissions are bypassed as CI runners can't
 * grant them.
 *
 * Uses a version counter to prevent race conditions where stale API
 * responses could overwrite more recent permission states.
 */
export function usePermissions({
  checkInterval = 2000,
}: UsePermissionsOptions = {}): UsePermissionsResult {
  const isMac = isMacOS();
  const isE2E = isE2EMode();

  const shouldBypassPermissions = isE2E;
  // Auto-grant on non-macOS OR in E2E mode.
  const autoGrant = !isMac || shouldBypassPermissions;

  const [cameraGranted, setCameraGranted] = useState<boolean>(autoGrant);
  const [microphoneGranted, setMicrophoneGranted] = useState<boolean>(autoGrant);
  const [localNetworkGranted, setLocalNetworkGranted] = useState<boolean>(autoGrant);
  const [bluetoothGranted, setBluetoothGranted] = useState<boolean>(autoGrant);
  // Only check on macOS (non-E2E).
  const [isChecking, setIsChecking] = useState<boolean>(!autoGrant);
  // Already "checked" on non-macOS or E2E.
  const [hasChecked, setHasChecked] = useState<boolean>(autoGrant);

  // Race-condition protection: track the current check version.
  const checkVersionRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);

  // Track previous state to only log changes.
  const previousStateRef = useRef<PermissionSnapshot>({
    camera: null,
    microphone: null,
    localNetwork: null,
    bluetooth: null,
  });

  const checkPermissions = useCallback(async (): Promise<void> => {
    // Skip permission checks on non-macOS platforms or in E2E mode.
    if (!isMac || shouldBypassPermissions || !mountedRef.current) {
      return;
    }

    // Increment version for this check - any older pending checks become stale.
    const currentVersion = ++checkVersionRef.current;

    try {
      setIsChecking(true);

      const cameraStatus = (await invoke(
        'plugin:macos-permissions|check_camera_permission'
      )) as boolean;

      // 🔒 Check if this response is stale (a newer check was launched).
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      const micStatus = (await invoke(
        'plugin:macos-permissions|check_microphone_permission'
      )) as boolean;

      // 🔒 Check again after mic check (another check could have started).
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      // Check local network permission (macOS Sequoia+). Returns:
      //   true  -> granted
      //   false -> denied
      //   null  -> unknown/pending (treated as not granted yet)
      let localNetworkStatus = true; // Default to true for pre-Sequoia.
      try {
        const result = (await invoke('check_local_network_permission')) as OptionalBoolResult;
        if (result === true) {
          localNetworkStatus = true;
        } else if (result === false) {
          localNetworkStatus = false;
        } else {
          localNetworkStatus = false;
        }
      } catch {
        // If the command fails (e.g. Swift not available), assume granted.
        localNetworkStatus = true;
      }

      // Check Bluetooth permission (macOS - needed for BLE-based WiFi setup).
      let bluetoothStatus = true;
      try {
        const result = (await invoke('check_bluetooth_permission')) as OptionalBoolResult;
        if (result === true) {
          bluetoothStatus = true;
        } else if (result === false) {
          bluetoothStatus = false;
        } else {
          // null means not determined yet - treat as not granted.
          bluetoothStatus = false;
        }
      } catch {
        bluetoothStatus = true;
      }

      // 🔒 Check again after all permission checks.
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      const cameraResult = cameraStatus === true;
      const micResult = micStatus === true;
      const localNetworkResult = localNetworkStatus === true;
      const bluetoothResult = bluetoothStatus === true;

      // Only log if state changed or first check.
      const stateChanged =
        previousStateRef.current.camera !== cameraResult ||
        previousStateRef.current.microphone !== micResult ||
        previousStateRef.current.localNetwork !== localNetworkResult ||
        previousStateRef.current.bluetooth !== bluetoothResult ||
        previousStateRef.current.camera === null;

      if (stateChanged) {
        previousStateRef.current = {
          camera: cameraResult,
          microphone: micResult,
          localNetwork: localNetworkResult,
          bluetooth: bluetoothResult,
        };
      }

      setCameraGranted(cameraResult);
      setMicrophoneGranted(micResult);
      setLocalNetworkGranted(localNetworkResult);
      setBluetoothGranted(bluetoothResult);
      setHasChecked(true);
    } catch {
      // 🔒 Don't update state if this check is stale.
      if (currentVersion !== checkVersionRef.current) {
        return;
      }

      setCameraGranted(false);
      setMicrophoneGranted(false);
      setLocalNetworkGranted(false);
      setBluetoothGranted(false);
      setHasChecked(true);
    } finally {
      // 🔒 Only update isChecking if this is still the current check.
      if (currentVersion === checkVersionRef.current) {
        setIsChecking(false);
      }
    }
  }, [isMac, shouldBypassPermissions]);

  useEffect(() => {
    mountedRef.current = true;

    checkPermissions();

    const interval = setInterval(checkPermissions, checkInterval);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [checkInterval, checkPermissions]);

  const allGranted =
    cameraGranted && microphoneGranted && localNetworkGranted && bluetoothGranted;

  return {
    cameraGranted,
    microphoneGranted,
    localNetworkGranted,
    bluetoothGranted,
    allGranted,
    isChecking,
    hasChecked,
    refresh: checkPermissions,
  };
}

export default usePermissions;
