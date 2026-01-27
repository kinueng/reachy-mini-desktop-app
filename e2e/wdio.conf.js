/**
 * WebdriverIO Configuration for Tauri E2E Testing
 *
 * This config is designed to test the installed .deb package on Linux CI.
 * It uses webkit2gtk-driver which is the native WebDriver for Tauri on Linux.
 *
 * @see https://tauri.app/develop/tests/webdriver/
 */

import { spawn } from 'child_process';
import path from 'path';

// Path to the installed application (after dpkg -i)
const APP_BINARY = '/usr/bin/reachy-mini-control';

// Timeout for app startup (daemon needs time to initialize)
const APP_STARTUP_TIMEOUT = 30000;

// WebDriver port
const WEBDRIVER_PORT = 4444;

let tauriDriver;

export const config = {
  //
  // ====================
  // Runner Configuration
  // ====================
  runner: 'local',
  port: WEBDRIVER_PORT,

  //
  // ==================
  // Specify Test Files
  // ==================
  specs: ['./e2e/specs/**/*.spec.js'],
  exclude: [],

  //
  // ============
  // Capabilities
  // ============
  maxInstances: 1, // Tauri apps can only run one instance at a time
  capabilities: [
    {
      'tauri:options': {
        application: APP_BINARY,
        // Launch in simulation mode (no hardware required)
        args: ['--', '--mockup-sim'],
      },
    },
  ],

  //
  // ===================
  // Test Configurations
  // ===================
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  //
  // =====
  // Hooks
  // =====

  /**
   * Gets executed once before all workers get launched.
   * Start the WebKitWebDriver (tauri-driver equivalent on Linux)
   */
  onPrepare: function () {
    return new Promise((resolve, reject) => {
      // On Linux, we use WebKitWebDriver from webkit2gtk
      // It's typically at /usr/bin/WebKitWebDriver
      const driverPath =
        process.env.WEBDRIVER_PATH || '/usr/bin/WebKitWebDriver';

      console.log(`🚀 Starting WebKitWebDriver at ${driverPath}...`);

      tauriDriver = spawn(driverPath, ['--port', WEBDRIVER_PORT.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      tauriDriver.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[WebDriver] ${output}`);
        // WebKitWebDriver logs when it's ready
        if (output.includes('Listening on')) {
          console.log('✅ WebKitWebDriver is ready');
          resolve();
        }
      });

      tauriDriver.stderr.on('data', (data) => {
        console.error(`[WebDriver Error] ${data}`);
      });

      tauriDriver.on('error', (err) => {
        console.error('❌ Failed to start WebKitWebDriver:', err);
        reject(err);
      });

      tauriDriver.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`❌ WebKitWebDriver exited with code ${code}`);
        }
      });

      // Timeout if WebDriver doesn't start
      setTimeout(() => {
        reject(new Error('WebKitWebDriver failed to start within timeout'));
      }, 15000);
    });
  },

  /**
   * Gets executed after all workers got shut down and the process is about to exit.
   */
  onComplete: function () {
    if (tauriDriver) {
      console.log('🛑 Stopping WebKitWebDriver...');
      tauriDriver.kill();
    }
  },

  //
  // ==============
  // Test Framework
  // ==============
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: APP_STARTUP_TIMEOUT + 60000, // Extra time for tests
  },
};
