/**
 * Helper functions for input processing and validation.
 */

export interface HeadPose {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
}

export type Antennas = readonly [number, number] | [number, number] | number[];

export interface RawInputs {
  lookHorizontal?: number;
  lookVertical?: number;
  moveForward?: number;
  moveRight?: number;
  moveUp?: number;
  roll?: number;
  bodyYaw?: number;
  antennaLeft?: number;
  antennaRight?: number;
  [key: string]: number | undefined;
}

/**
 * Check if a value is effectively zero (within tolerance).
 */
export function isZero(value: number, tolerance: number = 0.001): boolean {
  return Math.abs(value) < tolerance;
}

/**
 * Check if a head pose is at zero position.
 */
export function isHeadPoseZero(
  headPose: HeadPose | null | undefined,
  tolerance: number = 0.001
): boolean {
  if (!headPose) return true;

  return (
    isZero(headPose.x, tolerance) &&
    isZero(headPose.y, tolerance) &&
    isZero(headPose.z, tolerance) &&
    isZero(headPose.pitch, tolerance) &&
    isZero(headPose.yaw, tolerance) &&
    isZero(headPose.roll, tolerance)
  );
}

/**
 * Check if antennas are at zero position.
 */
export function areAntennasZero(
  antennas: Antennas | null | undefined,
  tolerance: number = 0.001
): boolean {
  if (!antennas || antennas.length !== 2) return true;
  return isZero(antennas[0], tolerance) && isZero(antennas[1], tolerance);
}

/**
 * Clamp a value within a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Check if any input value is above threshold (active).
 */
export function hasActiveInput(inputs: RawInputs, threshold: number = 0.02): boolean {
  return (
    Math.abs(inputs.lookHorizontal ?? 0) > threshold ||
    Math.abs(inputs.lookVertical ?? 0) > threshold ||
    Math.abs(inputs.moveForward ?? 0) > threshold ||
    Math.abs(inputs.moveRight ?? 0) > threshold ||
    Math.abs(inputs.moveUp ?? 0) > threshold ||
    Math.abs(inputs.roll ?? 0) > threshold ||
    Math.abs(inputs.bodyYaw ?? 0) > threshold ||
    Math.abs(inputs.antennaLeft ?? 0) > threshold ||
    Math.abs(inputs.antennaRight ?? 0) > threshold
  );
}

/**
 * Create a zero head pose object.
 */
export function createZeroHeadPose(): HeadPose {
  return { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
}

/**
 * Create zero antennas array.
 */
export function createZeroAntennas(): [number, number] {
  return [0, 0];
}
