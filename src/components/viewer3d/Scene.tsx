import React, { useState, useMemo, useEffect, useRef, memo } from 'react';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import URDFRobot from './URDFRobot';
import ScanEffect from './effects/ScanEffect';
import PremiumScanEffect from './effects/PremiumScanEffect';
import ErrorHighlight from './effects/ErrorHighlight';
import CinematicCamera from './CinematicCamera';
import useAppStore from '../../store/useAppStore';
import { DAEMON_CONFIG } from '../../config/daemon';

// TODO(ts): URDFLoader augments the robot root with `links` and joint helpers.
// These aren't exposed in the upstream RobotModel type, widen locally.
interface URDFLinkedObject extends THREE.Object3D {
  links?: Record<string, THREE.Object3D>;
}

interface CameraConfig {
  position?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
  minDistance?: number;
  maxDistance?: number;
}

export interface SceneProps {
  headPose?: number[] | null;
  headJoints?: number[] | null;
  passiveJoints?: number[] | { array?: number[] } | null;
  yawBody?: number;
  antennas?: number[] | null;
  isActive: boolean;
  isTransparent?: boolean;
  wireframe?: boolean;
  forceLoad?: boolean;
  hideGrid?: boolean;
  showScanEffect?: boolean;
  usePremiumScan?: boolean;
  onScanComplete?: (() => void) | null;
  onScanMesh?: ((mesh: THREE.Mesh, index: number, total: number) => void) | null;
  onMeshesReady?: ((meshes: THREE.Mesh[]) => void) | null;
  cameraConfig?: CameraConfig;
  useCinematicCamera?: boolean;
  errorFocusMesh?: THREE.Mesh | null;
  hideEffects?: boolean;
  darkMode?: boolean;
  dataVersion?: number;
}

