import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Box, Typography, CircularProgress, Button, Link } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import reachyUpdateBoxSvg from '../../assets/reachy-update-box.svg';
import useAppStore from '../../store/useAppStore';
import PulseButton from '@components/PulseButton';
import { useWirelessDaemonUpdate } from '../../hooks/daemon';
import { useConnection, ConnectionMode } from '../../hooks/useConnection';
import { telemetry } from '../../utils/telemetry';
import type { WirelessUpdateState } from '../../types/store';
import {
  ACCENT,
  BLUR,
  FONT_WEIGHT,
  RADIUS,
  STATUS,
  TYPO,
  blackAlpha,
  hexToRgba,
  useAppPalette,
  whiteAlpha,
} from '@styles';

/**
 * WirelessUpdateRequiredView
 *
 * Blocking screen shown when the WiFi pre-flight detected a daemon older
 * than `MIN_WIRELESS_DAEMON_VERSION`. Drives the daemon's own
 * `/update/start` endpoint via `useWirelessDaemonUpdate`, displays the
 * streamed install logs, and on success offers a "Connect now" CTA that
 * resumes the normal `connect(WIFI, host)` flow.
 *
 * Visual language is deliberately aligned with `UpdateView` (same hero
 * SVG, same PulseButton, same LogConsole-ish bottom strip) so users
 * recognise it as "the update screen, but for the robot".
 */
