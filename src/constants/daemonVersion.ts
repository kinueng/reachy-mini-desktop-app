/**
 * Minimum daemon version required by the desktop app.
 *
 * Why this gate exists:
 * - On Reachy Mini Lite (USB) and Simulation, the daemon is bundled with the
 *   app and gets updated automatically every time the app updates.
 * - On Reachy Mini Wireless, the daemon runs ON the robot (RPi) and is
 *   updated independently via PyPI. Users routinely run the latest desktop
 *   app against a daemon that is several months old, which causes silent
 *   API mismatches and confusing bug reports.
 *
 * When the wireless daemon is older than this constant, we present a
 * blocking but bienveillant `WirelessUpdateRequiredView` that drives the
 * built-in `/update/start` endpoint of the daemon to bring it up to par.
 *
 * # Bumping policy
 *
 * Bump this constant only when the desktop app starts depending on a daemon
 * API/behaviour that older daemons don't expose. Each bump should:
 *
 * 1. Reference the PR / commit that introduced the dependency.
 * 2. Be tagged in `MIN_WIRELESS_DAEMON_VERSION_REASON` so we can show users
 *    a meaningful "why" in the update view.
 * 3. Be conservative: prefer the oldest version that ships the dependency
 *    rather than "the latest at release time" - users who just ran an
 *    update yesterday should not be forced to update again the next day.
 */

export const MIN_WIRELESS_DAEMON_VERSION = '1.7.1';

/**
 * Short, user-facing rationale shown in the update view subtitle.
 * Keep it under one sentence: the dialog already gives the version numbers.
 */
export const MIN_WIRELESS_DAEMON_VERSION_REASON =
  'This version of the desktop app requires daemon features introduced in v1.7.1.';
