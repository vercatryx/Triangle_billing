const { performLoginSequence } = require('./auth');
const axios = require('axios');
const https = require('https');
const tlsRelaxedAgent = new https.Agent({ rejectUnauthorized: false });
const { executeBillingOnPage } = require('./billingActions');
const uniteSelectors = require('./uniteSelectors');
// Lazy-load browser (Playwright) so server can listen before Playwright loads (avoids hang/crash on filtered networks).
let _browser = null;
function getBrowser() {
    if (!_browser) _browser = require('./browser');
    return _browser;
}
const fs = require('fs');
const path = require('path');
const os = require('os');
const { needsDownloadFirst, downloadProofUrlToTemp } = require('./proofUrlDownload');
const { convertPdfFileToImages, isPdfFile } = require('./pdfToImage');

// Load .env from project root (parent of src/) so credentials are found regardless of cwd
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/** Number of browsers to run; always getBrowser().MAX_BROWSERS (no CPU-based scaling). */

const EMAIL = process.env.UNITEUS_EMAIL && String(process.env.UNITEUS_EMAIL).trim();
const PASSWORD = process.env.UNITEUS_PASSWORD && String(process.env.UNITEUS_PASSWORD).trim();

// --- API CONFIG DEFAULTS ---
const DEFAULT_API_BASE_URL = process.env.EXTENSION_API_BASE_URL || 'http://localhost:3000';
const DEFAULT_API_KEY = process.env.EXTENSION_API_KEY || 'justtomakesureicanlockyouout';

const TSS_BILLING_STATUS_URL = process.env.TSS_BILLING_STATUS_URL ||
    'https://www.trianglesquareservices.com/api/update-order-billing-status';
const TSS_API_KEY = process.env.TSS_API_KEY || null;

const TSS_BILLING_REQUESTS_URL = process.env.TSS_BILLING_REQUESTS_URL ||
    'https://www.trianglesquareservices.com/api/billing-requests-by-week';

/**
 * Retry hierarchy: 5 attempts (wait 2s between) → 3 refresh cycles → 2 restart cycles.
 * Only report failure to API after all retries exhausted. Env overrides:
 *   BILLING_ATTEMPTS_PER_CYCLE, BILLING_REFRESH_CYCLES, BILLING_RESTART_CYCLES, BILLING_SLEEP_ON_ERROR_MS
 */
const ATTEMPTS_PER_CYCLE = Math.max(1, parseInt(process.env.BILLING_ATTEMPTS_PER_CYCLE || '5', 10));
const REFRESH_CYCLES = Math.max(1, parseInt(process.env.BILLING_REFRESH_CYCLES || '3', 10));
const RESTART_CYCLES = Math.max(1, parseInt(process.env.BILLING_RESTART_CYCLES || '2', 10));
const SLEEP_ON_ERROR_MS = Math.max(0, parseInt(process.env.BILLING_SLEEP_ON_ERROR_MS || '2000', 10));

/**
 * Retries apply only to transient failures (DOM/timing). Logic/business errors fail immediately.
 * Retryable: Add button missing, shelf not open, date picker, Place of Service, submit button, etc.
 * Non-retryable: missing proofs, auth amount too low, invalid dates, duplicate, missing amount, etc.
 */
function isRetryableError(err) {
    if (!err || typeof err !== 'string') return false;
    const s = err.toLowerCase();
    if (s.includes('duplicate')) return false;
    if (s.includes('proof') || s.includes('upload proof')) return false;
    if (s.includes('missing "amount"') || s.includes('missing amount')) return false;
    if (s.includes('invalid date') || s.includes('clamped dates invalid') || s.includes('date range')) return false;
    if (s.includes('auth') && (s.includes('amount') || s.includes('too low') || s.includes('exceed'))) return false;
    if (s.includes('add button not found') || s.includes('shelf trigger')) return true;
    if (s.includes('shelf did not open')) return true;
    if (s.includes('amount field missing')) return true;
    if (s.includes('failed to set date range')) return true;
    if (s.includes('failed to select place of service')) return true;
    if (s.includes('submit button') && s.includes('not found')) return true;
    return false;
}

/**
 * Only these reasons are sent to the API as billing_failed. All other failures are left
 * with their current status so the order can be retried later.
 */
function isPermanentFailure(message) {
    if (!message || typeof message !== 'string') return false;
    const s = message.toLowerCase();
    if (s.includes('duplicate')) return true;
    if (s.includes('proof') || s.includes('upload proof')) return true;
    if (s.includes('missing "amount"') || s.includes('missing amount') || s.includes('missing date')) return true;
    if (s.includes('invalid date') || s.includes('clamped dates invalid') || s.includes('date range')) return true;
    if (s.includes('auth') && (s.includes('amount') || s.includes('too low') || s.includes('exceed'))) return true;
    return false;
}

// --- Helpers for API ---
/**
 * Fetch billing requests from Triangle Square Services API
 * @param {Object} config - Optional config (currently unused, kept for compatibility)
 * @returns {Promise<Array>} Array of billing requests
 */
