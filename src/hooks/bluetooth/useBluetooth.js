import { useCallback, useEffect } from 'react';
import {
  connect as blecConnect,
  disconnect as blecDisconnect,
  startScan,
  stopScan,
  getAdapterState,
  readString,
  sendString,
} from '@mnlphlp/plugin-blec';
import useAppStore from '../../store/useAppStore';

// BLE UUIDs for Reachy Mini (from bluetooth_service.py)
// Command service
const CMD_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const COMMAND_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef1';
const RESPONSE_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef2';
// Status service
const STATUS_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef3';
const NETWORK_STATUS_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef4';

// Timing
const RESPONSE_READ_DELAY = 500; // ms to wait after write before reading response
const SCAN_TIMEOUT = 10000; // ms scan duration

/**
 * useBluetooth — wraps @mnlphlp/plugin-blec for Reachy Mini BLE interactions.
 *
 * Protocol (from bluetooth_service.py):
 *  - "PING"         → "PONG"
 *  - "STATUS"        → "OK: System running"
 *  - "PIN_xxxxx"     → validates PIN (last 5 digits of serial)
 *  - "CMD_scriptname" → runs commands/scriptname.sh (requires prior PIN auth)
 */
export default function useBluetooth() {
  const {
    bleStatus,
    setBleStatus,
    bleDevices,
    setBleDevices,
    bleDeviceAddress,
    setBleDeviceAddress,
    setBlePin,
    loadBlePinForDevice,
  } = useAppStore();

  // Adapter state
  const checkAdapterState = useCallback(async () => {
    try {
      return await getAdapterState();
    } catch (e) {
      console.error('[BLE] Failed to get adapter state:', e);
      return null;
    }
  }, []);

  // Scan for ReachyMini devices
  // startScan(handler, timeout) — handler receives an array of devices per callback
  const scan = useCallback(async () => {
    setBleStatus('scanning');
    setBleDevices([]);

    try {
      // Start the scan (on Windows, the promise may resolve before the timeout)
      startScan(devices => {
        // Filter for ReachyMini devices client-side
        const reachyDevices = devices.filter(
          d => d.name && d.name.toLowerCase().replace(/-/g, '').includes('reachymini')
        );
        if (reachyDevices.length > 0) {
          const prev = useAppStore.getState().bleDevices;
          const merged = [...prev];
          for (const device of reachyDevices) {
            const idx = merged.findIndex(d => d.address === device.address);
            if (idx >= 0) {
              merged[idx] = device;
            } else {
              merged.push(device);
            }
          }
          setBleDevices(merged);
        }
      }, SCAN_TIMEOUT).catch(e => {
        console.error('[BLE] Scan error:', e);
      });

      // Wait for the full scan duration regardless of when the promise resolves
      await new Promise(r => setTimeout(r, SCAN_TIMEOUT));
    } finally {
      // Only reset to disconnected if still scanning (not if connect was triggered)
      const currentStatus = useAppStore.getState().bleStatus;
      if (currentStatus === 'scanning') {
        setBleStatus('disconnected');
      }
    }
  }, [setBleStatus, setBleDevices]);

  const stopScanning = useCallback(async () => {
    try {
      await stopScan();
    } catch (e) {
      // Ignore — scan may already be stopped
    }
    setBleStatus('disconnected');
  }, [setBleStatus]);

  // Connect to a specific device
  const connectToDevice = useCallback(
    async address => {
      // CoreBluetooth requires scanning to be stopped before connecting
      try {
        await stopScan();
      } catch (e) {
        // Ignore — scan may already be stopped
      }

      setBleStatus('connecting');
      try {
        await blecConnect(address, () => {
          console.warn('[BLE] Device disconnected');
          setBleStatus('disconnected');
          setBleDeviceAddress(null);
        });

        setBleDeviceAddress(address);
        loadBlePinForDevice(address);
        setBleStatus('connected');
      } catch (e) {
        console.error('[BLE] Connect error:', e);
        setBleStatus('disconnected');
        throw e;
      }
    },
    [setBleStatus, setBleDeviceAddress]
  );

  // Disconnect
  const disconnectDevice = useCallback(async () => {
    try {
      await blecDisconnect();
    } catch (e) {
      console.error('[BLE] Disconnect error:', e);
    }
    setBleStatus('disconnected');
    setBleDeviceAddress(null);
    setBleDevices([]);
  }, [setBleStatus, setBleDeviceAddress, setBleDevices]);

  // Send a raw string to the command characteristic, then read the response.
  // The Reachy BLE service updates the response characteristic value but does
  // not send a BLE notification, so we poll-read after a short delay.
  const sendRaw = useCallback(
    async message => {
      if (bleStatus !== 'connected') {
        throw new Error('Not connected');
      }

      await sendString(COMMAND_CHAR_UUID, message, 'withoutResponse', CMD_SERVICE_UUID);

      // Give the device time to process and write the response
      await new Promise(r => setTimeout(r, RESPONSE_READ_DELAY));

      // Read the response characteristic directly
      return await readString(RESPONSE_CHAR_UUID, CMD_SERVICE_UUID);
    },
    [bleStatus]
  );

  // Authenticate with PIN, then send a CMD_ command
  const sendCommand = useCallback(
    async (pin, commandName) => {
      // Authenticate first
      const pinResponse = await sendRaw(`PIN_${pin}`);
      if (pinResponse && pinResponse.toLowerCase().includes('error')) {
        throw new Error(pinResponse);
      }

      // Send the command
      return await sendRaw(`CMD_${commandName}`);
    },
    [sendRaw]
  );

  // Send PING (no auth required)
  const sendPing = useCallback(async () => {
    return await sendRaw('PING');
  }, [sendRaw]);

  // Send STATUS (no auth required)
  const sendStatus = useCallback(async () => {
    return await sendRaw('STATUS');
  }, [sendRaw]);

  // Read network status from the status service
  const readNetworkStatus = useCallback(async () => {
    if (bleStatus !== 'connected') {
      throw new Error('Not connected');
    }
    return await readString(NETWORK_STATUS_CHAR_UUID, STATUS_SERVICE_UUID);
  }, [bleStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (bleStatus === 'connected') {
        blecDisconnect().catch(() => {});
      }
    };
  }, []);

  return {
    // State
    bleStatus,
    bleDevices,
    bleDeviceAddress,

    // Actions
    scan,
    stopScanning,
    connectToDevice,
    disconnectDevice,
    sendCommand,
    sendPing,
    sendStatus,
    readNetworkStatus,
    checkAdapterState,

    // Store actions (for PIN)
    setBlePin,
  };
}
