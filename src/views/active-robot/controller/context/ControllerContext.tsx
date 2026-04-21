import {
  createContext,
  useContext,
  useReducer,
  useMemo,
  type ReactNode,
  type Dispatch,
} from 'react';
import { TargetSmoothingManager, type HeadPose, type SmoothedValues } from '@utils/targetSmoothing';

// =============================================================================
// STATE MACHINE - Clear states for the controller
// =============================================================================

export const ControllerMode = {
  IDLE: 'idle',
  DRAGGING_MOUSE: 'dragging_mouse',
  DRAGGING_GAMEPAD: 'dragging_gamepad',
  RESETTING: 'resetting',
} as const;

export type ControllerModeType = (typeof ControllerMode)[keyof typeof ControllerMode];

// =============================================================================
// STATE
// =============================================================================

export interface ControllerState {
  mode: ControllerModeType;
  headPose: HeadPose;
  bodyYaw: number;
  antennas: [number, number];
  lastInteractionTime: number;
  lastDragEndTime: number;
  canSyncFromRobot: boolean;
}

const createInitialState = (): ControllerState => ({
  mode: ControllerMode.IDLE,
  headPose: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
  bodyYaw: 0,
  antennas: [0, 0],
  lastInteractionTime: 0,
  lastDragEndTime: 0,
  canSyncFromRobot: true,
});

// =============================================================================
// ACTIONS
// =============================================================================

const ActionTypes = {
  START_MOUSE_DRAG: 'START_MOUSE_DRAG',
  START_GAMEPAD_INPUT: 'START_GAMEPAD_INPUT',
  END_INTERACTION: 'END_INTERACTION',
  START_RESET: 'START_RESET',

  UPDATE_HEAD_POSE: 'UPDATE_HEAD_POSE',
  UPDATE_BODY_YAW: 'UPDATE_BODY_YAW',
  UPDATE_ANTENNAS: 'UPDATE_ANTENNAS',
  UPDATE_ALL: 'UPDATE_ALL',

  SYNC_FROM_ROBOT: 'SYNC_FROM_ROBOT',
  RESET_TO_ZERO: 'RESET_TO_ZERO',
} as const;

export type ActionType = (typeof ActionTypes)[keyof typeof ActionTypes];

export interface PartialPositionPayload {
  headPose?: Partial<HeadPose>;
  bodyYaw?: number;
  antennas?: [number, number];
}

export type ControllerAction =
  | { type: typeof ActionTypes.START_MOUSE_DRAG }
  | { type: typeof ActionTypes.START_GAMEPAD_INPUT }
  | { type: typeof ActionTypes.END_INTERACTION }
  | { type: typeof ActionTypes.START_RESET }
  | { type: typeof ActionTypes.UPDATE_HEAD_POSE; payload: Partial<HeadPose> }
  | { type: typeof ActionTypes.UPDATE_BODY_YAW; payload: number }
  | { type: typeof ActionTypes.UPDATE_ANTENNAS; payload: [number, number] }
  | { type: typeof ActionTypes.UPDATE_ALL; payload: PartialPositionPayload }
  | { type: typeof ActionTypes.SYNC_FROM_ROBOT; payload: PartialPositionPayload }
  | { type: typeof ActionTypes.RESET_TO_ZERO };

// =============================================================================
// REDUCER
// =============================================================================

function controllerReducer(state: ControllerState, action: ControllerAction): ControllerState {
  const now = Date.now();

  switch (action.type) {
    case ActionTypes.START_MOUSE_DRAG:
      return {
        ...state,
        mode: ControllerMode.DRAGGING_MOUSE,
        lastInteractionTime: now,
        canSyncFromRobot: false,
      };

    case ActionTypes.START_GAMEPAD_INPUT:
      return {
        ...state,
        mode: ControllerMode.DRAGGING_GAMEPAD,
        lastInteractionTime: now,
        canSyncFromRobot: false,
      };

    case ActionTypes.END_INTERACTION:
      return {
        ...state,
        mode: ControllerMode.IDLE,
        lastDragEndTime: now,
        canSyncFromRobot: false,
      };

    case ActionTypes.START_RESET:
      return {
        ...state,
        mode: ControllerMode.RESETTING,
        headPose: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
        bodyYaw: 0,
        antennas: [0, 0],
      };

    case ActionTypes.UPDATE_HEAD_POSE:
      return {
        ...state,
        headPose: { ...state.headPose, ...action.payload },
      };

    case ActionTypes.UPDATE_BODY_YAW:
      return {
        ...state,
        bodyYaw: action.payload,
      };

    case ActionTypes.UPDATE_ANTENNAS:
      return {
        ...state,
        antennas: action.payload,
      };

    case ActionTypes.UPDATE_ALL:
      return {
        ...state,
        headPose: action.payload.headPose
          ? { ...state.headPose, ...action.payload.headPose }
          : state.headPose,
        bodyYaw: action.payload.bodyYaw ?? state.bodyYaw,
        antennas: action.payload.antennas ?? state.antennas,
      };

    case ActionTypes.SYNC_FROM_ROBOT: {
      if (!state.canSyncFromRobot || state.mode !== ControllerMode.IDLE) {
        return state;
      }

      const timeSinceInteraction = now - state.lastInteractionTime;
      if (timeSinceInteraction < 30000) {
        return state;
      }

      return {
        ...state,
        headPose: action.payload.headPose
          ? { ...state.headPose, ...action.payload.headPose }
          : state.headPose,
        bodyYaw: action.payload.bodyYaw ?? state.bodyYaw,
        antennas: action.payload.antennas ?? state.antennas,
        canSyncFromRobot: true,
      };
    }

    case ActionTypes.RESET_TO_ZERO:
      return {
        ...state,
        mode: ControllerMode.IDLE,
        headPose: { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 },
        bodyYaw: 0,
        antennas: [0, 0],
        canSyncFromRobot: true,
      };

    default:
      return state;
  }
}

