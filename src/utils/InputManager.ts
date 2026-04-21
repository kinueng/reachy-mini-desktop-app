import React from 'react';
import { INPUT_DEVICE_TYPES, type InputDeviceType } from './navigationConstants';
import { telemetry } from './telemetry';

export interface RawInputState {
  // Movement
  moveForward: number;
  moveRight: number;
  moveUp: number;
  // Rotation
  lookHorizontal: number;
  lookVertical: number;
  roll: number;
  // Body rotation
  bodyYaw: number;
  // Antennas
  antennaLeft: number;
  antennaRight: number;
  // Actions
  toggleMode: boolean;
  nextPosition: boolean;
  action1: boolean;
  action2: boolean;
  interact: boolean;
  returnHome: boolean;
}

export interface InputManagerConfig {
  deadzone: number;
  keyboardSensitivity: number;
  keyboardMovementMultiplier: number;
  keyboardLookMultiplier: number;
}

interface ProgressiveIncrement {
  value: number;
  holdTime: number;
  isHolding: boolean;
}

type InputListener = (inputs: RawInputState) => void;
type DeviceChangeListener = (device: InputDeviceType | null) => void;

const createEmptyInputs = (): RawInputState => ({
  moveForward: 0,
  moveRight: 0,
  moveUp: 0,
  lookHorizontal: 0,
  lookVertical: 0,
  roll: 0,
  bodyYaw: 0,
  antennaLeft: 0,
  antennaRight: 0,
  toggleMode: false,
  nextPosition: false,
  action1: false,
  action2: false,
  interact: false,
  returnHome: false,
});

/** Unified input management class (keyboard and gamepad). */
export class InputManager {
  inputs: RawInputState;
  keyboardInputs: RawInputState;
  gamepadInputs: RawInputState;
  config: InputManagerConfig;

  keysPressed: Record<string, boolean>;
  previousButtonStates: Record<string, boolean | undefined>;
  listeners: InputListener[];
  gamepadConnected: boolean;
  rafId: number | null;
  lastNotificationTime: number;

  debugEnabled: boolean;
  lastButtonStates: Record<string, boolean>;
  lastInputValues: Record<string, number>;

  progressiveIncrement: {
    bodyYaw: ProgressiveIncrement;
    moveUp: ProgressiveIncrement;
  };

  activeDevice: InputDeviceType | null;
  lastInputTime: Record<InputDeviceType, number>;
  deviceSwitchThreshold: number;

  deviceChangeListeners?: DeviceChangeListener[];

  constructor() {
    this.inputs = createEmptyInputs();
    this.keyboardInputs = createEmptyInputs();
    this.gamepadInputs = createEmptyInputs();

    this.config = {
      deadzone: 0.05,
      keyboardSensitivity: 1.5,
      keyboardMovementMultiplier: 1.0,
      keyboardLookMultiplier: 1.8,
    };

    this.keysPressed = {};
    this.previousButtonStates = {};
    this.listeners = [];
    this.gamepadConnected = false;
    this.rafId = null;
    this.lastNotificationTime = 0;

    this.debugEnabled = false;
    this.lastButtonStates = {};
    this.lastInputValues = {};

    this.progressiveIncrement = {
      bodyYaw: { value: 0, holdTime: 0, isHolding: false },
      moveUp: { value: 0, holdTime: 0, isHolding: false },
    };

    // Default to no device (keyboard mode disabled) - will switch to gamepad when detected
    this.activeDevice = null;
    this.lastInputTime = {
      [INPUT_DEVICE_TYPES.KEYBOARD]: 0,
      [INPUT_DEVICE_TYPES.GAMEPAD]: 0,
    };
    this.deviceSwitchThreshold = 100;

    this.bindEvents();
  }

  validateAxisValue(value: number | undefined | null): number {
    if (value == null || !isFinite(value)) {
      return 0;
    }
    return Math.max(-1, Math.min(1, value));
  }

  applyDeadzone(value: number): number {
    const absValue = Math.abs(value);
    if (absValue <= this.config.deadzone) {
      // Smooth fade-out near deadzone instead of hard cutoff
      const fadeFactor = absValue / this.config.deadzone;
      return value * fadeFactor;
    }
    return value;
  }

