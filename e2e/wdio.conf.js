/**
 * WebdriverIO Configuration for Tauri E2E Testing
 *
 * Based on the official Tauri WebDriver example:
 * https://v2.tauri.app/develop/tests/webdriver/example/webdriverio/
 *
 * IMPORTANT: tauri-driver 0.1.4 has a known bug with capability matching.
 * Use version 0.1.3: cargo install tauri-driver --version 0.1.3 --locked
 * See: https://github.com/tauri-apps/tauri/issues/8828
 */

import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the installed application (after dpkg -i)
const APP_BINARY = '/usr/bin/reachy-mini-control';

// Keep track of the tauri-driver child process
let tauriDriver;
let exit = false;

export const config = {
  //
  // ====================
  // Runner Configuration
  // ====================
  // IMPORTANT: Must specify host explicitly for tauri-driver
  host: '127.0.0.1',
  port: 4444,
  runner: 'local',

  //
  // ==================
  // Specify Test Files
  // ==================
  specs: [path.join(__dirname, 'specs', '**', '*.spec.js')],
  exclude: [],

  //
  // ============
  // Capabilities
  // ============
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application: APP_BINARY,
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
  // ==============
  // Test Framework
  // ==============
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  //
  // =====
  // Hooks
  // =====

  /**
   * Start tauri-driver before the session starts
   * This is the official approach from Tauri documentation
   */
  beforeSession: () => {
    const tauriDriverPath = path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver');
    
    console.log('🚀 Starting tauri-driver...');
    console.log(`   Path: ${tauriDriverPath}`);
    
    tauriDriver = spawn(tauriDriverPath, [], {
      stdio: [null, process.stdout, process.stderr],
    });

    tauriDriver.on('error', (error) => {
      console.error('❌ tauri-driver error:', error);
      process.exit(1);
    });

    tauriDriver.on('exit', (code) => {
      if (!exit) {
        console.error('❌ tauri-driver exited with code:', code);
        process.exit(1);
      }
    });
  },

  /**
   * Clean up tauri-driver after session ends
   */
  afterSession: () => {
    closeTauriDriver();
  },
};

function closeTauriDriver() {
  exit = true;
  tauriDriver?.kill();
}

function onShutdown(fn) {
  const cleanup = () => {
    try {
      fn();
    } finally {
      process.exit();
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('SIGBREAK', cleanup);
}

// Ensure tauri-driver is closed when the test process exits
onShutdown(() => {
  closeTauriDriver();
});
