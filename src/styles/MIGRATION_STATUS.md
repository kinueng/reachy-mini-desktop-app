# Style migration - Handoff note

Status snapshot after extending the palette to unblock parallel migration work.
Read this before resuming the migration in a new conversation (or handing a
bucket to a background agent).

## TL;DR

- **Foundation is in place, typecheck green, 0 hardcoded accent colors** in the
  app code outside `src/styles/` and the migration docs.
- **New palette tokens landed** (see "What's new" below) - TODOs for toasts,
  danger buttons, neutral "stopped" state, and accent text are now resolvable
  without touching `palette.ts` again.
- Remaining debt is **mechanical `darkMode ? A : B` -> `palette.*`** rewrites.
  The work has been split into **disjoint buckets** that can be migrated in
  parallel without conflicts (see "Parallel buckets" below).

## What's done

### Foundation (do not modify unless adding new tokens)

- `src/styles/tokens.ts` - primitives (`ACCENT`, `STATUS`, `STATUS_TEXT`,
  `DANGER`, `RADIUS`, `DURATION`, `EASING`, `Z`, `accentAlpha`, `blackAlpha`,
  `whiteAlpha`, `hexToRgba`, `transition`).
- `src/styles/palette.ts` - `buildAppPalette(isDark) -> AppPalette` with full
  semantic coverage for accent, text, surface, border, shadow, status (base +
  surface/border/text trios), danger, and ghost.
- `src/styles/useAppPalette.ts` - React hook memoized on `darkMode`.
- `src/styles/index.ts` - barrel.
- `src/main.tsx` - MUI `createTheme` reads from tokens.
- `tsconfig.json` + `vite.config.ts` - `@styles` and `@styles/*` aliases.
- `src/styles/MIGRATION_GUIDE.md` - reference cheat-sheet (now includes
  sections 2.b / 2.c / 2.d for status surfaces, danger, and greys).

### Pilot components (fully migrated, use as reference)

- `src/components/emoji-grid/DiceIcon.tsx`
- `src/components/emoji-grid/EmojiGrid.tsx`
- `src/components/emoji-grid/EmojiPicker.tsx`
- `src/components/emoji-grid/EmotionWheel.tsx` <- **best reference**
- `src/views/active-robot/right-panel/expressions/ExpressionsSection.tsx` <- **second reference**
- `src/components/viewer3d/SettingsOverlay.tsx` (second pass done, alias cleaned up)

## What's new (since the previous handoff)

`palette.ts` gained the following fields - agents can now use them directly
instead of leaving `// TODO(style-migration)` comments:

### Accent text

- `palette.accentTextStrong` - replaces `palette.isDark ? ACCENT.light : ACCENT.dark`.

### Status tinted tiles (surfaces + borders + readable text)