  /**
   * Apply exponential response curve to camera movements. Currently linear:
   * the curve was disabled because it produced a "magnet" effect at certain
   * values.
   */
  applyLookCurve(value: number): number {
    return this.applyDeadzone(value);
  }

  /** Get currently active device. Returns `null` when keyboard-only. */
  getActiveDevice(): InputDeviceType | null {
    return this.activeDevice === INPUT_DEVICE_TYPES.GAMEPAD ? INPUT_DEVICE_TYPES.GAMEPAD : null;
  }

  updateActiveDevice(deviceType: InputDeviceType): void {
    const now = Date.now();
    this.lastInputTime[deviceType] = now;

    if (this.activeDevice !== deviceType) {
      const lastActive = this.activeDevice ? this.lastInputTime[this.activeDevice] : 0;
      const timeSinceLastActiveInput = now - lastActive;

      if (timeSinceLastActiveInput > this.deviceSwitchThreshold) {
        this.activeDevice = deviceType;
        this.notifyDeviceChange(deviceType);
      }
    }
  }

  addDeviceChangeListener(callback: DeviceChangeListener): () => void {
    if (!this.deviceChangeListeners) {
      this.deviceChangeListeners = [];
    }

    this.deviceChangeListeners.push(callback);
    return () => {
      this.deviceChangeListeners = this.deviceChangeListeners?.filter(cb => cb !== callback);
    };
  }

  notifyDeviceChange(newDevice: InputDeviceType | null): void {
    if (this.deviceChangeListeners) {
      for (const listener of this.deviceChangeListeners) {
        listener(newDevice);
      }
    }

    if (newDevice === INPUT_DEVICE_TYPES.GAMEPAD) {
      telemetry.controllerUsed({ control: 'gamepad' });
    } else if (newDevice === INPUT_DEVICE_TYPES.KEYBOARD) {
      telemetry.controllerUsed({ control: 'keyboard' });
    }
  }

  addListener(callback: InputListener): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  /** Notify all listeners of input update (throttled to ~30fps for performance). */
  notifyListeners(): void {
    const now = Date.now();
    const throttleMs = 33; // ~30fps

    if (now - this.lastNotificationTime < throttleMs) {
      return;
    }

    this.lastNotificationTime = now;

    for (const listener of this.listeners) {
      listener({ ...this.inputs });
    }
  }

