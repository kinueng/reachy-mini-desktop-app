# E2E Testing Research for Tauri Desktop App

> **Date**: January 2026  
> **Status**: Research Phase  
> **Target**: Reachy Mini Desktop App (Tauri 2.x)

## Executive Summary

This document summarizes the research on implementing end-to-end (E2E) testing for our Tauri desktop application. The goal is to validate the app's core functionality using the simulation mode (`--mockup-sim`), which doesn't require physical robot hardware.

### Key Finding

**macOS E2E testing requires a paid subscription from CrabNebula**, while Linux and Windows have free native WebDriver support.

---

## Current Testing Status

| Layer | Coverage | Tools |
|-------|----------|-------|
| **Daemon (Python)** | ✅ Tested | pytest |
| **Tauri App (Frontend)** | ❌ No tests | - |
| **Tauri App (Rust backend)** | ❌ No tests | - |
| **Integration (App ↔ Daemon)** | ❌ No tests | - |

---

## Official Tauri E2E Approach: WebDriver

Tauri officially supports E2E testing via the **WebDriver protocol**. This allows automation tools like WebdriverIO or Selenium to interact with the app.

### Platform Support

| Platform | WebDriver Implementation | Cost | Status |
|----------|-------------------------|------|--------|
| **Linux** | `webkit2gtk-driver` | Free | ✅ Native support |
| **Windows** | `msedgedriver` | Free | ✅ Native support |
| **macOS** | CrabNebula Webdriver | **Paid subscription** | ⚠️ Requires `CN_API_KEY` |

### macOS Limitation

