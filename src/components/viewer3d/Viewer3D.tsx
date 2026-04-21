import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { IconButton, Tooltip, Box, Typography } from '@mui/material';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import CircleIcon from '@mui/icons-material/Circle';
import * as THREE from 'three';
import Scene from './Scene';
import { useRobotWebSocket } from './hooks';
import useAppStore from '../../store/useAppStore';
import { selectIsBusy } from '../../store/slices';
import { ROBOT_STATUS } from '../../constants/robotStatus';
import { arraysEqual } from '../../utils/arraysEqual';
import SettingsOverlay from './SettingsOverlay';
import { FPSMeter } from '../FPSMeter';
import type { BusyReason, RobotStatus } from '../../types/robot';

function WebGLCleanup(): null {
  const { gl, scene } = useThree();

  useEffect(() => {
    return () => {
      scene?.traverse(object => {
        const withResources = object as THREE.Object3D & {
          geometry?: THREE.BufferGeometry;
          material?: THREE.Material | THREE.Material[];
        };
        if (withResources.geometry) {
          withResources.geometry.dispose();
        }
        if (withResources.material) {
          if (Array.isArray(withResources.material)) {
            withResources.material.forEach(material => material.dispose());
          } else {
            withResources.material.dispose();
          }
        }
      });

      gl?.dispose();

      const loseContext = gl?.getContext()?.getExtension('WEBGL_lose_context') as {
        loseContext: () => void;
      } | null;
      if (loseContext) {
        loseContext.loseContext();
      }
    };
  }, [gl, scene]);

  return null;
}

interface CameraPresetConfig {
  position: [number, number, number];
  fov: number;
  target: [number, number, number];
  minDistance: number;
  maxDistance: number;
}

const CAMERA_PRESETS: Record<'normal' | 'scan', CameraPresetConfig> = {
  normal: {
    position: [-0.25, 0.35, 0.55],
    fov: 50,
    target: [0, 0.2, 0],
    minDistance: 0.2,
    maxDistance: 0.6,
  },
  scan: {
    position: [0, 0.22, 0.5],
    fov: 55,
    target: [0, 0.12, 0],
    minDistance: 0.15,
    maxDistance: 0.5,
  },
};

interface StatusTag {
  label: string;
  color: string;
  animated?: boolean;
}

export interface RobotViewer3DProps {
  isActive: boolean;
  initialMode?: 'normal' | 'xray';
  hideControls?: boolean;
  forceLoad?: boolean;
  hideGrid?: boolean;
  hideBorder?: boolean;
  showScanEffect?: boolean;
  usePremiumScan?: boolean;
  onScanComplete?: (() => void) | null;
  onScanMesh?: ((mesh: THREE.Mesh, index: number, total: number) => void) | null;
  onMeshesReady?: ((meshes: THREE.Mesh[]) => void) | null;
  cameraPreset?: 'normal' | 'scan' | Partial<CameraPresetConfig>;
  useCinematicCamera?: boolean;
  errorFocusMesh?: THREE.Mesh | null;
  backgroundColor?: string;
  wireframe?: boolean;
  antennas?: number[] | null;
  headPose?: number[] | null;
  headJoints?: number[] | null;
  yawBody?: number | null;
  showStatusTag?: boolean;
  isOn?: boolean | null;
  isMoving?: boolean;
  robotStatus?: RobotStatus | null;
  busyReason?: BusyReason | null;
  hideEffects?: boolean;
  canvasScale?: number;
  canvasTranslateX?: number | string;
  canvasTranslateY?: number | string;
}