  combineInputs(): void {
    this.inputs.moveForward = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.moveForward + this.gamepadInputs.moveForward)
    );

    this.inputs.moveRight = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.moveRight + this.gamepadInputs.moveRight)
    );

    this.inputs.moveUp = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.moveUp + this.gamepadInputs.moveUp)
    );

    this.inputs.lookHorizontal = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.lookHorizontal + this.gamepadInputs.lookHorizontal)
    );

    this.inputs.lookVertical = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.lookVertical + this.gamepadInputs.lookVertical)
    );

    this.inputs.roll = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.roll + this.gamepadInputs.roll)
    );

    this.inputs.bodyYaw = Math.max(
      -1,
      Math.min(1, this.keyboardInputs.bodyYaw + this.gamepadInputs.bodyYaw)
    );

    // Antennas (analog inputs) - triggers are 0 to 1, not -1 to 1
    this.inputs.antennaLeft = Math.max(
      0,
      Math.min(1, this.keyboardInputs.antennaLeft + this.gamepadInputs.antennaLeft)
    );
    this.inputs.antennaRight = Math.max(
      0,
      Math.min(1, this.keyboardInputs.antennaRight + this.gamepadInputs.antennaRight)
    );

    this.inputs.toggleMode = this.keyboardInputs.toggleMode || this.gamepadInputs.toggleMode;
    this.inputs.nextPosition = this.keyboardInputs.nextPosition || this.gamepadInputs.nextPosition;
    this.inputs.action1 = this.keyboardInputs.action1 || this.gamepadInputs.action1;
    this.inputs.action2 = this.keyboardInputs.action2 || this.gamepadInputs.action2;
    this.inputs.interact = this.keyboardInputs.interact || this.gamepadInputs.interact;
    this.inputs.returnHome = this.keyboardInputs.returnHome || this.gamepadInputs.returnHome;
  }

  bindEvents(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('gamepadconnected', this.handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.handleGamepadDisconnected);
    this.startGamepadPolling();
  }

  unbindEvents(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('gamepadconnected', this.handleGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.handleGamepadDisconnected);

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Keyboard event handling. Keyboard movement is currently disabled (only
   * special action bindings remain active for future implementation).
   */
  handleKeyDown = (event: KeyboardEvent): void => {
    this.keysPressed[event.code] = true;

    if (event.code === 'Tab') {
      event.preventDefault();
      this.keyboardInputs.toggleMode = true;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      if (!this.keyboardInputs.nextPosition) {
        this.keyboardInputs.nextPosition = true;
      }
    }

    if (event.code === 'KeyT') {
      if (!this.keyboardInputs.interact) {
        this.keyboardInputs.interact = true;
      }
    }

    if (event.code === 'Escape') {
      event.preventDefault();
      if (!this.keyboardInputs.returnHome) {
        this.keyboardInputs.returnHome = true;
      }
    }

    this.processKeyboardInput();
    this.combineInputs();
    this.notifyListeners();
  };

  handleKeyUp = (event: KeyboardEvent): void => {
    this.keysPressed[event.code] = false;

    if (event.code === 'Tab') {
      this.keyboardInputs.toggleMode = false;
    }
    if (event.code === 'Space') {
      setTimeout(() => {
        this.keyboardInputs.nextPosition = false;
        this.combineInputs();
        this.notifyListeners();
      }, 50);
    }

    if (event.code === 'KeyT') {
      setTimeout(() => {
        this.keyboardInputs.interact = false;
        this.combineInputs();
        this.notifyListeners();
      }, 50);
    }

    if (event.code === 'Escape') {
      setTimeout(() => {
        this.keyboardInputs.returnHome = false;
        this.combineInputs();
        this.notifyListeners();
      }, 50);
    }

    this.processKeyboardInput();
  };

  /** Keyboard input processing (movement currently disabled). */
  processKeyboardInput(): void {
    this.keyboardInputs.moveForward = 0;
    this.keyboardInputs.moveRight = 0;
    this.keyboardInputs.moveUp = 0;
    this.keyboardInputs.lookHorizontal = 0;
    this.keyboardInputs.lookVertical = 0;
    this.keyboardInputs.roll = 0;
    this.keyboardInputs.bodyYaw = 0;
    this.keyboardInputs.antennaLeft = 0;
    this.keyboardInputs.antennaRight = 0;

    this.combineInputs();
    this.notifyListeners();
  }

  handleGamepadConnected = (_event: Event): void => {
    this.gamepadConnected = true;
  };

  handleGamepadDisconnected = (_event: Event): void => {
    this.gamepadConnected = false;
    this.resetGamepadInputs();
    this.combineInputs();
    this.notifyListeners();
  };

  startGamepadPolling(): void {
    const poll = (): void => {
      this.pollGamepad();
      this.rafId = requestAnimationFrame(poll);
    };
    this.rafId = requestAnimationFrame(poll);
  }

  pollGamepad(): void {
    try {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gamepad = gamepads[0];

      if (!gamepad) {
        if (this.gamepadConnected) {
          this.gamepadConnected = false;
          this.resetGamepadInputs();
          this.combineInputs();
          this.notifyListeners();
        }
        return;
      }

      if (!gamepad.axes || !Array.isArray(gamepad.axes)) {
        return;
      }

      if (!this.gamepadConnected) {
        this.gamepadConnected = true;
      }

      const hasGamepadInput =
        Math.abs(gamepad.axes[0]) > this.config.deadzone ||
        Math.abs(gamepad.axes[1]) > this.config.deadzone ||
        Math.abs(gamepad.axes[2]) > this.config.deadzone ||
        Math.abs(gamepad.axes[3]) > this.config.deadzone ||
        gamepad.buttons.some(button => button.pressed);

      if (hasGamepadInput) {
        this.updateActiveDevice(INPUT_DEVICE_TYPES.GAMEPAD);
      }

      // Movements (left stick)
      const leftStickXValue = this.validateAxisValue(gamepad.axes[0]);
      const leftStickYValue = this.validateAxisValue(gamepad.axes[1]);
      const leftStickX = this.applyDeadzone(leftStickXValue);
      const leftStickY = this.applyDeadzone(leftStickYValue);
      this.gamepadInputs.moveRight = leftStickX;
      this.gamepadInputs.moveForward = -leftStickY;

      // D-pad Up/Down -> Z position with progressive increment
      const dpadUpPressed = gamepad.buttons[12]?.pressed || false;
      const dpadDownPressed = gamepad.buttons[13]?.pressed || false;
      const moveUpDirection = dpadUpPressed ? 1 : dpadDownPressed ? -1 : 0;

      if (moveUpDirection !== 0) {
        if (!this.progressiveIncrement.moveUp.isHolding) {
          this.progressiveIncrement.moveUp.value = moveUpDirection * 0.2;
          this.progressiveIncrement.moveUp.isHolding = true;
          this.progressiveIncrement.moveUp.holdTime = Date.now();
        } else {
          const frameIncrement = 0.002;
          const maxIncrement = 1.0;
          const newIncrement =
            this.progressiveIncrement.moveUp.value + frameIncrement * moveUpDirection;
          if (moveUpDirection > 0) {
            this.progressiveIncrement.moveUp.value = Math.min(newIncrement, maxIncrement);
          } else {
            this.progressiveIncrement.moveUp.value = Math.max(newIncrement, -maxIncrement);
          }
        }
      } else {
        this.progressiveIncrement.moveUp.value = 0;
        this.progressiveIncrement.moveUp.isHolding = false;
        this.progressiveIncrement.moveUp.holdTime = 0;
      }

      this.gamepadInputs.moveUp = this.progressiveIncrement.moveUp.value;

      // D-pad Left/Right -> body yaw with progressive increment
      const dpadRightPressed = gamepad.buttons[15]?.pressed || false;
      const dpadLeftPressed = gamepad.buttons[14]?.pressed || false;
      const bodyYawDirection = dpadRightPressed ? 1 : dpadLeftPressed ? -1 : 0;

      if (bodyYawDirection !== 0) {
        if (!this.progressiveIncrement.bodyYaw.isHolding) {
          this.progressiveIncrement.bodyYaw.value = bodyYawDirection * 0.2;
          this.progressiveIncrement.bodyYaw.isHolding = true;
          this.progressiveIncrement.bodyYaw.holdTime = Date.now();
        } else {
          const frameIncrement = 0.002;
          const maxIncrement = 1.0;
          const newIncrement =
            this.progressiveIncrement.bodyYaw.value + frameIncrement * bodyYawDirection;
          if (bodyYawDirection > 0) {
            this.progressiveIncrement.bodyYaw.value = Math.min(newIncrement, maxIncrement);
          } else {
            this.progressiveIncrement.bodyYaw.value = Math.max(newIncrement, -maxIncrement);
          }
        }
      } else {
        this.progressiveIncrement.bodyYaw.value = 0;
        this.progressiveIncrement.bodyYaw.isHolding = false;
        this.progressiveIncrement.bodyYaw.holdTime = 0;
      }

      this.gamepadInputs.bodyYaw = this.progressiveIncrement.bodyYaw.value;

      // Antennas: L1/R1 bumpers (analog buttons)
      this.gamepadInputs.antennaLeft = gamepad.buttons[6]?.value || 0;
      this.gamepadInputs.antennaRight = gamepad.buttons[7]?.value || 0;

      // Camera rotation (right stick)
      const rightStickXValue = this.validateAxisValue(gamepad.axes[2]);
      const rightStickYValue = this.validateAxisValue(gamepad.axes[3]);
      this.gamepadInputs.lookHorizontal = this.applyLookCurve(rightStickXValue);
      this.gamepadInputs.lookVertical = -this.applyLookCurve(rightStickYValue);

      if (this.debugEnabled) {
        const dpadButtons = [12, 13, 14, 15];
        dpadButtons.forEach(index => {
          const isPressed = gamepad.buttons[index]?.pressed || false;
          const lastState = this.lastButtonStates[`dpad_${index}`];
          if (isPressed !== lastState) {
            this.lastButtonStates[`dpad_${index}`] = isPressed;
          }
        });

        [6, 7].forEach(index => {
          const value = gamepad.buttons[index]?.value || 0;
          this.lastInputValues[`bumper_${index}`] = value;
        });

        [0, 1, 2, 3].forEach(index => {
          const isPressed = gamepad.buttons[index]?.pressed || false;
          const lastState = this.lastButtonStates[`action_${index}`];
          if (isPressed !== Boolean(lastState)) {
            this.lastButtonStates[`action_${index}`] = isPressed;
          }
        });

        const sticks: Array<{ axes: [number, number]; name: string }> = [
          { axes: [0, 1], name: 'Left Stick' },
          { axes: [2, 3], name: 'Right Stick' },
        ];

        sticks.forEach(({ axes, name }) => {
          const x = gamepad.axes[axes[0]] || 0;
          const y = gamepad.axes[axes[1]] || 0;
          const magnitude = Math.sqrt(x * x + y * y);
          const lastMagnitude = this.lastInputValues[`stick_${name}`] || 0;

          if (
            (magnitude > this.config.deadzone && lastMagnitude <= this.config.deadzone) ||
            (magnitude <= this.config.deadzone && lastMagnitude > this.config.deadzone)
          ) {
            this.lastInputValues[`stick_${name}`] = magnitude;
          }
        });
      }

      this.gamepadInputs.roll = 0;

      // Mode toggle (Y / triangle)
      if (gamepad.buttons[3]?.pressed && !this.previousButtonStates.mode) {
        this.gamepadInputs.toggleMode = true;
      } else {
        this.gamepadInputs.toggleMode = false;
      }
      this.previousButtonStates.mode = gamepad.buttons[3]?.pressed;

      // Next position (X)
      if (gamepad.buttons[2]?.pressed && !this.previousButtonStates.nextPosition) {
        this.gamepadInputs.nextPosition = true;
        setTimeout(() => {
          this.gamepadInputs.nextPosition = false;
          this.combineInputs();
          this.notifyListeners();
        }, 50);
      }
      this.previousButtonStates.nextPosition = gamepad.buttons[2]?.pressed;

      // Interact (A / cross)
      if (gamepad.buttons[0]?.pressed && !this.previousButtonStates.interact) {
        this.gamepadInputs.interact = true;
      } else {
        this.gamepadInputs.interact = false;
      }
      this.previousButtonStates.interact = gamepad.buttons[0]?.pressed;

      // Return home (B / circle)
      if (gamepad.buttons[1]?.pressed && !this.previousButtonStates.returnHome) {
        this.gamepadInputs.returnHome = true;
        setTimeout(() => {
          this.gamepadInputs.returnHome = false;
          this.combineInputs();
          this.notifyListeners();
        }, 50);
      }
      this.previousButtonStates.returnHome = gamepad.buttons[1]?.pressed;

      this.gamepadInputs.action2 = gamepad.buttons[3]?.pressed || false;

      this.combineInputs();
      this.notifyListeners();
    } catch (error) {
      console.error('Error in pollGamepad:', error);
      this.resetGamepadInputs();
      this.combineInputs();
      this.notifyListeners();
    }
  }

  resetGamepadInputs(): void {
    (Object.keys(this.gamepadInputs) as Array<keyof RawInputState>).forEach(key => {
      const value = this.gamepadInputs[key];
      if (typeof value === 'number') {
        (this.gamepadInputs[key] as number) = 0;
      } else if (typeof value === 'boolean') {
        (this.gamepadInputs[key] as boolean) = false;
      }
    });
  }

  resetKeyboardInputs(): void {
    (Object.keys(this.keyboardInputs) as Array<keyof RawInputState>).forEach(key => {
      const value = this.keyboardInputs[key];
      if (typeof value === 'number') {
        (this.keyboardInputs[key] as number) = 0;
      } else if (typeof value === 'boolean') {
        (this.keyboardInputs[key] as boolean) = false;
      }
    });
  }

  resetInputs(): void {
    this.resetGamepadInputs();
    this.resetKeyboardInputs();
    this.combineInputs();
  }

  updateConfig(newConfig: Partial<InputManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
    if (!enabled) {
      this.lastButtonStates = {};
      this.lastInputValues = {};
    }
  }

  dispose(): void {
    this.unbindEvents();
    this.listeners = [];
    this.lastButtonStates = {};
    this.lastInputValues = {};
  }

  isGamepadConnected(): boolean {
    return this.gamepadConnected;
  }

  triggerNextPositionAction(): void {
    this.resetInputs();
    this.keyboardInputs.nextPosition = true;
    this.combineInputs();
    this.notifyListeners();

    setTimeout(() => {
      this.keyboardInputs.nextPosition = false;
      this.combineInputs();
      this.notifyListeners();
    }, 50);
  }

  triggerInteractAction(): void {
    this.resetInputs();
    this.keyboardInputs.interact = true;
    this.combineInputs();
    this.notifyListeners();

    setTimeout(() => {
      this.keyboardInputs.interact = false;
      this.combineInputs();
      this.notifyListeners();
    }, 50);
  }

  /**
   * Vibrate gamepad (when connected). Returns the underlying promise, or
   * `null` if no controller is available / haptics are unsupported.
   */
  vibrateGamepad(
    duration = 200,
    weakMagnitude = 0.5,
    strongMagnitude = 0.8
  ): Promise<unknown> | null {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gamepad = gamepads[0];

    if (!gamepad || !this.gamepadConnected) {
      return null;
    }

    const actuator = (gamepad as Gamepad & { vibrationActuator?: GamepadHapticActuator })
      .vibrationActuator;
    if (
      actuator &&
      typeof (actuator as GamepadHapticActuator & { playEffect?: unknown }).playEffect ===
        'function'
    ) {
      return (
        actuator as GamepadHapticActuator & {
          playEffect: (
            type: string,
            params: {
              startDelay: number;
              duration: number;
              weakMagnitude: number;
              strongMagnitude: number;
            }
          ) => Promise<unknown>;
        }
      ).playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude,
        strongMagnitude,
      });
    }

    const hapticActuators = (
      gamepad as Gamepad & {
        hapticActuators?: Array<{ pulse: (value: number, duration: number) => Promise<unknown> }>;
      }
    ).hapticActuators;
    if (hapticActuators && hapticActuators.length > 0) {
      return hapticActuators[0].pulse(strongMagnitude, duration);
    }

    return null;
  }
}

