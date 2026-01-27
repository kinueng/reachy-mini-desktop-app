/**
 * WebdriverIO Configuration for Tauri E2E Testing
 *
 * This config is designed to test the installed .deb package on Linux CI.
 * It uses tauri-driver which wraps the native WebDriver (webkit2gtk-driver on Linux).
 *
 * @see https://tauri.app/develop/tests/webdriver/
 * @see https://v2.tauri.app/develop/tests/webdriver/ci/
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // Use absolute path to ensure specs are found regardless of working directory
  specs: [path.join(__dirname, 'specs', '**', '*.spec.js')],
  exclude: [],

  //
  // ============
  // Capabilities
  // ============
  maxInstances: 1, // Tauri apps can only run one instance at a time
  capabilities: [
    {
      // Standard WebDriver capabilities
      browserName: 'wry',
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
   * Start tauri-driver which wraps the native WebDriver
   */
  onPrepare: function () {
    return new Promise((resolve, reject) => {
      // Use tauri-driver which handles the WebDriver protocol for Tauri apps
      // tauri-driver must be installed via: cargo install tauri-driver
      const driverPath = process.env.TAURI_DRIVER_PATH || 'tauri-driver';

      console.log(`🚀 Starting tauri-driver...`);
      console.log(`   Driver: ${driverPath}`);
      console.log(`   Port: ${WEBDRIVER_PORT}`);

      tauriDriver = spawn(driverPath, ['--port', WEBDRIVER_PORT.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let resolved = false;

      tauriDriver.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[tauri-driver] ${output.trim()}`);
        // tauri-driver logs when it's ready
        if (!resolved && (output.includes('Listening') || output.includes('listening'))) {
          console.log('✅ tauri-driver is ready');
          resolved = true;
          resolve();
        }
      });

      tauriDriver.stderr.on('data', (data) => {
        const output = data.toString();
        console.log(`[tauri-driver stderr] ${output.trim()}`);
        // tauri-driver may log to stderr when ready
        if (!resolved && (output.includes('Listening') || output.includes('listening'))) {
          console.log('✅ tauri-driver is ready');
          resolved = true;
          resolve();
        }
      });

      tauriDriver.on('error', (err) => {
        console.error('❌ Failed to start tauri-driver:', err);
        console.error('   Make sure tauri-driver is installed: cargo install tauri-driver');
        reject(err);
      });

      tauriDriver.on('close', (code) => {
        if (code !== 0 && code !== null && !resolved) {
          console.error(`❌ tauri-driver exited with code ${code}`);
          reject(new Error(`tauri-driver exited with code ${code}`));
        }
      });

      // Give tauri-driver time to start, then assume it's ready
      // (some versions don't log "Listening")
      setTimeout(() => {
        if (!resolved) {
          console.log('⏳ Assuming tauri-driver is ready after timeout...');
          resolved = true;
          resolve();
        }
      }, 5000);
    });
  },

  /**
   * Gets executed after all workers got shut down and the process is about to exit.
   */
  onComplete: function () {
    if (tauriDriver) {
      console.log('🛑 Stopping tauri-driver...');
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
