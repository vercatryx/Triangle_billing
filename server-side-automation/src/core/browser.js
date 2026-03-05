const { chromium } = require('playwright');
require('dotenv').config();

/** Max number of browser instances (pool cap). Env: MAX_BROWSERS */
const MAX_BROWSERS = Math.max(1, Math.min(15, parseInt(process.env.MAX_BROWSERS || '15', 10)));

/** Number of active slots (0..activeCount-1). Dynamic; can grow/shrink. */
let activeCount = 0;

/** Target count set by scaling loop. Clamped to [1, MAX_BROWSERS]. */
let targetCount = 1;

/** Slots marked for drain: finish current request then close. */
const draining = Object.create(null);

/** Pool: slots[slot] = { browser, context, page } or null. Indices 0..MAX_BROWSERS-1. */
const slots = [];

function getSlot(slotIndex) {
    const slot = slotIndex == null ? 0 : slotIndex;
    if (slot < 0 || slot >= MAX_BROWSERS) throw new Error(`Invalid browser slot: ${slot} (MAX_BROWSERS=${MAX_BROWSERS})`);
    return slot;
}

function getActiveCount() {
    return activeCount;
}

function getTargetCount() {
    return targetCount;
}

function setTargetCount(n) {
    targetCount = Math.max(1, Math.min(MAX_BROWSERS, Math.floor(Number(n)) || 1));
    return targetCount;
}

function isDraining(slotIndex) {
    return draining[getSlot(slotIndex)] === true;
}

function requestDrain(slotIndex) {
    draining[getSlot(slotIndex)] = true;
}

/** Called by worker after it has closed a drained slot. Decrements activeCount (we only drain the last slot). */
function slotClosed(slotIndex) {
    const slot = getSlot(slotIndex);
    delete draining[slot];
    if (slot === activeCount - 1) {
        activeCount--;
    }
}

/**
 * Add a new slot (launch browser at index activeCount). Caller should only call when activeCount < targetCount.
 * @returns {Promise<boolean>} true if a slot was added
 */
async function addSlot() {
    if (activeCount >= MAX_BROWSERS) return false;
    const slot = activeCount;
    activeCount++;
    console.log(`[Browser] Launching Chromium (slot ${slot + 1}/${MAX_BROWSERS})...`);
    const browser = await chromium.launch({
        headless: process.env.HEADLESS === 'true',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials'
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        permissions: [],
        geolocation: undefined,
        locale: 'en-US',
        bypassCSP: true,
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    });

    await context.grantPermissions([], { origin: 'https://app.uniteus.io' });
    await context.clearPermissions();

    const page = await context.newPage();

    await page.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();

        if (url.includes('app.launchdarkly.com') || url.includes('maps.googleapis.com')) {
            return route.abort();
        }

        if (!url.includes('uniteus.io') && !url.includes('localhost') && !url.startsWith('data:')) {
            try {
                const response = await route.fetch();
                const headers = { ...response.headers() };
                headers['access-control-allow-origin'] = '*';
                headers['access-control-allow-credentials'] = 'true';
                return route.fulfill({ response, headers });
            } catch (e) {
                return route.continue();
            }
        }

        return route.continue();
    });

    page.on('console', msg => {
        if (msg.type() === 'log') console.log(`[Browser ${slot}] ${msg.text()}`);
        if (msg.type() === 'warn') console.warn(`[Browser ${slot}] ${msg.text()}`);
        if (msg.type() === 'error') console.error(`[Browser ${slot}] ${msg.text()}`);
    });

    slots[slot] = { browser, context, page };
    return true;
}

async function launchBrowserForSlot(slotIndex) {
    const slot = getSlot(slotIndex);
    const existing = slots[slot];
    if (existing && existing.browser && existing.browser.isConnected()) {
        try {
            if (!existing.page.isClosed()) return existing.page;
        } catch (e) { /* invalid, recreate */ }
    }

    if (existing && existing.browser) {
        try {
            await existing.browser.close();
        } catch (e) { /* already closed */ }
        slots[slot] = null;
    }

    console.log(`[Browser] Launching Chromium (slot ${slot + 1}/${MAX_BROWSERS})...`);
    const browser = await chromium.launch({
        headless: process.env.HEADLESS === 'true',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials'
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        permissions: [],
        geolocation: undefined,
        locale: 'en-US',
        bypassCSP: true,
        extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive'
        }
    });

    await context.grantPermissions([], { origin: 'https://app.uniteus.io' });
    await context.clearPermissions();

    const page = await context.newPage();

    await page.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();

        if (url.includes('app.launchdarkly.com') || url.includes('maps.googleapis.com')) {
            return route.abort();
        }

        if (!url.includes('uniteus.io') && !url.includes('localhost') && !url.startsWith('data:')) {
            try {
                const response = await route.fetch();
                const headers = { ...response.headers() };
                headers['access-control-allow-origin'] = '*';
                headers['access-control-allow-credentials'] = 'true';
                return route.fulfill({ response, headers });
            } catch (e) {
                return route.continue();
            }
        }

        return route.continue();
    });

    page.on('console', msg => {
        if (msg.type() === 'log') console.log(`[Browser ${slot}] ${msg.text()}`);
        if (msg.type() === 'warn') console.warn(`[Browser ${slot}] ${msg.text()}`);
        if (msg.type() === 'error') console.error(`[Browser ${slot}] ${msg.text()}`);
    });

    slots[slot] = { browser, context, page };
    return page;
}

async function getPage(slotIndex) {
    const slot = getSlot(slotIndex);
    if (!slots[slot] || !slots[slot].page || slots[slot].page.isClosed()) {
        return launchBrowserForSlot(slot);
    }
    return slots[slot].page;
}

function getContext(slotIndex) {
    const slot = getSlot(slotIndex);
    if (!slots[slot]) return null;
    return slots[slot].context;
}

async function closeBrowser(slotIndex) {
    if (slotIndex === undefined || slotIndex === null) {
        for (let s = 0; s < activeCount; s++) {
            const existing = slots[s];
            if (existing && existing.browser) {
                try {
                    await existing.browser.close();
                } catch (e) { /* ignore */ }
                slots[s] = null;
            }
        }
        activeCount = 0;
        Object.keys(draining).forEach(k => delete draining[k]);
        return;
    }
    const slot = getSlot(slotIndex);
    const existing = slots[slot];
    if (existing && existing.browser) {
        try {
            await existing.browser.close();
        } catch (e) { /* ignore */ }
        slots[slot] = null;
    }
    delete draining[slot];
}

async function restartBrowser(slotIndex) {
    const slot = getSlot(slotIndex);
    console.log(`[Browser] Restarting browser (slot ${slot + 1})...`);
    await closeBrowser(slot);
    return launchBrowserForSlot(slot);
}

/** Legacy single-browser API: ensure slot 0 exists, used by server startup. */
async function launchBrowser() {
    if (activeCount === 0) {
        await addSlot();
    } else if (!slots[0] || !slots[0].page || slots[0].page.isClosed()) {
        await launchBrowserForSlot(0);
    }
    return getPage(0);
}

module.exports = {
    launchBrowser,
    getPage,
    getContext,
    closeBrowser,
    restartBrowser,
    getActiveCount,
    getTargetCount,
    setTargetCount,
    isDraining,
    requestDrain,
    slotClosed,
    addSlot,
    MAX_BROWSERS
};
