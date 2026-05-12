const { getPage, getContext } = require('./browser');
const uniteSelectors = require('./uniteSelectors');

const { urls, auth } = uniteSelectors;

/**
 * @param {string} email
 * @param {string} password
 * @param {import('playwright').Page} [pageOptional] - If provided, use this page (and contextOptional) for this slot
 * @param {import('playwright').BrowserContext} [contextOptional] - Required when pageOptional is provided
 */
async function performLoginSequence(email, password, pageOptional, contextOptional) {
    const page = pageOptional || await getPage(0);
    const context = contextOptional != null ? contextOptional : getContext(0);

    console.log('[Auth] Starting robust login sequence (User-defined flow)...');

    // 1. SAFE CLEANUP
    console.log('[Auth] Cleaning up session...');
    try {
        await page.goto(urls.logout, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
        await context.clearCookies();
        await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { } }).catch(() => { });
    } catch (e) { }

    // 2. NAVIGATE TO START URL
    console.log(`[Auth] Navigating to ${urls.login}...`);
    try {
        await page.goto(urls.login, { waitUntil: 'networkidle' });
    } catch (e) {
        console.warn(`[Auth] Navigation warning: ${e.message}`);
    }

    // HELPER: Find element by multiple selectors
    const findEl = async (label, selectors) => {
        console.log(`[Auth] Looking for ${label}...`);
        for (const s of selectors) {
            const el = await page.$(s).catch(() => null);
            if (el && await el.isVisible()) {
                console.log(`[Auth] Found ${label} via [${s}]`);
                return el;
            }
        }
        throw new Error(`Could not find ${label} with any selector.`);
    };

    try {
        // --- STEP A: EMAIL ---
        const emailInput = await findEl('Email Input', auth.email.selectors);
        await emailInput.fill(email);
        console.log('[Auth] Email filled.');

        // --- STEP B: NEXT BUTTON ---
        const nextBtn = await findEl('Next Button', auth.nextButton.selectors);
        await nextBtn.click();
        console.log('[Auth] Clicked Next.');

        // --- STEP C: WAIT FOR REDIRECT TO /LOGIN ---
        console.log('[Auth] Waiting for redirect to /login...');
        await page.waitForURL(url => url.href.includes('/login'), { timeout: 20000 });
        await page.waitForLoadState('domcontentloaded');
        console.log('[Auth] Redirected to /login.');

        // --- STEP D: PASSWORD ---
        console.log('[Auth] Looking for Password input...');
        const pwdInput = await findEl('Password Input', auth.password.selectors);
        console.log('[Auth] Password input found, filling...');

        // Direct fill (no typing): Focus -> Clear -> Fill -> Input/Change events
        console.log('[Auth] Focusing password input...');
        await pwdInput.focus();
        console.log('[Auth] Clearing password input...');
        await pwdInput.fill(''); // Clear first
        console.log('[Auth] Filling password (direct fill, no typing)...');
        await pwdInput.fill(password); // Fill directly (no typing)
        console.log('[Auth] Dispatching input/change events...');
        // Use element's evaluate method directly (pwdInput is already an ElementHandle)
        await pwdInput.evaluate(el => el.dispatchEvent(new Event('input', { bubbles: true })));
        await pwdInput.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));

        // Verify password was filled
        const pwdValue = await pwdInput.inputValue();
        console.log(`[Auth] Password filled. Length: ${pwdValue.length} characters`);
        console.log('[Auth] Current URL after password fill:', page.url());
        console.log('[Auth] Waiting 1 second for form to be ready...');
        await new Promise(r => setTimeout(r, 1000));

        // --- STEP E: SIGN IN BUTTON ---
        console.log('[Auth] ========== SIGN IN BUTTON SEARCH START ==========');
        console.log('[Auth] Current URL:', page.url());
        
        const signSelectors = auth.signIn.selectors;
        let signBtn = null;
        let foundSelector = null;
        let elementInfo = null;

        console.log(`[Auth] Trying ${signSelectors.length} selectors to find Sign In button...`);

        for (let i = 0; i < signSelectors.length; i++) {
            const selector = signSelectors[i];
            console.log(`[Auth] [${i + 1}/${signSelectors.length}] Trying selector: "${selector}"`);
            
            try {
                signBtn = await page.$(selector);
                
                if (signBtn) {
                    console.log(`[Auth] ✓ Element found with selector: "${selector}"`);
                    
                    // Get detailed element info
                    elementInfo = await page.evaluate((sel) => {
                        const el = document.querySelector(sel) || 
                                  document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                        if (!el) return null;
                        return {
                            tagName: el.tagName,
                            id: el.id,
                            name: el.name,
                            value: el.value,
                            type: el.type,
                            className: el.className,
                            textContent: el.textContent?.trim(),
                            disabled: el.disabled,
                            style: el.getAttribute('style'),
                            outerHTML: el.outerHTML.substring(0, 200)
                        };
                    }, selector);
                    
                    console.log('[Auth] Element details:', JSON.stringify(elementInfo, null, 2));
                    
                    // Check visibility
                    const isVisible = await signBtn.isVisible();
                    console.log(`[Auth] Element visible: ${isVisible}`);
                    
                    if (isVisible) {
                        foundSelector = selector;
                        console.log(`[Auth] ✓✓✓ SUCCESS: Found visible Sign In button with selector: "${selector}"`);
                        break;
                    } else {
                        console.log(`[Auth] ✗ Element found but NOT visible with selector: "${selector}"`);
                        // Check if it's in viewport
                        const boundingBox = await signBtn.boundingBox();
                        console.log(`[Auth] Bounding box:`, boundingBox);
                    }
                } else {
                    console.log(`[Auth] ✗ No element found with selector: "${selector}"`);
                }
            } catch (e) {
                console.log(`[Auth] ✗ Error trying selector "${selector}": ${e.message}`);
            }
        }
        
        if (!signBtn) {
            console.error('[Auth] ========== SIGN IN BUTTON NOT FOUND ==========');
            console.error('[Auth] Tried all selectors, none found. Taking screenshot...');
            
            // Try to find ANY submit button for debugging
            const allSubmits = await page.$$('input[type="submit"], button[type="submit"]');
            console.log(`[Auth] Found ${allSubmits.length} total submit buttons on page`);
            for (let i = 0; i < allSubmits.length; i++) {
                const btn = allSubmits[i];
                const info = await page.evaluate(el => ({
                    tag: el.tagName,
                    id: el.id,
                    name: el.name,
                    value: el.value,
                    text: el.textContent,
                    visible: el.offsetParent !== null
                }), btn);
                console.log(`[Auth] Submit button ${i + 1}:`, info);
            }
            
            await page.screenshot({ path: 'login_flow_error.png', fullPage: true });
            throw new Error('Sign In button not found with any selector');
        }
        
        if (!foundSelector) {
            console.warn('[Auth] ⚠️  Button found but was not visible. Attempting to make it visible...');
            try {
                await signBtn.scrollIntoViewIfNeeded();
                await new Promise(r => setTimeout(r, 500));
                const isNowVisible = await signBtn.isVisible();
                console.log(`[Auth] After scrollIntoView, visible: ${isNowVisible}`);
            } catch (e) {
                console.warn(`[Auth] Error scrolling to button: ${e.message}`);
            }
        }
        
        console.log('[Auth] ========== ATTEMPTING TO CLICK SIGN IN BUTTON ==========');
        console.log('[Auth] Waiting 1 second before click...');
        await new Promise(r => setTimeout(r, 1000));
        
        // Try multiple click methods
        let clickSuccess = false;
        const clickMethods = [
            { name: 'standard click', fn: () => signBtn.click() },
            { name: 'force click', fn: () => signBtn.click({ force: true }) },
            { name: 'JavaScript click', fn: () => page.evaluate(el => el.click(), signBtn) }
        ];
        
        for (const method of clickMethods) {
            try {
                console.log(`[Auth] Trying ${method.name}...`);
                await method.fn();
                console.log(`[Auth] ✓✓✓ ${method.name} executed successfully!`);
                clickSuccess = true;
                break;
            } catch (e) {
                console.error(`[Auth] ✗ ${method.name} failed: ${e.message}`);
                console.error(`[Auth] Error stack:`, e.stack);
            }
        }
        
        if (!clickSuccess) {
            console.error('[Auth] ========== ALL CLICK METHODS FAILED ==========');
            await page.screenshot({ path: 'login_click_error.png', fullPage: true });
            throw new Error('Failed to click Sign In button with all methods');
        }
        
        console.log('[Auth] ========== SIGN IN BUTTON CLICKED SUCCESSFULLY ==========');
        console.log('[Auth] Current URL after click:', page.url());
        console.log('[Auth] Waiting 2 seconds for page response...');
        await new Promise(r => setTimeout(r, 2000));
        console.log('[Auth] URL after wait:', page.url());

    } catch (e) {
        console.error('[Auth] ========== ERROR DURING LOGIN FLOW ==========');
        console.error(`[Auth] Error message: ${e.message}`);
        console.error(`[Auth] Error stack:`, e.stack);
        try { console.error(`[Auth] Current URL: ${page.url()}`); } catch (_) {}
        try {
            console.error('[Auth] Taking error screenshot...');
            await page.screenshot({ path: 'login_flow_error.png', fullPage: true });
        } catch (_) {
            console.error('[Auth] Could not take screenshot (browser/page closed).');
        }
        return false;
    }

    // 3. FINAL VERIFICATION (No 'auth' in URL)
    console.log('[Auth] ========== FINAL VERIFICATION START ==========');
    console.log('[Auth] Current URL:', page.url());
    console.log('[Auth] Waiting for redirect away from auth domain (max 45s)...');
    
    try {
        // Check URL every 2 seconds and log progress
        const checkInterval = setInterval(async () => {
            const currentUrl = page.url();
            console.log(`[Auth] Still waiting... Current URL: ${currentUrl}`);
        }, 2000);
        
        await page.waitForURL(url => {
            const hostname = url.hostname;
            const hasAuth = hostname.includes('auth');
            const hasUniteus = hostname.includes('uniteus.io');
            const shouldContinue = !hasAuth && hasUniteus;
            
            if (shouldContinue) {
                clearInterval(checkInterval);
            }
            
            return shouldContinue;
        }, { timeout: 45000 });
        
        clearInterval(checkInterval);
        const finalUrl = page.url();
        console.log('[Auth] ========== LOGIN SUCCESSFUL ==========');
        console.log('[Auth] Final URL:', finalUrl);
        console.log('[Auth] ✓ Successfully logged in and redirected to dashboard');
        
        // Wait for network to be idle to ensure all authentication resources are loaded
        // This prevents 403 errors from happening due to premature navigation
        console.log('[Auth] Waiting for network to stabilize and session to be fully established...');
        try {
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
                console.log('[Auth] Network idle timeout, but continuing...');
            });
            // Additional wait to ensure cookies/session tokens are set
            await new Promise(r => setTimeout(r, 2000));
            console.log('[Auth] Session fully established. Ready to proceed.');
        } catch (e) {
            console.warn(`[Auth] Warning while waiting for network idle: ${e.message}`);
        }
        
        return true;
    } catch (e) {
        console.error('[Auth] ========== FINAL VERIFICATION FAILED ==========');
        console.error(`[Auth] Timeout waiting for redirect: ${e.message}`);
        try {
            const stuckUrl = page.url();
            console.error(`[Auth] Stuck at URL: ${stuckUrl}`);
            console.error('[Auth] Taking timeout screenshot...');
            await page.screenshot({ path: 'login_timeout.png', fullPage: true });
            const pageContent = await page.content();
            const hasDashboard = pageContent.includes('dashboard') || pageContent.includes('cases');
            console.log(`[Auth] Page contains dashboard/cases indicators: ${hasDashboard}`);
            if (hasDashboard) {
                console.log('[Auth] May be logged in but URL verification failed');
            }
        } catch (_) {
            console.error('[Auth] Could not inspect page (browser/page closed).');
        }
        return false;
    }
}

module.exports = { performLoginSequence };