// =============================================================================
// CONTEXT
// =============================================================================

export interface ControllerActions {
  startMouseDrag: () => void;
  startGamepadInput: () => void;
  endInteraction: () => void;
  startReset: () => void;
  updateHeadPose: (pose: Partial<HeadPose>) => void;
  updateBodyYaw: (yaw: number) => void;
  updateAntennas: (antennas: [number, number]) => void;
  updateAll: (values: PartialPositionPayload) => void;
  syncFromRobot: (values: PartialPositionPayload) => void;
  resetToZero: () => void;
}

export interface ControllerContextValue {
  state: ControllerState;
  actions: ControllerActions;
  smoother: TargetSmoothingManager;
  isDragging: boolean;
  isUsingGamepad: boolean;
  isActive: boolean;
}

const ControllerContext = createContext<ControllerContextValue | null>(null);

export interface ControllerProviderProps {
  children: ReactNode;
  isActive: boolean;
}

export function ControllerProvider({
  children,
  isActive,
}: ControllerProviderProps): React.ReactElement {
  const [state, dispatch] = useReducer(controllerReducer, null, createInitialState) as [
    ControllerState,
    Dispatch<ControllerAction>,
  ];

  const smoother = useMemo(() => new TargetSmoothingManager(), []);

  const actions: ControllerActions = useMemo(
    () => ({
      startMouseDrag: () => dispatch({ type: ActionTypes.START_MOUSE_DRAG }),
      startGamepadInput: () => dispatch({ type: ActionTypes.START_GAMEPAD_INPUT }),
      endInteraction: () => dispatch({ type: ActionTypes.END_INTERACTION }),
      startReset: () => dispatch({ type: ActionTypes.START_RESET }),

      updateHeadPose: pose => dispatch({ type: ActionTypes.UPDATE_HEAD_POSE, payload: pose }),
      updateBodyYaw: yaw => dispatch({ type: ActionTypes.UPDATE_BODY_YAW, payload: yaw }),
      updateAntennas: antennas =>
        dispatch({ type: ActionTypes.UPDATE_ANTENNAS, payload: antennas }),
      updateAll: values => dispatch({ type: ActionTypes.UPDATE_ALL, payload: values }),

      syncFromRobot: values => dispatch({ type: ActionTypes.SYNC_FROM_ROBOT, payload: values }),
      resetToZero: () => dispatch({ type: ActionTypes.RESET_TO_ZERO }),
    }),
    []
  );

  const isDragging =
    state.mode === ControllerMode.DRAGGING_MOUSE || state.mode === ControllerMode.DRAGGING_GAMEPAD;
  const isUsingGamepad = state.mode === ControllerMode.DRAGGING_GAMEPAD;

  const value = useMemo<ControllerContextValue>(
    () => ({
      state,
      actions,
      smoother,
      isDragging,
      isUsingGamepad,
      isActive,
    }),
    [state, actions, smoother, isDragging, isUsingGamepad, isActive]
  );

  return <ControllerContext.Provider value={value}>{children}</ControllerContext.Provider>;
}

// =============================================================================
// HOOK
// =============================================================================

export function useController(): ControllerContextValue {
  const context = useContext(ControllerContext);
  if (!context) {
    throw new Error('useController must be used within a ControllerProvider');
  }
  return context;
}

export { ActionTypes };

export type { SmoothedValues };