- `palette.statusSuccessSurface | statusSuccessBorder | statusSuccessText`
- `palette.statusErrorSurface | statusErrorSurfaceHover | statusErrorBorder | statusErrorText`
- `palette.statusWarningSurface | statusWarningBorder | statusWarningText`
- `palette.statusInfoSurface | statusInfoBorder | statusInfoText`
- `palette.statusNeutralSurface | statusNeutralBorder | statusNeutralText`
- `palette.statusNeutral` - neutral grey (#9ca3af) for `stopped`/`not_initialized`.

### Destructive "danger" actions (reset, clear, delete)

- `palette.dangerText | dangerBorder | dangerSurfaceHover`
  (warmer, lighter variants than `statusError`; use for confirm-destructive
  buttons).

### New helper in `tokens.ts`

- `hexToRgba(hex, alpha)` - generic alpha helper for any `STATUS.*` or custom
  color, so nobody hardcodes `rgba(34, 197, 94, 0.8)` again.

### TODOs that these new tokens resolve (pick them off as you go)

| File | What to replace |
|---|---|
| `src/components/Toast/Toast.tsx` | Full `getColors()` switch -> `palette.status*Surface/Border/Text`; use `hexToRgba(STATUS.x, 0.8)` for the progress bar. |
| `src/components/viewer3d/settings/SettingsCacheCard.tsx` | `dangerColor/Border/HoverBg` -> `palette.dangerText/Border/SurfaceHover`. |
| `src/components/viewer3d/settings/SettingsResetCard.tsx` | same as above. |
| `src/components/viewer3d/settings/SettingsDaemonCard.tsx` | `STATE_COLORS.stopped/not_initialized: '#888'` -> `palette.statusNeutral` (move the map inside the component so it can read `palette`). |
| `src/components/viewer3d/settings/ChangeWifiOverlay.tsx` | `palette.isDark ? ACCENT.light : ACCENT.dark` -> `palette.accentTextStrong`. |

## Parallel buckets (disjoint - pick one per agent)

Each bucket is a **disjoint set of files** that no other bucket touches, so
multiple agents (or multiple turns) can work on them concurrently without
conflicts.

**Ready-to-paste agent prompts live in `.ai/style-migration/`:**

| Bucket | Brief |
|---|---|
| 1 - LogConsole | [`.ai/style-migration/bucket-1-logconsole.md`](../../.ai/style-migration/bucket-1-logconsole.md) |
| 2 - Application store | [`.ai/style-migration/bucket-2-application-store.md`](../../.ai/style-migration/bucket-2-application-store.md) |
| 3 - Finding robot + setup | [`.ai/style-migration/bucket-3-finding-setup.md`](../../.ai/style-migration/bucket-3-finding-setup.md) |
| 4 - Active robot shell + right panel | [`.ai/style-migration/bucket-4-active-robot-shell.md`](../../.ai/style-migration/bucket-4-active-robot-shell.md) |
| 5 - Controller + sliders | [`.ai/style-migration/bucket-5-controller.md`](../../.ai/style-migration/bucket-5-controller.md) |
| 6 - Shared components + cleanup | [`.ai/style-migration/bucket-6-shared-cleanup.md`](../../.ai/style-migration/bucket-6-shared-cleanup.md) |

Shared context (required reading, tokens cheat-sheet, validation workflow):
[`.ai/style-migration/_shared-context.md`](../../.ai/style-migration/_shared-context.md).

**Before finishing any bucket** the agent must run, from
`reachy_mini_desktop_app/`:

```bash
./scripts/validate-style-migration.sh <files-touched>
```

The script runs `npm run typecheck`, checks for hardcoded accent colors,
counts remaining `darkMode ?` ternaries, and flags stray TODOs and
`const darkMode = palette.isDark` aliases. Reference files
(`EmotionWheel.tsx`, `ExpressionsSection.tsx`, `SettingsOverlay.tsx`) are the
source of truth for patterns.

### Bucket 1 - LogConsole

**Goal**: wire `useAppPalette()` into the console and drop all `darkMode`
ternaries. Preserve the `darkMode` prop on `FilterChip` / `LogItem` as
`@deprecated` if it's part of an exported API; otherwise remove it.

- `src/components/LogConsole/index.tsx` (31 ternaries)
- `src/components/LogConsole/LogItem.tsx` (8 ternaries)

Tokens to lean on: `palette.textSecondary/Muted/Faint`, `palette.border`,
`palette.surfaceCard/Subtle`, `palette.statusNeutral`, `hexToRgba(color, 0.1)`
for the filter chip backdrops.

### Bucket 2 - Application store

**Goal**: finish migrating the ternaries already opened by the first pass. The
`useAppPalette()` hook is already wired in most of these files; each starts
with `// TODO(style-migration): finish migrating remaining darkMode ternaries.`
and an alias `const darkMode = palette.isDark;` - remove the alias at the end.

- `src/views/active-robot/application-store/discover/Section.tsx` (35)
- `src/views/active-robot/application-store/installed/InstalledAppsSection.tsx` (30)
- `src/views/active-robot/application-store/installation/Overlay.tsx` (23)
- `src/views/active-robot/application-store/discover/Modal.tsx` (13)
- `src/views/active-robot/application-store/discover/components/SearchBar.tsx` (TODO purple token)
- `src/views/active-robot/application-store/discover/components/AppCard.tsx` (TODO private/web tags)

Tokens to lean on: `palette.textSecondary/Muted/Faint`, `palette.border`,
`palette.surfaceCard/Hover`, `palette.accentSurface*`, `palette.accentTextStrong`.

### Bucket 3 - Finding robot + setup flow

**Goal**: the largest single-file debt (`FindingRobotView.tsx`) plus the
surrounding connection / setup screens (all disjoint from buckets 1 / 2 / 4 / 5
/ 6).

- `src/views/finding-robot/FindingRobotView.tsx` (43)
- `src/views/setup-choice/SetupChoiceView.tsx` (10)
- `src/views/first-time-wifi-setup/FirstTimeWifiSetupView.tsx` (5)
- `src/views/first-time-wifi-setup/steps/Step2ConnectHotspot.tsx` (5)
- `src/views/first-time-wifi-setup/steps/Step1PowerOn.tsx` (1)
- `src/views/permissions-required/PermissionsRequiredView.tsx` (9)
- `src/views/bluetooth-support/BluetoothSupportView.tsx` (5)
- `src/views/starting/StartupView.tsx` (3)
- `src/views/starting/StartingView.tsx` (1)
- `src/views/closing/ClosingView.tsx` (3)

Tokens to lean on: `palette.textSecondary/Muted`, `palette.surfaceBg/Card`,
`palette.accentTextStrong`, `palette.statusInfoSurface/Text` (for the
"scanning..." banners), `palette.border`.

### Bucket 4 - Active robot shell + right panel

**Goal**: top-level shell of the "active robot" view. All files are disjoint
from the application-store bucket even though they share the same parent
directory - list carefully before running.

- `src/views/active-robot/ActiveRobotView.tsx` (11)
- `src/views/active-robot/right-panel/EmbeddedAppView.tsx` (12)
- `src/views/active-robot/right-panel/RightPanel.tsx` (2)
- `src/views/active-robot/camera/CameraFeed.tsx` (6)
- `src/views/active-robot/audio/AudioControls.tsx` (9)
- `src/views/active-robot/audio/DoAIndicator.tsx` (1)
- `src/views/update/UpdateView.tsx` (16)

Tokens to lean on: `palette.surfaceCard/Hover`, `palette.border/Strong`,
`palette.accentSurface*`, `palette.statusSuccess/Error/Warning` (for the
update / camera banners).

### Bucket 5 - Controller + sliders

**Goal**: the tactile / joystick UI. All siblings under the `controller/`
directory.

- `src/views/active-robot/controller/Controller.tsx` (5)
- `src/views/active-robot/controller/components/Joystick2D.tsx` (5)
- `src/views/active-robot/controller/components/SimpleSlider.tsx` (9)
- `src/views/active-robot/controller/components/CircularSlider.tsx` (9)
- `src/views/active-robot/controller/components/VerticalSlider.tsx` (5)

Tokens to lean on: `palette.accentSurface*`, `palette.accentBorder*`,
`palette.accentGlow*`, `palette.textMuted/Faint`, `palette.border`.

### Bucket 6 - Shared small components + TODO cleanup

**Goal**: quick wins (1-5 ternaries each) and resolving the remaining
`TODO(style-migration)` comments now that the palette covers toasts, danger,
accent text, and neutrals.

Short migrations:

- `src/components/AppTopBar.tsx` (1)
- `src/components/FPSMeter.tsx` (3)
- `src/components/FullscreenOverlay.tsx` (5)
- `src/components/DevPlayground.tsx` (5)
- `src/components/viewer3d/Scene.tsx` (3)
- `src/components/viewer3d/Viewer3D.tsx` (1)

TODO cleanup (use the mapping in "What's new > TODOs that these new tokens
resolve"):

- `src/components/Toast/Toast.tsx`
- `src/components/viewer3d/settings/SettingsCacheCard.tsx`
- `src/components/viewer3d/settings/SettingsResetCard.tsx`
- `src/components/viewer3d/settings/SettingsDaemonCard.tsx`
- `src/components/viewer3d/settings/ChangeWifiOverlay.tsx`
- `src/components/viewer3d/SettingsOverlay.tsx` (still has the indigo-tint TODO
  around the "disabled" button - leave the literal with a comment or escalate).

Leftover TODOs that do **not** fit the current palette and should stay as
comments (document intent, don't invent tokens):

- `src/components/ui/StepsProgressIndicator.tsx` - component-local greys.
- `src/components/WebApp.tsx` - app-frame greys (1a1a1a/f5f5f7).
- `src/views/starting/components/StartupLogsPanel.tsx` - translucent backdrop.
- `src/views/starting/components/ScanErrorDisplay.tsx` - amber-600 alert.
- `src/views/starting/components/ScanStatusLabel.tsx` - precise greys.
- `src/views/active-robot/RobotHeader.tsx` - Apple-style `#1d1d1f`.
- `src/views/active-robot/right-panel/ControlButtons.tsx` - custom 0.02 alpha.
- `src/views/active-robot/right-panel/applications/SimulationDisclaimer.tsx`.
- `src/views/active-robot/right-panel/applications/HfLoginOverlay.tsx`.

`src/utils/viewer3d/applyRobotMaterials.ts` (3 ternaries) is intentionally left
alone - pure Three.js utility receiving `darkMode` from the scene. Low
priority, not part of any bucket.

## Rules for parallel work

1. **One agent = one bucket.** Never touch a file in another bucket.
2. **Start each turn with `git status`** to confirm the bucket is clean on
   disk before editing.
3. **Do NOT spawn multiple background subagents in this environment** - the
   previous session confirmed that 4/5 stopped after their first read. Use
   foreground subagents, or run the buckets across separate conversations.
4. **Always run `npm run typecheck` before and after.** Abort the bucket if the
   "before" run is red (someone else broke something).
5. **Never touch `src/styles/`** unless you are adding a brand new token that
   multiple buckets need. If you do, update `MIGRATION_GUIDE.md` in the same
   commit.

## Verification commands

```bash
cd reachy_mini_desktop_app

# Dashboard: ternary count per bucket / file, with done markers.
./scripts/style-migration-status.sh

# One-shot check: typecheck + hardcoded accent + ternary debt + TODO list.
./scripts/validate-style-migration.sh

# Scope to a bucket's files (same flags, targeted scope):
./scripts/validate-style-migration.sh --quick src/components/LogConsole

# Raw commands the script runs, if you need to dig:
npm run typecheck
grep -rn "#FF9500\|rgba(255,\s*149" src | grep -vE "styles/|MIGRATION_"
grep -rc "darkMode ?" src | grep -v ":0$" | sort -t: -k2 -rn
grep -rn "TODO(style-migration" src
```

## Git state at handoff

- `src/styles/tokens.ts` and `src/styles/palette.ts` gained new fields; no
  existing token changed shape.
- `src/styles/MIGRATION_GUIDE.md` has new sections **2.b / 2.c / 2.d**.
- No component files were touched in this pass - all six buckets are still
  untouched and disjoint.

## What NOT to do

- Don't force-push to `github` remote (ever).
- Don't remove `darkMode` props from public component APIs. Mark them
  `@deprecated` and stop destructuring them internally - callers still compile.
- Don't spawn more than one background subagent in parallel in this
  environment. If you need parallelism, run the subagents sequentially
  (foreground) or split the work across separate conversation turns.
- Don't invent new palette tokens mid-bucket. If you need one, stop, add it to
  `palette.ts` + `MIGRATION_GUIDE.md` first, then resume.
