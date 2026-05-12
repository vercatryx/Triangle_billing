#!/usr/bin/env node
/**
 * Installs Playwright browsers (Chromium + headless shell) into playwright-browsers/
 * so they can be bundled with the Windows/Mac installer. Run before electron-builder.
 * Uses PLAYWRIGHT_BROWSERS_PATH so the install goes to our folder, not the default.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const browsersDir = path.join(projectRoot, 'playwright-browsers');
const cliPath = path.join(projectRoot, 'node_modules', 'playwright', 'cli.js');

if (!fs.existsSync(cliPath)) {
  console.error('Playwright not found. Run npm install first.');
  process.exit(1);
}

// Use our directory so we can bundle it
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir };
fs.mkdirSync(browsersDir, { recursive: true });

// Install Chromium and the headless shell (required by Playwright 1.49+ for headless mode)
console.log('Installing Playwright Chromium into playwright-browsers/ ...');
const chromiumResult = spawnSync('node', [cliPath, 'install', 'chromium'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit'
});
if (chromiumResult.status !== 0) {
  console.error('Playwright install chromium failed.');
  process.exit(1);
}

console.log('Installing Chromium headless shell (required for headless mode)...');
const shellResult = spawnSync('node', [cliPath, 'install', 'chromium-headless-shell'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit'
});
if (shellResult.status !== 0) {
  console.error('Playwright install chromium-headless-shell failed.');
  process.exit(1);
}

console.log('Done. playwright-browsers/ is ready to bundle.');