export default function WirelessUpdateRequiredView() {
  const palette = useAppPalette();
  const isDark = palette.isDark;

  const { wirelessUpdate, cancelWirelessUpdate, resetWirelessUpdate } = useAppStore(
    useShallow(state => ({
      wirelessUpdate: state.wirelessUpdate as WirelessUpdateState,
      cancelWirelessUpdate: state.cancelWirelessUpdate,
      resetWirelessUpdate: state.resetWirelessUpdate,
    }))
  );

  const { startUpdate, checkInternet } = useWirelessDaemonUpdate();
  const { connect, isConnecting } = useConnection();

  // Internet pre-check: runs once on mount so we can disable the CTA when
  // the robot can't reach PyPI. Re-armed by the "Retry" button after a
  // failed attempt.
  type InternetState = 'checking' | 'online' | 'offline' | 'error';
  const [internet, setInternet] = useState<InternetState>('checking');
  const [internetReason, setInternetReason] = useState<string | null>(null);
  const checkSeqRef = useRef(0);

  const runInternetCheck = useMemo(
    () => async () => {
      const seq = ++checkSeqRef.current;
      setInternet('checking');
      setInternetReason(null);
      const result = await checkInternet();
      // Drop stale results if a newer check superseded this one.
      if (seq !== checkSeqRef.current) return;
      if (result.ok) {
        setInternet('online');
      } else if (result.reason === 'pypi_unreachable') {
        setInternet('offline');
        setInternetReason('Robot is online but cannot reach PyPI.');
      } else {
        setInternet('error');
        setInternetReason(result.reason ?? null);
      }
    },
    [checkInternet]
  );

  useEffect(() => {
    void runInternetCheck();
  }, [runInternetCheck]);

  // Auto-scroll the log box to the bottom as new lines arrive.
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [wirelessUpdate.logs.length]);

  const status = wirelessUpdate.status;
  const isInProgress =
    status === 'pre-check' ||
    status === 'updating' ||
    status === 'restarting' ||
    status === 'verifying';
  const isSucceeded = status === 'succeeded';
  const isErrored = status === 'error';

  const stageLabel = (() => {
    switch (status) {
      case 'pre-check':
        return 'Checking robot Internet...';
      case 'updating':
        return 'Updating daemon (this can take 1-2 minutes)...';
      case 'restarting':
        return 'Daemon restarting...';
      case 'verifying':
        return 'Verifying new version...';
      default:
        return null;
    }
  })();

  const handleCancel = (): void => {
    telemetry.wirelessUpdateCancelled({
      from_version: wirelessUpdate.currentVersion,
      min_version: wirelessUpdate.minVersion ?? 'unknown',
    });
    cancelWirelessUpdate();
  };

  const handleConnect = async (): Promise<void> => {
    if (!wirelessUpdate.targetHost) return;
    const host = wirelessUpdate.targetHost;
    // Drop the update flag BEFORE calling connect: otherwise the view
    // router would briefly render us again on the next render tick.
    resetWirelessUpdate();
    await connect(ConnectionMode.WIFI, { host });
  };

  return (
    <Box
      sx={{
        width: '100vw',
        height: '100vh',
        background: palette.surfaceCard,
        backdropFilter: BLUR.lg,
        WebkitBackdropFilter: BLUR.lg,
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          px: 4,
        }}
      >
        {/* Hero icon */}
        <Box sx={{ mb: 3 }}>
          <img src={reachyUpdateBoxSvg} alt="Reachy Update" style={{ width: 200, height: 200 }} />
        </Box>

        {/* Title */}
        <Typography
          sx={{
            fontSize: 24,
            fontWeight: FONT_WEIGHT.semibold,
            color: palette.textPrimary,
            mb: 1,
            textAlign: 'center',
          }}
        >
          Robot update required
        </Typography>

        {/* Version diff */}
        <Typography
          sx={{
            fontSize: TYPO.md,
            color: palette.textSecondary,
            textAlign: 'center',
            maxWidth: 420,
            lineHeight: 1.6,
            mb: 0.5,
          }}
        >
          Your Reachy Mini&apos;s software is too old for this version of the app.
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.sm,
            color: palette.textFaint,
            textAlign: 'center',
            mb: 2.5,
            fontFamily: 'SF Mono, Monaco, Menlo, monospace',
          }}
        >
          {wirelessUpdate.currentVersion ? `v${wirelessUpdate.currentVersion}` : 'unknown'}
          {'  →  '}
          {wirelessUpdate.minVersion ? `v${wirelessUpdate.minVersion}+` : 'unknown'}
        </Typography>

        {/* Release notes link (idle / pre-update only) */}
        {status === 'idle' && (
          <Link
            href="https://huggingface.co/spaces/pollen-robotics/Reachy_Mini#/download?scrollTo=release-notes"
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              color: palette.textMuted,
              fontSize: TYPO.sm,
              textDecoration: 'none',
              mb: 2,
              '&:hover': { color: ACCENT.main },
            }}
          >
            View release notes
            <OpenInNewIcon sx={{ fontSize: TYPO.md }} />
          </Link>
        )}

        {/* Stage indicator + spinner during the flow */}
        {isInProgress && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              mb: 1.5,
              minHeight: 28,
            }}
          >
            <CircularProgress size={16} thickness={3} sx={{ color: ACCENT.main }} />
            <Typography
              sx={{
                fontSize: TYPO.body,
                color: palette.textSecondary,
                fontWeight: FONT_WEIGHT.medium,
              }}
            >
              {stageLabel}
            </Typography>
          </Box>
        )}

        {/* Live log strip during update / restart / verifying */}
        {(isInProgress || (isErrored && wirelessUpdate.logs.length > 0)) && (
          <Box
            ref={logBoxRef}
            sx={{
              width: '100%',
              maxWidth: 480,
              maxHeight: 140,
              minHeight: 80,
              overflowY: 'auto',
              mb: 2,
              p: 1.25,
              borderRadius: RADIUS.md,
              border: `1px solid ${palette.border}`,
              bgcolor: isDark ? blackAlpha(0.4) : blackAlpha(0.03),
              fontFamily: 'SF Mono, Monaco, Menlo, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              color: palette.textMuted,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {wirelessUpdate.logs.length === 0 ? (
              <Box sx={{ color: palette.textFaint, fontStyle: 'italic' }}>
                Waiting for daemon logs...
              </Box>
            ) : (
              wirelessUpdate.logs.map((line, idx) => <div key={idx}>{line}</div>)
            )}
          </Box>
        )}

        {/* Success state */}
        {isSucceeded && (
          <Box sx={{ textAlign: 'center', mb: 1, maxWidth: 380 }}>
            <Typography
              sx={{
                fontSize: TYPO.body,
                color: STATUS.success,
                fontWeight: FONT_WEIGHT.semibold,
                mb: 1,
              }}
            >
              Update complete.
            </Typography>
          </Box>
        )}

        {/* Error state */}
        {isErrored && wirelessUpdate.error && (
          <Box sx={{ textAlign: 'center', mb: 1, maxWidth: 460 }}>
            <Typography
              sx={{
                fontSize: TYPO.body,
                color: STATUS.error,
                fontWeight: FONT_WEIGHT.medium,
                mb: 0.5,
                lineHeight: 1.5,
              }}
            >
              {wirelessUpdate.error}
            </Typography>
          </Box>
        )}

        {/* Internet pre-check banner (idle state, before first attempt) */}
        {status === 'idle' && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              mb: 1.5,
              px: 1.5,
              py: 0.75,
              borderRadius: RADIUS.md,
              bgcolor:
                internet === 'online'
                  ? hexToRgba(STATUS.success, isDark ? 0.1 : 0.06)
                  : internet === 'offline' || internet === 'error'
                    ? hexToRgba(STATUS.error, isDark ? 0.1 : 0.06)
                    : palette.surfaceSubtle,
              border: '1px solid',
              borderColor:
                internet === 'online'
                  ? hexToRgba(STATUS.success, isDark ? 0.3 : 0.2)
                  : internet === 'offline' || internet === 'error'
                    ? hexToRgba(STATUS.error, isDark ? 0.3 : 0.2)
                    : palette.border,
              minHeight: 30,
            }}
          >
            {internet === 'checking' ? (
              <>
                <CircularProgress size={10} thickness={4} sx={{ color: palette.textMuted }} />
                <Typography sx={{ fontSize: TYPO.xs, color: palette.textMuted }}>
                  Checking robot Internet...
                </Typography>
              </>
            ) : internet === 'online' ? (
              <Typography
                sx={{
                  fontSize: TYPO.xs,
                  color: STATUS.success,
                  fontWeight: FONT_WEIGHT.medium,
                }}
              >
                Robot can reach PyPI - ready to update.
              </Typography>
            ) : (
              <Typography
                sx={{
                  fontSize: TYPO.xs,
                  color: STATUS.error,
                  fontWeight: FONT_WEIGHT.medium,
                }}
              >
                {internetReason ??
                  'Robot has no Internet access. Connect it to a network with Internet, then retry.'}
              </Typography>
            )}
          </Box>
        )}

        {/* Action buttons */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 1.25,
            mt: 1,
            width: '100%',
            maxWidth: 280,
          }}
        >
          {status === 'idle' && (
            <PulseButton
              onClick={() => void startUpdate()}
              disabled={internet !== 'online'}
              darkMode={isDark}
              pulse={internet === 'online'}
              size="medium"
              sx={{ minWidth: 200 }}
            >
              Update now
            </PulseButton>
          )}

          {isErrored && (
            <PulseButton
              onClick={() => {
                void runInternetCheck();
                void startUpdate();
              }}
              darkMode={isDark}
              pulse
              size="medium"
              sx={{ minWidth: 200 }}
            >
              Retry update
            </PulseButton>
          )}

          {isSucceeded && (
            <PulseButton
              onClick={() => void handleConnect()}
              disabled={isConnecting}
              darkMode={isDark}
              pulse
              size="medium"
              sx={{ minWidth: 200 }}
            >
              {isConnecting ? 'Connecting...' : 'Connect now'}
            </PulseButton>
          )}

          {/* Cancel escape hatch: always available except mid-restart, where
              cancelling could leave the daemon in a half-updated state. */}
          {status !== 'restarting' && status !== 'verifying' && (
            <Button
              variant="text"
              onClick={handleCancel}
              sx={{
                color: palette.textMuted,
                fontWeight: FONT_WEIGHT.medium,
                fontSize: TYPO.body,
                py: 0.5,
                textTransform: 'none',
                '&:hover': {
                  bgcolor: isDark ? whiteAlpha(0.05) : blackAlpha(0.04),
                },
              }}
            >
              Cancel and disconnect
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}
