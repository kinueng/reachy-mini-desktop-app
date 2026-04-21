/**
 * Design tokens - single source of truth for the app's visual language.
 *
 * These are pure primitives. They do not depend on React or on `darkMode`.
 * For dark/light derived values, use `useAppPalette()` which composes these
 * tokens into a context-aware palette.
 *
 * Import directly when you need a raw value (e.g. a color constant for a
 * non-React utility). Prefer `useAppPalette()` in components so they stay in
 * sync with the current theme mode automatically.
 */

/* ============================================================
 * COLORS
 * ============================================================ */

/** Primary brand accent (Reachy orange). */
export const ACCENT = {
  /** Raw hex - use sparingly. Prefer `accentAlpha()` for translucent variants. */
  main: '#FF9500',
  light: '#FFB340',
  dark: '#E08500',
} as const;

/**
 * Returns the brand accent with an arbitrary alpha.
 * Centralized so we never hardcode `rgba(255,149,0,…)` again.
 */
export function accentAlpha(alpha: number): string {
  return `rgba(255, 149, 0, ${alpha})`;
}

/** Neutral overlay helpers. */
export function blackAlpha(alpha: number): string {
  return `rgba(0, 0, 0, ${alpha})`;
}
export function whiteAlpha(alpha: number): string {
  return `rgba(255, 255, 255, ${alpha})`;
}

/**
 * Convert a 3- or 6-digit hex color to `rgba(r, g, b, alpha)`.
 * Centralized so consumers never need to parse hex strings by hand
 * (e.g. building tinted backgrounds around a `STATUS.*` color).
 */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h
      .split('')
      .map(c => c + c)
      .join('');
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Semantic status base colors. Kept in sync with the MUI theme in `main.tsx`. */
export const STATUS = {
  success: '#22c55e',
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
  /** Neutral grey for "stopped" / "not initialized" states. */
  neutral: '#9ca3af',
} as const;

/**
 * Status "text" shades tuned for readability on tinted surfaces
 * (used by toasts, alerts, status chips).
 * `light` is bright enough to read on a dark translucent fill;
 * `dark` is saturated enough to read on a light translucent fill.
 */
export const STATUS_TEXT = {
  success: { light: '#86efac', dark: '#16a34a' },
  error: { light: '#fca5a5', dark: '#dc2626' },
  warning: { light: '#fde047', dark: '#ca8a04' },
  info: { light: '#93c5fd', dark: '#2563eb' },
  neutral: { light: '#d1d5db', dark: '#6b7280' },
} as const;

/**
 * "Danger" accent for destructive actions (reset, clear cache, delete).
 * Intentionally warmer and lighter than `STATUS.error` so destructive buttons
 * don't scream "crash" - they only warn.
 */
export const DANGER = {
  light: '#f87171',
  dark: '#dc2626',
} as const;

/* ============================================================
 * RADII
 * ============================================================ */

export const RADIUS = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 16,
  pill: 999,
  circle: '50%',
} as const;

/* ============================================================
 * DURATIONS (ms) + EASINGS
 * ============================================================ */

export const DURATION = {
  instant: 60,
  fast: 150,
  base: 200,
  medium: 250,
  slow: 300,
  slower: 400,
} as const;

export const EASING = {
  /** Material "standard" curve - default for most transitions. */
  standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** Bouncy overshoot - use for playful interactive feedback. */
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  /** Deceleration curve for elements entering the viewport. */
  entrance: 'cubic-bezier(0.4, 0, 0.6, 1)',
  /** Acceleration curve for elements leaving the viewport. */
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

/** Compose a CSS transition string from the tokens. */
export function transition(
  property: string | readonly string[] = 'all',
  durationMs: number = DURATION.base,
  easing: string = EASING.standard
): string {
  const props = Array.isArray(property) ? property : [property];
  return props.map(p => `${p} ${durationMs}ms ${easing}`).join(', ');
}

/* ============================================================
 * Z-INDEX SCALE
 * ============================================================ */

export const Z = {
  base: 0,
  raised: 1,
  dropdown: 10,
  sticky: 100,
  overlay: 1000,
  modal: 1300,
  tooltip: 1500,
  notification: 1700,
} as const;

/* ============================================================
 * TYPOGRAPHY HELPERS (non-MUI fallbacks)
 * ============================================================ */

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const LETTER_SPACING = {
  tight: '-0.3px',
  normal: '0',
  wide: '0.1em',
  wider: '0.12em',
} as const;

/* ============================================================
 * BREAKPOINTS (matches MUI defaults, re-exposed for non-MUI contexts)
 * ============================================================ */

export const BREAKPOINT = {
  sm: 600,
  md: 900,
  lg: 1200,
  xl: 1536,
} as const;

/* ============================================================
 * TYPES
 * ============================================================ */

export type AccentToken = typeof ACCENT;
export type StatusToken = typeof STATUS;
export type StatusTextToken = typeof STATUS_TEXT;
export type DangerToken = typeof DANGER;
export type RadiusToken = typeof RADIUS;
export type DurationToken = typeof DURATION;
export type EasingToken = typeof EASING;
export type StatusSeverity = keyof typeof STATUS;
