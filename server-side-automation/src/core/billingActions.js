// This module contains the complex DOM interactions ported from the extension.
// It uses page.evaluate() to inject the exact same robust logic into the browser.
// All Unite DOM selectors/IDs come from uniteSelectors.billing – edit that file when the site updates.

const fs = require('fs');
const uniteSelectors = require('./uniteSelectors');

async function executeBillingOnPage(page, requestData) {
    console.log('[BillingActions] Injecting billing logic...');

    // Build data for injection; pre-downloaded proofs (Firebase/Drive) become base64 payloads
    const data = { ...requestData };
    if (requestData.proofDownloadedMeta && requestData.proofDownloadedMeta.length) {
        data.proofFilePayloads = [];
        const proofURLs = Array.isArray(requestData.proofURL) ? requestData.proofURL : (requestData.proofURL ? [requestData.proofURL] : []);
        for (let i = 0; i < requestData.proofDownloadedMeta.length; i++) {
            const meta = requestData.proofDownloadedMeta[i];
            if (meta && meta.path && fs.existsSync(meta.path)) {
                const buf = fs.readFileSync(meta.path);
                data.proofFilePayloads[i] = {
                    base64: buf.toString('base64'),
                    filename: meta.filename,
                    mimeType: meta.contentType || 'application/octet-stream'
                };
            } else if (proofURLs[i]) {
                // Server tried to download this URL and failed (e.g. 403, redirect). Do NOT pass URL
                // as fallback — browser fetch would hit CORS (e.g. dashboard.scanovator.com).
                const reason = (requestData.proofDownloadErrors && requestData.proofDownloadErrors[i]) || 'Download failed';
                data.proofFilePayloads[i] = { downloadFailed: true, reason };
            } else {
                data.proofFilePayloads[i] = null;
            }
        }
    }

    try {
        const sel = uniteSelectors.billing;
        const result = await page.evaluate(async ({ data, sel }) => {
            // =========================================================================
            //  INJECTED LOGIC START (Ported from enterBillingDetails.js)
            //  Uses sel.* for all Unite elements – see uniteSelectors.js
            // =========================================================================

            console.log('[Injected] Starting billing logic for:', data);

            // Bail immediately if the page is a login/auth page (session expired)
            const currentHost = window.location.hostname || '';
            const currentHref = window.location.href || '';
            if (currentHost.includes('auth') || currentHref.includes('/login') || currentHref.includes('/sign-in')) {
                return { ok: false, error: 'Session expired — redirected to login page', loggedOut: true };
            }

            // --- Helpers ---
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const byXPath = (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
            const shown = (el) => !!(el && (el.offsetParent !== null || (el.getClientRects?.().length || 0) > 0));

            // Event firers
            const fire = (el, type, init = {}) => el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
            const mouse = (el, type) => el && el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            const pointer = (el, type) => el && el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true }));
            const clickLikeHuman = (el) => {
                pointer(el, 'pointerdown');
                mouse(el, 'mousedown');
                pointer(el, 'pointerup');
                mouse(el, 'mouseup');
                mouse(el, 'click');
            };
            const setNativeValue = (el, value) => {
                const desc = el?.tagName === 'TEXTAREA' ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                if (desc?.set) desc.set.call(el, value); else if (el) el.value = value;
            };

            // Parsers
            const parseMDY = (s) => {
                const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (!m) return null;
                const mm = +m[1], dd = +m[2], yyyy = +m[3];
                if (mm < 1 || mm > 12) return null;
                const last = new Date(yyyy, mm, 0).getDate();
                if (dd < 1 || dd > last) return null;
                return new Date(yyyy, mm - 1, dd);
            };
            // Format ISO YYYY-MM-DD -> MDY or Date obj -> MDY
            const toMDY = (d) => {
                if (typeof d === 'string') { // ISO string
                    const [y, m, day] = d.split('-');
                    return `${Number(m)}/${Number(day)}/${y}`;
                }
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                const yy = d.getFullYear();
                return `${mm}/${dd}/${yy}`;
            };

            // Red error messages on page (p.text-red.text-13px) – check often so we report real reason, not technical failure
            const getPageError = () => {
                const errorParagraphs = document.querySelectorAll('p.text-red.text-13px');
                if (errorParagraphs.length > 0) {
                    const msg = errorParagraphs[0].textContent.trim();
                    if (msg) return msg;
                }
                return null;
            };

            // --- Inputs ---
            // Dates are in MM-DD-YYYY format
            const startStr = data.start;
            const endStr = data.end;
            const [sM, sD, sY] = startStr.split('-').map(Number);
            const [eM, eD, eY] = endStr.split('-').map(Number);
            const reqStart = new Date(sY, sM - 1, sD);
            const reqEnd = new Date(eY, eM - 1, eD);
            // USER REQUEST: Do not calculate amount. Use JSON amount directly.
            const amount = data.amount;

            if (amount === undefined || amount === null) {
                return { ok: false, error: 'Missing "amount" in JSON request' };
            }

            console.log(`[Injected] Transformed dates: ${toMDY(reqStart)} -> ${toMDY(reqEnd)}`);
            console.log(`[Injected] Using explicit amount from JSON: $${amount}`);

            // --- EARLY DUPLICATE GUARD ---
            const plannedDays = Math.max(1, Math.floor((reqEnd - reqStart) / 86400000) + 1);
            // const plannedAmount = ratePerDay * plannedDays; // DEPRECATED - We use direct amount now

            const doInlineScanFallback = (startD, endD, amount) => {
                const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
                const cents = (v) => {
                    const n = Number(String(v).replace(/[^\d.]/g, ''));
                    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
                };
                const sameDay = (a, b) => a && b && a.getTime() === b.getTime();
                const ds = sel.duplicateScan;
                const cards = Array.from(document.querySelectorAll('.' + ds.cardClass));
                const amtSel = '[data-test-element="' + ds.amountDataTest + '"]';
                const datesSel = (ds.datesDataTest || []).map(d => '[data-test-element="' + d + '"]').join(', ') || '[data-test-element="service-dates-value"]';
                const tCents = cents(amount);
                for (const card of cards) {
                    const amtEl = card.querySelector(amtSel);
                    const rngEl = card.querySelector(datesSel);
                    const amtCents = cents(norm(amtEl?.textContent));
                    const txt = norm(rngEl?.textContent);
                    let s = null, e = null;
                    if (txt) {
                        const parts = txt.split(/\s*-\s*/);
                        if (parts.length === 2) { s = new Date(parts[0]); e = new Date(parts[1]); }
                        else { s = new Date(txt); e = s; }
                        if (s) s.setHours(0, 0, 0, 0);
                        if (e) e.setHours(0, 0, 0, 0);
                    }
                    if (Number.isFinite(amtCents) && s && e && amtCents === tCents && sameDay(s, startD) && sameDay(e, endD)) {
                        return true;
                    }
                }
                return false;
            };

            if (doInlineScanFallback(reqStart, reqEnd, amount)) {
                console.warn('[Injected] Duplicate detected (early). Aborting.');
                return { ok: false, duplicate: true, error: 'Duplicate invoice detected' };
            }

            // --- 0. Wait for Authorized Table (Page Ready Check) ---
            const ad = sel.authorizedTable.date;
            const aa = sel.authorizedTable.amount;

            console.log('[Injected] Waiting for Authorized Table elements...');
            const getAuthEls = () => ({
                dateEl: document.getElementById(ad.id) || (ad.xpath && byXPath(ad.xpath)) || null,
                amountEl: document.getElementById(aa.id) || (aa.xpath && byXPath(aa.xpath)) || null
            });

            for (let i = 0; i < 30; i++) {
                const { dateEl, amountEl } = getAuthEls();
                if (dateEl && amountEl && shown(dateEl)) break;
                await sleep(500);
            }

            const { dateEl, amountEl } = getAuthEls();
            if (dateEl && amountEl) {
                console.log('[Injected] Authorized table found. Entering dates as-is — Unite will show errors if out of range.');
            } else {
                console.warn('[Injected] Authorized table elements not found. Continuing anyway.');
            }


            // --- 1. Find Add Button & Open Shelf ---
            { const err = getPageError(); if (err) return { ok: false, error: err }; }
            const ab = sel.addButton;
            const findAddButton = () => {
                let btn = (ab.id && document.getElementById(ab.id)) || (ab.xpath && byXPath(ab.xpath));
                if (btn) return btn;
                const fallback = (ab.textContains || 'add new contracted service').toLowerCase();
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                return buttons.find(b => (b.textContent || '').toLowerCase().includes(fallback)) || null;
            };

            let addBtn = null;
            for (let i = 0; i < 10; i++) {
                addBtn = findAddButton();
                if (addBtn && shown(addBtn)) break;
                await sleep(500);
            }

            if (!addBtn) { const err = getPageError(); return { ok: false, error: err || 'Add button not found (Shelf trigger missing)' }; }

            const am = sel.amount;
            const isShelfOpen = () => !!((am.id && document.getElementById(am.id)) || (am.xpath && byXPath(am.xpath)));

            if (!isShelfOpen()) {
                console.log('[Injected] Clicking Add Button...');
                clickLikeHuman(addBtn);
                // Wait for shelf
                for (let i = 0; i < 20; i++) {
                    if (isShelfOpen()) break;
                    await sleep(200);
                }
                if (!isShelfOpen()) { const err = getPageError(); return { ok: false, error: err || 'Shelf did not open' }; }
            }

            // --- 2. Calculate & Verify Dates ---
            const days = Math.floor((reqEnd - reqStart) / 86400000) + 1;
            // const amount = days * ratePerDay; // DEPRECATED - used from JSON
            console.log(`[Step] Date Calculation: ${startStr} to ${endStr} = ${days} days.`);
            console.log(`[Step] Amount (Explicit): $${amount}`);

            if (days < 1) {
                const err = getPageError(); return { ok: false, error: err || `Invalid date range: ${days} days` };
            }

            // --- 3. Fill Billing Info ---
            { const err = getPageError(); if (err) return { ok: false, error: err }; }
            const amountField = (am.id && document.getElementById(am.id)) || (am.xpath && byXPath(am.xpath));
            if (!amountField) { const err = getPageError(); return { ok: false, error: err || 'Amount field missing' }; }

            // Use the exact amount from JSON - no calculation, no multiplication, no modification
            // Convert to number to ensure proper formatting, then back to string for the input
            const exactAmount = typeof amount === 'number' ? amount : Number(amount);
            // Format as string without any currency symbols or extra formatting
            const amountValue = exactAmount.toString();
            
            console.log(`[Step] Entering Exact Amount: ${amountValue} (original from JSON: ${amount})...`);
            
            amountField.focus();
            // Clear field first to remove any existing value
            setNativeValue(amountField, '');
            await sleep(50);
            // Set the exact amount value
            setNativeValue(amountField, amountValue);
            // Trigger events to ensure React/framework recognizes the change
            fire(amountField, 'input', { bubbles: true, cancelable: true });
            fire(amountField, 'change', { bubbles: true, cancelable: true });
            amountField.blur();
            await sleep(500);

            // --- 4. Date Picker Logic (The Beast) ---
            { const err = getPageError(); if (err) return { ok: false, error: err }; }
            // Period of Service: "Single Date" (equipment) or "Date Range" (default). We select the radio first; only then open the range picker for non-equipment.
            const isEquipment = data.equipment === true || data.equipment === 'true' || data.equtment === true || data.equtment === 'true';
            console.log(isEquipment ? '[Step] Setting date (equipment: Single Date).' : '[Step] Setting Date Range in UI...');

            // ===== Robust Date Picker Logic (Ported from Extension) =====
            async function setDateForRequest(bStart, bEnd, isEquip) {
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                const M = (el, t) => el && el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
                const P = (el, t) => el && el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
                const clickLikeHuman = (el) => { P(el, 'pointerdown'); M(el, 'mousedown'); P(el, 'pointerup'); M(el, 'mouseup'); M(el, 'click'); };

                const po = sel.periodOfService || {};
                const dr = sel.dateRange;
                const fi = dr.fakeInput || {};

                // 1) Select Period of Service: "Single Date" for equipment, "Date Range" for non-equipment (do not click Date Range for equipment).
                const selectPeriodOfService = async (useSingleDate) => {
                    const radioId = useSingleDate ? (po.singleDateRadioId || 'provided-service-period-of-service-0') : (po.dateRangeRadioId || 'provided-service-period-of-service-1');
                    const value = useSingleDate ? (po.singleDateLabelText || 'Single Date') : (po.dateRangeLabelText || 'Date Range');
                    const name = po.radioName || 'provided_service.period_of_service';
                    const radio = document.getElementById(radioId) ||
                        document.querySelector(`input[name="${name}"][value="${value}"]`) ||
                        (() => {
                            const label = Array.from(document.querySelectorAll('label')).find((l) => (l.textContent || '').trim() === value);
                            return label && label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null;
                        })();
                    if (!radio) {
                        console.error('[DateLogic] Period of Service radio not found:', value);
                        return false;
                    }
                    if (!radio.checked) {
                        console.log('[DateLogic] Selecting Period of Service:', value);
                        clickLikeHuman(radio);
                        await sleep(400);
                        const labelFor = document.querySelector(`label[for="${radioId}"]`);
                        if (labelFor && !radio.checked) clickLikeHuman(labelFor);
                        await sleep(300);
                    }
                    return true;
                };

                if (!await selectPeriodOfService(!!isEquip)) {
                    return false;
                }

                if (isEquip) {
                    // Equipment: "Single Date" selected. Open single-date calendar and select bStart.
                    const sd = sel.singleDate || {};
                    const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
                    const MONTH_ABBREV = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
                    const getSingleDateTrigger = () => {
                        const el = (sd.triggerSelector && document.querySelector(sd.triggerSelector)) || null;
                        if (el) return el;
                        const container = sd.triggerXpath && byXPath(sd.triggerXpath);
                        return container ? (container.querySelector('a[role="button"]') || container) : null;
                    };
                    const openSingleDateCalendar = async () => {
                        const trigger = getSingleDateTrigger();
                        if (!trigger) { console.error('[DateLogic] Single-date trigger not found.'); return false; }
                        trigger.scrollIntoView?.({ block: 'center', inline: 'center' });
                        await sleep(80);
                        clickLikeHuman(trigger);
                        await sleep(250);
                        return true;
                    };
                    const getSingleDateOpenDropdown = () => {
                        const openClass = (sd.dropdownOpenClass || 'ui-date-field__dropdown--open').replace(/\s+/g, '.');
                        const dd = document.querySelector((sd.dropdownSelector || '.ui-date-field__dropdown') + '.' + openClass);
                        return dd && (dd.querySelector('.ui-calendar') || dd.querySelector('.ui-date-field__controls')) ? dd : null;
                    };
                    const getVisibleMonthYear = () => {
                        const dd = getSingleDateOpenDropdown();
                        if (!dd) return null;
                        const yearInp = dd.querySelector('#' + (sd.yearInputId || 'provided-service-date-year-input')) || (sd.yearInputId && document.getElementById(sd.yearInputId));
                        const block = yearInp && yearInp.parentElement && dd.contains(yearInp) ? yearInp.parentElement : (sd.monthYearDivXpath && byXPath(sd.monthYearDivXpath)) || dd.querySelector('.ui-date-field__controls > div');
                        if (!block) return null;
                        const span = block.querySelector('span');
                        const year = yearInp ? parseInt(yearInp.value, 10) : NaN;
                        if (!span || !Number.isFinite(year)) return null;
                        const monthText = (span.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (!monthText) return null;
                        const first3 = monthText.substring(0, 3);
                        const monthIdx = MONTH_ABBREV.indexOf(first3);
                        return monthIdx >= 0 ? { month: monthIdx, year } : null;
                    };
                    const clickSingleDateMonthNav = async (prevNotNext) => {
                        const xpath = prevNotNext ? sd.prevMonthXpath : sd.nextMonthXpath;
                        const btn = xpath ? byXPath(xpath) : null;
                        if (!btn) return false;
                        clickLikeHuman(btn);
                        await sleep(120);
                        return true;
                    };
                    const navigateSingleDateToMonth = async (targetMonth, targetYear) => {
                        for (let i = 0; i < 24; i++) {
                            const cur = getVisibleMonthYear();
                            if (!cur) return false;
                            if (cur.month === targetMonth && cur.year === targetYear) return true;
                            if (cur.year < targetYear || (cur.year === targetYear && cur.month < targetMonth)) await clickSingleDateMonthNav(false);
                            else await clickSingleDateMonthNav(true);
                        }
                        return false;
                    };
                    const clickSingleDateDay = (dayNum) => {
                        const cal = sd.calendarPaneXpath ? byXPath(sd.calendarPaneXpath) : null;
                        if (!cal) return false;
                        const dayButtons = cal.querySelectorAll(sd.dayCellSelector || '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]');
                        const want = String(dayNum);
                        const btn = Array.from(dayButtons).find(b => (b.textContent || '').trim() === want);
                        if (!btn) return false;
                        clickLikeHuman(btn);
                        return true;
                    };
                    console.log('[DateLogic] Equipment: opening single-date calendar and selecting', toMDY(bStart));
                    if (!await openSingleDateCalendar()) return false;
                    await sleep(80);
                    if (!await navigateSingleDateToMonth(bStart.getMonth(), bStart.getFullYear())) return false;
                    await sleep(50);
                    if (!clickSingleDateDay(bStart.getDate())) return false;
                    await sleep(100);
                    return true;
                }

                const isOpen = () => !!document.querySelector('.' + (dr.dropdownOpenClass || 'ui-duration-field__dropdown ui-duration-field__dropdown--open').replace(/\s+/g, '.'));

                const getFakeCandidates = () => {
                    const a = dr.buttonId && document.getElementById(dr.buttonId);
                    const b = fi.roleButton && document.querySelector(fi.roleButton);
                    const c = fi.value && document.querySelector(fi.value);
                    const d = fi.container && document.querySelector(fi.container);
                    return [a, b, c, d].filter(Boolean);
                };

                // 2) Open the Date Range picker (click the date range trigger — only for non-equipment; we already selected "Date Range" above).
                const openDateRangePicker = async () => {
                    if (isOpen()) return true;

                    const label = (dr.labelId && document.getElementById(dr.labelId)) || (dr.labelXpath && byXPath(dr.labelXpath));

                    const tryOnce = async () => {
                        const cands = getFakeCandidates();
                        console.log('[DateLogic] Opening date range picker...');

                        if (label && shown(label)) {
                            clickLikeHuman(label);
                            await sleep(120);
                            if (isOpen()) return true;
                        }

                        for (const el of cands) {
                            if (!shown(el)) continue;
                            el.scrollIntoView?.({ block: 'center', inline: 'center' });
                            await sleep(40);
                            clickLikeHuman(el);
                            for (let i = 0; i < 10; i++) { if (isOpen()) return true; await sleep(60); }
                        }

                        const best = cands.find(shown);
                        if (best) {
                            best.focus?.();
                            best.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
                            best.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
                            await sleep(120);
                            if (isOpen()) return true;
                            best.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                            best.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                            for (let i = 0; i < 10; i++) { if (isOpen()) return true; await sleep(60); }
                        }
                        return false;
                    };

                    for (let attempt = 1; attempt <= 3 && !isOpen(); attempt++) {
                        if (await tryOnce()) break;
                        await sleep(150 + attempt * 100);
                    }
                    return isOpen();
                };

                if (!await openDateRangePicker()) {
                    console.error('[DateLogic] Failed to open date picker after robust attempts.');
                    return false;
                }
                console.log('[DateLogic] Picker is open.');
                await sleep(500);

                // 2. NAVIGATE & CLICK
                const dd = document.querySelector(dr.dropdownClass ? '.' + dr.dropdownClass.replace(/^\./, '') : '.ui-duration-field__dropdown');
                const prevBtn = dd && dd.querySelector(dr.navPrev || 'a[role="button"]:first-of-type');
                const nextBtn = dd && dd.querySelector(dr.navNext || 'a[role="button"]:last-of-type');
                const startYearInput = dd && dr.startYearId && dd.querySelector('#' + dr.startYearId);
                const endYearInput = dd && dr.endYearId && dd.querySelector('#' + dr.endYearId);
                const leftCal = dd && dd.querySelector(dr.leftCalendar || '.ui-calendar:nth-of-type(1)');
                const rightCal = dd && dd.querySelector(dr.rightCalendar || '.ui-calendar:nth-of-type(2)');
                const leftSpan = dd && dd.querySelector(dr.leftSpan || '.ui-duration-field__controls div:nth-of-type(1) span');
                const rightSpan = dd && dd.querySelector(dr.rightSpan || '.ui-duration-field__controls div:nth-of-type(2) span');

                if (!prevBtn || !nextBtn) {
                    console.error('[DateLogic] Calendar controls missing.');
                    return false;
                }

                const monthIdx = (name) => ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
                    .indexOf(String(name || '').trim().toLowerCase());

                const getVisibleRange = () => {
                    const lMonth = monthIdx(leftSpan.textContent);
                    const rMonth = monthIdx(rightSpan.textContent);
                    const lYear = parseInt(startYearInput?.value || '0', 10);
                    const rYear = parseInt(endYearInput?.value || '0', 10);
                    return { left: lYear * 12 + lMonth, right: rYear * 12 + rMonth, lYear, rYear, lMonth, rMonth };
                };

                const ensureVis = async (date) => {
                    const target = date.getFullYear() * 12 + date.getMonth();
                    for (let i = 0; i < 24; i++) {
                        const { left, right } = getVisibleRange();
                        if (target >= left && target <= right) return true;
                        if (target < left) M(prevBtn, 'click');
                        else M(nextBtn, 'click');
                        await sleep(300); // Wait for transition
                    }
                    return false;
                };

                const clickDay = async (pane, date) => {
                    const want = String(date.getDate());
                    const daySel = dr.dayButton || '.ui-calendar__day:not(.ui-calendar__day--out-of-month) div[role="button"]';
                    const btns = Array.from(pane.querySelectorAll(daySel));
                    const btn = btns.find(b => (b.textContent || '').trim() === want);
                    if (btn) {
                        M(btn, 'mousedown');
                        M(btn, 'mouseup');
                        M(btn, 'click');
                        await sleep(200);
                        return true;
                    }
                    return false;
                };

                // CLICK START
                if (!await ensureVis(bStart)) return false;
                let vis = getVisibleRange();
                let pane = (vis.lYear === bStart.getFullYear() && vis.lMonth === bStart.getMonth()) ? leftCal : rightCal;
                console.log(`[DateLogic] Clicking Start Day: ${bStart.getDate()}`);
                if (!await clickDay(pane, bStart)) return false;

                // CLICK END
                if (!await ensureVis(bEnd)) return false;
                vis = getVisibleRange();
                pane = (vis.lYear === bEnd.getFullYear() && vis.lMonth === bEnd.getMonth()) ? leftCal : rightCal;
                console.log(`[DateLogic] Clicking End Day: ${bEnd.getDate()}`);
                if (!await clickDay(pane, bEnd)) return false;

                // CLOSE/VERIFY
                // Usually closes automatically or we click out? 
                // Extension logic says: let it close itself.
                await sleep(500);
                return true;
            }

            // Execute: equipment skips only the date range button; non-equipment opens it and sets start/end.
            const dateParams = {
                start: new Date(sY, sM - 1, sD),
                end: new Date(eY, eM - 1, eD)
            };

            const dateResult = await setDateForRequest(dateParams.start, dateParams.end, isEquipment);
            if (!dateResult) {
                const err = getPageError(); return { ok: false, error: err || 'Failed to set date range in UI' };
            }

            console.log('[Step] Date step complete.');

            // --- 4. Place of Service Logic (The Beast Part 2) ---
            { const err = getPageError(); if (err) return { ok: false, error: err }; }
            console.log('[Step] Setting Place of Service (12 - Home)...');

            async function selectHomeRobust() {
                const po = sel.placeOfService || {};
                const PLACE_ID = po.id;
                const PLACE_OUTER_XPATH = po.xpath;
                const HOME_TEXT = po.homeText || '12 - Home';
                const HOME_VALUE = po.homeValue || 'c0d441b4-ba1b-4f68-93af-a4d7d6659fba';
                const ch = po.choices || {};

                // Local helpers for this scope
                const byXPath = (xp) => document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
                const fire = (el, type, init = {}) => el && el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
                const mouse = (el, type) => el && el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                const keyEvt = (el, type, key = 'Enter', code = key) => el && el.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
                const setNativeValue = (el, value) => {
                    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                    if (desc?.set) desc.set.call(el, value);
                    else if (el) el.value = value;
                };

                const inner = PLACE_OUTER_XPATH ? byXPath(PLACE_OUTER_XPATH) : null;
                const selectEl = PLACE_ID ? document.getElementById(PLACE_ID) : null;
                if (!inner || !selectEl) {
                    console.warn('[selectHome] Select controls not present yet');
                    return false;
                }

                // 1) Try Choices instance API
                const inst = selectEl.choices || selectEl._choices || selectEl._instance;
                if (inst && (typeof inst.setChoiceByValue === 'function' || typeof inst.setValue === 'function')) {
                    try {
                        if (typeof inst.setChoiceByValue === 'function') inst.setChoiceByValue(HOME_VALUE);
                        else inst.setValue([{ value: HOME_VALUE, label: HOME_TEXT }]);
                        fire(selectEl, 'change');
                        console.log('[selectHome] Set via Choices instance API');
                        return true;
                    } catch (e) {
                        console.warn('[selectHome] Choices API path failed, falling back:', e);
                    }
                }

                const root = inner.closest('.choices') || inner.parentElement || inner;
                const openDropdown = () => {
                    const opener = (ch.inner && root.querySelector(ch.inner)) || root;
                    mouse(opener, 'mousedown');
                    mouse(opener, 'mouseup');
                    mouse(opener, 'click');
                };
                const getList = () =>
                    (ch.listDropdownExpanded && root.querySelector(ch.listDropdownExpanded)) ||
                    (ch.listDropdown && root.querySelector(ch.listDropdown));

                // 2) UI: open dropdown and try to click the option node directly
                openDropdown();
                for (let i = 0; i < 10; i++) {
                    const list = getList();
                    if (list?.children?.length) {
                        const optSel = ch.option || '.choices__item[role="option"]';
                        let optionNode =
                            list.querySelector('[data-value="' + HOME_VALUE + '"]') ||
                            Array.from(list.querySelectorAll(optSel)).find(n =>
                                (n.textContent || '').trim().toLowerCase() === (HOME_TEXT || '').toLowerCase()
                            ) ||
                            Array.from(list.querySelectorAll(optSel)).find(n =>
                                (n.textContent || '').toLowerCase().includes('home')
                            );

                        if (optionNode) {
                            optionNode.scrollIntoView({ block: 'nearest' });
                            mouse(optionNode, 'mousedown');
                            mouse(optionNode, 'mouseup');
                            mouse(optionNode, 'click');
                            const val = optionNode.getAttribute('data-value') || HOME_VALUE;
                            if (selectEl && val) {
                                selectEl.value = val;
                                fire(selectEl, 'change');
                            }
                            console.log('[selectHome] Clicked option node in dropdown');
                            return true;
                        }
                    }
                    await sleep(100);
                }

                openDropdown();
                await sleep(80);
                const searchInput =
                    (ch.searchInput && root.querySelector(ch.searchInput)) ||
                    (ch.searchInputAlt && root.querySelector(ch.searchInputAlt));
                if (searchInput) {
                    setNativeValue(searchInput, 'home');
                    fire(searchInput, 'input');
                    fire(searchInput, 'change');
                    await sleep(120);
                    keyEvt(searchInput, 'keydown', 'Enter');
                    keyEvt(searchInput, 'keyup', 'Enter');
                    await sleep(150);

                    if (selectEl && (selectEl.value === HOME_VALUE ||
                        (selectEl.selectedOptions?.[0]?.textContent || '').toLowerCase().includes('home'))) {
                        console.log('[selectHome] Selected via search + Enter');
                        fire(selectEl, 'change');
                        return true;
                    }
                }

                const byValue = selectEl.querySelector('option[value="' + HOME_VALUE + '"]');
                const byText = Array.from(selectEl.options || []).find(o => (o.textContent || '').toLowerCase().includes('home'));
                const target = byValue || byText;
                if (target) {
                    selectEl.value = target.value;
                    fire(selectEl, 'change');
                    const single = (ch.singleSelected && root.querySelector(ch.singleSelected));
                    if (single) {
                        single.textContent = (target.textContent || HOME_TEXT).trim();
                        single.classList.remove('choices__placeholder');
                        single.setAttribute('data-value', target.value);
                    }
                    console.log('[selectHome] Applied fallback to set select value directly');
                    return true;
                }
                console.warn('[selectHome] All strategies failed');
                return false;
            }

            const homeSuccess = await selectHomeRobust();
            if (!homeSuccess) {
                const err = getPageError(); return { ok: false, error: err || 'Failed to select Place of Service (12 - Home)' };
            }

            // --- 5. File Upload Logic (Browser-Side Fetch or pre-downloaded payload) ---
            const proofUrls = Array.isArray(data.proofURL) ? data.proofURL : (data.proofURL ? [data.proofURL] : []);
            const proofFilePayloads = data.proofFilePayloads || [];
            if (proofUrls.length > 0) {
                { const err = getPageError(); if (err) return { ok: false, error: err }; }
                console.log(`[Step] Uploading ${proofUrls.length} proof file(s)...`);

                async function uploadFileRobust(source, filename) {
                    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

                    // 1. Get Blob: only from pre-downloaded base64. Never fetch(url) for cross-origin (CORS).
                    if (source.downloadFailed) {
                        const reason = source.reason || 'Proof could not be downloaded on server.';
                        console.error('[Upload] Proof download failed:', reason);
                        return { failed: true, reason };
                    }
                    // Detect real file type from magic bytes so the MIME and
                    // extension always match the actual content.
                    function detectMime(bytes) {
                        if (!bytes || bytes.length < 12) return null;
                        if (bytes[0]===0xFF && bytes[1]===0xD8 && bytes[2]===0xFF) return 'image/jpeg';
                        if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return 'image/png';
                        if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x38) return 'image/gif';
                        if (bytes[0]===0x25 && bytes[1]===0x50 && bytes[2]===0x44 && bytes[3]===0x46) return 'application/pdf';
                        if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46 &&
                            bytes[8]===0x57 && bytes[9]===0x45 && bytes[10]===0x42 && bytes[11]===0x50) return 'image/webp';
                        if (bytes[0]===0x42 && bytes[1]===0x4D) return 'image/bmp';
                        return null;
                    }

                    let blob = null;
                    if (source.base64 != null) {
                        try {
                            const binary = atob(source.base64);
                            const bytes = new Uint8Array(binary.length);
                            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                            const realMime = detectMime(bytes) || source.mimeType || 'application/octet-stream';
                            if (realMime !== source.mimeType) {
                                console.log(`[Upload] Magic bytes detected "${realMime}" (server said "${source.mimeType}")`);
                            }
                            blob = new Blob([bytes], { type: realMime });
                            console.log(`[Upload] Using pre-downloaded blob size: ${blob.size}, type: ${blob.type}`);
                        } catch (e) {
                            console.error('[Upload] Failed to decode base64 payload:', e);
                            return false;
                        }
                    } else if (source.url) {
                        try {
                            const resp = await fetch(source.url);
                            if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
                            blob = await resp.blob();
                            const arr = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
                            const realMime = detectMime(arr);
                            if (realMime && realMime !== blob.type) {
                                console.log(`[Upload] Magic bytes detected "${realMime}" (fetch said "${blob.type}")`);
                                blob = new Blob([blob], { type: realMime });
                            }
                            console.log(`[Upload] Fetched blob size: ${blob.size}, type: ${blob.type}`);
                        } catch (e) {
                            console.error('[Upload] Failed to fetch file inside browser:', e);
                            return false;
                        }
                    } else {
                        console.error('[Upload] No source (url or base64)');
                        return false;
                    }

                    const pu = sel.proofUpload || {};
                    const attachText = pu.attachButtonText || 'Attach Document';
                    let attachBtn = null;
                    const findBtn = () => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        return btns.find(b => (b.textContent || '').includes(attachText) && b.offsetParent !== null);
                    };

                    for (let i = 0; i < 30; i++) {
                        attachBtn = findBtn();
                        if (attachBtn) break;
                        await sleep(100);
                    }
                    if (!attachBtn) { console.error('[Upload] Attach button not found'); return false; }

                    console.log('[Upload] Clicking Attach Document...');
                    attachBtn.click();
                    await sleep(1000);

                    const mo = pu.modal || {};
                    const fi2 = pu.fileInput || {};
                    let modal = null, input = null, submitBtn = null;
                    for (let i = 0; i < 30; i++) {
                        modal = (mo.id && document.getElementById(mo.id)) ||
                            (mo.classFallback && document.querySelector('.' + mo.classFallback.replace(/^\./, ''))) ||
                            (mo.roleFallback && document.querySelector(mo.roleFallback));

                        if (modal && modal.offsetParent !== null) {
                            input = (fi2.dataTestId && modal.querySelector('input[data-testid="' + fi2.dataTestId + '"]')) ||
                                (fi2.typeFallback && modal.querySelector(fi2.typeFallback));
                            submitBtn = (pu.saveButtonClass && modal.querySelector('.' + pu.saveButtonClass.replace(/^\./, '')));

                            if (input && submitBtn) break;
                        }
                        await sleep(200);
                    }

                    if (!modal || !input) { console.error('[Upload] Upload dialog/input not found'); return false; }

                    // 4. Set File (DataTransfer Magic)
                    const fileType = blob.type || 'application/octet-stream';
                    // Map MIME → correct extension, and also list which extensions
                    // are valid for each MIME so we can detect mismatches.
                    const mimeExtMap = {
                        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
                        'image/webp': '.webp', 'image/bmp': '.bmp',
                        'application/pdf': '.pdf'
                    };
                    const mimeValidExts = {
                        'image/jpeg': ['.jpg', '.jpeg'],
                        'image/png': ['.png'],
                        'image/gif': ['.gif'],
                        'image/webp': ['.webp'],
                        'image/bmp': ['.bmp'],
                        'application/pdf': ['.pdf']
                    };
                    let fixedName = filename;
                    const lastDot = filename.lastIndexOf('.');
                    const currentExt = lastDot > 0 ? filename.slice(lastDot).toLowerCase() : '';
                    const correctExt = mimeExtMap[fileType] || '.jpg';
                    const validExts = mimeValidExts[fileType];
                    // Fix if: no extension, or extension doesn't match actual content type
                    if (!currentExt || (validExts && !validExts.includes(currentExt))) {
                        const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
                        fixedName = stem + correctExt;
                        console.log(`[Upload] Fixed filename: "${filename}" → "${fixedName}" (actual type: ${fileType})`);
                    }
                    const file = new File([blob], fixedName, { type: fileType, lastModified: Date.now() });
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    input.files = dt.files;

                    // Events to trigger React/Framework change detection
                    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

                    console.log(`[Upload] File set in input: ${filename} (${fileType}). Waiting for validation...`);
                    await sleep(1000);

                    const disabledCls = pu.disabledClass || 'opacity-40';
                    for (let i = 0; i < 30; i++) {
                        if (!submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true' && !submitBtn.classList.contains(disabledCls)) {
                            console.log('[Upload] Button enabled. Clicking...');
                            submitBtn.click();
                            await sleep(2000); // Wait for upload/close
                            return true;
                        }
                        await sleep(200);
                    }
                    console.error('[Upload] Attach button never enabled');
                    return false;
                }

                let uploadSuccessCount = 0;
                let firstFailureReason = null;
                for (let idx = 0; idx < proofUrls.length; idx++) {
                    const url = proofUrls[idx];
                    const payload = proofFilePayloads[idx];
                    const source = payload?.downloadFailed
                        ? { downloadFailed: true, reason: payload.reason }
                        : payload
                            ? { base64: payload.base64, mimeType: payload.mimeType }
                            : { url };
                    const filename = payload && !payload.downloadFailed ? payload.filename : (url.split('/').pop() || `proof-${idx + 1}`);
                    console.log(`[Step] Uploading proof ${idx + 1}/${proofUrls.length}: ${payload?.downloadFailed ? 'download-failed' : payload ? 'pre-downloaded' : url}`);
                    const uploadResult = await uploadFileRobust(source, filename);
                    const uploadOk = uploadResult === true;
                    if (uploadOk) {
                        uploadSuccessCount++;
                    } else {
                        if (uploadResult && uploadResult.reason && !firstFailureReason) firstFailureReason = uploadResult.reason;
                        console.warn(`[Step] Proof ${idx + 1}/${proofUrls.length} failed to upload; continuing with others.`);
                    }
                }
                if (uploadSuccessCount === 0) {
                    const err = getPageError();
                    const specific = firstFailureReason ? ` ${firstFailureReason}` : '';
                    return { ok: false, error: err || `Failed to upload any of ${proofUrls.length} proof file(s).${specific}` };
                }
                console.log(`[Step] ${uploadSuccessCount}/${proofUrls.length} proof file(s) uploaded successfully.`);
            } else {
                console.log('[Step] No proofURL provided, skipping upload.');
            }

            // --- 6. Fill Dependants (If Present) ---
            if (data.dependants && Array.isArray(data.dependants) && data.dependants.length > 0) {
                console.log('[Step] Processing Dependants:', data.dependants.length);

                // Formatter helper to align text
                // Goal: "child 1 (next line) child 2" for names
                // Goal: "child 1:       date"
                //       "child 2 long:  date"
                // Logic: 2 spaces per 1 character difference (heuristic for variable width fonts)

                let nameStr = '';
                let dobStr = '';
                let cinStr = '';

                // Calculate max name length for padding
                const maxNameLen = data.dependants.reduce((max, d) => Math.max(max, (d.name || 'Unknown').length), 0);

                data.dependants.forEach((d, idx) => {
                    const isLast = idx === data.dependants.length - 1;
                    const newline = isLast ? '' : '\n';

                    const name = d.name || 'Unknown';
                    const diff = maxNameLen - name.length;
                    const padding = ' '.repeat(Math.round(diff * 1.7)); // 1.7 spaces per char (User tuned)
                    const buffer = '  '; // Restored buffer

                    const paddedLabel = name + padding + buffer;

                    nameStr += `${name}${newline}`;
                    // Use paddedLabel for the labels in DOB and CIN fields to align values
                    dobStr += `${paddedLabel}: ${d.Birthday || ''}${newline}`;
                    cinStr += `${paddedLabel}: ${d.CIN || ''}${newline}`;
                });

                console.log('[Step] Dependants Strings Generated');

                const dep = sel.dependants || {};
                const fillArea = (field, value) => {
                    const id = field && field.id;
                    const xp = field && field.xpath;
                    const el = (id && document.getElementById(id)) || (xp && byXPath(xp));
                    if (el) {
                        el.focus();
                        setNativeValue(el, value);
                        fire(el, 'input');
                        fire(el, 'change');
                        el.blur();
                        return true;
                    }
                    return false;
                };

                if (fillArea(dep.name, nameStr)) console.log('Filled Dependant Names');
                else console.warn('Failed to find Dependant Name Field');

                if (fillArea(dep.dob, dobStr)) console.log('Filled Dependant DOBs');
                else console.warn('Failed to find Dependant DOB Field');

                if (fillArea(dep.cin, cinStr)) console.log('Filled Dependant CINs');
                else console.warn('Failed to find Dependant CIN Field');

            } else {
                console.log('[Step] No dependants to process.');
            }


            // --- 4. Submit ---
            const sub = sel.submit || {};
            const devSkip = !!sub.devSkipSubmit;

            if (devSkip) {
                console.log('[Step] DEV: Submit skipped (devSkipSubmit).');
                return { ok: true, amount, days, verified: false, devSkippedSubmit: true };
            }

            // Pre-submit: if page shows validation errors, fail with first message (no click).
            const errorParagraphs = document.querySelectorAll('p.text-red.text-13px');
            if (errorParagraphs.length > 0) {
                const firstMessage = errorParagraphs[0].textContent.trim();
                console.log('[Step] Validation errors on page (' + errorParagraphs.length + '). Failing with first: ' + firstMessage);
                return { ok: false, error: firstMessage };
            }

            console.log('[Step] Submitting billing record...');
            const subId = sub.id || 'fee-schedule-provided-service-post-note-btn';
            const submitBtn = document.getElementById(subId);

            if (submitBtn) {
                clickLikeHuman(submitBtn);
                await sleep(3000);

                console.log('[Step] Verifying submission...');
                let found = false;
                for (let i = 0; i < 20; i++) {
                    if (doInlineScanFallback(reqStart, reqEnd, amount)) {
                        found = true;
                        break;
                    }
                    await sleep(500);
                }

                if (found) {
                    return { ok: true, amount, days, verified: true };
                } else {
                    console.warn('[Step] Verification failed: New record not found after submit.');
                    return { ok: true, amount, days, verified: false, warning: 'Billing attempted but not verified in list' };
                }
            } else {
                const err = getPageError(); return { ok: false, error: err || 'Submit button (' + subId + ') not found' };
            }

            // =========================================================================
            //  INJECTED LOGIC END
            // =========================================================================
        }, { data, sel });

        return result;

    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = { executeBillingOnPage };
