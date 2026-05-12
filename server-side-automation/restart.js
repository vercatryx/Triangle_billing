#!/usr/bin/env node

const path = require('path');
// Load .env from this script's directory so PORT is correct when run from any cwd (e.g. npm from repo root)
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { execSync } = require('child_process');
const { spawn } = require('child_process');
const os = require('os');

const PORT = process.env.PORT || 3500;

console.log(`Killing any process on port ${PORT}...`);
try {
    if (os.platform() === 'win32') {
        const out = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
        const pids = [...new Set(out.split('\n').map(line => {
            const m = line.trim().split(/\s+/);
            return m[m.length - 1];
        }).filter(pid => /^\d+$/.test(pid)))];
        for (const pid of pids) {
            try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch (_) {}
        }
        if (pids.length) console.log('Done. Waiting for port to be released...');
    } else {
        execSync(`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`, { encoding: 'utf8' });
        console.log('Done. Waiting for port to be released...');
    }
} catch (e) {
    // No process on port or command failed; that's fine
}
setTimeout(() => {
    startServer();
}, 2000);

function startServer() {
    console.log('Starting server...');
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: __dirname,
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'inherit'
    });
    
    server.on('error', (err) => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
    
    // Handle Ctrl+C
    process.on('SIGINT', () => {
        console.log('\nShutting down server...');
        server.kill();
        process.exit(0);
    });
}

