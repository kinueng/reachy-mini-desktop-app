import { useCallback, useRef } from 'react';
import { useController } from '../context/ControllerContext';
import type { ControllerState } from '../context/ControllerContext';
import { ROBOT_POSITION_RANGES, EXTENDED_ROBOT_RANGES } from '@utils/inputConstants';
import { clamp } from '@utils/inputHelpers';
import type { HeadPose, SmoothedValues } from '@utils/targetSmoothing';

const BODY_YAW_RANGE = { min: (-160 * Math.PI) / 180, max: (160 * Math.PI) / 180 };

interface UseControllerHandlersArgs {
  sendCommand: (headPose: HeadPose, antennas: [number, number] | number[], bodyYaw: number) => void;
}

interface DragSnapshot extends Partial<ControllerState> {
  antennas?: [number, number];
}

interface UseControllerHandlersReturn {
  localValues: {
    headPose: HeadPose;
    bodyYaw: number;
    antennas: [number, number];
  };
  getSmoothedValues: () => SmoothedValues;
  handleChange: (updates: Partial<HeadPose>, continuous?: boolean) => void;
  handleBodyYawChange: (value: number, continuous?: boolean) => void;
  handleAntennasChange: (antenna: 'left' | 'right', value: number, continuous?: boolean) => void;
  handleDragEnd: () => void;
  resetAllValues: () => void;
}

export function useControllerHandlers({
  sendCommand,
}: UseControllerHandlersArgs): UseControllerHandlersReturn {
  const { state, actions, smoother, isActive } = useController();

  const dragStartRef = useRef<DragSnapshot | null>(null);

  const handleHeadPoseChange = useCallback(
    (updates: Partial<HeadPose>, continuous: boolean = false): void => {
      if (!isActive) return;

      const newHeadPose = { ...state.headPose, ...updates };

      const clampedHeadPose: HeadPose = {
        x: clamp(
          newHeadPose.x,
          EXTENDED_ROBOT_RANGES.POSITION.min,
          EXTENDED_ROBOT_RANGES.POSITION.max
        ),
        y: clamp(
          newHeadPose.y,
          EXTENDED_ROBOT_RANGES.POSITION.min,
          EXTENDED_ROBOT_RANGES.POSITION.max
        ),
        z: clamp(
          newHeadPose.z,
          ROBOT_POSITION_RANGES.POSITION.min,
          ROBOT_POSITION_RANGES.POSITION.max
        ),
        pitch: clamp(
          newHeadPose.pitch,
          EXTENDED_ROBOT_RANGES.PITCH.min,
          EXTENDED_ROBOT_RANGES.PITCH.max
        ),
        yaw: clamp(newHeadPose.yaw, EXTENDED_ROBOT_RANGES.YAW.min, EXTENDED_ROBOT_RANGES.YAW.max),
        roll: clamp(
          newHeadPose.roll,
          ROBOT_POSITION_RANGES.ROLL.min,
          ROBOT_POSITION_RANGES.ROLL.max
        ),
      };

      actions.updateHeadPose(clampedHeadPose);
      smoother.setTargets({ headPose: clampedHeadPose });

      if (continuous) {
        if (!dragStartRef.current) {
          dragStartRef.current = { headPose: { ...state.headPose }, bodyYaw: state.bodyYaw };
          actions.startMouseDrag();
        }
      } else {
        dragStartRef.current = null;
        actions.endInteraction();

        requestAnimationFrame(() => {
          const smoothed = smoother.getCurrentValues();
          sendCommand(smoothed.headPose, smoothed.antennas, smoothed.bodyYaw);
        });
      }
    },
    [state.headPose, state.bodyYaw, actions, smoother, sendCommand, isActive]
  );

  const handleBodyYawChange = useCallback(
    (value: number, continuous: boolean = false): void => {
      if (!isActive) return;

      const clampedValue = clamp(
        typeof value === 'number' && !isNaN(value) ? value : 0,
        BODY_YAW_RANGE.min,
        BODY_YAW_RANGE.max
      );

      actions.updateBodyYaw(clampedValue);
      smoother.setTargets({ bodyYaw: clampedValue });

      if (continuous) {
        if (!dragStartRef.current) {
          dragStartRef.current = { bodyYaw: state.bodyYaw };
          actions.startMouseDrag();
        }
      } else {
        dragStartRef.current = null;
        actions.endInteraction();

        requestAnimationFrame(() => {
          const smoothed = smoother.getCurrentValues();
          sendCommand(smoothed.headPose, smoothed.antennas, smoothed.bodyYaw);
        });
      }
    },
    [state.bodyYaw, actions, smoother, sendCommand, isActive]
  );

  const handleAntennasChange = useCallback(
    (antenna: 'left' | 'right', value: number, continuous: boolean = false): void => {
      if (!isActive) return;

      const currentAntennas: [number, number] = state.antennas || [0, 0];
      const newAntennas: [number, number] =
        antenna === 'left' ? [value, currentAntennas[1]] : [currentAntennas[0], value];

      const clampedAntennas: [number, number] = [
        clamp(newAntennas[0], ROBOT_POSITION_RANGES.ANTENNA.min, ROBOT_POSITION_RANGES.ANTENNA.max),
        clamp(newAntennas[1], ROBOT_POSITION_RANGES.ANTENNA.min, ROBOT_POSITION_RANGES.ANTENNA.max),
      ];

      actions.updateAntennas(clampedAntennas);
      smoother.setTargets({ antennas: clampedAntennas });

      if (continuous) {
        if (!dragStartRef.current) {
          dragStartRef.current = { antennas: [...currentAntennas] as [number, number] };
          actions.startMouseDrag();
        }
      } else {
        dragStartRef.current = null;
        actions.endInteraction();

        requestAnimationFrame(() => {
          const smoothed = smoother.getCurrentValues();
          sendCommand(smoothed.headPose, smoothed.antennas, smoothed.bodyYaw);
        });
      }
    },
    [state.antennas, actions, smoother, sendCommand, isActive]
  );

  const handleDragEnd = useCallback((): void => {
    dragStartRef.current = null;
    actions.endInteraction();
  }, [actions]);

  const resetAllValues = useCallback((): void => {
    actions.startReset();
    smoother.setTargets({
      headPose: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
      bodyYaw: 0,
      antennas: [0, 0],
    });
  }, [actions, smoother]);

  return {
    localValues: {
      headPose: state.headPose,
      bodyYaw: state.bodyYaw,
      antennas: state.antennas,
    },

    getSmoothedValues: () => smoother.getCurrentValues(),

    handleChange: handleHeadPoseChange,
    handleBodyYawChange,
    handleAntennasChange,
    handleDragEnd,
    resetAllValues,
  };
}
