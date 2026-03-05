// Load .env first so all required modules see fresh values
require('dotenv').config(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {});

// File logger: full console (log/info/warn/error) → logs/server.log, keeps last 3 days
const { install: installLogger, getLogPath } = require('./core/logger');
installLogger();

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { launchBrowser, closeBrowser, getActiveCount, MAX_BROWSERS } = require('./core/browser');
const { performLoginSequence } = require('./core/auth');
const { billingWorker, fetchRequestsFromApi, fetchRequestsFromTSS } = require('./core/billingWorker');
const { getDeviceId } = require('./core/deviceId');

const app = express();
const PORT = process.env.PORT || 3500;

// Log env fingerprint at startup so you can confirm this process is using fresh .env
(function logEnvFingerprint() {
    const envPath = path.resolve(process.cwd(), '.env');
    let mtime = '';
    try {
        const s = fs.statSync(envPath);
        mtime = new Date(s.mtime).toISOString();
    } catch (_) {
        mtime = '(no .env file)';
    }
    const maxBrowsers = process.env.MAX_BROWSERS || '15';
    const defaultBrowsers = process.env.DEFAULT_BROWSERS || '10';
    console.log(`[Env] Loaded .env (mtime: ${mtime}) → PORT=${PORT}, MAX_BROWSERS=${maxBrowsers}, DEFAULT_BROWSERS=${defaultBrowsers}`);
})();

// Allow large queue payloads when running "Run current queue" with many items (default is 100kb)
app.use(express.json({ limit: '10mb' }));
// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// -- SSE Setup --
let clients = [];

function eventsHandler(req, res) {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
    res.writeHead(200, headers);

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    clients.push(newClient);

    // Send initial queue state if exists
    if (currentRequests) {
        res.write(`event: queue\ndata: ${JSON.stringify(currentRequests)}\n\n`);
    }
    // Send config (e.g. current browser count; may change during run)
    res.write(`event: config\ndata: ${JSON.stringify({ browserCount: getActiveCount(), maxBrowsers: MAX_BROWSERS })}\n\n`);
    if (lastSystemState) {
        res.write(`event: system\ndata: ${JSON.stringify(lastSystemState)}\n\n`);
    }

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
}

function broadcast(type, data) {
    clients.forEach(client => {
        client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    });
}

// Live CPU usage (process + system load) for dashboard
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let lastSystemState = null;

setInterval(() => {
    const now = Date.now();
    const elapsedSec = (now - lastCpuTime) / 1000;
    const delta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = now;
    const cpuPercent = elapsedSec > 0
        ? Math.min(100, Math.round(((delta.user + delta.system) / 1e6 / elapsedSec) * 100))
        : 0;
    const loadAvg = os.loadavg && os.loadavg();
    lastSystemState = { cpuPercent, loadAvg: loadAvg || [0, 0, 0] };
    broadcast('system', lastSystemState);
}, 1500);

app.get('/events', eventsHandler);

// Download log file (copy to user-chosen location via browser Save As). Allowed when unauth for easy access.
app.get('/api/log-file', (req, res) => {
    const logPath = getLogPath();
    if (!fs.existsSync(logPath)) {
        return res.status(404).json({ error: 'Log file not found' });
    }
    const name = `server-log-${new Date().toISOString().slice(0, 10)}.log`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.sendFile(logPath);
});

