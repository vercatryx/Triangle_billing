/**
 * File logger that mirrors full console (log, info, warn, error) to a file.
 * Keeps only the last 3 days of log data so the file stays small.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const RETENTION_DAYS = 3;
const TRIM_INTERVAL_MS = 6 * 60 * 60 * 1000; // trim every 6 hours
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

// ISO timestamp regex at start of line: 2025-03-05T12:00:00.000Z
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;

function parseLineTime(line) {
    const m = line.match(TIMESTAMP_RE);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return isNaN(t) ? null : t;
}

function trimToRetention() {
    try {
        if (!fs.existsSync(LOG_FILE)) return;
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const kept = lines.filter((line) => {
            const t = parseLineTime(line);
            return t === null || t >= cutoff;
        });
        if (kept.length < lines.length) {
            fs.writeFileSync(LOG_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
        }
    } catch (e) {
        // Don't throw; logging should not break the app
        if (typeof process !== 'undefined' && process.stdout && process.stdout.write) {
            process.stdout.write(util.format('[Logger] Trim failed:', e.message) + '\n');
        }
    }
}

function formatMessage(level, args) {
    const ts = new Date().toISOString();
    const prefix = `[${level}]`;
    const text = args.map((a) =>
        typeof a === 'string' ? a : util.inspect(a, { depth: 4, colors: false })
    ).join(' ');
    return `${ts} ${prefix} ${text}\n`;
}

let stream = null;
let trimTimer = null;

function writeToFile(level, args) {
    if (!stream) return;
    try {
        const line = formatMessage(level, args);
        stream.write(line);
    } catch (_) {
        // ignore write errors
    }
}

function install() {
    if (stream) return; // already installed

    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        trimToRetention();
        stream = fs.createWriteStream(LOG_FILE, { flags: 'a', encoding: 'utf8' });
    } catch (e) {
        if (process.stdout && process.stdout.write) {
            process.stdout.write(util.format('[Logger] Could not create log file:', e.message) + '\n');
        }
        return;
    }

    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = function (...args) {
        writeToFile('log', args);
        origLog.apply(console, args);
    };
    console.info = function (...args) {
        writeToFile('info', args);
        origInfo.apply(console, args);
    };
    console.warn = function (...args) {
        writeToFile('warn', args);
        origWarn.apply(console, args);
    };
    console.error = function (...args) {
        writeToFile('error', args);
        origError.apply(console, args);
    };

    trimTimer = setInterval(trimToRetention, TRIM_INTERVAL_MS);
    if (trimTimer.unref) trimTimer.unref();
}

function getLogPath() {
    return LOG_FILE;
}

module.exports = { install, getLogPath, trimToRetention };
