/**
 * ScanStatusLabel - Uppercase status label
 *
 * Displays the current scan step label (e.g., "Scanning Hardware", "Connecting to Daemon")
 */

import React from 'react';
import { Typography } from '@mui/material';
import { useAppPalette } from '@styles';

export interface ScanStatusLabelProps {
  label: string;
  /** @deprecated Theme mode is now read from `useAppPalette()`. Prop kept for back-compat but ignored. */
  darkMode?: boolean;
}

function ScanStatusLabel({ label }: ScanStatusLabelProps) {
  const palette = useAppPalette();
  return (
    <Typography
      sx={{
        fontSize: 11,
        fontWeight: 600,
        // TODO(style-migration): precise grays `#666` / `#999` have no
        // exact palette mapping; `textMuted` is the closest semantic match.
        color: palette.textMuted,
        letterSpacing: '1px',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </Typography>
  );
}

export default React.memo(ScanStatusLabel);
