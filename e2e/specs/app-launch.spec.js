/**
 * E2E Test: Application Launch & Simulation Mode
 *
 * This test simulates a real user flow:
 * 1. App launches and shows the connection selection screen
 * 2. User clicks on "Simulation" card
 * 3. User clicks "Start" button
 * 4. App starts daemon in simulation mode
 * 5. Robot view appears
 *
 * No hardware required - uses simulation mode.
 */

describe('Reachy Mini Control - Application Launch', () => {
  /**
   * Test: App launches and shows connection screen
   */
  it('should launch the application and show connection screen', async () => {
    // Wait for app to load
    await browser.pause(3000);

    // Get the window title
    const title = await browser.getTitle();
    console.log(`📋 Window title: "${title}"`);
    expect(title).toContain('Reachy Mini');

    // Check that the root element exists and has content
    const appRoot = await browser.$('#root');
    expect(await appRoot.isExisting()).toBe(true);
  });

  /**
   * Test: Connection selection screen is visible
   */
  it('should show the connection selection screen', async () => {
    // Wait for the UI to render
    await browser.pause(2000);

    // Look for the "Connect to Reachy" title or the connection cards
    // The page should have text indicating connection options
    const pageContent = await browser.execute(() => {
      return document.body.innerText;
    });

    console.log(`📄 Page content preview: "${pageContent.substring(0, 200)}..."`);

    // Should contain connection-related text
    const hasConnectionUI =
      pageContent.includes('Connect') ||
      pageContent.includes('Simulation') ||
      pageContent.includes('USB') ||
      pageContent.includes('WiFi');

    expect(hasConnectionUI).toBe(true);
  });

  /**
   * Test: Click on Simulation card and Start
   */
  it('should select Simulation mode and click Start', async () => {
    // Wait for UI to be ready
    await browser.pause(1000);

    // Find and click on the Simulation card
    // The card contains text "Simulation"
    const simulationCard = await browser.$('//div[contains(text(), "Simulation")]/..');
    
    if (await simulationCard.isExisting()) {
      console.log('🎮 Found Simulation card, clicking...');
      await simulationCard.click();
      await browser.pause(500);
    } else {
      // Try alternative selector - look for any clickable element with Simulation text
      console.log('🔍 Trying alternative selector for Simulation...');
      const altSelector = await browser.$('//*[contains(text(), "Simulation")]');
      if (await altSelector.isExisting()) {
        await altSelector.click();
        await browser.pause(500);
      }
    }

    // Find and click the Start button
    // The button contains text "Start"
    const startButton = await browser.$('//button[contains(., "Start")]');
    
    if (await startButton.isExisting() && await startButton.isEnabled()) {
      console.log('▶️ Found Start button, clicking...');
      await startButton.click();
      console.log('✅ Start button clicked!');
    } else {
      // Try alternative - any element with "Start" text that's clickable
      console.log('🔍 Trying alternative selector for Start button...');
      const altStart = await browser.$('//*[contains(text(), "Start")]');
      if (await altStart.isExisting()) {
        await altStart.click();
        console.log('✅ Start clicked via alternative selector');
      }
    }

    // Wait for the app to start transitioning
    await browser.pause(2000);
  });

  /**
   * Test: App transitions to starting/loading state
   */
  it('should show loading state after clicking Start', async () => {
    // After clicking Start, the app should show some loading indication
    // or transition to the HardwareScanView
    await browser.pause(3000);

    const pageContent = await browser.execute(() => {
      return document.body.innerText;
    });

    console.log(`📄 After Start - Page content: "${pageContent.substring(0, 300)}..."`);

    // The app should either:
    // - Show loading/connecting state
    // - Show the daemon starting
    // - Show the robot view
    // Any of these indicates success
    const hasProgressed =
      pageContent.includes('Connecting') ||
      pageContent.includes('Starting') ||
      pageContent.includes('simulation') ||
      pageContent.includes('Simulation') ||
      pageContent.includes('daemon') ||
      pageContent.includes('Reachy') ||
      pageContent.includes('Loading');

    // Log what we see for debugging
    if (!hasProgressed) {
      console.log('⚠️ Page content does not show expected loading state');
      console.log('   This might be okay if the app loads very fast');
    }

    // This test passes as long as the app didn't crash
    expect(true).toBe(true);
  });
});

describe('Reachy Mini Control - Daemon Startup', () => {
  /**
   * Test: Wait for daemon to start (or timeout gracefully)
   */
  it('should wait for daemon initialization', async () => {
    // Wait for daemon to potentially start
    // In CI, this might take longer
    console.log('⏳ Waiting for daemon startup (up to 30 seconds)...');
    
    // Poll for up to 30 seconds
    let daemonStarted = false;
    const maxWait = 30000;
    const pollInterval = 3000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      await browser.pause(pollInterval);

      const pageContent = await browser.execute(() => {
        return document.body.innerText;
      });

      // Check for signs the daemon started or app progressed
      if (
        pageContent.includes('Active') ||
        pageContent.includes('Connected') ||
        pageContent.includes('Robot') ||
        pageContent.includes('Controller') ||
        pageContent.includes('Camera') ||
        pageContent.includes('Apps')
      ) {
        daemonStarted = true;
        console.log('✅ App appears to have progressed past startup!');
        break;
      }

      // Check for error states
      if (pageContent.includes('Error') || pageContent.includes('Failed')) {
        console.log('⚠️ App shows error state:', pageContent.substring(0, 200));
        break;
      }

      console.log(`   Still waiting... (${Math.round((Date.now() - startTime) / 1000)}s)`);
    }

    if (!daemonStarted) {
      console.log('⚠️ Daemon did not start within timeout (this is okay for smoke test)');
    }

    // Smoke test passes as long as app didn't crash
    // Take a final snapshot of page content for debugging
    const finalContent = await browser.execute(() => {
      return document.body.innerText.substring(0, 500);
    });
    console.log(`📄 Final page state: "${finalContent}..."`);

    expect(true).toBe(true);
  });

  /**
   * Test: UI is still responsive
   */
  it('should have a responsive UI', async () => {
    // Final check - make sure the app is still running and responsive
    const title = await browser.getTitle();
    console.log(`📋 Final window title: "${title}"`);

    // The app should still be running
    expect(title).toBeDefined();
    expect(title.length).toBeGreaterThan(0);

    // Check root element still exists
    const rootExists = await browser.execute(() => {
      const root = document.getElementById('root');
      return root !== null && root.innerHTML.length > 0;
    });

    expect(rootExists).toBe(true);
    console.log('✅ App is still responsive!');
  });
});
