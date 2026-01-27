/**
 * WebdriverIO Configuration for Tauri v2 E2E Testing
 *
 * Supports both Linux and Windows platforms:
 * - Linux: Uses WebKitWebDriver via tauri-driver
 * - Windows: Uses MSEdgeDriver via tauri-driver
 *
 * Based on official Tauri v2 documentation:
 * https://v2.tauri.app/develop/tests/webdriver/example/webdriverio/
 *
 * IMPORTANT: This project uses Tauri v2, so we need tauri-driver 2.0.x
 * Install with: cargo install tauri-driver --locked
 */

import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Detect platform
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/**
 * Get the path to the installed application
 * Can be overridden via E2E_APP_BINARY environment variable
 */
function getAppBinary() {
  // Allow override via environment variable (useful for CI)
  if (process.env.E2E_APP_BINARY) {
    console.log(`📍 Using E2E_APP_BINARY from env: ${process.env.E2E_APP_BINARY}`);
    return process.env.E2E_APP_BINARY;
  }

  if (isWindows) {
    // Windows: Installed via MSI to Program Files
    return 'C:\\Program Files\\Reachy Mini Control\\Reachy Mini Control.exe';
  } else if (isLinux) {
    // Linux: Installed via .deb to /usr/bin
    return '/usr/bin/reachy-mini-control';
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/**
 * Get the path to tauri-driver executable
 */
function getTauriDriverPath() {
  const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
  const binName = isWindows ? 'tauri-driver.exe' : 'tauri-driver';
  return path.join(cargoHome, 'bin', binName);
}

const APP_BINARY = getAppBinary();

// Keep track of the tauri-driver child process
let tauriDriver;
let exit = false;

export const config = {
  //
  // ====================
  // Runner Configuration
  // ====================
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
   * Start tauri-driver before each session
   * Official pattern: spawn with NO arguments, tauri-driver uses default port 4444
   */
  beforeSession: () => {
    const tauriDriverPath = getTauriDriverPath();

    console.log('🚀 Starting tauri-driver...');
    console.log(`   Platform: ${process.platform}`);
    console.log(`   Path: ${tauriDriverPath}`);
    console.log(`   App: ${APP_BINARY}`);

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
