import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Typography, Button, IconButton, CircularProgress, Tooltip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { fetchWithTimeout, buildApiUrl, DAEMON_CONFIG } from '@config/daemon';
import { openUrl } from '@utils/tauriCompat';

const AUTH_POLL_INTERVAL = 2000; // 2 seconds
const AUTH_POLL_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Compact HuggingFace login banner shown in the Applications section.
 * OAuth-only login — opens system browser for HF authorization.
 * Visible in all connection modes (USB, WiFi, Simulation).
 */
export default function HfLoginBanner({ darkMode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isWaitingForAuth, setIsWaitingForAuth] = useState(false);
  const [error, setError] = useState(null);
  const pollIntervalRef = useRef(null);
  const pollTimeoutRef = useRef(null);
  const mountedRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    setIsWaitingForAuth(false);
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(
        buildApiUrl('/api/hf-auth/status'),
        {},
        DAEMON_CONFIG.TIMEOUTS.COMMAND,
        { silent: true }
      );

      if (response.ok) {
        const data = await response.json();
        if (mountedRef.current) {
          setIsAuthenticated(data.is_logged_in);
          setUsername(data.username || null);
        }
        return data.is_logged_in;
      }
    } catch {
      // Silent — daemon may not have this endpoint
    }
    return false;
  }, []);

  // Check auth status on mount
  useEffect(() => {
    checkAuthStatus();
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [checkAuthStatus, stopPolling]);

  const handleLogin = async () => {
    if (isWaitingForAuth || isLoading) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithTimeout(
        buildApiUrl('/api/hf-auth/oauth/start'),
        {},
        DAEMON_CONFIG.TIMEOUTS.COMMAND,
        { label: 'HF OAuth start' }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || `OAuth start failed (${response.status})`);
      }

      const data = await response.json();
      const { auth_url } = data;

      if (!auth_url) {
        throw new Error('No auth URL returned');
      }

      // Open in system browser
      await openUrl(auth_url);

      setIsLoading(false);
      setIsWaitingForAuth(true);

      // Poll for auth completion
      pollIntervalRef.current = setInterval(async () => {
        const loggedIn = await checkAuthStatus();
        if (loggedIn) {
          stopPolling();
        }
      }, AUTH_POLL_INTERVAL);

      // Auto-stop after 5 minutes
      pollTimeoutRef.current = setTimeout(() => {
        stopPolling();
      }, AUTH_POLL_TIMEOUT);
    } catch (err) {
      console.error('[HfLoginBanner] OAuth error:', err);
      setError(err.message);
      setIsLoading(false);
      setIsWaitingForAuth(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchWithTimeout(
        buildApiUrl('/api/hf-auth/token'),
        { method: 'DELETE' },
        DAEMON_CONFIG.TIMEOUTS.COMMAND,
        { label: 'HF logout' }
      );
      setIsAuthenticated(false);
      setUsername(null);
    } catch {
      // Re-check server state on failure
      await checkAuthStatus();
    }
  };

  // --- Logged-in state ---
  if (isAuthenticated) {
    return (
      <Box
        sx={{
          mx: 3,
          mb: 1,
          py: 1,
          px: 2,
          borderRadius: '10px',
          bgcolor: darkMode ? 'rgba(34, 197, 94, 0.04)' : 'rgba(34, 197, 94, 0.03)',
          border: `1px solid ${darkMode ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.12)'}`,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
        }}
      >
        <Typography sx={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>🤗</Typography>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: '#22c55e',
            flexShrink: 0,
          }}
        />
        <Typography
          sx={{
            fontSize: 14,
            fontWeight: 700,
            color: darkMode ? '#e0e0e0' : '#333',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {username || 'user'}
        </Typography>
        <Tooltip title="Disconnect Hugging Face" arrow placement="top">
          <IconButton
            size="small"
            onClick={handleLogout}
            sx={{
              width: 22,
              height: 22,
              color: darkMode ? '#777' : '#999',
              '&:hover': {
                color: darkMode ? '#ccc' : '#555',
                bgcolor: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              },
            }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
    );
  }

  // --- Logged-out state ---
  return (
    <Box
      sx={{
        mx: 3,
        mb: 1,
        py: 1.5,
        px: 2,
        borderRadius: '10px',
        bgcolor: darkMode ? 'rgba(255, 149, 0, 0.04)' : 'rgba(255, 149, 0, 0.03)',
        border: `1px solid ${darkMode ? 'rgba(255, 149, 0, 0.12)' : 'rgba(255, 149, 0, 0.08)'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>🤗</Typography>
        <Button
          size="small"
          disabled={isLoading || isWaitingForAuth}
          onClick={handleLogin}
          startIcon={
            isLoading || isWaitingForAuth ? (
              <CircularProgress size={12} sx={{ color: 'inherit' }} />
            ) : null
          }
          sx={{
            flex: 1,
            py: 0.75,
            px: 2,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'none',
            borderRadius: '8px',
            color: '#fff',
            background: 'linear-gradient(135deg, #FF9500, #E08500)',
            boxShadow: 'none',
            transition: 'all 0.2s ease',
            '&:hover': {
              background: 'linear-gradient(135deg, #FFa520, #E89510)',
              boxShadow: '0 2px 8px rgba(255, 149, 0, 0.3)',
            },
            '&:disabled': {
              color: 'rgba(255,255,255,0.7)',
              background: darkMode ? 'rgba(255, 149, 0, 0.3)' : 'rgba(255, 149, 0, 0.4)',
            },
          }}
        >
          {isWaitingForAuth
            ? 'Waiting for login...'
            : isLoading
              ? 'Connecting...'
              : 'Login with Hugging Face'}
        </Button>
      </Box>

      <Typography
        sx={{
          fontSize: 11,
          color: darkMode ? '#666' : '#999',
          pl: 3.5, // align with button (after emoji)
        }}
      >
        Access private spaces and exclusive apps
      </Typography>

      {error && (
        <Typography
          sx={{
            fontSize: 11,
            color: '#ef4444',
            pl: 3.5,
          }}
        >
          {error}
        </Typography>
      )}
    </Box>
  );
}
