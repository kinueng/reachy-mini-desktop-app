/**
 * Wireless Update Slice - Manages the forced-update flow for wireless robots.
 *
 * Responsibilities (single domain):
 *   - Hold the "we need to update the remote daemon before connecting" flag
 *     and the related metadata (target host, current version, min version).
 *   - Hold the live status of an in-flight update job + its log buffer.
 *
 * Not responsible for:
 *   - Calling the daemon endpoints (that's `useWirelessDaemonUpdate`'s job).
 *   - Routing to a specific view (that's `useViewRouter`'s job).
 *
 * The slice is intentionally inert when `required === false`: the
 * orchestrator hook short-circuits and the view router skips the dedicated
 * view, keeping the rest of the app unaffected.
 */
import type { StateCreator } from 'zustand';
import type {
  AppState,
  WirelessUpdateSlice,
  WirelessUpdateSliceState,
  WirelessUpdateStatus,
} from '../../types/store';

/** Cap log buffer to keep memory bounded during long-tailed PyPI installs. */
const MAX_LOG_LINES = 1000;

export const wirelessUpdateInitialState: WirelessUpdateSliceState = {
  wirelessUpdate: {
    required: false,
    targetHost: null,
    currentVersion: null,
    minVersion: null,
    status: 'idle',
    jobId: null,
    logs: [],
    error: null,
    lastSucceededAt: null,
  },
};

export const createWirelessUpdateSlice: StateCreator<AppState, [], [], WirelessUpdateSlice> = (
  set,
  get
) => ({
  ...wirelessUpdateInitialState,

  requestWirelessUpdate: ({ targetHost, currentVersion, minVersion }) => {
    set({
      wirelessUpdate: {
        required: true,
        targetHost,
        currentVersion,
        minVersion,
        status: 'idle',
        jobId: null,
        logs: [],
        error: null,
        lastSucceededAt: get().wirelessUpdate.lastSucceededAt,
      },
    });
  },

  setWirelessUpdateStatus: (status: WirelessUpdateStatus) => {
    set(state => ({
      wirelessUpdate: { ...state.wirelessUpdate, status },
    }));
  },

  setWirelessUpdateJobId: (jobId: string | null) => {
    set(state => ({
      wirelessUpdate: { ...state.wirelessUpdate, jobId },
    }));
  },

  appendWirelessUpdateLog: (line: string) => {
    set(state => {
      const next = [...state.wirelessUpdate.logs, line];
      if (next.length > MAX_LOG_LINES) {
        next.splice(0, next.length - MAX_LOG_LINES);
      }
      return {
        wirelessUpdate: { ...state.wirelessUpdate, logs: next },
      };
    });
  },

  setWirelessUpdateError: (error: string | null) => {
    set(state => ({
      wirelessUpdate: {
        ...state.wirelessUpdate,
        status: error ? 'error' : state.wirelessUpdate.status,
        error,
      },
    }));
  },

  markWirelessUpdateSucceeded: () => {
    set(state => ({
      wirelessUpdate: {
        ...state.wirelessUpdate,
        status: 'succeeded',
        error: null,
        lastSucceededAt: Date.now(),
      },
    }));
  },

  cancelWirelessUpdate: () => {
    set({
      wirelessUpdate: {
        required: false,
        targetHost: null,
        currentVersion: null,
        minVersion: null,
        status: 'idle',
        jobId: null,
        logs: [],
        error: null,
        lastSucceededAt: get().wirelessUpdate.lastSucceededAt,
      },
    });
  },

  resetWirelessUpdate: () => {
    set({
      wirelessUpdate: {
        required: false,
        targetHost: null,
        currentVersion: null,
        minVersion: null,
        status: 'idle',
        jobId: null,
        logs: [],
        error: null,
        lastSucceededAt: get().wirelessUpdate.lastSucceededAt,
      },
    });
  },
});
