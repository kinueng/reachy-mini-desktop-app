import { useCallback, useRef, useEffect } from 'react';
import { useActiveRobotContext } from '../../context';
import type { HeadPose } from '@utils/targetSmoothing';

const SEND_THROTTLE_MS = 50;

const WS_RECONNECT_DELAY_MS = 1000;
const WS_MAX_RECONNECT_ATTEMPTS = 5;

interface CommandRequestBody {
  target_head_pose: HeadPose;
  target_antennas: [number, number] | number[];
  target_body_yaw: number;
}

interface UseControllerAPIReturn {
  sendCommand: (headPose: HeadPose, antennas: [number, number] | number[], bodyYaw: number) => void;
  forceSendCommand: (
    headPose: HeadPose,
    antennas: [number, number] | number[],
    bodyYaw: number
  ) => Promise<unknown> | void;
}

export function useControllerAPI(): UseControllerAPIReturn {
  const { api } = useActiveRobotContext();
  const { buildApiUrl, fetchWithTimeout, config: DAEMON_CONFIG } = api;

  const lastSendTimeRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectAttempts = useRef<number>(0);
  const wsReconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildWsUrl = useCallback((): string => {
    const httpUrl = buildApiUrl('/api/move/ws/set_target');
    return httpUrl.replace(/^http/, 'ws');
  }, [buildApiUrl]);

  const connectWebSocket = useCallback((): void => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (wsReconnectTimeoutRef.current) {
      clearTimeout(wsReconnectTimeoutRef.current);
      wsReconnectTimeoutRef.current = null;
    }

    try {
      const ws = new WebSocket(buildWsUrl());

      ws.onopen = () => {
        wsReconnectAttempts.current = 0;
      };

      ws.onclose = event => {
        wsRef.current = null;

        if (event.code !== 1000 && wsReconnectAttempts.current < WS_MAX_RECONNECT_ATTEMPTS) {
          wsReconnectAttempts.current++;
          wsReconnectTimeoutRef.current = setTimeout(connectWebSocket, WS_RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {};

      ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data);
          if (data.status === 'error') {
            console.warn('[Controller] WebSocket error:', data.detail);
          }
        } catch {
          // Ignore non-JSON messages
        }
      };

      wsRef.current = ws;
    } catch {
      // Will fallback to HTTP
    }
  }, [buildWsUrl]);

  const disconnectWebSocket = useCallback((): void => {
    if (wsReconnectTimeoutRef.current) {
      clearTimeout(wsReconnectTimeoutRef.current);
      wsReconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close(1000);
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    connectWebSocket();

    return () => {
      disconnectWebSocket();
    };
  }, [connectWebSocket, disconnectWebSocket]);

  const sendViaWebSocket = useCallback((requestBody: CommandRequestBody): boolean => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(requestBody));
      return true;
    }
    return false;
  }, []);

  const sendViaHttp = useCallback(
    (requestBody: CommandRequestBody, fireAndForget: boolean = true): Promise<unknown> => {
      const options: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      };

      // TODO(ts): DAEMON_CONFIG is typed as Record<string, unknown>; narrow upstream
      const timeoutMs = (DAEMON_CONFIG as { MOVEMENT: { CONTINUOUS_MOVE_TIMEOUT: number } })
        .MOVEMENT.CONTINUOUS_MOVE_TIMEOUT;

      return fetchWithTimeout(buildApiUrl('/api/move/set_target'), options, timeoutMs, {
        label: 'Set target',
        silent: true,
        fireAndForget,
      }).catch(() => {});
    },
    [buildApiUrl, fetchWithTimeout, DAEMON_CONFIG]
  );

  const sendCommand = useCallback(
    (headPose: HeadPose, antennas: [number, number] | number[], bodyYaw: number): void => {
      const now = Date.now();
      if (now - lastSendTimeRef.current < SEND_THROTTLE_MS) {
        return;
      }
      lastSendTimeRef.current = now;

      const requestBody: CommandRequestBody = {
        target_head_pose: headPose,
        target_antennas: antennas,
        target_body_yaw: bodyYaw,
      };

      if (!sendViaWebSocket(requestBody)) {
        sendViaHttp(requestBody);
      }
    },
    [sendViaWebSocket, sendViaHttp]
  );

  const forceSendCommand = useCallback(
    (
      headPose: HeadPose,
      antennas: [number, number] | number[],
      bodyYaw: number
    ): Promise<unknown> | void => {
      lastSendTimeRef.current = Date.now();

      const requestBody: CommandRequestBody = {
        target_head_pose: headPose,
        target_antennas: antennas,
        target_body_yaw: bodyYaw,
      };

      if (sendViaWebSocket(requestBody)) {
        return Promise.resolve({ status: 'ok' });
      }

      return sendViaHttp(requestBody, false);
    },
    [sendViaWebSocket, sendViaHttp]
  );

  return { sendCommand, forceSendCommand };
}