async function fetchRequestsFromTSS(config) {
    console.log(`[TSS API] GET ${TSS_BILLING_REQUESTS_URL}`);

    try {
        const headers = {};
        if (TSS_API_KEY) {
            headers['Authorization'] = `Bearer ${TSS_API_KEY}`;
        }

        const res = await axios.get(TSS_BILLING_REQUESTS_URL, { headers, httpsAgent: tlsRelaxedAgent });

        let requests = null;
        if (Array.isArray(res.data)) {
            requests = res.data;
        } else if (res.data && Array.isArray(res.data.billingRequests)) {
            requests = res.data.billingRequests;
        }

        if (!requests) {
            console.error('[TSS API] Unexpected response format:', typeof res.data);
            if (typeof res.data === 'string' && res.data.trim().startsWith('<')) {
                throw new Error('Received HTML instead of JSON. Check API URL.');
            }
            throw new Error(`Expected array or { billingRequests: array }, got ${typeof res.data}`);
        }

        console.log(`[TSS API] Fetched ${requests.length} billing requests`);
        return requests;
    } catch (err) {
        console.error('[TSS API] Fetch Error:', err.message);
        if (err.response) {
            console.error('[TSS API] Response Status:', err.response.status);
            console.error('[TSS API] Response Data:', JSON.stringify(err.response.data).substring(0, 200));
        }
        throw err;
    }
}

/**
 * Legacy function for extension API (kept for backward compatibility)
 * @deprecated Use fetchRequestsFromTSS instead
 */
async function fetchRequestsFromApi(config) {
    const baseUrl = config?.baseUrl || DEFAULT_API_BASE_URL;
    const key = config?.key || DEFAULT_API_KEY;

    // Mask key for logging: show first 4 chars
    const maskedKey = key.length > 4 ? `${key.substring(0, 4)}...` : '(empty)';
    console.log(`[API] GET ${baseUrl}/api/extension/billing-requests`);
    console.log(`[API] Using Token: Bearer ${maskedKey}`);

    try {
        const res = await axios.get(`${baseUrl}/api/extension/billing-requests`, {
            headers: { 'Authorization': `Bearer ${key}` }
        });

        if (!Array.isArray(res.data)) {
            console.error('[API] Unexpected response format:', typeof res.data);
            if (typeof res.data === 'string' && res.data.trim().startsWith('<')) {
                throw new Error('Received HTML instead of JSON. Check API URL.');
            }
            throw new Error(`Expected array, got ${typeof res.data}`);
        }

        return res.data;
    } catch (err) {
        console.error('[API] Fetch Error:', err.message);
        if (err.response) {
            console.error('[API] Response Status:', err.response.status);
            console.error('[API] Response Data:', JSON.stringify(err.response.data).substring(0, 200));
        }
        throw err;
    }
}

