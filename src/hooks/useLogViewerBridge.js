import { useEffect, useRef } from 'react';
import { emit } from '../utils/tauriCompat';
import useAppStore from '../store/useAppStore';
import { getWsBaseUrl } from '../config/daemon';

/**
 * Bridge between the daemon's log sources and the Log Viewer window.
 *
 * - Lite/USB mode: sidecar events are already global (Log Viewer listens directly)
 * - WiFi mode: connects a WebSocket to /logs/ws/daemon and forwards lines
 *   as 'log-viewer:ws-line' events so the Log Viewer window receives them.
 */
export default function useLogViewerBridge() {
  const { connectionMode } = useAppStore();
  const wsRef = useRef(null);

  useEffect(() => {
    // Only needed in WiFi mode — sidecar events are already global for lite/USB
    if (connectionMode !== 'wifi') return;

    let reconnectTimer;
    let stopped = false;

    function connect() {
      if (stopped) return;
      try {
        const wsUrl = `${getWsBaseUrl()}/logs/ws/daemon`;
        const ws = new WebSocket(wsUrl);

        ws.onmessage = event => {
          if (event.data) {
            emit('log-viewer:ws-line', event.data);
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (!stopped) {
            reconnectTimer = setTimeout(connect, 3000);
          }
        };

        ws.onerror = () => {
          // onclose will fire after this
        };

        wsRef.current = ws;
      } catch {
        if (!stopped) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      }
    }

    connect();

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectionMode]);
}
