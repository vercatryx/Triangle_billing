// Load .env first so all required modules see fresh values.
const path = require('path');
const fs = require('fs');

// .env must be in the project root: same folder as package.json and src/
const projectRoot = path.resolve(__dirname, '..');
const envPath = process.env.DOTENV_CONFIG_PATH || path.join(projectRoot, '.env');

const envExists = (() => { try { return fs.existsSync(envPath); } catch (_) { return false; } })();
console.log('[Env] Using .env at:', envPath);
console.log('[Env] File exists:', envExists, envExists ? '' : '→ Put .env in: ' + projectRoot);

const envResult = require('dotenv').config({ path: envPath });
if (envResult.error && !process.env.DOTENV_CONFIG_PATH) {
    require('dotenv').config(); // fallback: cwd
}

// PORT: use env, or parse from .env file if dotenv didn't set it (e.g. Windows path/encoding)
function getPort() {
    const fromEnv = process.env.PORT;
    if (fromEnv != null && String(fromEnv).trim() !== '') {
        const n = parseInt(String(fromEnv).trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
    }
    try {
        const content = fs.readFileSync(envPath, 'utf8');
        const m = content.match(/^\s*PORT\s*=\s*(\d+)/m);
        if (m) return parseInt(m[1], 10);
    } catch (_) {}
    return 3500;
}
const PORT = getPort();

// File logger: full console (log/info/warn/error) → logs/server.log, keeps last 3 days
const { install: installLogger, getLogPath } = require('./core/logger');
try {
    installLogger();
} catch (e) {
    try { console.warn('[Server] Logger init failed (logs may not be saved):', e.message); } catch (_) {}
}

const express = require('express');
const axios = require('axios');
const https = require('https');
const tlsRelaxedAgent = new https.Agent({ rejectUnauthorized: false });
// Lazy-load browser (Playwright) so server can listen immediately; avoids hang/crash on filtered networks (since 1.0.8).
let _browser = null;
function getBrowser() {
    if (!_browser) _browser = require('./core/browser');
    return _browser;
}
const { performLoginSequence } = require('./core/auth');
const { billingWorker, fetchRequestsFromApi, fetchRequestsFromTSS } = require('./core/billingWorker');
const { getDeviceId } = require('./core/deviceId');

const app = express();

// Log env fingerprint (same path as above)
(function logEnvFingerprint() {
    let mtime = '';
    try {
        const s = fs.statSync(envPath);
        mtime = new Date(s.mtime).toISOString();
    } catch (_) {
        mtime = '(not found)';
    }
    const maxBrowsers = process.env.MAX_BROWSERS || '15';
    console.log(`[Env] .env mtime: ${mtime} → PORT=${PORT}, MAX_BROWSERS=${maxBrowsers}`);
})();

// Allow large queue payloads when running "Run current queue" with many items (default is 100kb)
app.use(express.json({ limit: '10mb' }));
// Serve static frontend
app.use(express.static(path.join(__dirname, '../public')));

// -- SSE Setup --
let clients = [];
let lastSystemState = null;

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
    res.write(`event: config\ndata: ${JSON.stringify({ browserCount: getBrowser().getActiveCount(), maxBrowsers: getBrowser().MAX_BROWSERS })}\n\n`);
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
    const tryFetch = async (attempt) => {
        const res = await axios.get(AUTHORIZED_DEVICES_URL, { timeout: 15000, httpsAgent: tlsRelaxedAgent });
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
    };
    try {
        return await tryFetch(1);
    } catch (e) {
        try {
            await new Promise((r) => setTimeout(r, 1500));
            return await tryFetch(2);
        } catch (e2) {
            console.error('[Server] Auth list unreachable (tried twice) – denying access:', e.message);
            authorizedDeviceIdsCache = [];
            authorizedDeviceIdsCacheTime = now;
            return [];
        }
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

const BILLING_FILE_PATH = path.join(__dirname, '../billing_requests.json');

/** Stable key for dedup/merge and for removing from file (url|date|name). */
function requestKey(r) {
    const url = (r && r.url != null) ? String(r.url).trim() : '';
    const date = (r && r.date != null) ? String(r.date).trim() : '';
    const name = (r && r.name != null) ? String(r.name).trim() : '';
    return `${url}|${date}|${name}`;
}

/** Normalize a request from TSS API (or any source) to our file shape; API may use different field names. */
function normalizeIncomingRequest(r) {
    if (!r || typeof r !== 'object') return null;
    const url = (r.url ?? r.order_url ?? r.link ?? r.page_url ?? r.orderLink ?? '').toString().trim();
    const date = (r.date ?? r.start_date ?? r.service_date ?? r.period_start ?? r.serviceDate ?? '').toString().trim();
    const name = (r.name ?? r.client_name ?? r.clientName ?? r.client ?? '').toString().trim();
    const amount = typeof r.amount === 'number' ? r.amount : (r.amount != null ? Number(String(r.amount).replace(/[^\d.-]/g, '')) : 0);
    let proofURL = r.proofURL ?? r.proof_url ?? r.proofUrl ?? r.document_url ?? '';
    if (Array.isArray(proofURL)) proofURL = proofURL[0] || '';
    proofURL = proofURL ? String(proofURL).trim() : '';
    const equipment = r.equipment === true || r.equipment === 'true' || r.equtment === true || r.equtment === 'true';
    const dependants = Array.isArray(r.dependants) ? r.dependants : [];
    const orderIds = Array.isArray(r.orderIds) && r.orderIds.length ? r.orderIds : (Array.isArray(r.order_ids) ? r.order_ids : []);
    const out = { name, url, date, amount, proofURL, dependants };
    if (equipment) out.equipment = 'true';
    if (orderIds.length) out.orderIds = orderIds;
    return out;
}

/** Merge new requests into billing_requests.json (add only new keys). Uses normalizeIncomingRequest so API field names work. Returns merged array. */
function mergeNewRequestsIntoFile(newRequests) {
    let existing = [];
    if (fs.existsSync(BILLING_FILE_PATH)) {
        try {
            const data = fs.readFileSync(BILLING_FILE_PATH, 'utf8');
            const parsed = JSON.parse(data);
            existing = Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            existing = [];
        }
    }
    const keys = new Set(existing.map(r => requestKey(r)));
    const added = [];
    for (const r of newRequests) {
        const normalized = normalizeIncomingRequest(r);
        if (!normalized) continue;
        const k = requestKey(normalized);
        if (!keys.has(k)) {
            keys.add(k);
            existing.push(normalized);
            added.push(normalized);
        }
    }
    fs.writeFileSync(BILLING_FILE_PATH, JSON.stringify(existing, null, 4), 'utf8');
    if (added.length) {
        console.log(`[Server] Appended ${added.length} new request(s) to billing_requests.json (total ${existing.length})`);
    }
    existing.forEach(r => { r.status = r.status || 'pending'; r.message = r.message || ''; });
    return existing;
}

/** Remove one request from billing_requests.json by key (after successful billing). */
function removeRequestFromFile(req) {
    if (!fs.existsSync(BILLING_FILE_PATH)) return;
    const key = requestKey(req);
    try {
        const data = fs.readFileSync(BILLING_FILE_PATH, 'utf8');
        const requests = JSON.parse(data);
        if (!Array.isArray(requests)) return;
        const filtered = requests.filter(r => requestKey(r) !== key);
        if (filtered.length === requests.length) return;
        fs.writeFileSync(BILLING_FILE_PATH, JSON.stringify(filtered, null, 4), 'utf8');
        console.log(`[Server] Removed 1 request from billing_requests.json (${filtered.length} remaining)`);
    } catch (e) {
        console.error('[Server] removeRequestFromFile Error:', e.message);
    }
}

// Routes (device authorization applied to all action endpoints)
app.post('/fetch-requests', requireAuthorizedDevice, async (req, res) => {
    try {
        console.log('[Server] Fetching requests from TSS API (Preview Mode)...');
        const requests = await fetchRequestsFromTSS();

        if (!requests || requests.length === 0) {
            return res.json({ success: true, count: 0, message: 'No pending requests found.', requests: [] });
        }

        // Replace billing file with fetched list (wipe and replace, no append)
        const normalized = requests.map(r => normalizeIncomingRequest(r)).filter(Boolean);
        fs.writeFileSync(BILLING_FILE_PATH, JSON.stringify(normalized, null, 4), 'utf8');
        console.log(`[Server] Replaced billing_requests.json with ${normalized.length} request(s) from TSS API.`);
        normalized.forEach(r => { r.status = 'pending'; r.message = ''; });
        currentRequests = normalized;
        broadcast('queue', currentRequests);

        // Include requests in response so client can show them even if SSE is disconnected (e.g. Electron)
        res.json({ success: true, count: normalized.length, message: `Saved to file and loaded ${normalized.length} requests.`, requests: normalized });
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
    const jsonPath = BILLING_FILE_PATH;
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
    const jsonPath = BILLING_FILE_PATH;
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
            const jsonPath = BILLING_FILE_PATH;
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

    // When a request is successfully billed, remove it only from the file (so file = unbilled only).
    // Keep it in the queue/UI so the screen shows what happened (short-term memory).
    const onRequestSuccess = (req) => {
        removeRequestFromFile(req);
    };

    (async () => {
        try {
            await getBrowser().launchBrowser();
            // Pass requests to worker (for file mode) or null (for API mode, worker will fetch from TSS)
            // Also pass stopCheck and onRequestSuccess (remove from file after each successful billing)
            await billingWorker((source === 'file' || source === 'queue') ? requests : null, broadcast, source, apiConfig, () => shouldStop, onRequestSuccess);
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
            getBrowser().closeBrowser();
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
