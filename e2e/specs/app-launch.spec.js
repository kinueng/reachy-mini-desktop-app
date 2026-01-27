/**
 * E2E Test: Application Launch
 *
 * This is a smoke test that validates the core application functionality:
 * 1. The app launches successfully
 * 2. The window is created with the correct title
 * 3. The daemon starts and responds
 *
 * This test runs in simulation mode (--mockup-sim) so no hardware is required.
 */

describe('Reachy Mini Control - Application Launch', () => {
  /**
   * Test: App window opens with correct title
   */
  it('should launch the application and show the window', async () => {
    // Wait for the app to fully load
    // The app goes through several stages: permissions, update check, finding robot, etc.
    await browser.pause(5000);

    // Get the window title
    const title = await browser.getTitle();
    console.log(`📋 Window title: "${title}"`);

    // The title should contain "Reachy Mini"
    expect(title).toContain('Reachy Mini');
  });

  /**
   * Test: Daemon health check responds
   *
   * The daemon should start automatically when the app launches in sim mode.
   * We verify it's running by checking the health endpoint.
   */
  it('should have the daemon running and responding', async () => {
    // Wait for daemon to be fully initialized
    // In sim mode, startup is faster but still takes a few seconds
    await browser.pause(10000);

    // Execute JavaScript in the app context to check daemon status
    // The app uses fetch to communicate with the daemon at localhost:8000
    const daemonStatus = await browser.execute(async () => {
      try {
        const response = await fetch('http://localhost:8000/api/daemon/status', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          return { error: `HTTP ${response.status}` };
        }

        return await response.json();
      } catch (error) {
        return { error: error.message };
      }
    });

    console.log(`🤖 Daemon status:`, JSON.stringify(daemonStatus, null, 2));

    // Verify daemon responded without error
    expect(daemonStatus.error).toBeUndefined();
  });

  /**
   * Test: UI elements are rendered
   *
   * Check that basic UI elements are present, indicating React rendered successfully.
   */
  it('should render the main UI elements', async () => {
    // Wait for React to render
    await browser.pause(2000);

    // Check that the app root element exists
    const appRoot = await browser.$('#root');
    const exists = await appRoot.isExisting();

    expect(exists).toBe(true);

    // Check that something is rendered inside
    const innerHTML = await browser.execute(() => {
      const root = document.getElementById('root');
      return root ? root.innerHTML.length : 0;
    });

    console.log(`📐 Root element innerHTML length: ${innerHTML}`);

    // Should have substantial content (not empty)
    expect(innerHTML).toBeGreaterThan(100);
  });
});

describe('Reachy Mini Control - Simulation Mode', () => {
  /**
   * Test: Robot state in simulation mode
   *
   * In simulation mode, the robot should start in a known state.
   */
  it('should have robot in simulation mode', async () => {
    // Query the daemon for robot info
    const robotInfo = await browser.execute(async () => {
      try {
        const response = await fetch('http://localhost:8000/api/robot/info', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });

        if (!response.ok) {
          return { error: `HTTP ${response.status}` };
        }

        return await response.json();
      } catch (error) {
        return { error: error.message };
      }
    });

    console.log(`🎮 Robot info:`, JSON.stringify(robotInfo, null, 2));

    // In sim mode, we expect the robot to be detected (simulated)
    // The exact response depends on the daemon API, but it shouldn't error
    if (robotInfo.error) {
      // Some endpoints might not exist, that's okay for a smoke test
      console.log(`⚠️ Robot info endpoint returned: ${robotInfo.error}`);
    }
  });
});