function Scene({
  headPose,
  headJoints,
  passiveJoints,
  yawBody,
  antennas,
  isActive,
  isTransparent,
  wireframe = false,
  forceLoad = false,
  hideGrid = false,
  showScanEffect = false,
  usePremiumScan = false,
  onScanComplete = null,
  onScanMesh = null,
  onMeshesReady = null,
  cameraConfig = {},
  useCinematicCamera = false,
  errorFocusMesh = null,
  hideEffects: _hideEffects = false,
  darkMode = false,
  dataVersion = 0,
}: SceneProps): React.ReactElement {
  void _hideEffects;
  const [outlineMeshes, setOutlineMeshes] = useState<THREE.Mesh[]>([]);
  const [robotRef, setRobotRef] = useState<URDFLinkedObject | null>(null);

  useEffect(() => {
    if (onMeshesReady && outlineMeshes.length > 0) {
      onMeshesReady(outlineMeshes);
    }
  }, [onMeshesReady, outlineMeshes]);

  const lastHeadJointsRef = useRef<number[] | null>(null);
  const lastHasPassiveJointsRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (headJoints && headJoints.length === 7) {
      const headJointsChanged =
        !lastHeadJointsRef.current ||
        headJoints.some((v, i) => Math.abs(v - (lastHeadJointsRef.current?.[i] || 0)) > 0.001);
      const hasPassiveJoints = !!passiveJoints;
      const passiveJointsChanged = hasPassiveJoints !== lastHasPassiveJointsRef.current;

      if (headJointsChanged || passiveJointsChanged) {
        (window as unknown as { kinematics: unknown }).kinematics = {
          headJoints,
          passiveJoints,
          headPose,
          timestamp: new Date().toISOString(),
        };
        lastHeadJointsRef.current = headJoints;
        lastHasPassiveJointsRef.current = hasPassiveJoints;
      }
    }
  }, [headJoints, passiveJoints, headPose]);

  // scanDuration kept for parity with original (unused variable was
  // present in JS version as well, preserved 1:1 runtime behavior).
  const scanDuration = DAEMON_CONFIG.ANIMATIONS.SCAN_DURATION / 1000;
  void scanDuration;

  const { activeEffect } = useAppStore();

  const cellShading = {
    bands: 100,
    smoothness: 0.45,
    rimIntensity: 0.4,
    specularIntensity: 0.3,
    ambientIntensity: 0.45,
    contrastBoost: 0.9,
    outlineEnabled: true,
    outlineThickness: 12.0,
    outlineColor: '#000000',
  };
  void cellShading;
  const lighting = {
    ambient: 0.3,
    keyIntensity: 1.8,
    fillIntensity: 0.3,
    rimIntensity: 0.8,
  };
  const xraySettings = {
    opacity: darkMode ? 0.05 : 0.2,
  };
  const scene = {
    showGrid: true,
    fogDistance: 2.5,
  };

  const headPositionVectorRef = useRef(new THREE.Vector3());

  const headPosition = useMemo<[number, number, number]>(() => {
    if (!robotRef) return [0, 0.18, 0.02];

    const cameraLink = robotRef.links?.['camera'];
    if (cameraLink) {
      cameraLink.getWorldPosition(headPositionVectorRef.current);

      return [
        headPositionVectorRef.current.x,
        headPositionVectorRef.current.y + 0.03,
        headPositionVectorRef.current.z + 0.02,
      ];
    }

    const headLink = robotRef.links?.['xl_330'];
    if (headLink) {
      headLink.getWorldPosition(headPositionVectorRef.current);
      return [
        headPositionVectorRef.current.x,
        headPositionVectorRef.current.y + 0.03,
        headPositionVectorRef.current.z + 0.02,
      ];
    }

    return [0, 0.18, 0.02];
  }, [robotRef, activeEffect]);
  void headPosition;

  const gridHelper = useMemo(() => {
    const majorLineColor = darkMode ? '#555555' : '#999999';
    const minorLineColor = darkMode ? '#333333' : '#cccccc';

    const grid = new THREE.GridHelper(2, 20, majorLineColor, minorLineColor);
    const gridMat = grid.material as THREE.Material & {
      opacity: number;
      transparent: boolean;
      fog: boolean;
    };
    gridMat.opacity = darkMode ? 0.4 : 0.5;
    gridMat.transparent = true;
    gridMat.fog = true;
    return grid;
  }, [darkMode]);

  const errorMeshes = useMemo<THREE.Mesh[] | null>(() => {
    if (!errorFocusMesh) {
      return null;
    }

    if (!robotRef || !outlineMeshes.length) {
      return [errorFocusMesh];
    }

    const collectMeshesFromObject = (
      obj: THREE.Object3D,
      meshes: THREE.Mesh[] = []
    ): THREE.Mesh[] => {
      const maybeMesh = obj as THREE.Mesh & {
        isMesh?: boolean;
        userData: { isOutline?: boolean; [key: string]: unknown };
      };
      if (maybeMesh.isMesh && !maybeMesh.userData.isOutline) {
        meshes.push(maybeMesh);
      }
      if (obj.children) {
        obj.children.forEach(child => {
          collectMeshesFromObject(child, meshes);
        });
      }
      return meshes;
    };

    let isCameraMesh = false;
    let cameraLink: THREE.Object3D | null = null;

    if (robotRef.links?.['camera']) {
      cameraLink = robotRef.links['camera'];
      const cameraMeshes = collectMeshesFromObject(cameraLink, []);
      isCameraMesh = cameraMeshes.includes(errorFocusMesh);

      if (isCameraMesh) {
        return cameraMeshes.length > 0 ? cameraMeshes : [errorFocusMesh];
      }
    }

    let current: THREE.Object3D | null = errorFocusMesh;
    let depth = 0;
    while (current && current.parent && depth < 10) {
      const parentName = (current.parent.name || '').toLowerCase();
      const currentName = (current.name || '').toLowerCase();

      if (parentName.includes('camera') || currentName.includes('camera')) {
        isCameraMesh = true;
        break;
      }
      current = current.parent;
      depth++;
    }

    if (isCameraMesh) {
      if (cameraLink) {
        const cameraMeshes = collectMeshesFromObject(cameraLink, []);
        return cameraMeshes.length > 0 ? cameraMeshes : [errorFocusMesh];
      }

      const cameraMeshes: THREE.Mesh[] = [];
      outlineMeshes.forEach(mesh => {
        let cur: THREE.Object3D | null = mesh;
        let d = 0;
        while (cur && cur.parent && d < 10) {
          const parentName = (cur.parent.name || '').toLowerCase();
          const currentName = (cur.name || '').toLowerCase();
          if (parentName.includes('camera') || currentName.includes('camera')) {
            cameraMeshes.push(mesh);
            break;
          }
          cur = cur.parent;
          d++;
        }
      });

      return cameraMeshes.length > 0 ? cameraMeshes : [errorFocusMesh];
    }

    return [errorFocusMesh];
  }, [errorFocusMesh, robotRef, outlineMeshes]);

  const fogColor = darkMode ? '#1a1a1a' : '#fdfcfa';

  return (
    <>
      <fog attach="fog" args={[fogColor, 1, scene.fogDistance]} />

      <ambientLight intensity={lighting.ambient} />

      <directionalLight
        position={[2, 4, 2]}
        intensity={lighting.keyIntensity}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />

      <directionalLight position={[-2, 2, 1.5]} intensity={lighting.fillIntensity} />

      <directionalLight position={[0, 3, -2]} intensity={lighting.rimIntensity} color="#FFB366" />

      {!hideGrid && scene.showGrid && <primitive object={gridHelper} position={[0, 0, 0]} />}

      <URDFRobot
        headJoints={headJoints}
        passiveJoints={passiveJoints}
        yawBody={yawBody}
        antennas={antennas}
        isActive={isActive}
        isTransparent={isTransparent}
        wireframe={wireframe}
        xrayOpacity={xraySettings.opacity}
        onMeshesReady={setOutlineMeshes}
        onRobotReady={(r: THREE.Object3D) => setRobotRef(r as URDFLinkedObject)}
        forceLoad={forceLoad}
        dataVersion={dataVersion}
      />

      {showScanEffect && (
        <>
          {usePremiumScan ? (
            <PremiumScanEffect
              meshes={outlineMeshes}
              scanColor="#00ff88"
              enabled={true}
              onScanMesh={(mesh, index, total) => {
                if (onScanMesh) {
                  onScanMesh(mesh, index, total);
                }
              }}
              onComplete={() => {
                if (onScanComplete) {
                  onScanComplete();
                }
              }}
            />
          ) : (
            <>
              <ScanEffect
                meshes={outlineMeshes}
                scanColor="#16a34a"
                enabled={true}
                onScanMesh={(mesh, index, total) => {
                  if (onScanMesh) {
                    onScanMesh(mesh, index, total);
                  }
                }}
                onComplete={() => {
                  if (onScanComplete) {
                    onScanComplete();
                  }
                }}
              />
            </>
          )}
        </>
      )}

      {errorFocusMesh && (
        <ErrorHighlight
          errorMesh={errorFocusMesh}
          errorMeshes={errorMeshes}
          allMeshes={outlineMeshes}
          errorColor="#ff0000"
          enabled={true}
        />
      )}

      {useCinematicCamera ? (
        <CinematicCamera
          initialPosition={cameraConfig.position || [0, 0.22, 0.35]}
          target={cameraConfig.target || [0, 0.12, 0]}
          fov={cameraConfig.fov || 55}
          enabled={true}
          errorFocusMesh={errorFocusMesh}
        />
      ) : (
        <OrbitControls
          enablePan={false}
          enableRotate={true}
          enableZoom={true}
          enableDamping={true}
          dampingFactor={0.05}
          target={cameraConfig.target || [0, 0.2, 0]}
          minDistance={cameraConfig.minDistance || 0.2}
          maxDistance={cameraConfig.maxDistance || 10}
        />
      )}
    </>
  );
}

export default memo(Scene, (prevProps, nextProps) => {
  if (
    prevProps.isActive !== nextProps.isActive ||
    prevProps.isTransparent !== nextProps.isTransparent ||
    prevProps.wireframe !== nextProps.wireframe ||
    prevProps.forceLoad !== nextProps.forceLoad ||
    prevProps.hideGrid !== nextProps.hideGrid ||
    prevProps.showScanEffect !== nextProps.showScanEffect ||
    prevProps.useCinematicCamera !== nextProps.useCinematicCamera ||
    prevProps.hideEffects !== nextProps.hideEffects ||
    prevProps.darkMode !== nextProps.darkMode
  ) {
    return false;
  }

  if (prevProps.dataVersion !== nextProps.dataVersion) {
    return false;
  }

  return true;
});