> *"The macOS webdriver currently requires a subscription. [Contact us](https://crabnebula.dev/contact/) to get access."*  
> — [CrabNebula Documentation](https://docs.crabnebula.dev/plugins/tauri-e2e-tests/)

macOS does not provide a native WebDriver for desktop applications. CrabNebula (the company behind Tauri) offers a proprietary solution that requires:

1. `@crabnebula/tauri-driver` NPM package
2. `@crabnebula/test-runner-backend` for local macOS testing
3. `tauri-plugin-automation` Rust plugin in the app
4. `CN_API_KEY` environment variable (subscription required)

---

## Available Solutions

### Option 1: CrabNebula tauri-driver (Official)

**Pros:**
- Official Tauri integration
- Well-documented setup
- Works on all platforms (macOS requires subscription)
- CI/CD compatible (GitHub Actions examples available)

**Cons:**
- macOS requires paid subscription (pricing unknown, contact required)
- Complex initial setup
- Requires building the app before each test run

**Required packages:**
```bash
npm install --save-dev @crabnebula/tauri-driver
# For macOS local testing:
npm install --save-dev @crabnebula/test-runner-backend @crabnebula/webdriverio-cloud-reporter
```

**Rust plugin (macOS only):**
```rust
// src-tauri/src/main.rs
let mut builder = tauri::Builder::default();

#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_automation::init());
}
```

### Option 2: tauri-remote-ui (Open Source Alternative)

**Description:** Exposes the Tauri app's UI to any web browser via WebSocket, allowing standard browser automation tools.

**Pros:**
- Free and open source
- Can use Playwright/Cypress (mature tools)
- Works on macOS without subscription

**Cons:**
- Less official/maintained
- Security concerns (exposes UI remotely)
- Additional latency due to network layer
- More "hacky" architecture

**NPM package:** [@anthropic/tauri-remote-ui](https://www.npmjs.com/package/tauri-remote-ui)

### Option 3: Unit/Integration Tests Only (No E2E)

**Description:** Skip E2E testing, focus on unit tests for React components and mocking Tauri's `invoke` API.

**Pros:**
- Fast and reliable
- No platform-specific issues
- Easy to maintain
- Free

**Cons:**
- Doesn't catch integration issues between frontend and daemon
- Doesn't validate the full user flow
- Mocks may diverge from actual behavior

**Tools:**
- Vitest + React Testing Library
- Mock `@tauri-apps/api` calls

---

## CI/CD Considerations

### GitHub Actions Support

| Platform | E2E Support | Requirements |
|----------|-------------|--------------|
| **Linux** | ✅ Yes | `xvfb` (virtual display), `webkit2gtk-driver` |
| **Windows** | ✅ Yes | `msedgedriver` |
| **macOS** | ⚠️ Requires subscription | `CN_API_KEY`, CrabNebula packages |

### Example CI Workflow (Linux)

```yaml
jobs:
  e2e-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y webkit2gtk-driver xvfb
      - name: Build Tauri app
        run: yarn tauri build --debug --no-bundle
      - name: Run E2E tests
        run: xvfb-run yarn test:e2e
```

---

## Recommended Test Scenarios (Simulation Mode)

If we implement E2E testing, these are the critical paths to validate:

| # | Test Case | What it validates |
|---|-----------|-------------------|
| 1 | App launches in sim mode | Build integrity, sidecar bundling |
| 2 | Daemon starts successfully | Daemon lifecycle, IPC communication |
| 3 | Robot state is "sleeping" initially | State machine initialization |
| 4 | Wake up robot | API calls, state transitions |
| 5 | Play an expression | Recorded moves, WebSocket events |
| 6 | Go to sleep | Cleanup, state consistency |
| 7 | Restart daemon | Full lifecycle, resource cleanup |

---

## Cost Analysis

### CrabNebula Cloud Pricing (App Distribution - NOT E2E)

> Note: This is for their app distribution service, not E2E testing specifically.

- **Base price:** €8.85/month
- **Storage:** 1 GB included, €0.41/GB additional
- **Downloads:** 5K/month included, €1.18/10K additional
- **Free trial:** 14 days

### E2E Testing (macOS)

- **Pricing:** Unknown (requires contacting CrabNebula)
- **Contact:** https://crabnebula.dev/contact/

---

## Recommendations

### Short-term (Recommended)

1. **Contact CrabNebula** to inquire about:
   - Pricing for macOS E2E testing subscription
   - Open source / small team discounts
   - Free tier availability

2. **Implement E2E on Linux CI only** (free):
   - Covers most integration scenarios
   - Test locally on macOS manually
   - Use simulation mode for reproducibility

### Medium-term

3. **Add unit tests with Vitest**:
   - Test React components in isolation
   - Mock Tauri `invoke` calls
   - Fast feedback loop

### Long-term

4. **Evaluate tauri-remote-ui** if CrabNebula pricing is prohibitive
5. **Monitor Tauri ecosystem** - E2E tooling is rapidly evolving

---

## References

- [Tauri Official Testing Documentation](https://v2.tauri.app/develop/tests/)
- [Tauri WebDriver Guide](https://tauri.app/develop/tests/webdriver/)
- [CrabNebula E2E Documentation](https://docs.crabnebula.dev/plugins/tauri-e2e-tests/)
- [CrabNebula Cloud Pricing](https://crabnebula.dev/cloud/pricing/)
- [WebdriverIO with Tauri Example](https://tauri.app/develop/tests/webdriver/example/webdriverio/)
- [tauri-remote-ui NPM](https://www.npmjs.com/package/tauri-remote-ui)

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| Jan 2026 | Research phase | Evaluate options before implementation |
| Jan 2026 | **Implemented Linux E2E** | Free WebDriver, validates core functionality |
| Jan 2026 | Skip macOS E2E | CrabNebula subscription required, code is identical |
| Jan 2026 | Integrated into release workflow | E2E must pass before release is published |

## Implementation Status

✅ **E2E Testing is now implemented!**

- **Location**: `e2e/` directory
- **Framework**: WebdriverIO with webkit2gtk-driver
- **CI Integration**: `release-unified.yml` - E2E job blocks release if tests fail
- **Documentation**: `e2e/README.md`

### How it works

1. Release workflow builds the Linux `.deb` package
2. E2E job installs the `.deb` on Ubuntu
3. App launches in simulation mode (`--mockup-sim`)
4. WebdriverIO tests validate app startup, daemon health, and UI rendering
5. If tests fail → release is blocked
6. If tests pass → release proceeds