export default function RobotViewer3D({
  isActive,
  initialMode = 'normal',
  hideControls = false,
  forceLoad = false,
  hideGrid = false,
  hideBorder = false,
  showScanEffect = false,
  usePremiumScan = false,
  onScanComplete = null,
  onScanMesh = null,
  onMeshesReady = null,
  cameraPreset = 'normal',
  useCinematicCamera = false,
  errorFocusMesh = null,
  backgroundColor = '#e0e0e0',
  wireframe = false,
  antennas = null,
  headPose = null,
  headJoints = null,
  yawBody = null,
  showStatusTag = false,
  isOn = null,
  isMoving = false,
  robotStatus = null,
  busyReason = null,
  hideEffects = false,
  canvasScale = 1,
  canvasTranslateX = 0,
  canvasTranslateY = 0,
}: RobotViewer3DProps): React.ReactElement {
  const cameraConfig: CameraPresetConfig =
    typeof cameraPreset === 'string'
      ? CAMERA_PRESETS[cameraPreset]
      : { ...CAMERA_PRESETS.normal, ...cameraPreset };

  const shouldConnectWebSocket = isActive || (forceLoad && headJoints !== null);
  const robotState = useRobotWebSocket(shouldConnectWebSocket);

  const prevAntennasRef = useRef<number[] | null>(null);
  const prevHeadPoseRef = useRef<number[] | null>(null);
  const prevHeadJointsRef = useRef<number[] | null>(null);
  const prevYawBodyRef = useRef<number | null>(null);
  const prevPassiveJointsRef = useRef<number[] | { array?: number[] } | null>(null);

  useEffect(() => {
    if (!shouldConnectWebSocket) {
      prevAntennasRef.current = null;
      prevHeadPoseRef.current = null;
      prevHeadJointsRef.current = null;
      prevYawBodyRef.current = null;
      prevPassiveJointsRef.current = null;
    }
  }, [shouldConnectWebSocket]);

  const finalAntennas = useMemo<number[]>(() => {
    const value =
      antennas !== null
        ? antennas
        : shouldConnectWebSocket
          ? robotState.antennas || [0, 0]
          : [0, 0];
    if (!arraysEqual(value, prevAntennasRef.current)) {
      prevAntennasRef.current = value;
      return value;
    }
    return prevAntennasRef.current || value;
  }, [antennas, shouldConnectWebSocket, robotState.antennas]);

  const finalHeadPose = useMemo<number[] | null>(() => {
    const value =
      headPose !== null ? headPose : shouldConnectWebSocket ? robotState.headPose : null;
    if (value && (!prevHeadPoseRef.current || !arraysEqual(value, prevHeadPoseRef.current))) {
      prevHeadPoseRef.current = value;
      return value;
    }
    if (!value && prevHeadPoseRef.current) {
      prevHeadPoseRef.current = null;
      return null;
    }
    return prevHeadPoseRef.current || value;
  }, [headPose, shouldConnectWebSocket, robotState.headPose]);

  const finalHeadJoints = useMemo<number[] | null>(() => {
    const value =
      headJoints !== null ? headJoints : shouldConnectWebSocket ? robotState.headJoints : null;
    if (value && (!prevHeadJointsRef.current || !arraysEqual(value, prevHeadJointsRef.current))) {
      prevHeadJointsRef.current = value;
      return value;
    }
    if (!value && prevHeadJointsRef.current) {
      prevHeadJointsRef.current = null;
      return null;
    }
    return prevHeadJointsRef.current || value;
  }, [headJoints, shouldConnectWebSocket, robotState.headJoints]);

  const finalYawBody = useMemo<number | null>(() => {
    const value = yawBody !== null ? yawBody : shouldConnectWebSocket ? robotState.yawBody : null;
    if (
      value !== undefined &&
      value !== null &&
      Math.abs(value - (prevYawBodyRef.current ?? 0)) > 0.005
    ) {
      prevYawBodyRef.current = value;
      return value;
    }
    return prevYawBodyRef.current ?? value ?? null;
  }, [yawBody, shouldConnectWebSocket, robotState.yawBody]);

  const finalPassiveJoints = useMemo<number[] | { array?: number[] } | null>(() => {
    const value = (shouldConnectWebSocket ? robotState.passiveJoints : null) as
      | number[]
      | { array?: number[] }
      | null;
    const prev = prevPassiveJointsRef.current;
    const prevPassive = Array.isArray(prev) ? prev : prev?.array;
    const currentPassive = Array.isArray(value) ? value : value?.array;
    if (value && (!prevPassiveJointsRef.current || !arraysEqual(currentPassive, prevPassive))) {
      prevPassiveJointsRef.current = value;
      return value;
    }
    if (!value && prevPassiveJointsRef.current) {
      prevPassiveJointsRef.current = null;
      return null;
    }
    return prevPassiveJointsRef.current || value;
  }, [shouldConnectWebSocket, robotState.passiveJoints]);

  const [isTransparent] = useState<boolean>(initialMode === 'xray');
  const [showSettingsOverlay, setShowSettingsOverlay] = useState<boolean>(false);

  const darkMode = useAppStore(state => state.darkMode);
  const isBusy = useAppStore(selectIsBusy);

  const effectiveBackgroundColor =
    backgroundColor === 'transparent'
      ? 'transparent'
      : backgroundColor === '#e0e0e0'
        ? darkMode
          ? '#1a1a1a'
          : '#e0e0e0'
        : backgroundColor;

  const getStatusTag = (): StatusTag => {
    if (robotStatus) {
      switch (robotStatus) {
        case ROBOT_STATUS.DISCONNECTED:
          return { label: 'Offline', color: '#999' };

        case ROBOT_STATUS.READY_TO_START:
          return { label: 'Ready to Start', color: '#3b82f6' };

        case ROBOT_STATUS.STARTING:
          return { label: 'Starting', color: '#3b82f6', animated: true };

        case ROBOT_STATUS.SLEEPING:
          return { label: 'Sleeping', color: '#6b7280' };

        case ROBOT_STATUS.READY:
          if (isOn === true) {
            return { label: 'Ready', color: '#22c55e' };
          } else if (isOn === false) {
            return { label: 'Standby', color: '#6b7280' };
          }
          return { label: 'Connected', color: '#3b82f6' };

        case ROBOT_STATUS.BUSY: {
          const busyLabels: Record<BusyReason, StatusTag> = {
            moving: { label: 'Moving', color: '#a855f7' },
            command: { label: 'Executing', color: '#a855f7' },
            'app-running': { label: 'App Running', color: '#a855f7' },
            installing: { label: 'Installing', color: '#3b82f6' },
          };
          const busyInfo = (busyReason && busyLabels[busyReason]) || {
            label: 'Busy',
            color: '#a855f7',
          };
          return { ...busyInfo, animated: true };
        }

        case ROBOT_STATUS.STOPPING:
          return { label: 'Stopping', color: '#ef4444', animated: true };

        case ROBOT_STATUS.CRASHED:
          return { label: 'Crashed', color: '#ef4444' };

        default:
          return { label: 'Unknown', color: '#999' };
      }
    }

    if (!isActive) {
      return { label: 'Offline', color: '#999' };
    }

    if (isMoving) {
      return { label: 'Moving', color: '#a855f7', animated: true };
    }

    if (isOn === true) {
      return { label: 'Ready', color: '#22c55e' };
    }

    if (isOn === false) {
      return { label: 'Standby', color: '#6b7280' };
    }

    return { label: 'Connected', color: '#3b82f6' };
  };

  const status = getStatusTag();

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background:
          effectiveBackgroundColor === 'transparent' ? 'transparent' : effectiveBackgroundColor,
        backgroundColor:
          effectiveBackgroundColor === 'transparent' ? 'transparent' : effectiveBackgroundColor,
        borderRadius: hideBorder ? '0' : '16px',
        position: 'relative',
        overflow: 'visible',
      }}
    >
      <Canvas
        camera={{ position: cameraConfig.position, fov: cameraConfig.fov }}
        dpr={[1, 2]}
        frameloop={hideEffects ? 'demand' : 'always'}
        gl={
          {
            antialias: true,
            alpha: effectiveBackgroundColor === 'transparent',
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance',
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.0,
            // TODO(ts): `outputEncoding` / `sRGBEncoding` are deprecated in newer
            // three.js typings but still honored at runtime. Keep 1:1 behavior.
            outputEncoding: (THREE as unknown as { sRGBEncoding: unknown }).sRGBEncoding,
            stencil: false,
            depth: true,
            logarithmicDepthBuffer: false,
          } as unknown as THREE.WebGLRendererParameters
        }
        onCreated={({ gl }) => {
          gl.sortObjects = false;
          if (effectiveBackgroundColor === 'transparent') {
            gl.setClearColor(0x000000, 0);
          }
        }}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          background:
            effectiveBackgroundColor === 'transparent' ? 'transparent' : effectiveBackgroundColor,
          border: hideBorder
            ? 'none'
            : darkMode
              ? '1px solid rgba(255, 255, 255, 0.08)'
              : '1px solid rgba(0, 0, 0, 0.08)',
          borderRadius: hideBorder ? '0' : '16px',
          transform: `scale(${canvasScale}) translate(${canvasTranslateX}, ${canvasTranslateY})`,
          transformOrigin: 'center center',
        }}
      >
        <WebGLCleanup />
        {effectiveBackgroundColor !== 'transparent' && (
          <color attach="background" args={[effectiveBackgroundColor]} />
        )}
        <Scene
          headPose={finalHeadPose}
          headJoints={finalHeadJoints}
          passiveJoints={finalPassiveJoints}
          yawBody={finalYawBody ?? undefined}
          antennas={finalAntennas}
          isActive={isActive}
          isTransparent={isTransparent}
          wireframe={wireframe}
          forceLoad={forceLoad}
          hideGrid={hideGrid}
          showScanEffect={showScanEffect}
          usePremiumScan={usePremiumScan}
          onScanComplete={onScanComplete}
          onScanMesh={onScanMesh}
          onMeshesReady={onMeshesReady}
          cameraConfig={cameraConfig}
          useCinematicCamera={useCinematicCamera}
          errorFocusMesh={errorFocusMesh}
          hideEffects={hideEffects}
          darkMode={darkMode}
          dataVersion={robotState.dataVersion}
        />
      </Canvas>

      {!hideControls && (
        <Box
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            zIndex: 10,
          }}
        >
          <Tooltip title="Settings" placement="top" arrow>
            <span>
              <IconButton
                onClick={() => setShowSettingsOverlay(true)}
                size="small"
                disabled={isBusy}
                sx={{
                  width: 36,
                  height: 36,
                  transition: 'all 0.2s ease',
                  color: isBusy ? (darkMode ? '#666' : '#999') : '#FF9500',
                  bgcolor: darkMode ? 'rgba(26, 26, 26, 0.95)' : 'rgba(255, 255, 255, 0.95)',
                  border: '1px solid',
                  borderColor: isBusy
                    ? darkMode
                      ? 'rgba(255, 255, 255, 0.1)'
                      : 'rgba(0, 0, 0, 0.1)'
                    : darkMode
                      ? 'rgba(255, 149, 0, 0.5)'
                      : 'rgba(255, 149, 0, 0.4)',
                  backdropFilter: 'blur(10px)',
                  boxShadow: darkMode
                    ? '0 2px 8px rgba(0, 0, 0, 0.3)'
                    : '0 2px 8px rgba(0, 0, 0, 0.08)',
                  opacity: isBusy ? 0.4 : 1,
                  '&:hover': {
                    bgcolor: darkMode ? 'rgba(255, 149, 0, 0.15)' : 'rgba(255, 149, 0, 0.1)',
                    borderColor: '#FF9500',
                    transform: isBusy ? 'none' : 'scale(1.05)',
                  },
                  '&:active': {
                    transform: isBusy ? 'none' : 'scale(0.95)',
                  },
                  '&.Mui-disabled': {
                    bgcolor: darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.6)',
                    color: darkMode ? '#666' : '#999',
                    borderColor: darkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
                  },
                }}
              >
                <SettingsOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      )}

      {!hideControls && import.meta.env.DEV && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 50,
            left: 12,
            zIndex: 11,
          }}
        >
          <FPSMeter darkMode={darkMode} />
        </Box>
      )}

      {!hideControls && showStatusTag && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.5,
            py: 0.75,
            borderRadius: '10px',
            bgcolor: darkMode ? 'rgba(26, 26, 26, 0.95)' : 'rgba(255, 255, 255, 0.95)',
            border: `1.5px solid ${
              status.color === '#22c55e'
                ? 'rgba(34, 197, 94, 0.3)'
                : status.color === '#6b7280'
                  ? 'rgba(107, 114, 128, 0.3)'
                  : status.color === '#3b82f6'
                    ? 'rgba(59, 130, 246, 0.3)'
                    : status.color === '#a855f7'
                      ? 'rgba(168, 85, 247, 0.35)'
                      : status.color === '#ef4444'
                        ? 'rgba(239, 68, 68, 0.4)'
                        : status.color === '#999'
                          ? 'rgba(153, 153, 153, 0.25)'
                          : 'rgba(0, 0, 0, 0.12)'
            }`,
            backdropFilter: 'blur(10px)',
            transition: 'none',
            zIndex: 10,
          }}
        >
          <CircleIcon
            sx={{
              fontSize: 7,
              color: status.color,
              ...(status.animated && {
                animation: 'pulse-dot 1.5s ease-in-out infinite',
                '@keyframes pulse-dot': {
                  '0%, 100%': {
                    opacity: 1,
                    transform: 'scale(1)',
                  },
                  '50%': {
                    opacity: 0.6,
                    transform: 'scale(1.3)',
                  },
                },
              }),
            }}
          />
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 600,
              color: status.color,
              letterSpacing: '0.2px',
            }}
          >
            {status.label}
          </Typography>
        </Box>
      )}

      <SettingsOverlay
        open={showSettingsOverlay}
        onClose={() => setShowSettingsOverlay(false)}
        darkMode={darkMode}
      />
    </div>
  );
}
