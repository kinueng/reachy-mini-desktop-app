import { useCallback, useMemo } from 'react';
import { useStore } from '../../store';
import {
  LOG_LEVELS,
  LOG_EMOJIS,
  LOG_PREFIXES,
  LOG_CATEGORIES,
  type LogLevel,
  type LogCategory,
} from './constants';
import type { FullAppState } from '../../store/useStore';

type AddFrontendLog = FullAppState['addFrontendLog'];
type AddAppLog = FullAppState['addAppLog'];

export interface UseLoggerResult {
  info: (message: string, category?: LogCategory) => void;
  success: (message: string, category?: LogCategory) => void;
  warning: (message: string, category?: LogCategory) => void;
  error: (message: string, category?: LogCategory) => void;
  api: (method: string, endpoint: string, ok: boolean, details?: string) => void;
  daemon: (message: string, level?: LogLevel) => void;
  app: (appName: string, message: string, level?: LogLevel) => void;
  userAction: (action: string, details?: string) => void;
  permission: (message: string) => void;
  timeout: (message: string) => void;
}

/**
 * React hook for logging in components.
 * Each method routes to addFrontendLog with the appropriate category.
 */
export function useLogger(): UseLoggerResult {
  const addFrontendLog = useStore(state => state.addFrontendLog) as AddFrontendLog;
  const addAppLog = useStore(state => state.addAppLog) as AddAppLog;

  const info = useCallback(
    (message: string, category: LogCategory = LOG_CATEGORIES.FRONTEND) => {
      addFrontendLog(message, LOG_LEVELS.INFO, category);
    },
    [addFrontendLog]
  );

  const success = useCallback(
    (message: string, category: LogCategory = LOG_CATEGORIES.FRONTEND) => {
      const formatted = `${LOG_EMOJIS.SUCCESS} ${message}`;
      addFrontendLog(formatted, LOG_LEVELS.SUCCESS, category);
    },
    [addFrontendLog]
  );

  const warning = useCallback(
    (message: string, category: LogCategory = LOG_CATEGORIES.FRONTEND) => {
      const formatted = `${LOG_EMOJIS.WARNING} ${message}`;
      addFrontendLog(formatted, LOG_LEVELS.WARNING, category);
    },
    [addFrontendLog]
  );

  const error = useCallback(
    (message: string, category: LogCategory = LOG_CATEGORIES.FRONTEND) => {
      const formatted = `${LOG_EMOJIS.ERROR} ${message}`;
      addFrontendLog(formatted, LOG_LEVELS.ERROR, category);
    },
    [addFrontendLog]
  );

  const api = useCallback(
    (method: string, endpoint: string, ok: boolean, details: string = '') => {
      const icon = ok ? LOG_EMOJIS.SUCCESS : LOG_EMOJIS.ERROR;
      const message = details
        ? `${icon} ${method} ${endpoint}: ${details}`
        : `${icon} ${method} ${endpoint}`;
      addFrontendLog(message, ok ? LOG_LEVELS.SUCCESS : LOG_LEVELS.ERROR, LOG_CATEGORIES.FRONTEND);
    },
    [addFrontendLog]
  );

  const daemon = useCallback(
    (message: string, level: LogLevel = LOG_LEVELS.INFO) => {
      const formatted = `${LOG_PREFIXES.DAEMON} ${message}`;
      addFrontendLog(formatted, level, LOG_CATEGORIES.DAEMON);
    },
    [addFrontendLog]
  );

  const app = useCallback(
    (appName: string, message: string, level: LogLevel = LOG_LEVELS.INFO) => {
      addAppLog(message, appName, level);
    },
    [addAppLog]
  );

  const userAction = useCallback(
    (action: string, details: string = '') => {
      const message = details ? `${action}: ${details}` : action;
      addFrontendLog(message, LOG_LEVELS.INFO, LOG_CATEGORIES.FRONTEND);
    },
    [addFrontendLog]
  );

  const permission = useCallback(
    (message: string) => {
      const formatted = `${LOG_EMOJIS.PERMISSION} ${message}`;
      addFrontendLog(formatted, LOG_LEVELS.WARNING, LOG_CATEGORIES.FRONTEND);
    },
    [addFrontendLog]
  );

  const timeout = useCallback(
    (message: string) => {
      const formatted = `${LOG_EMOJIS.TIMEOUT} ${message}`;
      addFrontendLog(formatted, LOG_LEVELS.WARNING, LOG_CATEGORIES.FRONTEND);
    },
    [addFrontendLog]
  );

  return useMemo(
    () => ({ info, success, warning, error, api, daemon, app, userAction, permission, timeout }),
    [info, success, warning, error, api, daemon, app, userAction, permission, timeout]
  );
}
