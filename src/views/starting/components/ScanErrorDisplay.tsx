/**
 * ScanErrorDisplay - Error state with retry button
 *
 * Pure presentational component for hardware scan errors.
 * Shows connection-specific error messages.
 */

import React from 'react';
import { Box, Typography, Button, CircularProgress } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { openUrl } from '../../../utils/tauriCompat';

// Troubleshooting page URL
const TROUBLESHOOTING_URL = 'https://reachy-mini.com/faq#troubleshooting';

export interface ScanErrorMessageParts {
  text?: string;
  bold: string;
  suffix?: string;
}

export interface ScanErrorLike {
  messageParts?: ScanErrorMessageParts;
  message?: string;
  details?: string;
  type?: string;
  [key: string]: unknown;
}

export interface ScanErrorExtra {
  action?: unknown;
  code?: string;
  [key: string]: unknown;
}

export interface ScanErrorDisplayProps {
  error: ScanErrorLike | string | null | undefined;
  scanError?: ScanErrorExtra | null;
  isRetrying: boolean;
  onRetry: () => void;
  onBack?: () => void;
  darkMode: boolean;
}

function ScanErrorDisplay({
  error,
  scanError,
  isRetrying,
  onRetry,
  onBack,
  darkMode,
}: ScanErrorDisplayProps) {
  // Extract message parts from error
  const getErrorMessage = (): ScanErrorMessageParts => {
    if (error && typeof error === 'object' && (error as ScanErrorLike).messageParts) {
      return (error as ScanErrorLike).messageParts as ScanErrorMessageParts;
    }
    if (scanError?.action) {
      return {
        text: '',
        bold: 'Check',
        suffix: ' the camera cable connection and restart',
      };
    }
    if (error && typeof error === 'object' && (error as ScanErrorLike).message) {
      return { text: '', bold: (error as ScanErrorLike).message as string, suffix: '' };
    }
    return { text: '', bold: (error as string) || 'Hardware error detected', suffix: '' };
  };

  const message = getErrorMessage();
  const details = typeof error === 'object' && error ? (error as ScanErrorLike).details : undefined;
  const isTimeout =
    typeof error === 'object' && error ? (error as ScanErrorLike).type === 'timeout' : false;

  const handleTroubleshootingClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    openUrl(TROUBLESHOOTING_URL);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1.5,
        py: 1,
        maxWidth: '360px',
        minHeight: '100px',
      }}
    >
      {/* Main message */}
      <Box
        sx={{
          textAlign: 'center',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography
          component="span"
          sx={{
            fontSize: 15,
            fontWeight: 500,
            color: darkMode ? '#f5f5f5' : '#333',
            lineHeight: 1.5,
          }}
        >
          {message.text && `${message.text} `}
          <Box component="span" sx={{ fontWeight: 700 }}>
            {message.bold}
          </Box>
          {message.suffix && ` ${message.suffix}`}
        </Typography>
      </Box>

      {/* Details */}
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 400,
          color: darkMode ? '#a3a3a3' : '#666',
          textAlign: 'center',
          maxWidth: '300px',
          lineHeight: 1.5,
        }}
      >
        {details || 'An error occurred during connection. If it persists, try restarting Reachy.'}
      </Typography>

      {/* Error code (for scan errors) */}
      {scanError?.code && (
        <Typography
          sx={{
            fontSize: 9,
            fontWeight: 500,
            color: darkMode ? '#666' : '#999',
            fontFamily: 'monospace',
            bgcolor: darkMode ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.05)',
            px: 1.5,
            py: 0.5,
            borderRadius: '6px',
            border: '1px solid rgba(239, 68, 68, 0.2)',
          }}
        >
          {scanError.code}
        </Typography>
      )}

      {/* Retry button */}
      <Button
        variant="outlined"
        startIcon={
          isRetrying ? (
            <CircularProgress size={15} sx={{ color: isTimeout ? '#d97706' : '#ef4444' }} />
          ) : (
            <RefreshIcon sx={{ fontSize: 15, color: isTimeout ? '#d97706' : '#ef4444' }} />
          )
        }
        onClick={onRetry}
        disabled={isRetrying}
        sx={{
          borderColor: isTimeout ? '#d97706' : '#ef4444',
          color: isTimeout ? '#d97706' : '#ef4444',
          fontWeight: 600,
          fontSize: 11,
          px: 2.5,
          py: 0.75,
          borderRadius: '10px',
          textTransform: 'none',
          bgcolor: 'transparent',
          mt: 0.5,
          '&:hover': {
            borderColor: isTimeout ? '#b45309' : '#dc2626',
            bgcolor: isTimeout
              ? darkMode
                ? 'rgba(217, 119, 6, 0.08)'
                : 'rgba(217, 119, 6, 0.04)'
              : darkMode
                ? 'rgba(239, 68, 68, 0.08)'
                : 'rgba(239, 68, 68, 0.04)',
          },
          '&:disabled': {
            borderColor: darkMode
              ? isTimeout
                ? 'rgba(217, 119, 6, 0.3)'
                : 'rgba(239, 68, 68, 0.3)'
              : isTimeout
                ? '#fcd34d'
                : '#fca5a5',
            color: darkMode
              ? isTimeout
                ? 'rgba(217, 119, 6, 0.3)'
                : 'rgba(239, 68, 68, 0.3)'
              : isTimeout
                ? '#fcd34d'
                : '#fca5a5',
          },
        }}
      >
        {isRetrying ? 'Reconnecting...' : 'Try Again'}
      </Button>

      {/* Ghost links */}
      <Box sx={{ display: 'flex', gap: 2, mt: 0.5 }}>
        <Typography
          component="a"
          href="#"
          onClick={handleTroubleshootingClick}
          sx={{
            fontSize: 11,
            fontWeight: 500,
            color: '#FF9500',
            textDecoration: 'underline',
            cursor: 'pointer',
            '&:hover': {
              color: '#FFB340',
            },
          }}
        >
          Need help?
        </Typography>
        <Typography
          component="a"
          href="#"
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
            e.preventDefault();
            onBack?.();
          }}
          sx={{
            fontSize: 11,
            fontWeight: 500,
            color: '#FF9500',
            textDecoration: 'underline',
            cursor: 'pointer',
            '&:hover': {
              color: '#FFB340',
            },
          }}
        >
          Change robot
        </Typography>
      </Box>
    </Box>
  );
}

export default React.memo(ScanErrorDisplay);
