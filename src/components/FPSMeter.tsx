import React, { useState, useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import { RADIUS, blackAlpha, whiteAlpha } from '@styles/tokens';
import { useAppPalette } from '@styles';

export interface FPSMeterProps {
  /** @deprecated Theme mode is now read from `useAppPalette()`. Prop kept for back-compat but ignored. */
  darkMode?: boolean;
}

/**
 * Simple FPS Meter component. Displays an FPS counter above the Reachy
 * status tag in the 3D viewer. Should be rendered inside `Viewer3D` with
 * `position: absolute`.
 */
export function FPSMeter(_props: FPSMeterProps = {}): React.ReactElement {
  const palette = useAppPalette();
  const [fps, setFps] = useState<number>(0);
  const frameCount = useRef<number>(0);
  const lastTime = useRef<number>(performance.now());
  const animationFrameId = useRef<number | null>(null);

  useEffect(() => {
    const measureFPS = (): void => {
      frameCount.current += 1;
      const currentTime = performance.now();
      const deltaTime = currentTime - lastTime.current;

      if (deltaTime >= 1000) {
        const currentFPS = Math.round((frameCount.current * 1000) / deltaTime);
        setFps(currentFPS);
        frameCount.current = 0;
        lastTime.current = currentTime;
      }

      animationFrameId.current = requestAnimationFrame(measureFPS);
    };

    animationFrameId.current = requestAnimationFrame(measureFPS);

    return () => {
      if (animationFrameId.current !== null) {
        cancelAnimationFrame(animationFrameId.current);
      }
    };
  }, []);

  // TODO(style-migration): the translucent chrome surface (0.85 opacity) is
  // specific to the floating HUD and is not captured by `surfaceCard`.
  const hudBg = palette.isDark ? 'rgba(26, 26, 26, 0.85)' : 'rgba(255, 255, 255, 0.85)';
  const hudBorder = palette.isDark ? whiteAlpha(0.1) : blackAlpha(0.1);

  return (
    <Box
      sx={{
        px: 1.25,
        py: 0.75,
        borderRadius: `${RADIUS.md}px`,
        bgcolor: hudBg,
        border: `1px solid ${hudBorder}`,
        backdropFilter: 'blur(10px)',
        pointerEvents: 'none',
      }}
    >
      <Typography
        sx={{
          fontSize: 9,
          fontWeight: 500,
          color: palette.textSecondary,
          fontFamily: 'SF Mono, Monaco, Menlo, monospace',
          letterSpacing: '0.02em',
          lineHeight: 1,
        }}
      >
        {fps} FPS
      </Typography>
    </Box>
  );
}

/** Wrapper kept for backward compatibility with prior usages. */
export default function FPSMeterWrapper(): React.ReactElement {
  return <FPSMeter />;
}