// Billing UI (same as index) – ensure reachable at /billing (e.g. localhost:3000/billing)
app.get('/billing', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// -- Device authorization: GET returns {"deviceIds":["id1","id2"]} --
const DEFAULT_AUTH_LIST_URL = 'https://www.vercatryx.com/api/triangle-server/auth-list';
const AUTHORIZED_DEVICES_URL = (process.env.AUTHORIZED_DEVICES_URL && process.env.AUTHORIZED_DEVICES_URL.trim()) || DEFAULT_AUTH_LIST_URL;
let authorizedDeviceIdsCache = null;
let authorizedDeviceIdsCacheTime = 0;
const AUTHORIZED_CACHE_MS = 60 * 1000;

/** Normalize ID for lenient comparison: trim, lowercase, collapse/remove all whitespace. */
function normalizeDeviceIdForCompare(id) {
    if (id == null) return '';
    return String(id).trim().toLowerCase().replace(/\s+/g, '');
}

async function fetchAuthorizedDeviceIds() {
    if (!AUTHORIZED_DEVICES_URL) return null;
    const now = Date.now();
    if (authorizedDeviceIdsCache && now - authorizedDeviceIdsCacheTime < AUTHORIZED_CACHE_MS) {
        return authorizedDeviceIdsCache;
    }
    try {
        const res = await axios.get(AUTHORIZED_DEVICES_URL, { timeout: 10000 });
        if (res.status < 200 || res.status >= 300) {
            authorizedDeviceIdsCache = [];
            authorizedDeviceIdsCacheTime = now;
            return [];
        }
        const list = res.data && res.data.deviceIds;
        if (!Array.isArray(list)) {
            authorizedDeviceIdsCache = [];
            authorizedDeviceIdsCacheTime = now;
            return [];
        }
        authorizedDeviceIdsCache = list.map(id => String(id).trim());
        authorizedDeviceIdsCacheTime = now;
        return authorizedDeviceIdsCache;
    } catch (e) {
        // Fail closed: any connection/network/parse error = disallow
        console.error('[Server] Auth list unreachable or error – denying access:', e.message);
        authorizedDeviceIdsCache = [];
        authorizedDeviceIdsCacheTime = now;
        return [];
    }
}

async function isDeviceAuthorized() {
    const list = await fetchAuthorizedDeviceIds();
    if (list === null) return true; // no URL configured => no restriction
    const deviceId = getDeviceId();
    const normalized = normalizeDeviceIdForCompare(deviceId);
    return list.some(authorizedId => normalizeDeviceIdForCompare(authorizedId) === normalized);
}

/** Middleware: reject with 403 and deviceId if this device is not authorized. */
async function requireAuthorizedDevice(req, res, next) {
    try {
        const authorized = await isDeviceAuthorized();
        if (authorized) return next();
        const deviceId = getDeviceId();
        const ids = await fetchAuthorizedDeviceIds();
        console.log('[Server] Access denied. Device ID:', deviceId, '— Authorized IDs:', Array.isArray(ids) && ids.length ? ids.join(', ') : '(none)');
        return res.status(403).json({
            error: 'This device is not authorized to run automation.',
            deviceId
        });
    } catch (e) {
        const deviceId = getDeviceId();
        const ids = await fetchAuthorizedDeviceIds().catch(() => []);
        console.log('[Server] Access denied (error). Device ID:', deviceId, '— Authorized IDs:', Array.isArray(ids) && ids.length ? ids.join(', ') : '(none)');
        return res.status(403).json({
            error: 'Device authorization check failed. Access denied.',
            deviceId
        });
    }
}

app.get('/device-status', async (req, res) => {
    const deviceId = getDeviceId();
    if (!AUTHORIZED_DEVICES_URL) {
        return res.json({ deviceId, authorized: true, authorizedDeviceIds: [] });
    }
    try {
        const authorizedIds = await fetchAuthorizedDeviceIds();
        const authorized = Array.isArray(authorizedIds) && authorizedIds.includes(deviceId);
        if (!authorized) {
            console.log('[Server] Device not authorized. Device ID:', deviceId, '— Authorized IDs:', authorizedIds && authorizedIds.length ? authorizedIds.join(', ') : '(none)');
        }
        return res.json({ deviceId, authorized, authorizedDeviceIds: authorizedIds || [] });
    } catch (e) {
        console.log('[Server] Device status check failed – denying. Device ID:', deviceId);
        return res.status(500).json({ deviceId, authorized: false, authorizedDeviceIds: [], error: 'Could not verify device.' });
    }
});

// State
let isRunning = false;
let currentRequests = null;
let shouldStop = false;
let stopBillingWorker = null;

// Routes (device authorization applied to all action endpoints)
app.post('/fetch-requests', requireAuthorizedDevice, async (req, res) => {
    try {
        console.log('[Server] Fetching requests from TSS API (Preview Mode)...');
        const requests = await fetchRequestsFromTSS();

        if (!requests || requests.length === 0) {
            return res.json({ success: true, count: 0, message: 'No pending requests found.' });
        }

        // Initialize status
        requests.forEach(r => { r.status = 'pending'; r.message = ''; });
        currentRequests = requests;
        broadcast('queue', currentRequests);

        res.json({ success: true, count: requests.length, message: `Loaded ${requests.length} requests.` });
    } catch (e) {
        console.error('[Server] Fetch Preview Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Save billing requests (e.g. after Excel import) to billing_requests.json and update queue
app.post('/billing-requests', requireAuthorizedDevice, (req, res) => {
    const { requests: bodyRequests } = req.body;
    if (!Array.isArray(bodyRequests) || bodyRequests.length === 0) {
        return res.status(400).json({ error: 'Body must contain "requests" as a non-empty array.' });
    }
    const jsonPath = path.join(__dirname, '../billing_requests.json');
    try {
        const requests = bodyRequests.map(r => {
            const out = {
                name: r.name != null ? r.name : '',
                url: r.url != null ? String(r.url).trim() : '',
                date: r.date != null ? String(r.date).trim() : '',
                amount: typeof r.amount === 'number' ? r.amount : (r.amount != null ? Number(String(r.amount).replace(/[^\d.-]/g, '')) : 0),
                proofURL: r.proofURL != null ? (Array.isArray(r.proofURL) ? (r.proofURL[0] || '') : String(r.proofURL)) : '',
                dependants: Array.isArray(r.dependants) ? r.dependants : []
            };
            if (r.equipment === true || r.equipment === 'true' || r.equtment === true || r.equtment === 'true') out.equipment = 'true';
            if (Array.isArray(r.orderIds) && r.orderIds.length) out.orderIds = r.orderIds;
            return out;
        });
        fs.writeFileSync(jsonPath, JSON.stringify(requests, null, 4), 'utf8');
        requests.forEach(r => { r.status = 'pending'; r.message = ''; });
        currentRequests = requests;
        broadcast('queue', currentRequests);
        console.log(`[Server] Saved ${requests.length} requests to billing_requests.json`);
        res.json({ success: true, count: requests.length, message: `Saved ${requests.length} requests to billing file.` });
    } catch (e) {
        console.error('[Server] Save billing-requests Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Load billing_requests.json into the queue only (no automation run). Use "Run current queue" to run.
app.post('/load-billing-file', requireAuthorizedDevice, (req, res) => {
    const jsonPath = path.join(__dirname, '../billing_requests.json');
    if (!fs.existsSync(jsonPath)) {
        return res.status(404).json({ error: 'billing_requests.json not found' });
    }
    try {
        const data = fs.readFileSync(jsonPath, 'utf8');
        const requests = JSON.parse(data);
        if (!Array.isArray(requests)) {
            return res.status(500).json({ error: 'billing_requests.json must contain an array' });
        }
        if (requests.length === 0) {
            return res.status(400).json({ error: 'No requests found in billing_requests.json' });
        }
        requests.forEach(r => { r.status = r.status || 'pending'; r.message = r.message || ''; });
        currentRequests = requests;
        broadcast('queue', currentRequests);
        console.log(`[Server] Loaded ${requests.length} requests from billing_requests.json (queue only)`);
        res.json({ success: true, count: requests.length, message: `Loaded ${requests.length} requests. Run the queue when ready.` });
    } catch (e) {
        console.error('[Server] Load billing file Error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/process-billing', requireAuthorizedDevice, async (req, res) => {
    if (isRunning) {
        return res.status(409).json({ message: 'Process already running' });
    }

    const { source = 'file', requests: bodyRequests } = req.body;

    let requests = [];

    try {
        if (source === 'file') {
            // -- SOURCE: FILE --
            const jsonPath = path.join(__dirname, '../billing_requests.json');
            if (!fs.existsSync(jsonPath)) {
                return res.status(404).json({ error: 'billing_requests.json not found' });
            }
            const data = fs.readFileSync(jsonPath, 'utf8');
            requests = JSON.parse(data);

            // Validate that we have an array
            if (!Array.isArray(requests)) {
                return res.status(500).json({ error: 'billing_requests.json must contain an array' });
            }
            if (requests.length === 0) {
                return res.status(400).json({ error: 'No requests found in billing_requests.json' });
            }

            // Initialize status for UI
            requests.forEach(r => { r.status = 'pending'; r.message = ''; });
            currentRequests = requests;
            broadcast('queue', currentRequests);
        } else if (source === 'queue') {
            // -- SOURCE: QUEUE (client sends selected list – no refetch) --
            if (!Array.isArray(bodyRequests) || bodyRequests.length === 0) {
                return res.status(400).json({
                    error: bodyRequests == null
                        ? 'Missing "requests" in body for Run current queue.'
                        : 'No requests in queue. Select items or load from server first.'
                });
            }
            // Use a shallow copy so we have a stable snapshot (objects inside are same refs for status updates)
            requests = bodyRequests.slice();
            requests.forEach(r => { r.status = r.status || 'pending'; r.message = r.message || ''; });
            currentRequests = requests;
            broadcast('queue', currentRequests);
            broadcast('log', { message: `Running ${requests.length} request(s) from current queue (no refetch).`, type: 'info' });
            console.log(`[Server] Run current queue: ${requests.length} request(s) (no TSS refetch).`);
        } else {
            // -- SOURCE: TSS API (only for "Start from Server") --
            console.log('[Server] Fetching requests from TSS API...');
            requests = await fetchRequestsFromTSS();
            
            if (!requests || requests.length === 0) {
                return res.status(400).json({ error: 'No requests found from TSS API' });
            }

            // Initialize status for UI
            requests.forEach(r => { r.status = 'pending'; r.message = ''; });
            currentRequests = requests;
            broadcast('queue', currentRequests);
            broadcast('log', { message: `Fetched ${requests.length} requests from TSS API.`, type: 'info' });
        }

    } catch (e) {
        console.error('[Server] Setup Error:', e);
        return res.status(500).json({ error: `Setup failed: ${e.message}` });
    }

    console.log(`[Server] Starting automation (Source: ${source})`);
    res.json({ message: 'Automation started', source: source });

    isRunning = true;
    shouldStop = false;
    broadcast('log', { message: `--- Starting Automation Run (${source}) ---`, type: 'info' });
    broadcast('status', { isRunning: true });

    // For TSS API, we don't need apiConfig since it's a public endpoint
    const apiConfig = null;

    // Create stop function that can be called to stop the worker
    stopBillingWorker = () => {
        shouldStop = true;
        console.log('[Server] Stop signal received');
    };

    (async () => {
        try {
            await launchBrowser();
            // Pass requests to worker (for file mode) or null (for API mode, worker will fetch from TSS)
            // Also pass a function to check if we should stop
            await billingWorker((source === 'file' || source === 'queue') ? requests : null, broadcast, source, apiConfig, () => shouldStop);
            if (shouldStop) {
                broadcast('log', { message: '--- Automation Run Stopped by User ---', type: 'warning' });
            } else {
                broadcast('log', { message: '--- Automation Run Complete ---', type: 'success' });
            }
        } catch (e) {
            console.error('CRITICAL AUTOMATION ERROR:', e);
            broadcast('log', { message: `Critical Error: ${e.message}`, type: 'error' });
        } finally {
            isRunning = false;
            shouldStop = false;
            stopBillingWorker = null;
            closeBrowser();
            broadcast('status', { isRunning: false });
            broadcast('runners', []);
        }
    })();
});

app.post('/stop-billing', requireAuthorizedDevice, (req, res) => {
    if (!isRunning) {
        return res.json({ message: 'No process is currently running' });
    }

    console.log('[Server] Stop request received');
    shouldStop = true;
    if (stopBillingWorker) {
        stopBillingWorker();
    }
    
    broadcast('log', { message: 'Stop signal sent. Process will stop after current client...', type: 'warning' });
    res.json({ message: 'Stop signal sent' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
