# E2E Testing for Reachy Mini Desktop App

End-to-end tests that validate the application works correctly before release.

## Overview

These tests run automatically in the release workflow on GitHub Actions. They:

1. Build the `.deb` package for Linux
2. Install it on Ubuntu
3. Launch the app in simulation mode (`--mockup-sim`)
4. Run WebdriverIO tests to validate core functionality

**If E2E tests fail, the release is blocked.**

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Actions (Ubuntu)                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────┐  │
│  │ Build .deb  │───▶│ Install .deb │───▶│ Run E2E Tests │  │
│  └─────────────┘    └──────────────┘    └───────────────┘  │
│                                                │            │
│                                                ▼            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    xvfb (Virtual Display)            │   │
│  │  ┌─────────────────┐    ┌────────────────────────┐  │   │
│  │  │ WebKitWebDriver │◀──▶│ Reachy Mini Control    │  │   │
│  │  │ (webkit2gtk)    │    │ (--mockup-sim mode)    │  │   │
│  │  └─────────────────┘    └────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Test Scenarios

| Test | What it validates |
|------|-------------------|
| App launches | Build integrity, Tauri bundling |
| Window title | Frontend rendering works |
| Daemon responds | Sidecar starts, IPC communication |
| UI renders | React components load correctly |

## Running Locally (Linux only)

```bash
# Install dependencies
sudo apt install webkit2gtk-driver xvfb libwebkit2gtk-4.1-0 libportaudio2

# Build and install the .deb
yarn build:sidecar-linux
yarn tauri build
sudo dpkg -i src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb

# Run tests with virtual display
xvfb-run yarn test:e2e
```

## Configuration

- **Config file**: `e2e/wdio.conf.js`
- **Test specs**: `e2e/specs/*.spec.js`
- **WebDriver**: `webkit2gtk-driver` (native on Linux)

## Why Linux Only?

| Platform | WebDriver | Cost |
|----------|-----------|------|
| **Linux** | webkit2gtk-driver | Free ✅ |
| macOS | CrabNebula | Paid subscription |
| Windows | Complex setup | Not implemented |

The application code is identical across platforms. Testing on Linux validates:
- Build process works
- Daemon starts correctly
- Frontend-backend IPC works
- UI renders properly

Platform-specific bugs (rare) would be caught during manual QA.

## Troubleshooting

### Tests fail with "WebKitWebDriver not found"

```bash
# Check if webkit2gtk-driver is installed
which WebKitWebDriver

# Install it
sudo apt install webkit2gtk-driver
```

### Tests fail with "Display not found"

```bash
# Run with xvfb
xvfb-run yarn test:e2e

# Or start xvfb manually
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
yarn test:e2e
```

### Daemon doesn't start

Check that the app binary exists and is executable:

```bash
ls -la /usr/bin/reachy-mini-control
```

## Adding New Tests

Create a new spec file in `e2e/specs/`:

```javascript
// e2e/specs/my-feature.spec.js
describe('My Feature', () => {
  it('should do something', async () => {
    // Wait for app to be ready
    await browser.pause(5000);
    
    // Interact with the app via WebDriver
    const element = await browser.$('#my-element');
    expect(await element.isExisting()).toBe(true);
  });
});
```

## CI/CD Integration

The E2E tests are integrated into the release workflow:

```yaml
# .github/workflows/release-unified.yml

jobs:
  build-and-release:
    # ... builds all platforms ...

  e2e-tests:
    needs: build-and-release
    # Downloads Linux .deb
    # Installs it
    # Runs E2E tests
    # If fails → release is blocked

  create-update-manifest:
    needs: [build-and-release, e2e-tests]
    # Only runs if E2E tests pass
```
