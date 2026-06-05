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
 * We deliberately keep this floor ALIGNED with the daemon version bundled
 * for Lite/Simulation (`REACHY_MINI_VERSION` in
 * `.github/workflows/release-unified.yml`), so every platform converges on
 * the same daemon: a release that ships daemon X for Lite/sim also requires
 * X on Wireless. The trade-off is explicit - wireless robots older than X
 * are forced to update on first connect, even if they would technically
 * still work. Each bump should:
 *
 * 1. Move in lockstep with `REACHY_MINI_VERSION` in the release workflow.
 * 2. Reference the PR / commit that introduced the dependency.
 * 3. Be tagged in `MIN_WIRELESS_DAEMON_VERSION_REASON` so we can show users
 *    a meaningful "why" in the update view.
 */

export const MIN_WIRELESS_DAEMON_VERSION = '1.8.0';

/**
 * Short, user-facing rationale shown in the update view subtitle.
 * Keep it under one sentence: the dialog already gives the version numbers.
 */
export const MIN_WIRELESS_DAEMON_VERSION_REASON =
  'This version of the desktop app requires daemon v1.8.0 or newer.';
