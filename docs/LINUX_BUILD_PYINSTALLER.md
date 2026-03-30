# Why Linux Uses PyInstaller Instead of uv + venv

## Context

On **macOS and Windows**, the daemon is shipped as a Python venv bundled alongside the app:
- A uv-trampoline Rust binary is the Tauri sidecar
- The `.venv` and the CPython interpreter are bundled as Tauri resources
- At runtime, the uv-trampoline launches the daemon from the venv

On **Linux**, a different approach is used:
- PyInstaller compiles the entire Python daemon into a single standalone ELF binary
- That binary is the Tauri sidecar — no venv, no interpreter to bundle

---

## Root Cause (issue #35)

When Tauri builds an **AppImage** on Linux, it uses `linuxdeploy` to bundle all ELF binaries
and resolve their shared library dependencies.

The problem: `linuxdeploy` **recursively scans the entire venv**, including native packages.
`opencv-python` (a direct dependency of `reachy_mini`) ships its own `.so` files that in turn
depend on X11 system libraries:

```
opencv_python.libs/libxcb-image-e82a276d.so.0.0.0
ERROR: Could not find dependency: libxcb-shm-7a199f70.so.0.0.0
```

`libxcb-shm` is not available on the minimal Ubuntu 22.04 CI runner, so linuxdeploy fails
and the AppImage build crashes.

The `.deb` build does not have this problem (it declares system library dependencies instead
of bundling them), but AppImage requires everything to be self-contained.

---

## Why PyInstaller Solves This

PyInstaller analyzes the dependency graph at build time and copies only the `.so` files
that are actually needed at runtime. It handles native library resolution itself — linuxdeploy
never sees the venv, so the X11 issue never surfaces.

The result is a single self-contained ELF binary that behaves like any normal sidecar.

---

## Alternatives Considered

### Option 1 — Switch to `opencv-python-headless`

`opencv-python-headless` has no X11/GUI dependencies. Replacing it in `reachy_mini/pyproject.toml`
would remove the libxcb issue.

**Why it was not chosen:**
- Requires a change and a new release of `reachy_mini` (separate repo, separate PyPI publish)
- `PyGObject` (also a Linux-only dependency in `reachy_mini`) may cause the same class of
  problem once opencv is fixed — we would just be shifting the issue
- More moving parts, uncertain outcome without testing

### Option 2 — Only build `.deb`, no AppImage

`.deb` packages do not require linuxdeploy and do not need to bundle system libraries.
The venv approach (same as macOS/Windows) would work fine for `.deb`.

**Downside:** Tauri's auto-updater only supports AppImage on Linux. Without AppImage,
Linux users would not receive automatic updates.

### Option 3 — PyApp / box

[PyApp](https://github.com/ofek/pyapp) compiles a minimal binary that downloads and installs
dependencies on first run.

**Downside:** Requires an internet connection on first launch. Not suitable for an end-user
desktop app where offline installation is expected.

### Option 4 — PyTauri + python-build-standalone

Embed a full portable Python interpreter as a Tauri resource and link against it at compile time.

**Downside:** Requires significant changes to the Tauri build pipeline and the daemon code.
The AppImage rpath issue may still appear depending on how the Python libraries are bundled.

### Option 5 — Upstream fix in Tauri / linuxdeploy

An [open issue (#11898)](https://github.com/tauri-apps/tauri/issues/11898) requests an exclusion
mechanism to prevent linuxdeploy from modifying specific sidecar binaries. Currently tagged as
upstream (`linuxdeploy` limitation). No fix available as of March 2026.

---

## ⚠️ Known Issues with the Current PyInstaller Spec

The PyInstaller spec in `scripts/build/build-daemon-pyinstaller.sh` was written against an older
version of the daemon. Several things have changed and the spec has **not been updated**.

### 1. Static files and templates are NOT bundled (critical)

The daemon now serves a full web dashboard with Jinja2 templates and static files:

```
reachy_mini/daemon/app/dashboard/
├── static/      (SVG assets, JS, CSS)
└── templates/   (HTML: index, settings, logs, sections/*)
```

The spec has `datas=[]` — these files are not included in the bundle. The daemon would crash
at startup with a `FileNotFoundError` when FastAPI tries to mount `StaticFiles`.

The fix requires adding to the spec:

```python
datas=[
    ('path/to/reachy_mini/daemon/app/dashboard/static',  'reachy_mini/daemon/app/dashboard/static'),
    ('path/to/reachy_mini/daemon/app/dashboard/templates', 'reachy_mini/daemon/app/dashboard/templates'),
],
```

### 2. Missing hiddenimports

The daemon has grown significantly. These modules are dynamically imported or used indirectly
and must be listed explicitly for PyInstaller:

| Module | Reason |
|---|---|
| `zeroconf` | mDNS service registration (`MdnsServiceRegistration`) |
| `jinja2` | Template engine for the dashboard |
| `fastapi.staticfiles` | `StaticFiles` mount |
| `fastapi.templating` | `Jinja2Templates` |
| `aiohttp` | New direct dependency |
| `pulsectl` | Linux volume control (new Linux-only dep) |
| `reachy_mini.apps.manager` | `AppManager` |
| `reachy_mini.apps.sources.hf_auth` | HuggingFace OAuth flow |
| `reachy_mini.media.audio_utils` | asoundrc configuration |
| `reachy_mini.motion.recorded_move` | Dataset preloading |
| `reachy_mini.utils.discovery` | mDNS |
| `reachy_mini.utils.wireless_version.startup_check` | Startup checks |

### 3. The build test does not catch these issues

The build script verifies the binary with `./reachy-mini-daemon --help`. This only tests
argument parsing — it does not start the server. The missing static files and hidden imports
would only be detected at actual runtime.

### 4. `sounddevice` and `soundfile` are now optional

They were listed as required `hiddenimports` in the spec but `sounddevice` is now an optional
extra (`reachy_mini[sounddevice]`). Whether it is needed depends on how the daemon is installed.

---

## Current Implementation

| Aspect | macOS / Windows | Linux |
|---|---|---|
| Python runtime | uv-trampoline + bundled venv | PyInstaller standalone binary |
| Build script | `build-sidecar-unix.sh` / `build-sidecar-windows.ps1` | `build-daemon-pyinstaller.sh` |
| Tauri config | `tauri.macos.conf.json` / `tauri.windows.conf.json` | `tauri.linux.pyinstaller.conf.json` |
| Bundle size | ~500 MB (full venv) | ~150-200 MB |
| Auto-update | AppImage + .dmg / .msi | AppImage + .deb |

---

## Path to Unification

If a future version of `reachy_mini` replaces `opencv-python` with `opencv-python-headless`
**and** verifies that `PyGObject` (Linux-only dep) does not trigger the same linuxdeploy error,
it would be possible to remove PyInstaller and use the same uv+venv pipeline on all platforms.

Until then, PyInstaller is the pragmatic and stable solution.
