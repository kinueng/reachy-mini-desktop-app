import React from 'react';
import StoreOutlinedIcon from '@mui/icons-material/StoreOutlined';
import PulseButton from '@components/PulseButton';
import { useAppPalette } from '@styles';

interface DiscoverAppsButtonProps {
  onClick: () => void;
  /** @deprecated Theme mode is now read from `useAppPalette()`. Prop kept for back-compat but ignored. */
  darkMode?: boolean;
  disabled?: boolean;
}

export default function DiscoverAppsButton({
  onClick,
  disabled = false,
}: DiscoverAppsButtonProps): React.ReactElement {
  const palette = useAppPalette();
  return (
    <PulseButton
      onClick={onClick}
      disabled={disabled}
      startIcon={<StoreOutlinedIcon sx={{ fontSize: 16 }} />}
      darkMode={palette.isDark}
      size="small"
      sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '-0.2px' }}
    >
      Discover apps
    </PulseButton>
  );
}
