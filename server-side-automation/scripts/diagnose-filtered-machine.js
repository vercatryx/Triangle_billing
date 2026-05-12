#!/usr/bin/env node
/**
 * Run this script ON THE FILTERED COMPUTER where the app fails to start.
 * It checks each piece that could fail (TLS/cert, module load order, ports, Playwright).
 *
 * Usage (from server-side-automation folder):
 *   node scripts/diagnose-filtered-machine.js
 *
 * Or from project root:
 *   node server-side-automation/scripts/diagnose-filtered-machine.js
 *
 * Copy the full output and share it to diagnose the issue.
 */

const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(projectRoot, 'src');
const envPath = process.env.DOTENV_CONFIG_PATH || path.join(projectRoot, '.env');

function ok(msg) {
    console.log('[OK]', msg);
}
function fail(msg, err) {
    console.log('[FAIL]', msg);
    if (err) console.log('      ', err.message || err);
}
function section(title) {
    console.log('\n---', title, '---');
}

async function run() {
    let hasFailure = false;

    // ---------------------------------------------------------------------------
    section('1. Node and paths');
    // ---------------------------------------------------------------------------
    try {
        console.log('Node version:', process.version);
        console.log('Platform:', process.platform, process.arch);
        console.log('CWD:', process.cwd());
        console.log('Project root:', projectRoot);
        console.log('.env path:', envPath);
        console.log('.env exists:', fs.existsSync(envPath));
        ok('Paths OK');
    } catch (e) {
        fail('Paths', e);
        hasFailure = true;
    }

    // ---------------------------------------------------------------------------
    section('2. TLS / certificate (what we changed for filtered computer)');
    // ---------------------------------------------------------------------------
    try {
        const https = require('https');
        const defaultReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        console.log('NODE_TLS_REJECT_UNAUTHORIZED (before):', defaultReject === undefined ? '(not set)' : defaultReject);

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        console.log('Set NODE_TLS_REJECT_UNAUTHORIZED=0 (like server.js does)');

        const agent = new https.Agent({ rejectUnauthorized: false });
        ok('Created https.Agent({ rejectUnauthorized: false })');

        const testUrl = 'https://www.vercatryx.com/api/triangle-server/auth-list';
        console.log('Testing HTTPS GET (with cert check disabled):', testUrl);
        await new Promise((resolve, reject) => {
            const req = https.get(testUrl, { timeout: 15000 }, (res) => {
                res.resume();
                ok('HTTPS request succeeded, status: ' + res.statusCode);
                resolve();
            });
            req.on('error', (e) => reject(e));
        });
    } catch (e) {
        fail('TLS / HTTPS', e);
        hasFailure = true;
    }

    // ---------------------------------------------------------------------------
    section('3. Load modules in server startup order (without browser/Playwright)');
    // ---------------------------------------------------------------------------
    try {
        require('path');
        ok('require("path")');
    } catch (e) { fail('path', e); hasFailure = true; }

    try {
        require('fs');
        ok('require("fs")');
    } catch (e) { fail('fs', e); hasFailure = true; }

    try {
        require('http');
        ok('require("http")');
    } catch (e) { fail('http', e); hasFailure = true; }

    try {
        require('dotenv').config({ path: envPath });
        ok('require("dotenv").config()');
    } catch (e) { fail('dotenv', e); hasFailure = true; }

    try {
        const logger = require(path.join(srcRoot, 'core', 'logger.js'));
        if (logger.install) logger.install();
        ok('require("./core/logger") + install()');
    } catch (e) { fail('logger', e); hasFailure = true; }

    try {
        require('express');
        ok('require("express")');
    } catch (e) { fail('express', e); hasFailure = true; }

    try {
        require('axios');
        ok('require("axios")');
    } catch (e) { fail('axios', e); hasFailure = true; }

    try {
        require(path.join(srcRoot, 'core', 'auth.js'));
        ok('require("./core/auth")');
    } catch (e) { fail('auth', e); hasFailure = true; }

    try {
        require(path.join(srcRoot, 'core', 'deviceId.js'));
        ok('require("./core/deviceId")');
    } catch (e) { fail('deviceId', e); hasFailure = true; }

    try {
        require(path.join(srcRoot, 'core', 'proofUrlDownload.js'));
        ok('require("./core/proofUrlDownload") - creates https agent with rejectUnauthorized: false');
    } catch (e) {
        fail('proofUrlDownload (TLS agent)', e);
        hasFailure = true;
    }

    try {
        require(path.join(srcRoot, 'core', 'billingWorker.js'));
        ok('require("./core/billingWorker") - should NOT load browser/Playwright yet');
    } catch (e) {
        fail('billingWorker', e);
        hasFailure = true;
    }

    // ---------------------------------------------------------------------------
    section('4. Port check (find free port in 3008-3012)');
    // ---------------------------------------------------------------------------
    try {
        const net = require('net');
        let freePort = null;
        for (let p = 3008; p <= 3012; p++) {
            const connected = await new Promise((resolve) => {
                const socket = net.connect(p, '127.0.0.1', () => { socket.destroy(); resolve(true); });
                socket.on('error', (e) => { if (e.code === 'ECONNREFUSED') resolve(false); else resolve(true); });
            });
            if (!connected) {
                freePort = p;
                break;
            }
        }
        if (freePort != null) {
            ok('Free port found: ' + freePort);
        } else {
            fail('No free port in 3008-3012 (all in use?)');
            hasFailure = true;
        }
    } catch (e) {
        fail('Port check', e);
        hasFailure = true;
    }

    // ---------------------------------------------------------------------------
    section('5. Playwright load (with 15s timeout - often hangs on filtered networks)');
    // ---------------------------------------------------------------------------
    try {
        console.log('Loading Playwright (chromium)... may hang on filtered networks.');
        const loadPlaywright = () => require('playwright').chromium;
        await Promise.race([
            Promise.resolve().then(loadPlaywright),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout 15s')), 15000))
        ]);
        ok('require("playwright").chromium loaded within 15s');
    } catch (e) {
        fail('Playwright load (timeout or error)', e);
        hasFailure = true;
    }

    // ---------------------------------------------------------------------------
    section('6. Minimal HTTP server listen');
    // ---------------------------------------------------------------------------
    try {
        const http = require('http');
        const express = require('express');
        const app = express();
        app.get('/', (req, res) => res.end('ok'));
        const server = http.createServer(app);
        const port = 3010;
        await new Promise((resolve, reject) => {
            server.listen(port, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });
        ok('Express server listened on port ' + port);
        await new Promise((r) => server.close(r));
    } catch (e) {
        fail('Minimal server listen', e);
        hasFailure = true;
    }

    // ---------------------------------------------------------------------------
    section('Summary');
    // ---------------------------------------------------------------------------
    if (hasFailure) {
        console.log('\nSome checks failed. Copy this full output to share for diagnosis.');
        process.exit(1);
    } else {
        console.log('\nAll checks passed. If the app still does not start, the issue may be');
        console.log('Electron-specific (e.g. spawn path, env, or packaged paths).');
        process.exit(0);
    }
}

run().catch((e) => {
    console.error('Script error:', e);
    process.exit(1);
});