/** @returns {Promise<{ ok: boolean, error?: string }>} */
async function updateOrderStatus(orderNumber, status, config) {
    if (!orderNumber) return { ok: true };
    const baseUrl = config?.baseUrl || DEFAULT_API_BASE_URL;
    const key = config?.key || DEFAULT_API_KEY;

    console.log(`[API] Updating Order #${orderNumber} -> ${status}`);
    try {
        await axios.post(`${baseUrl}/api/extension/update-status`, {
            orderNumber: orderNumber,
            status: status
        }, {
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[API] Extension status updated.`);
        return { ok: true };
    } catch (err) {
        console.error(`[API] Update Failed for #${orderNumber}:`, err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * POST to Triangle Square Services API to update order billing status.
 * Called after each billing person is complete.
 * @param {string[]} orderIds - Array of order UUIDs
 * @param {string} status - 'billing_successful' | 'billing_failed' | 'billing_unconfirmed'
 * @param {string} billingNotes - Reason or notes (e.g. error message on failure)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function updateOrderBillingStatus(orderIds, status, billingNotes = '') {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
        console.log('[TSS] No orderIds provided, skipping API update.');
        return { ok: true };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (TSS_API_KEY) headers['Authorization'] = `Bearer ${TSS_API_KEY}`;

    const payload = {
        orderIds,
        status,
        billingNotes: String(billingNotes || '').trim()
    };

    console.log(`[TSS] POST ${TSS_BILLING_STATUS_URL}`);
    console.log(`[TSS] Headers:`, JSON.stringify(headers, null, 2));
    console.log(`[TSS] Payload:`, JSON.stringify(payload, null, 2));
    console.log(`[TSS] Updating ${orderIds.length} order(s) -> ${status}`);
    
    try {
        const response = await axios.post(TSS_BILLING_STATUS_URL, payload, { headers, httpsAgent: tlsRelaxedAgent });
        console.log(`[TSS] Billing status updated successfully. Response status: ${response.status}`);
        return { ok: true };
    } catch (err) {
        console.error(`[TSS] Update billing status failed:`, err.message);
        if (err.response) {
            console.error(`[TSS] Response Status: ${err.response.status}`);
            console.error(`[TSS] Response Data:`, JSON.stringify(err.response.data)?.substring(0, 500));
        }
        if (err.request) {
            console.error(`[TSS] Request made but no response received. URL: ${TSS_BILLING_STATUS_URL}`);
        }
        return { ok: false, error: err.message };
    }
}

function getOrderIds(req) {
    if (Array.isArray(req.orderIds) && req.orderIds.length > 0) return req.orderIds;
    if (req.orderNumber != null && req.orderNumber !== '') return [String(req.orderNumber)];
    return [];
}

/**
 * Main worker entry point.
 * @param {Array} requests - (Legacy) requests if passed directly, or null if using internal fetch
 * @param {function} emitEvent - Function to emit socket events
 * @param {string} source - 'file' (default) or 'api'
 * @param {Object} apiConfig - API configuration (optional)
 * @param {function} stopCheck - Function that returns true if the process should stop
 * @param {function} onRequestSuccess - Optional; called when a request is successfully billed (e.g. to remove from file)
 */
async function billingWorker(initialRequests, emitEvent, source = 'file', apiConfig = null, stopCheck = () => false, onRequestSuccess = null) {
    if (!EMAIL || !PASSWORD) {
        emitEvent('log', { message: 'Missing UNITEUS_EMAIL or UNITEUS_PASSWORD in env.', type: 'error' });
        return;
    }

    emitEvent('log', { message: `Initializing Billing Cycle (Source: ${source})...` });

    // --- Load Requests based on Source (queue = always use passed list, no refetch) ---
    let requests;
    if (source === 'queue') {
        requests = Array.isArray(initialRequests) ? initialRequests : [];
        if (requests.length === 0) {
            emitEvent('log', { message: 'No requests in queue. Nothing to process.', type: 'warning' });
            return;
        }
    } else {
        requests = initialRequests || [];
        if (!initialRequests || initialRequests.length === 0) {
            try {
                if (source === 'api' || source === 'tss') {
                    requests = await fetchRequestsFromTSS(apiConfig);
                    if (!requests || requests.length === 0) {
                        emitEvent('log', { message: 'No pending requests found from TSS API.' });
                        return;
                    }
                } else if (source === 'file') {
                    if (!requests || requests.length === 0) {
                        emitEvent('log', { message: 'No requests provided for file mode.' });
                        return;
                    }
                }
            } catch (err) {
                emitEvent('error', { message: `Failed to load requests: ${err.message}` });
                return;
            }
        }
    }

    emitEvent('log', { message: `Processing ${requests.length} requests...` });

    // Shared queue: pull-based; no client assigned until a browser takes the next index
    let nextIndex = 0;
    const takeNext = () => (nextIndex < requests.length ? nextIndex++ : null);
    const hasWork = () => nextIndex < requests.length;

    getBrowser().setTargetCount(1);
    const runners = [];
    const setRunner = (slot, data) => {
        while (runners.length <= slot) runners.push(null);
        runners[slot] = data;
        emitEvent('runners', runners.slice(0, getBrowser().getActiveCount()));
    };

    emitEvent('config', { browserCount: getBrowser().getActiveCount(), maxBrowsers: getBrowser().MAX_BROWSERS });

    /**
     * Process a single request (one iteration of the old lane loop).
     * @returns {{ breakLane?: boolean, page?: object, context?: object }} breakLane true to stop this runner; page/context when browser was restarted so caller can use the new refs
     */
    async function processOneRequest(slot, i, requests, page, context, emitEvent, source, apiConfig, setRunner, attachConsoleLogger, sleep, isLoggedIn, waitForPageReady, onRequestSuccess) {
        const req = requests[i];
        req.status = 'processing';
        req.message = 'Starting...';
        setRunner(slot, { clientName: req.name, step: 'Starting...' });
        emitEvent('queue', requests);
        emitEvent('log', { message: `Processing ${req.name} (${i + 1}/${requests.length})` });

        /** Temp proof files to delete when request finishes */
        let proofTempPathsToClean = [];
        let resultSourceStatus = 'unknown';

        if (req.skip) {
            req.status = 'skipped';
            setRunner(slot, { clientName: req.name, step: 'Skipped' });
            emitEvent('log', { message: 'Skipped by config.', type: 'warning' });
            emitEvent('queue', requests);
            return {};
        }

        if (!req.date) {
            req.status = 'failed';
            req.message = 'Missing date field.';
            setRunner(slot, { clientName: req.name, step: 'Failed' });
            emitEvent('log', { message: 'Missing date field.', type: 'error' });
            if (source === 'api' && req.orderNumber) {
                await updateOrderStatus(req.orderNumber, 'billing_failed', apiConfig);
            }
            const orderIds = getOrderIds(req);
            if (orderIds.length) {
                await updateOrderBillingStatus(orderIds, 'billing_failed', req.message);
            }
            emitEvent('queue', requests);
            return {};
        }

        try {
            const dateParts = req.date.split(/[\/\-.]/).map(Number);
            let month, day, year;
            if (dateParts.length !== 3) throw new Error('Unparseable date: ' + req.date);
            if (dateParts[2] >= 2000) {
                // MM-DD-YYYY (standard format)
                [month, day, year] = dateParts;
            } else if (dateParts[0] >= 2000) {
                // legacy YYYY-MM-DD
                [year, month, day] = dateParts;
            } else if (dateParts[2] < 100) {
                // M/D/YY
                [month, day] = dateParts; year = 2000 + dateParts[2];
            } else {
                [month, day, year] = dateParts;
            }
            if (month > 12 && day <= 12) { [month, day] = [day, month]; }
            const startDate = new Date(year, month - 1, day);
            const endDate = new Date(startDate);
            const isEquipment = req.equipment === true || req.equipment === 'true' || req.equtment === true || req.equtment === 'true';
            if (!isEquipment) {
                endDate.setDate(endDate.getDate() + 6);
            }
            const formatDate = (d) => {
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const y = d.getFullYear();
                return `${m}-${day}-${y}`;
            };
            req.start = formatDate(startDate);
            req.end = formatDate(endDate);
            emitEvent('log', { message: isEquipment ? `Date (equipment, single day): ${req.start}` : `Date range: ${req.start} to ${req.end}` });
        } catch (e) {
            req.status = 'failed';
            req.message = `Invalid date: ${e.message}`;
            setRunner(slot, { clientName: req.name, step: 'Failed' });
            emitEvent('log', { message: `Invalid date: ${e.message}`, type: 'error' });
            if (source === 'api' && req.orderNumber) {
                await updateOrderStatus(req.orderNumber, 'billing_failed', apiConfig);
            }
            const orderIds = getOrderIds(req);
            if (orderIds.length) {
                await updateOrderBillingStatus(orderIds, 'billing_failed', req.message);
            }
            emitEvent('queue', requests);
            return {};
        }

        if (!(await isLoggedIn())) {
            setRunner(slot, { clientName: req.name, step: 'Logging in...' });
            emitEvent('log', { message: 'Logging in...' });
            try {
                // Browser may have been closed — get a fresh page first
                try {
                    if (page.isClosed()) throw new Error('page closed');
                } catch (_) {
                    emitEvent('log', { message: 'Page/browser gone. Restarting browser...', type: 'warning' });
                    page = await getBrowser().restartBrowser(slot);
                    context = getBrowser().getContext(slot);
                    attachConsoleLogger(page);
                }
                const loginOk = await performLoginSequence(EMAIL, PASSWORD, page, context);
                if (!loginOk) {
                    req.status = 'failed';
                    setRunner(slot, { clientName: req.name, step: 'Login failed' });
                    emitEvent('log', { message: 'Login failed. Aborting.', type: 'error' });
                    return { breakLane: true };
                }
                await sleep(2000);
            } catch (loginErr) {
                emitEvent('log', { message: `Login error: ${loginErr.message}. Restarting browser...`, type: 'error' });
                try {
                    page = await getBrowser().restartBrowser(slot);
                    context = getBrowser().getContext(slot);
                    attachConsoleLogger(page);
                    const retryLogin = await performLoginSequence(EMAIL, PASSWORD, page, context);
                    if (!retryLogin) {
                        req.status = 'failed';
                        setRunner(slot, { clientName: req.name, step: 'Login failed' });
                        emitEvent('log', { message: 'Login failed after restart. Aborting lane.', type: 'error' });
                        return { breakLane: true };
                    }
                    await sleep(2000);
                } catch (restartErr) {
                    req.status = 'failed';
                    req.message = `Browser restart failed: ${restartErr.message}`;
                    setRunner(slot, { clientName: req.name, step: 'Failed' });
                    emitEvent('log', { message: req.message, type: 'error' });
                    return { breakLane: true };
                }
            }
        }

        if (!req.url) {
            req.status = 'failed';
            req.message = 'Missing URL.';
            setRunner(slot, { clientName: req.name, step: 'Failed' });
            emitEvent('log', { message: 'Missing URL.', type: 'error' });
            emitEvent('queue', requests);
            return {};
        }

        let result = null;
        let lastResult = null;  // used to skip browser restart when failure was duplicate
        let loginFailedOnRetry = false;
        let logicError = false;
        let restartedPage, restartedContext;  // when browser was restarted, pass back so lane uses new refs

        try {
            setRunner(slot, { clientName: req.name, step: 'Navigating...' });
            console.log(`[Worker] Navigating to ${req.url}`);
            await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitForPageReady();
            setRunner(slot, { clientName: req.name, step: 'Filling form...' });

            if (req.proofURL) {
                req.proofURL = Array.isArray(req.proofURL) ? req.proofURL : [req.proofURL];
            }

            // Resolve proof URLs that need server-side download (Firebase, Google Drive, or non-direct links).
            // Same logic for every source: Excel export, TSS API, billing_requests.json, manual paste — we only look at the URL string.
            const proofTempPathsToClean = [];
            if (req.proofURL && req.proofURL.length > 0) {
                req.proofDownloadedMeta = [];
                req.proofDownloadErrors = [];
                const tempDir = os.tmpdir();
                for (let p = 0; p < req.proofURL.length; p++) {
                    const url = (req.proofURL[p] || '').trim();
                    if (!url) {
                        req.proofDownloadedMeta.push(null);
                        req.proofDownloadErrors.push(null);
                        continue;
                    }
                    if (needsDownloadFirst(url)) {
                        try {
                            const meta = await downloadProofUrlToTemp(url, tempDir);
                            req.proofDownloadedMeta.push(meta);
                            req.proofDownloadErrors.push(null);
                            proofTempPathsToClean.push(meta.path);
                        } catch (e) {
                            const reason = e && e.message ? String(e.message) : 'Unknown error';
                            console.warn(`[Worker] Failed to download proof ${p + 1}: ${reason}`);
                            req.proofDownloadedMeta.push(null);
                            req.proofDownloadErrors.push(reason);
                        }
                    } else {
                        req.proofDownloadedMeta.push(null);
                        req.proofDownloadErrors.push(null);
                    }
                }

                // Convert unsupported formats (WEBP, BMP, TIFF) to JPEG.
                // PDF, JPEG, PNG, GIF are accepted by the billing system as-is.
                const ACCEPTED_MIMES = new Set([
                    'image/jpeg', 'image/png', 'image/gif',
                    'application/pdf',
                    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                ]);
                const expandedMeta = [];
                const expandedErrors = [];
                const expandedUrls = [];
                for (let p = 0; p < req.proofDownloadedMeta.length; p++) {
                    const meta = req.proofDownloadedMeta[p];
                    const mime = (meta && meta.contentType || '').split(';')[0].trim().toLowerCase();
                    const needsConversion = meta && meta.path && mime && !ACCEPTED_MIMES.has(mime) &&
                        (mime.startsWith('image/') || isPdfFile(meta));
                    if (needsConversion) {
                        try {
                            const imageMetas = await convertPdfFileToImages(meta.path, tempDir);
                            console.log(`[Worker] Converted ${mime} proof to ${imageMetas.length} JPEG image(s)`);
                            for (const img of imageMetas) {
                                expandedMeta.push(img);
                                expandedErrors.push(null);
                                expandedUrls.push(req.proofURL[p] || '');
                                proofTempPathsToClean.push(img.path);
                            }
                            try { fs.unlinkSync(meta.path); } catch (_) {}
                        } catch (convErr) {
                            console.warn(`[Worker] Format conversion failed, keeping original: ${convErr.message}`);
                            expandedMeta.push(meta);
                            expandedErrors.push(req.proofDownloadErrors[p]);
                            expandedUrls.push(req.proofURL[p] || '');
                        }
                    } else {
                        expandedMeta.push(meta);
                        expandedErrors.push(req.proofDownloadErrors[p]);
                        expandedUrls.push(req.proofURL[p] || '');
                    }
                }
                req.proofDownloadedMeta = expandedMeta;
                req.proofDownloadErrors = expandedErrors;
                req.proofURL = expandedUrls;
            }

            restartLoop: for (let r = 0; r < RESTART_CYCLES; r++) {
                if (r > 0) {
                    emitEvent('log', { message: `Restart ${r}/${RESTART_CYCLES}: shutting down browser, clearing cookies/data, starting fresh...`, type: 'warning' });
                    await getBrowser().closeBrowser(slot);
                    page = await getBrowser().getPage(slot);
                    context = getBrowser().getContext(slot);
                    restartedPage = page;
                    restartedContext = context;
                    attachConsoleLogger(page);
                    emitEvent('log', { message: 'Logging in (after restart). Login flow clears cookies & storage.', type: 'info' });
                    const loginOk = await performLoginSequence(EMAIL, PASSWORD, page, context);
                    if (!loginOk) {
                        loginFailedOnRetry = true;
                        req.status = 'failed';
                        req.message = 'Login failed after browser restart.';
                        resultSourceStatus = 'billing_failed';
                        break restartLoop;
                    }
                    await sleep(2000);
                    console.log(`[Worker] Navigating to ${req.url}`);
                    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await waitForPageReady();
                }

                for (let f = 0; f < REFRESH_CYCLES; f++) {
                    if (f > 0) {
                        emitEvent('log', { message: `Refresh ${f}/${REFRESH_CYCLES}: refreshing page...`, type: 'warning' });
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                        await waitForPageReady();
                    }

                    for (let a = 0; a < ATTEMPTS_PER_CYCLE; a++) {
                        if (a > 0) {
                            await sleep(SLEEP_ON_ERROR_MS);
                        }
                        result = await executeBillingOnPage(page, req);
                        lastResult = result;
                        if (result.ok || result.duplicate) break restartLoop;
                        if (result.loggedOut) {
                            emitEvent('log', { message: 'Session expired (login page detected). Re-logging in...', type: 'warning' });
                            try {
                                page = await getBrowser().restartBrowser(slot);
                                context = getBrowser().getContext(slot);
                                restartedPage = page;
                                restartedContext = context;
                                attachConsoleLogger(page);
                                const loginOk = await performLoginSequence(EMAIL, PASSWORD, page, context);
                                if (!loginOk) { loginFailedOnRetry = true; break restartLoop; }
                                await sleep(2000);
                                await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                                await waitForPageReady();
                                a = -1; // reset attempt counter after re-login
                                continue;
                            } catch (reLoginErr) {
                                emitEvent('log', { message: `Re-login failed: ${reLoginErr.message}`, type: 'error' });
                                loginFailedOnRetry = true;
                                break restartLoop;
                            }
                        }
                        if (!isRetryableError(result.error)) {
                            logicError = true;
                            emitEvent('log', { message: `Logic error (non-retryable): ${result.error}. Failing immediately.`, type: 'error' });
                            break restartLoop;
                        }
                        emitEvent('log', { message: `Attempt ${a + 1}/${ATTEMPTS_PER_CYCLE} failed: ${result.error}. Waiting ${SLEEP_ON_ERROR_MS / 1000}s...`, type: 'warning' });
                    }

                    if (f < REFRESH_CYCLES - 1) {
                        emitEvent('log', { message: `All ${ATTEMPTS_PER_CYCLE} attempts failed. Will refresh.`, type: 'warning' });
                    }
                }

                if (r < RESTART_CYCLES - 1) {
                    emitEvent('log', { message: `All ${REFRESH_CYCLES} refresh cycles failed. Will restart browser.`, type: 'warning' });
                }
            }

            if (loginFailedOnRetry) {
                emitEvent('log', { message: 'Login failed after restart. Aborting.', type: 'error' });
            } else if (result) {
                if (result.ok) {
                    if (result.verified) {
                        req.status = 'success';
                        req.message = `Billed: $${result.amount || req.amount}`;
                        setRunner(slot, { clientName: req.name, step: 'Complete' });
                        emitEvent('log', { message: `✅ Success!`, type: 'success' });
                        if (onRequestSuccess) onRequestSuccess(req);
                        resultSourceStatus = 'billing_successful';
                    } else {
                        req.status = 'warning';
                        req.message = 'Submitted but verification failed';
                        setRunner(slot, { clientName: req.name, step: 'Submitted (unverified)' });
                        emitEvent('log', { message: `⚠️ Submitted, unverified.`, type: 'warning' });
                        resultSourceStatus = 'billing_unconfirmed';
                    }
                } else {
                    if (result.duplicate) {
                        req.status = 'failed';
                        req.message = result.error || 'Duplicate invoice detected';
                        setRunner(slot, { clientName: req.name, step: 'Failed' });
                        emitEvent('log', { message: `❌ Duplicate - marking as failed: ${req.message}`, type: 'error' });
                        resultSourceStatus = 'billing_failed';
                    } else {
                        req.status = 'failed';
                        req.message = result.error;
                        setRunner(slot, { clientName: req.name, step: 'Failed' });
                        emitEvent('log', { message: logicError ? `❌ Failed (logic error): ${result.error}` : `❌ Failed (all retries exhausted): ${result.error}`, type: 'error' });
                        resultSourceStatus = 'billing_failed';
                    }
                }
            }
        } catch (e) {
            req.status = 'failed';
            req.message = e.message;
            setRunner(slot, { clientName: req.name, step: 'Failed' });
            emitEvent('log', { message: `Exception: ${e.message}`, type: 'error' });
            resultSourceStatus = 'billing_failed';

            const errorMsg = String(e.message || '').toLowerCase();
            const isBrowserClosed =
                (errorMsg.includes('target page') && errorMsg.includes('closed')) ||
                (errorMsg.includes('page.goto') && errorMsg.includes('closed')) ||
                errorMsg.includes('browser has been closed') ||
                errorMsg.includes('context has been closed') ||
                errorMsg.includes('target closed') ||
                (errorMsg.includes('protocol error') && errorMsg.includes('target')) ||
                (errorMsg.includes('connection closed') && errorMsg.includes('browser')) ||
                errorMsg.includes('browser closed') ||
                errorMsg.includes('page has been closed');

            // Duplicates are final: do not restart browser or retry.
            if (lastResult && lastResult.duplicate) {
                req.status = 'failed';
                req.message = lastResult.error || 'Duplicate invoice detected';
                setRunner(slot, { clientName: req.name, step: 'Failed' });
                emitEvent('log', { message: `❌ Duplicate - marking as failed (no restart): ${req.message}`, type: 'error' });
                resultSourceStatus = 'billing_failed';
            } else if (isBrowserClosed) {
                emitEvent('log', { message: 'CRITICAL: Browser/page has been closed. Reopening new browser instance...', type: 'warning' });
                emitEvent('log', { message: `Error details: ${e.message}`, type: 'error' });

                try {
                    await getBrowser().closeBrowser(slot);
                    page = await getBrowser().restartBrowser(slot);
                    context = getBrowser().getContext(slot);
                    attachConsoleLogger(page);

                    emitEvent('log', { message: 'Browser restarted successfully. Re-logging in...', type: 'info' });

                    const loginOk = await performLoginSequence(EMAIL, PASSWORD, page, context);
                    if (!loginOk) {
                        req.status = 'failed';
                        req.message = 'Login failed after browser restart.';
                        emitEvent('log', { message: 'Login failed after browser restart. Aborting.', type: 'error' });
                        proofTempPathsToClean.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
                        emitEvent('queue', requests);
                        return { breakLane: true };
                    }

                    await sleep(2000);
                    emitEvent('log', { message: 'Browser restarted and logged in. Retrying current request...', type: 'info' });

                    req.status = 'processing';
                    req.message = 'Retrying after browser restart...';
                    emitEvent('queue', requests);

                    console.log(`[Worker] Navigating to ${req.url} (after browser restart)`);
                    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await waitForPageReady();

                    let retryResult = null;
                    for (let retryAttempt = 0; retryAttempt < ATTEMPTS_PER_CYCLE; retryAttempt++) {
                        if (retryAttempt > 0) {
                            await sleep(SLEEP_ON_ERROR_MS);
                        }
                        retryResult = await executeBillingOnPage(page, req);
                        lastResult = retryResult;
                        if (retryResult.ok || retryResult.duplicate) break;
                        if (!isRetryableError(retryResult.error)) {
                            break;
                        }
                        emitEvent('log', { message: `Retry attempt ${retryAttempt + 1}/${ATTEMPTS_PER_CYCLE} failed: ${retryResult.error}`, type: 'warning' });
                    }

                    if (retryResult) {
                        result = retryResult;
                        if (retryResult.ok) {
                            if (retryResult.verified) {
                                req.status = 'success';
                                req.message = `Billed: $${retryResult.amount || req.amount}`;
                                emitEvent('log', { message: `✅ Success after browser restart!`, type: 'success' });
                                if (onRequestSuccess) onRequestSuccess(req);
                                resultSourceStatus = 'billing_successful';
                            } else {
                                req.status = 'warning';
                                req.message = 'Submitted but verification failed';
                                emitEvent('log', { message: `⚠️ Submitted after browser restart, unverified.`, type: 'warning' });
                                resultSourceStatus = 'billing_unconfirmed';
                            }
                        } else {
                            if (retryResult.duplicate) {
                                req.status = 'failed';
                                req.message = retryResult.error || 'Duplicate invoice detected';
                                emitEvent('log', { message: `❌ Duplicate after browser restart - marking as failed: ${req.message}`, type: 'error' });
                                resultSourceStatus = 'billing_failed';
                            } else {
                                req.status = 'failed';
                                req.message = retryResult.error;
                                emitEvent('log', { message: `❌ Failed after browser restart: ${retryResult.error}`, type: 'error' });
                                resultSourceStatus = 'billing_failed';
                            }
                        }
                    }
                    restartedPage = page;
                    restartedContext = context;
                } catch (restartError) {
                    emitEvent('log', { message: `Failed to restart browser: ${restartError.message}`, type: 'error' });
                    req.status = 'failed';
                    req.message = `Browser restart failed: ${restartError.message}`;
                    resultSourceStatus = 'billing_failed';
                    emitEvent('queue', requests);
                }
            } else {
                await page.screenshot({ path: `error_${slot}_${i}.png` }).catch(() => {});
            }
        }

        // Clean up temp proof files (Firebase/Drive downloads)
        proofTempPathsToClean.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });

        // Never report success to API unless we actually got a successful billing result from the page
        if (resultSourceStatus === 'billing_successful' && (!result || !result.ok)) {
            emitEvent('log', { message: 'Safety: not reporting success — no confirmed billing result from browser.', type: 'warning' });
            resultSourceStatus = 'billing_failed';
        }

        const shouldReportFailure = resultSourceStatus !== 'billing_failed' || isPermanentFailure(req.message);

        if (!shouldReportFailure) {
            emitEvent('log', { message: `Failure not reported to API (transient/retryable). Order left unchanged for retry.`, type: 'info' });
        }

        if (shouldReportFailure && source === 'api' && req.orderNumber) {
            const extResult = await updateOrderStatus(req.orderNumber, resultSourceStatus, apiConfig);
            if (extResult.ok) {
                emitEvent('log', { message: 'Extension API: status updated.', type: 'info' });
            } else {
                emitEvent('log', { message: `Extension API: failed to update status — ${extResult.error}`, type: 'error' });
            }
        }

        const orderIds = getOrderIds(req);
        if (shouldReportFailure && orderIds.length > 0) {
            let tssNotes = '';
            if (resultSourceStatus === 'billing_successful') {
                tssNotes = `Payment processed successfully. Amount: $${result?.amount || req.amount || 'N/A'}`;
            } else if (resultSourceStatus === 'billing_failed') {
                tssNotes = req.message || 'Billing failed';
            } else if (resultSourceStatus === 'billing_unconfirmed') {
                tssNotes = req.message || 'Billing submitted but unverified';
            } else {
                tssNotes = req.message || '';
            }

            emitEvent('log', { message: `Calling TSS API to update status: ${resultSourceStatus} for ${orderIds.length} order(s)`, type: 'info' });
            const tssResult = await updateOrderBillingStatus(orderIds, resultSourceStatus, tssNotes);
            if (tssResult.ok) {
                emitEvent('log', { message: `TSS API: billing status updated successfully for ${orderIds.length} order(s).`, type: 'success' });
            } else {
                emitEvent('log', { message: `TSS API: failed to update billing status — ${tssResult.error}`, type: 'error' });
            }
        } else if (orderIds.length === 0) {
            emitEvent('log', { message: 'No orderIds found in request, skipping TSS API update.', type: 'warning' });
        }

        emitEvent('queue', requests);

        if (loginFailedOnRetry) {
            return { breakLane: true };
        }

        const out = {};
        if (restartedPage) out.page = restartedPage;
        if (restartedContext) out.context = restartedContext;
        return out;
    }

    async function runOneLane(slot) {
        let page, context;
        try {
            page = await getBrowser().getPage(slot);
            context = getBrowser().getContext(slot);
        } catch (initErr) {
            console.error(`[Worker slot ${slot}] Failed to get browser page: ${initErr.message}. Attempting restart...`);
            try {
                page = await getBrowser().restartBrowser(slot);
                context = getBrowser().getContext(slot);
            } catch (restartErr) {
                console.error(`[Worker slot ${slot}] Browser restart failed: ${restartErr.message}. Lane cannot start.`);
                return;
            }
        }

        const attachConsoleLogger = (p) => {
            p.on('console', msg => {
                const text = msg.text();
                if (text.startsWith('[Injected]')) {
                    console.log(`[Browser ${slot}] ${text}`);
                } else if (msg.type() === 'error') {
                    console.error(`[Browser ${slot} Error] ${text}`);
                }
            });
        };
        attachConsoleLogger(page);

        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const isLoggedIn = async () => {
            try {
                const currentUrl = page.url();
                return currentUrl.includes('uniteus.io') && !currentUrl.includes('auth');
            } catch (e) { return false; }
        };
        const pageReadyId = uniteSelectors.billing.pageReady.id;
        const waitForPageReady = async () => {
            try {
                await page.waitForSelector(`#${pageReadyId}`, { timeout: 15000 });
            } catch (e) {
                console.warn(`[Worker slot ${slot}] Warning: Auth table not found, possibly wrong page or slow load.`);
            }
        };

        let i;
        try {
            while ((i = takeNext()) !== null && !stopCheck() && !getBrowser().isDraining(slot)) {
                if (stopCheck()) {
                    if (requests[i]) {
                        requests[i].status = 'stopped';
                        requests[i].message = 'Process stopped by user';
                    }
                    emitEvent('queue', requests);
                    emitEvent('log', { message: 'Stop signal received. Stopping process...', type: 'warning' });
                    break;
                }
                const out = await processOneRequest(slot, i, requests, page, context, emitEvent, source, apiConfig, setRunner, attachConsoleLogger, sleep, isLoggedIn, waitForPageReady, onRequestSuccess);
                if (out && out.breakLane) break;
                if (out && out.page) page = out.page;
                if (out && out.context) context = out.context;
                await sleep(1000);
            }
        } catch (laneErr) {
            console.error(`[Worker slot ${slot}] Unhandled lane error: ${laneErr.message}. Lane stopping gracefully.`);
            emitEvent('log', { message: `Lane ${slot} crashed: ${laneErr.message}. Remaining items still queued.`, type: 'error' });
        }

        setRunner(slot, null);
        if (getBrowser().isDraining(slot)) {
            await getBrowser().closeBrowser(slot);
            getBrowser().slotClosed(slot);
            emitEvent('config', { browserCount: getBrowser().getActiveCount(), maxBrowsers: getBrowser().MAX_BROWSERS });
            emitEvent('runners', runners.slice(0, getBrowser().getActiveCount()));
        }
    }

    const runnerPromises = [];
    let runEnding = false;

    function startRunner(slot) {
        runnerPromises.push(runOneLane(slot));
    }

    // Ensure slot 0 exists (launchBrowser already called by server)
    startRunner(0);

    // Always use getBrowser().MAX_BROWSERS (no CPU-based scaling)
    getBrowser().setTargetCount(getBrowser().MAX_BROWSERS);
    const initialToAdd = Math.max(0, getBrowser().MAX_BROWSERS - 1);
    for (let a = 0; a < initialToAdd; a++) {
        const added = await getBrowser().addSlot();
        if (added && !runEnding) {
            startRunner(getBrowser().getActiveCount() - 1);
            emitEvent('config', { browserCount: getBrowser().getActiveCount(), maxBrowsers: getBrowser().MAX_BROWSERS });
            emitEvent('runners', runners.slice(0, getBrowser().getActiveCount()));
        }
    }

    // Wait until queue is drained
    await new Promise((resolve) => {
        const check = () => {
            if (nextIndex >= requests.length) resolve();
            else setTimeout(check, 500);
        };
        check();
    });
    runEnding = true;

    await Promise.all(runnerPromises);

    emitEvent('log', { message: 'Billing Cycle Completed.' });
}

module.exports = { billingWorker, fetchRequestsFromApi, fetchRequestsFromTSS };
