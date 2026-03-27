import { useEffect } from 'react';
import useAppStore from '../store/useAppStore';

/**
 * Bridge that provides the remote daemon host to the Log Viewer window.
 *
 * The Log Viewer connects directly to the daemon's WebSocket for logs.
 * This bridge responds to 'log-viewer:request-host' with the remoteHost
 * so the log viewer knows where to connect.
 *
 * In lite/USB mode, sidecar events are already cross-window — no bridge needed.
 */
export default function useLogViewerBridge() {
  const { remoteHost, connectionMode } = useAppStore();

  useEffect(() => {
    let unlisten;

    const setup = async () => {
      try {
        const { listen, emit } = await import('@tauri-apps/api/event');

        // When the log viewer asks for the host, send it
        unlisten = await listen('log-viewer:request-host', () => {
          if (remoteHost) {
            emit('log-viewer:remote-host', remoteHost);
          }
        });

        // Also proactively send when remoteHost changes (viewer might already be open)
        if (remoteHost) {
          emit('log-viewer:remote-host', remoteHost);
        }
      } catch {
        // Not in Tauri
      }
    };

    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, [remoteHost, connectionMode]);
}
