/**
 * Constants for logging system - single source of truth.
 */

export const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
} as const;

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

export const LOG_CATEGORIES = {
  DAEMON: 'daemon',
  APP: 'app',
  FRONTEND: 'frontend',
} as const;

export type LogCategory = (typeof LOG_CATEGORIES)[keyof typeof LOG_CATEGORIES];

export const LOG_EMOJIS = {
  SUCCESS: '✓',
  ERROR: '❌',
  WARNING: '⚠️',
  PERMISSION: '🔒',
  TIMEOUT: '⏱️',
  SIMULATION: '🎭',
  USER_ACTION: '',
  RECEIVE: '📥',
  SEND: '📤',
  INFO: 'ℹ️',
} as const;

export const LOG_PREFIXES = {
  DAEMON: '[Daemon]',
  API: '[API]',
  APP: (appName: string) => `[App: ${appName}]`,
} as const;

export interface CategoryMeta {
  label: string;
  color: string;
}

/**
 * Display metadata for category filter chips (used in LogConsole UI).
 */
export const CATEGORY_META: Record<LogCategory, CategoryMeta> = {
  daemon: { label: 'Daemon', color: '#60a5fa' },
  app: { label: 'Apps', color: '#c084fc' },
  frontend: { label: 'Frontend', color: '#5db3ff' },
};
