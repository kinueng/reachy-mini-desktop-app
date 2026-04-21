import {
  LOG_LEVELS,
  LOG_PREFIXES,
  LOG_CATEGORIES,
  type LogLevel,
  type LogCategory,
} from './constants';

/**
 * Subset of the store API the logger needs.
 * We avoid importing the full store type to keep this module dependency-light
 * and to break the import cycle (`daemon.ts -> logging -> store -> slices`).
 */
interface LogsStoreApi {
  addFrontendLog?: (message: string, level: LogLevel, category: LogCategory) => void;
  addAppLog?: (message: string, appName: string, level: LogLevel) => void;
}

interface ZustandStore {
  getState: () => LogsStoreApi;
}

let _store: ZustandStore | null = null;

/**
 * Resolve (and cache) the Zustand logs store.
 * Triggers the dynamic import the first time it is called and returns `null`
 * until the import completes.
 */
const getLogsStore = (): LogsStoreApi | null => {
  try {
    if (!_store) {
      const mod = import('../../store') as Promise<{ useStore: ZustandStore }>;
      mod
        .then(m => {
          _store = m.useStore;
        })
        .catch(() => {});
      return null;
    }
    return _store.getState();
  } catch {
    return null;
  }
};

const addLog = (
  message: string,
  level: LogLevel = LOG_LEVELS.INFO,
  category: LogCategory = LOG_CATEGORIES.FRONTEND
): void => {
  const logsStore = getLogsStore();
  if (logsStore?.addFrontendLog) {
    logsStore.addFrontendLog(message, level, category);
    return;
  }

  void (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const { emit } = await import('@tauri-apps/api/event');
      const currentWindow = await getCurrentWindow();
      if (currentWindow.label !== 'main') {
        await emit('add-log', { message, level, category });
      }
    } catch {
      // Silently fail
    }
  })();
};

export const logInfo = (message: string, category: LogCategory = LOG_CATEGORIES.FRONTEND): void => {
  addLog(message, LOG_LEVELS.INFO, category);
};

export const logSuccess = (
  message: string,
  category: LogCategory = LOG_CATEGORIES.FRONTEND
): void => {
  addLog(message, LOG_LEVELS.SUCCESS, category);
};

export const logWarning = (
  message: string,
  category: LogCategory = LOG_CATEGORIES.FRONTEND
): void => {
  addLog(message, LOG_LEVELS.WARNING, category);
};

export const logError = (
  message: string,
  category: LogCategory = LOG_CATEGORIES.FRONTEND
): void => {
  addLog(message, LOG_LEVELS.ERROR, category);
};

export const logApiCall = (
  method: string,
  endpoint: string,
  success: boolean,
  details: string = ''
): void => {
  const message = details ? `${method} ${endpoint}: ${details}` : `${method} ${endpoint}`;
  addLog(message, success ? LOG_LEVELS.SUCCESS : LOG_LEVELS.ERROR, LOG_CATEGORIES.FRONTEND);
};

export const logDaemon = (message: string, level: LogLevel = LOG_LEVELS.INFO): void => {
  const formattedMessage = `${LOG_PREFIXES.DAEMON} ${message}`;
  addLog(formattedMessage, level, LOG_CATEGORIES.DAEMON);
};

export const logApp = (
  appName: string,
  message: string,
  level: LogLevel = LOG_LEVELS.INFO
): void => {
  const store = getLogsStore();
  if (store?.addAppLog) {
    store.addAppLog(message, appName, level);
  }
};

export const logUserAction = (action: string, details: string = ''): void => {
  const message = details ? `${action}: ${details}` : action;
  addLog(message, LOG_LEVELS.INFO, LOG_CATEGORIES.FRONTEND);
};

export const logPermission = (message: string): void => {
  addLog(message, LOG_LEVELS.WARNING, LOG_CATEGORIES.FRONTEND);
};

export const logTimeout = (message: string): void => {
  addLog(message, LOG_LEVELS.WARNING, LOG_CATEGORIES.FRONTEND);
};
