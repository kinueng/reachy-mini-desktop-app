// Hook for React components
export { useLogger } from './useLogger';
export type { UseLoggerResult } from './useLogger';

// Static functions for use outside React components
export {
  logInfo,
  logSuccess,
  logWarning,
  logError,
  logApiCall,
  logDaemon,
  logApp,
  logUserAction,
  logPermission,
  logTimeout,
} from './logger';

// Constants & types
export { LOG_LEVELS, LOG_EMOJIS, LOG_PREFIXES, LOG_CATEGORIES, CATEGORY_META } from './constants';
export type { LogLevel, LogCategory, CategoryMeta } from './constants';

// Log filtering (single source of truth for simple-mode noise reduction)
export { FILTERED_PATTERNS, shouldFilterLog } from './logFilters';
