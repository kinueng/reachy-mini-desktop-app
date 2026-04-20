import { useEffect, useRef } from 'react';
import { useController, ControllerMode } from '../context/ControllerContext';
import { useActiveRobotContext } from '../../context';
import type { HeadPose } from '@utils/targetSmoothing';

const SYNC_TOLERANCE = 0.01;
const MAJOR_CHANGE_TOLERANCE = 0.1;

interface RobotValues {
  headPose: HeadPose;
  bodyYaw: number;
  antennas: [number, number];
}

interface StateLike {
  headPose: HeadPose;
  bodyYaw: number;
  antennas: [number, number];
}

// TODO(ts): RobotStateData.head_pose is declared as HeadPoseMatrix (number[]) in
// src/types/robot.ts, but runtime data is actually an object with x/y/z/pitch/yaw/roll.
// Using a local cast here until the upstream type is reconciled.
interface HeadPoseObjectData {
  head_pose?: Partial<HeadPose> & Record<string, number | undefined>;
  body_yaw?: number;
  antennas_position?: [number, number];
}

export function useControllerSync(): void {
  const { state, actions, smoother, isDragging, isActive } = useController();
  const { robotState } = useActiveRobotContext();
  const robotStateFull = robotState.robotStateFull;

  const lastSyncTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!isActive || !robotStateFull?.data) return;

    const data = robotStateFull.data as unknown as HeadPoseObjectData;
    if (!data.head_pose) return;

    const robotValues: RobotValues = {
      headPose: {
        x: data.head_pose.x || 0,
        y: data.head_pose.y || 0,
        z: data.head_pose.z || 0,
        pitch: data.head_pose.pitch || 0,
        yaw: data.head_pose.yaw || 0,
        roll: data.head_pose.roll || 0,
      },
      bodyYaw: typeof data.body_yaw === 'number' ? data.body_yaw : 0,
      antennas: (data.antennas_position || [0, 0]) as [number, number],
    };

    if (isDragging) return;

    if (state.mode !== ControllerMode.IDLE) return;

    const timeSinceInteraction = Date.now() - state.lastInteractionTime;
    if (timeSinceInteraction < 30000) return;

    const hasMajorChange = checkMajorChange(state, robotValues);
    if (!hasMajorChange) return;

    const targetValues = smoother.getTargetValues();
    const isCloseToTarget = isCloseEnough(robotValues, targetValues, SYNC_TOLERANCE);
    if (isCloseToTarget) return;

    actions.syncFromRobot(robotValues);
    smoother.sync(robotValues);
    lastSyncTimeRef.current = Date.now();
  }, [isActive, robotStateFull, state, isDragging, actions, smoother]);
}

function checkMajorChange(state: StateLike, robotValues: RobotValues): boolean {
  const headDiff =
    Math.abs(state.headPose.x - robotValues.headPose.x) +
    Math.abs(state.headPose.y - robotValues.headPose.y) +
    Math.abs(state.headPose.z - robotValues.headPose.z) +
    Math.abs(state.headPose.pitch - robotValues.headPose.pitch) +
    Math.abs(state.headPose.yaw - robotValues.headPose.yaw) +
    Math.abs(state.headPose.roll - robotValues.headPose.roll);

  const bodyYawDiff = Math.abs(state.bodyYaw - robotValues.bodyYaw);

  const antennasDiff =
    Math.abs(state.antennas[0] - robotValues.antennas[0]) +
    Math.abs(state.antennas[1] - robotValues.antennas[1]);

  return (
    headDiff > MAJOR_CHANGE_TOLERANCE ||
    bodyYawDiff > MAJOR_CHANGE_TOLERANCE ||
    antennasDiff > MAJOR_CHANGE_TOLERANCE
  );
}

function isCloseEnough(
  values1: { headPose: HeadPose; bodyYaw: number; antennas: [number, number] | number[] },
  values2: { headPose: HeadPose; bodyYaw: number; antennas: [number, number] | number[] },
  tolerance: number
): boolean {
  const headClose =
    Math.abs(values1.headPose.x - values2.headPose.x) < tolerance &&
    Math.abs(values1.headPose.y - values2.headPose.y) < tolerance &&
    Math.abs(values1.headPose.z - values2.headPose.z) < tolerance &&
    Math.abs(values1.headPose.pitch - values2.headPose.pitch) < tolerance &&
    Math.abs(values1.headPose.yaw - values2.headPose.yaw) < tolerance &&
    Math.abs(values1.headPose.roll - values2.headPose.roll) < tolerance;

  const bodyYawClose = Math.abs(values1.bodyYaw - values2.bodyYaw) < tolerance;

  const antennasClose =
    Math.abs(values1.antennas[0] - values2.antennas[0]) < tolerance &&
    Math.abs(values1.antennas[1] - values2.antennas[1]) < tolerance;

  return headClose && bodyYawClose && antennasClose;
}
