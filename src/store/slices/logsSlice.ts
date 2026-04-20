/**
 * Logs Slice - Manages all types of logs (daemon, frontend, app)
 *
 * Two display modes:
 *   - "simple": user-facing actions only (errors, user actions, key events)
 *   - "dev":    everything with category/level filters and search
 *
 * Note: We don't import DAEMON_CONFIG here to avoid circular dependencies
 * (daemon.js imports useStore which imports slices).
 * We also avoid importing from utils/logging/constants for the same reason;
 * the canonical category list lives there, but we inline the values here.
 */
import type { StateCreator } from 'zustand';
import type { LogLevel } from '../../types/api';
import type { AppState, LogCategory, LogEntry, LogsSlice, LogsSliceState } from '../../types/store';

const MAX_FRONTEND_LOGS = 500;
const MAX_APP_LOGS = 1000;

const ALL_CATEGORIES: LogCategory[] = ['daemon', 'app', 'frontend'];

export const logsInitialState: LogsSliceState = {
  logs: [],
  frontendLogs: [],
  appLogs: [],

  logMode: 'simple',
  logSearch: '',
  logCategoryFilters: [...ALL_CATEGORIES],
};

const VALID_FRONTEND_LEVELS: LogLevel[] = ['info', 'success', 'warning', 'error'];
const VALID_APP_LEVELS: LogLevel[] = ['info', 'warning', 'error'];

const formatTimestamp = (now: number): string => {
  try {
    return new Date(now).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return new Date(now).toISOString().substring(11, 19);
  }
};

/**
 * Create logs slice
 */
export const createLogsSlice: StateCreator<AppState, [], [], LogsSlice> = set => ({
  ...logsInitialState,

  // Set daemon logs - store raw, filtering happens at display time
  setLogs: newLogs =>
    set(state => {
      if (
        state.logs === newLogs ||
        (Array.isArray(state.logs) &&
          Array.isArray(newLogs) &&
          state.logs.length === newLogs.length &&
          state.logs.length > 0 &&
          state.logs[state.logs.length - 1] === newLogs[newLogs.length - 1])
      ) {
        return state;
      }
      return { logs: newLogs };
    }),

  addFrontendLog: (
    message: string,
    level: LogLevel = 'info',
    category: LogCategory = 'frontend'
  ) => {
    if (message == null) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[addFrontendLog] Received null/undefined message, skipping');
      }
      return;
    }

    const normalizedLevel: LogLevel = VALID_FRONTEND_LEVELS.includes(level) ? level : 'info';
    const sanitizedMessage = String(message).slice(0, 10000);

    try {
      const now = Date.now();
      const formattedTimestamp = formatTimestamp(now);

      set(state => {
        const newLog: LogEntry = {
          timestamp: formattedTimestamp,
          timestampNumeric: now,
          message: sanitizedMessage,
          source: 'frontend',
          category: category || 'frontend',
          level: normalizedLevel,
        };

        const newFrontendLogs = [...state.frontendLogs.slice(-MAX_FRONTEND_LOGS), newLog];

        return { frontendLogs: newFrontendLogs };
      });
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[addFrontendLog] Error adding log:', error);
      }
    }
  },

  addAppLog: (message: string, appName?: string, level: LogLevel = 'info') => {
    if (message == null) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[addAppLog] Received null/undefined message, skipping');
      }
      return;
    }

    const sanitizedMessage = String(message).slice(0, 10000);
    const sanitizedAppName = appName ? String(appName).slice(0, 100) : undefined;
    const sanitizedLevel: LogLevel = VALID_APP_LEVELS.includes(level) ? level : 'info';

    try {
      const now = Date.now();
      const formattedTimestamp = formatTimestamp(now);

      const newLog: LogEntry = {
        timestamp: formattedTimestamp,
        timestampNumeric: now,
        message: sanitizedMessage,
        source: 'app',
        appName: sanitizedAppName,
        level: sanitizedLevel,
      };

      set(state => {
        // Deduplication
        const lastLog = state.appLogs[state.appLogs.length - 1];
        const isDuplicate =
          lastLog &&
          lastLog.message === sanitizedMessage &&
          lastLog.appName === sanitizedAppName &&
          lastLog.timestampNumeric &&
          now - lastLog.timestampNumeric < 100;

        if (isDuplicate) {
          return state;
        }

        return {
          appLogs: [...state.appLogs.slice(-MAX_APP_LOGS), newLog],
        };
      });
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[addAppLog] Error adding log:', error);
      }
    }
  },

  clearAppLogs: (appName?: string) =>
    set(state => ({
      appLogs: appName ? state.appLogs.filter(log => log.appName !== appName) : [],
    })),

  clearAllLogs: () =>
    set({
      logs: [],
      frontendLogs: [],
      appLogs: [],
    }),

  setLogMode: mode => set({ logMode: mode }),
  setLogSearch: search => set({ logSearch: search }),
  toggleLogCategory: (category: LogCategory) =>
    set(state => {
      const current = state.logCategoryFilters;
      return {
        logCategoryFilters: current.includes(category)
          ? current.filter(c => c !== category)
          : [...current, category],
      };
    }),
});
