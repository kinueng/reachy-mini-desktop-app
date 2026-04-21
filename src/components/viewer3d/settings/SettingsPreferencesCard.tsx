import React, { useState } from 'react';
import { Box, Typography, Switch } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import PrivacyTipOutlinedIcon from '@mui/icons-material/PrivacyTipOutlined';
import useAppStore from '../../../store/useAppStore';
import { isTelemetryEnabled, setTelemetryEnabled } from '../../../utils/telemetry';
import SectionHeader from './SectionHeader';
import { DURATION, EASING, blackAlpha } from '@styles/tokens';
import { useAppPalette } from '@styles';

export interface SettingsPreferencesCardProps {
  /** @deprecated Theme mode is now read from `useAppPalette()`. Prop kept for back-compat but ignored. */
  darkMode?: boolean;
  cardStyle?: SxProps<Theme>;
}

export default function SettingsPreferencesCard({
  cardStyle,
}: SettingsPreferencesCardProps): React.ReactElement {
  const palette = useAppPalette();
  const textPrimary = palette.textPrimary;
  const textSecondary = palette.textSecondary;

  const rowBg = palette.isDark ? blackAlpha(0.2) : blackAlpha(0.02);
  const rowBgHover = palette.isDark ? blackAlpha(0.3) : blackAlpha(0.04);

  const [telemetryEnabled, setTelemetryEnabledState] = useState<boolean>(isTelemetryEnabled());

  const handleTelemetryToggle = (): void => {
    const newValue = !telemetryEnabled;
    setTelemetryEnabled(newValue);
    setTelemetryEnabledState(newValue);
  };

  return (
    <Box sx={cardStyle}>
      <SectionHeader title="Preferences" icon={null} darkMode={palette.isDark} />

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 1.5,
          borderRadius: '12px',
          bgcolor: rowBg,
          cursor: 'pointer',
          transition: `background ${DURATION.fast}ms ${EASING.standard}`,
          mb: 1.5,
          '&:hover': {
            bgcolor: rowBgHover,
          },
        }}
        onClick={() => useAppStore.getState().toggleDarkMode()}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {palette.isDark ? (
            <DarkModeOutlinedIcon sx={{ fontSize: 18, color: textSecondary }} />
          ) : (
            <LightModeOutlinedIcon sx={{ fontSize: 18, color: textSecondary }} />
          )}
          <Typography sx={{ fontSize: 13, fontWeight: 500, color: textPrimary }}>
            {palette.isDark ? 'Dark Mode' : 'Light Mode'}
          </Typography>
        </Box>
        <Switch checked={palette.isDark} size="small" color="primary" />
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 1.5,
          borderRadius: '12px',
          bgcolor: rowBg,
          cursor: 'pointer',
          transition: `background ${DURATION.fast}ms ${EASING.standard}`,
          '&:hover': {
            bgcolor: rowBgHover,
          },
        }}
        onClick={handleTelemetryToggle}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <PrivacyTipOutlinedIcon sx={{ fontSize: 18, color: textSecondary }} />
          <Typography sx={{ fontSize: 13, fontWeight: 500, color: textPrimary }}>
            Share anonymous usage data
          </Typography>
        </Box>
        <Switch checked={telemetryEnabled} size="small" color="primary" />
      </Box>

      <Box
        component="a"
        href="https://pollen-robotics.com/privacy"
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          fontSize: 11,
          color: 'primary.main',
          textDecoration: 'none',
          display: 'inline-block',
          width: 'fit-content',
          mt: 1,
          ml: 0.5,
          '&:hover': {
            textDecoration: 'underline',
          },
        }}
      >
        Learn more about privacy →
      </Box>
    </Box>
  );
}