let inputManagerInstance: InputManager | null = null;

export const getInputManager = (): InputManager => {
  if (!inputManagerInstance) {
    inputManagerInstance = new InputManager();
  }
  return inputManagerInstance;
};

/** React hook to use input manager in components. */
export const useInputs = (): RawInputState => {
  const [inputs, setInputs] = React.useState<RawInputState>(getInputManager().inputs);

  React.useEffect(() => {
    const unsubscribe = getInputManager().addListener(newInputs => {
      setInputs({ ...newInputs });
    });
    return unsubscribe;
  }, []);

  return inputs;
};

/** React hook to get active device information. */
export const useActiveDevice = (): InputDeviceType | null => {
  const [activeDevice, setActiveDevice] = React.useState<InputDeviceType | null>(
    getInputManager().getActiveDevice()
  );

  React.useEffect(() => {
    const inputManager = getInputManager();

    const unsubscribe = inputManager.addDeviceChangeListener(newDevice => {
      setActiveDevice(newDevice);
    });

    setActiveDevice(inputManager.getActiveDevice());

    return unsubscribe;
  }, []);

  return activeDevice;
};

/**
 * React hook to check whether a gamepad is connected. Pauses polling when the
 * window is hidden.
 */
export const useGamepadConnected = (): boolean => {
  const [isConnected, setIsConnected] = React.useState<boolean>(
    getInputManager().isGamepadConnected()
  );
  const [isVisible, setIsVisible] = React.useState<boolean>(() =>
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
  );

  React.useEffect(() => {
    const handler = (): void => setIsVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  React.useEffect(() => {
    if (!isVisible) return;

    const inputManager = getInputManager();
    setIsConnected(inputManager.isGamepadConnected());

    const checkInterval = setInterval(() => {
      setIsConnected(inputManager.isGamepadConnected());
    }, 500);

    return () => clearInterval(checkInterval);
  }, [isVisible]);

  return isConnected;
};
