const termEl = document.getElementById('terminal');
const queueBody = document.getElementById('queue-body');
const statusBadge = document.getElementById('connection-status');
const filterStatusEl = document.getElementById('filter-status');

/** Device authorization: if false, action buttons are disabled and server will reject. */
let deviceAuthorized = true;
let deviceId = '';

/** Full request list (unfiltered). Updated on each queue event. */
let allRequests = [];

/** Set of indices in allRequests that are selected for "Run current queue". */
let selectedIndices = new Set();

/** Drag-to-select state: paint checkboxes when dragging over the select column */
let dragSelect = {
    active: false,
    startIndex: -1,
    initialChecked: false,
    hasMoved: false
};

/** Last row index clicked (for Shift+click range selection). -1 = none yet. */
let lastClickedIndex = -1;

/** When true, hovering over a row adds it to the selection (hold Shift to activate). */
let shiftMassSelectMode = false;

// Electron: show "Open in browser" button and wire it
(function initOpenInBrowser() {
    const btn = document.getElementById('btn-open-in-browser');
    if (btn && typeof window.electronApi !== 'undefined' && typeof window.electronApi.openInBrowser === 'function') {
        btn.style.display = '';
        btn.addEventListener('click', () => window.electronApi.openInBrowser());
    }
    const configBtn = document.getElementById('btn-open-config-folder');
    if (configBtn && typeof window.electronApi !== 'undefined' && typeof window.electronApi.openConfigFolder === 'function') {
        configBtn.style.display = '';
        configBtn.addEventListener('click', () => window.electronApi.openConfigFolder());
    }
    // Hidden: 5 clicks on device ID badge opens .env in default app (Electron only)
    const deviceBadge = document.getElementById('device-badge');
    if (deviceBadge && typeof window.electronApi !== 'undefined' && typeof window.electronApi.openEnvFile === 'function') {
        let envClickCount = 0;
        let envClickReset = null;
        deviceBadge.addEventListener('click', () => {
            envClickCount += 1;
            if (envClickReset) clearTimeout(envClickReset);
            if (envClickCount >= 5) {
                envClickCount = 0;
                window.electronApi.openEnvFile();
            } else {
                envClickReset = setTimeout(() => { envClickCount = 0; }, 1500);
            }
        });
    }
})();

/** Recheck device authorization (used on load and when user clicks Refresh in unauthorized banner). */
function checkDeviceStatus() {
    const refreshBtn = document.getElementById('btn-refresh-auth');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Checking…';
    }
    return fetch('/device-status')
        .then(r => r.json().then(d => ({ ok: r.ok, status: r.status, data: d })))
        .then(({ ok, status, data: d }) => {
            deviceId = (d && d.deviceId) ? String(d.deviceId).trim() : '';
            deviceAuthorized = ok && d && d.authorized === true;
            const badge = document.getElementById('device-badge');
            const deviceIdEl = document.getElementById('device-id');
            if (badge && deviceIdEl) {
                deviceIdEl.textContent = deviceId || '–';
                badge.style.display = '';
                if (!deviceAuthorized) badge.classList.add('unauthorized');
                else badge.classList.remove('unauthorized');
            }
            const banner = document.getElementById('device-unauthorized-banner');
            const unauthIdEl = document.getElementById('unauthorized-device-id');
            if (banner && unauthIdEl) {
                if (!deviceAuthorized) {
                    unauthIdEl.textContent = deviceId || '(see server console)';
                    banner.style.display = 'block';
                    setActionButtonsEnabled(false);
                    log(`Access denied. Device ID: ${deviceId || '(unavailable)'}. Add this device to the allowed list or check server connection. (Authorized IDs are in server logs.)`, 'error');
                } else {
                    banner.style.display = 'none';
                    setActionButtonsEnabled(true);
                    log('Device is now authorized. You can use automation.', 'success');
                }
            }
        })
        .catch(() => {
            deviceAuthorized = false;
            deviceId = '';
            setActionButtonsEnabled(false);
            const banner = document.getElementById('device-unauthorized-banner');
            const unauthIdEl = document.getElementById('unauthorized-device-id');
            if (banner && unauthIdEl) {
                unauthIdEl.textContent = '(could not verify – see server console)';
                banner.style.display = 'block';
            }
            const badge = document.getElementById('device-badge');
            if (badge) badge.classList.add('unauthorized');
            log('Could not verify device. Access denied.', 'error');
        })
        .finally(() => {
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = '🔄 Refresh';
            }
        });
}

// Fetch device authorization status on load. Fail closed: any error = treat as not authorized.
checkDeviceStatus();

document.getElementById('btn-refresh-auth')?.addEventListener('click', function () {
    checkDeviceStatus();
});

function setActionButtonsEnabled(enabled) {
    const ids = ['btn-run-queue', 'btn-load-file', 'btn-download', 'btn-import-excel', 'btn-stop', 'excel-save-file', 'btn-print', 'btn-export-excel'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
    });
}

/** When server returns 403, parse body and show deviceId then reject. */
function parse403AndReject(r) {
    return r.json().then(d => {
        const id = (d && d.deviceId) || deviceId;
        log(`Device not authorized. Your device ID: ${id}. Add it to the allowed list to proceed.`, 'error');
        throw new Error(d && d.error ? d.error : 'Device not authorized');
    });
}

// Connect to SSE with reconnect on error (fixes "Disconnected" and missing queue updates in Electron)
let evtSource = null;
let sseReconnectDelay = 1000;
const SSE_RECONNECT_MAX_DELAY = 15000;

function connectSSE() {
    if (evtSource) {
        evtSource.close();
        evtSource = null;
    }
    statusBadge.textContent = 'Connecting...';
    statusBadge.className = 'badge';
    evtSource = new EventSource('/events');

    evtSource.onopen = () => {
        statusBadge.textContent = 'Connected';
        statusBadge.className = 'badge connected';
        sseReconnectDelay = 1000; // reset backoff on successful connect
        log('System connected to server.');
        fetch('/api/port').then(r => r.ok ? r.json() : {}).then(d => {
            const port = d && Number.isFinite(d.port) ? d.port : null;
            const hint = document.getElementById('port-hint');
            const numEl = document.getElementById('port-number');
            if (hint && numEl && port != null && port !== 3500) {
                numEl.textContent = port;
                hint.style.display = '';
                hint.title = 'Server is using port ' + port + ' (e.g. if default was in use). Set PORT=' + port + ' in .env to use it next time.';
            }
        }).catch(() => {});
    };

    evtSource.addEventListener('config', (e) => {
        const data = JSON.parse(e.data);
        const countEl = document.getElementById('browser-count-n');
        const maxEl = document.getElementById('max-browsers-n');
        if (countEl && data.browserCount != null) countEl.textContent = data.browserCount;
        if (maxEl && data.maxBrowsers != null) maxEl.textContent = data.maxBrowsers;
    });

    evtSource.onerror = () => {
        // Only close and reconnect when connection is actually CLOSED (2). While CONNECTING (0),
        // browsers/Electron often fire onerror once; closing here would prevent onopen from ever firing.
        if (evtSource && evtSource.readyState === 2) {
            statusBadge.textContent = 'Disconnected';
            statusBadge.className = 'badge disconnected';
            evtSource.close();
            evtSource = null;
            const delay = sseReconnectDelay;
            sseReconnectDelay = Math.min(sseReconnectDelay * 1.5, SSE_RECONNECT_MAX_DELAY);
            setTimeout(connectSSE, delay);
        } else {
            statusBadge.textContent = 'Connecting...';
            statusBadge.className = 'badge';
        }
    };

    evtSource.addEventListener('queue', onQueueEvent);
    evtSource.addEventListener('log', onLogEvent);
    evtSource.addEventListener('status', onStatusEvent);
    evtSource.addEventListener('runners', onRunnersEvent);
}

function onQueueEvent(e) {
    const requests = JSON.parse(e.data);
    allRequests = requests;
    syncFilterOptions(requests);
    applyFilterAndRender();
    updateStats(requests);
}

function onLogEvent(e) {
    const data = JSON.parse(e.data);
    log(data.message, data.type);
}

function onStatusEvent(e) {
    const data = JSON.parse(e.data);
    const stopBtn = document.getElementById('btn-stop');
    if (stopBtn) {
        if (data.isRunning) {
            stopBtn.style.display = 'inline-block';
        } else {
            stopBtn.style.display = 'none';
        }
    }
}

function onRunnersEvent(e) {
    const runners = JSON.parse(e.data);
    const grid = document.getElementById('runners-grid');
    const section = document.getElementById('runners-section');
    if (!grid || !section) return;
    const list = Array.isArray(runners) ? runners.filter(Boolean) : [];
    grid.innerHTML = '';
    list.forEach((r) => {
        const card = document.createElement('div');
        card.className = 'runner-card';
        card.innerHTML = `<div class="runner-name">${escapeHtml(r.clientName || '')}</div><div class="runner-step">${escapeHtml(r.step || '')}</div>`;
        grid.appendChild(card);
    });
    section.style.display = list.length ? 'block' : 'none';
}

connectSSE();

// Shift key: activate mass-select mode (hover to add rows to selection)
document.addEventListener('keydown', function (e) {
    if (e.key === 'Shift' && !shiftMassSelectMode) {
        shiftMassSelectMode = true;
        document.body.classList.add('shift-mass-select');
        const hint = document.getElementById('shift-hint');
        if (hint) hint.classList.add('visible');
    }
});
document.addEventListener('keyup', function (e) {
    if (e.key === 'Shift') {
        shiftMassSelectMode = false;
        document.body.classList.remove('shift-mass-select');
        const hint = document.getElementById('shift-hint');
        if (hint) hint.classList.remove('visible');
    }
});

filterStatusEl.addEventListener('change', () => applyFilterAndRender());

document.getElementById('select-none').addEventListener('click', function () {
    selectedIndices.clear();
    applyFilterAndRender();
    updateTotalAmount();
});

document.getElementById('select-all').addEventListener('change', function () {
    const checked = this.checked;
    const status = (filterStatusEl.value || '').trim();
    const norm = (s) => (s != null && String(s).trim() !== '' ? String(s).trim() : 'pending');
    const filtered = status ? allRequests.filter(r => norm(r.status) === status) : allRequests;
    filtered.forEach(req => {
        const idx = allRequests.findIndex(r => r === req);
        if (idx !== -1) {
            if (checked) selectedIndices.add(idx); else selectedIndices.delete(idx);
        }
    });
    applyFilterAndRender();
    updateTotalAmount();
});

function getOrderCount(req) {
    const ids = req.orderIds;
    if (Array.isArray(ids) && ids.length > 0) return ids.length;
    if (req.orderNumber != null && req.orderNumber !== '') return 1;
    return 1;
}

function getAmountNum(req) {
    const n = Number(req.amount);
    return Number.isFinite(n) ? n : 0;
}

function runCurrentQueue() {
    const toRun = selectedIndices.size > 0
        ? allRequests.filter((_, i) => selectedIndices.has(i))
        : allRequests;
    if (toRun.length === 0) {
        log('No requests to run. Load from server or select items.', 'error');
        return;
    }
    log(`Sending ${toRun.length} request(s) to run (current queue)...`, 'info');
    fetch('/process-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'queue', requests: toRun })
    })
        .then(r => {
            if (!r.ok) {
                if (r.status === 403) return parse403AndReject(r);
                return r.json().then(data => { throw new Error(data.error || r.statusText); });
            }
            return r.json();
        })
        .then(d => {
            log(`Started: ${d.message || 'OK'} (${toRun.length} items)`, 'success');
        })
        .catch(e => {
            log(`Error: ${e.message}`, 'error');
        });
}

function loadFromFile() {
    log('Loading queue from billing_requests.json...', 'info');
    fetch('/load-billing-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })
        .then(r => {
            if (r.status === 403) return parse403AndReject(r);
            return r.json();
        })
        .then(d => {
            if (d && d.error) {
                log(`Load failed: ${d.error}`, 'error');
            } else if (d) {
                log(d.message || `Loaded ${d.count || 0} requests. Run the queue when ready.`, 'success');
            }
        })
        .catch(e => {
            log(`Load failed: ${e.message}`, 'error');
        });
}

function triggerProcess(source) {
    log(`Sending request to start automation (Source: ${source})...`, 'info');

    fetch('/process-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source })
    })
        .then(r => {
            console.log('[Client] Response status:', r.status, r.statusText);
            if (!r.ok) {
                if (r.status === 403) return parse403AndReject(r);
                return r.json().then(data => {
                    console.error('[Client] Error response:', data);
                    throw new Error(data.error || `HTTP ${r.status}: ${r.statusText}`);
                });
            }
            return r.json();
        })
        .then(d => {
            console.log('[Client] Success response:', d);
            if (d && d.error) {
                log(`Error: ${d.error}`, 'error');
            } else if (d) {
                const msg = d.source === 'queue' ? `Started: ${d.message || 'OK'}` : 'Automation started [TSS API Mode]';
                log(msg, 'success');
            }
        })
        .catch(e => {
            console.error('[Client] Fetch error:', e);
            log(`Error triggering: ${e.message || e}`, 'error');
        });
}

function downloadCloudRequests() {
    log('Fetching from server and saving to billing file (Load from File will use this)...', 'info');
    document.getElementById('queue-body').innerHTML = ''; // Clear previous

    fetch('/fetch-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    })
        .then(r => {
            if (r.status === 403) return parse403AndReject(r);
            return r.json();
        })
        .then(d => {
            if (d && d.error) {
                log(`Fetch Error: ${d.error}`, 'error');
            } else if (d) {
                log(d.message || `Fetched ${d.count} requests (saved to file).`, 'success');
                // Always apply queue from response (merged list = file content) so UI matches what was saved
                if (Array.isArray(d.requests)) {
                    allRequests = d.requests;
                    syncFilterOptions(allRequests);
                    applyFilterAndRender();
                    updateStats(allRequests);
                }
            }
        })
        .catch(e => {
            log(`Fetch Failed: ${e.message}`, 'error');
        });
}

function stopProcess() {
    log('Sending stop signal to server...', 'info');
    
    fetch('/stop-billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
        .then(r => {
            if (r.status === 403) return parse403AndReject(r);
            return r.json();
        })
        .then(d => {
            if (d && d.error) {
                log(`Stop Error: ${d.error}`, 'error');
            } else if (d) {
                log(`Stop signal sent: ${d.message}`, 'warning');
            }
        })
        .catch(e => {
            log(`Stop Failed: ${e.message}`, 'error');
        });
}

function log(msg, type = 'info') {
    const div = document.createElement('div');
    div.className = `line ${type}`;
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    termEl.appendChild(div);
    termEl.scrollTop = termEl.scrollHeight;
}

/**
 * Build filter options from every distinct status in the data.
 * No preset list – only statuses that appear in requests (worker, API, or file).
 */
function syncFilterOptions(requests) {
    const seen = new Set();
    for (const r of requests) {
        const s = r.status != null && String(r.status).trim() !== '' ? String(r.status).trim() : 'pending';
        seen.add(s);
    }
    const statuses = [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const current = filterStatusEl.value;
    filterStatusEl.innerHTML = '<option value="">All</option>';
    for (const s of statuses) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (s === current) opt.selected = true;
        filterStatusEl.appendChild(opt);
    }
    const currentNorm = current.trim().toLowerCase();
    const exists = statuses.some(z => z.trim().toLowerCase() === currentNorm);
    if (!exists && current !== '') filterStatusEl.value = '';
}

function applyFilterAndRender() {
    const status = (filterStatusEl.value || '').trim();
    const norm = (s) => (s != null && String(s).trim() !== '' ? String(s).trim() : 'pending');
    const filtered = status
        ? allRequests.filter(r => norm(r.status) === status)
        : allRequests;
    renderQueue(filtered);
}

function statusToClass(s) {
    const v = (s || 'pending').toLowerCase();
    const map = { pending: 'status-pending', processing: 'status-processing', success: 'status-success', failed: 'status-failed', skipped: 'status-skipped', warning: 'status-warning' };
    return map[v] || 'status-other';
}

function renderQueue(requests) {
    queueBody.innerHTML = '';
    requests.forEach(req => {
        const idx = allRequests.findIndex(r => r === req);
        const isSelected = idx !== -1 && selectedIndices.has(idx);
        const status = req.status || 'pending';
        const statusClass = statusToClass(req.status);
        const orderCount = getOrderCount(req);
        const amount = getAmountNum(req);
        const amountStr = amount > 0 ? '$' + amount.toFixed(2) : '-';
        const isEquipment = req.equipment === true || req.equipment === 'true' || req.equtment === true || req.equtment === 'true';
        const equipmentCell = isEquipment ? '<span class="equipment-badge">Yes</span>' : '–';

        const proofUrls = req.proofURL != null
            ? (Array.isArray(req.proofURL) ? req.proofURL.filter(u => u && String(u).trim()) : [String(req.proofURL).trim()].filter(Boolean))
            : [];

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="col-select"><input type="checkbox" class="row-select" data-index="${idx}" ${isSelected ? 'checked' : ''} aria-label="Select row"></td>
            <td>${escapeHtml(req.name)}</td>
            <td class="col-orders">${orderCount}</td>
            <td class="col-amount">${amountStr}</td>
            <td>${req.start ? `${escapeHtml(req.start)} → ${escapeHtml(req.end)}` : (req.date ? escapeHtml(req.date) : '-')}</td>
            <td class="col-equipment">${equipmentCell}</td>
            <td class="col-proof">${proofUrls.length === 0 ? '<span class="proof-none">–</span>' : ''}</td>
            <td><span class="status-badge ${statusClass}">${escapeHtml(status)}</span></td>
            <td style="font-size:0.85em; color:#ccc">${escapeHtml(req.message || '-')}</td>
        `;
        if (proofUrls.length > 0) {
            const proofTd = tr.querySelector('.col-proof');
            proofUrls.forEach((url, i) => {
                const a = document.createElement('a');
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.className = 'proof-link';
                a.title = url;
                a.textContent = proofUrls.length > 1 ? `View ${i + 1}` : 'View';
                a.addEventListener('click', function (e) {
                    e.stopPropagation();
                });
                proofTd.appendChild(a);
                if (i < proofUrls.length - 1) proofTd.appendChild(document.createTextNode(' '));
            });
        }
        const cb = tr.querySelector('.row-select');
        cb.addEventListener('change', function () {
            const i = parseInt(this.getAttribute('data-index'), 10);
            if (!Number.isFinite(i) || i < 0) return;
            if (this.checked) selectedIndices.add(i); else selectedIndices.delete(i);
            updateTotalAmount();
            updateSelectAllState();
        });
        const selectCell = tr.querySelector('.col-select');
        if (selectCell) {
            selectCell.addEventListener('mousedown', onSelectCellMouseDown);
        }
        // Click anywhere on the row to toggle selection (skip if click was on the checkbox)
        tr.addEventListener('click', function (e) {
            if (e.target.closest('.row-select')) return;
            const i = getRowIndexFromElement(e.target);
            if (i < 0) return;
            setRowSelected(i, !selectedIndices.has(i));
            lastClickedIndex = i;
            updateTotalAmount();
            updateSelectAllState();
        });
        // Shift + hover: add row to selection
        tr.addEventListener('mouseenter', function () {
            if (!shiftMassSelectMode) return;
            const i = getRowIndexFromElement(tr);
            if (i >= 0) {
                setRowSelected(i, true);
                updateTotalAmount();
                updateSelectAllState();
            }
        });
        queueBody.appendChild(tr);
    });
    updateSelectAllState();
}

function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

/**
 * Get request index for a row from a DOM element (climb to tr, then read data-index from checkbox).
 * @returns {number} -1 if not a queue row
 */
function getRowIndexFromElement(el) {
    const tr = el && el.closest ? el.closest('tr') : null;
    if (!tr) return -1;
    const cb = tr.querySelector('.row-select');
    if (!cb) return -1;
    const i = parseInt(cb.getAttribute('data-index'), 10);
    return Number.isFinite(i) ? i : -1;
}

/**
 * Set selection for one index (add/remove from selectedIndices and update checkbox in DOM).
 */
function setRowSelected(index, selected) {
    if (index < 0) return;
    if (selected) selectedIndices.add(index); else selectedIndices.delete(index);
    const cb = document.querySelector(`.row-select[data-index="${index}"]`);
    if (cb) cb.checked = selected;
}

function onSelectCellMouseDown(e) {
    const index = getRowIndexFromElement(e.target);
    if (index < 0) return;
    e.preventDefault();
    dragSelect.active = true;
    dragSelect.startIndex = index;
    dragSelect.initialChecked = selectedIndices.has(index);
    dragSelect.hasMoved = false;
    document.addEventListener('mousemove', onDragSelectMove);
    document.addEventListener('mouseup', onDragSelectUpHandler);
}

function onDragSelectUpHandler(e) {
    onDragSelectUp(e);
    document.removeEventListener('mouseup', onDragSelectUpHandler);
}

function onDragSelectMove(e) {
    if (!dragSelect.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const index = getRowIndexFromElement(el);
    if (index >= 0) {
        dragSelect.hasMoved = true;
        const lo = Math.min(dragSelect.startIndex, index);
        const hi = Math.max(dragSelect.startIndex, index);
        for (let i = lo; i <= hi; i++) setRowSelected(i, dragSelect.initialChecked);
    }
}

function onDragSelectUp(e) {
    document.removeEventListener('mousemove', onDragSelectMove);
    if (!dragSelect.active) return;
    if (!dragSelect.hasMoved) {
        if (e && e.shiftKey && lastClickedIndex >= 0) {
            const lo = Math.min(lastClickedIndex, dragSelect.startIndex);
            const hi = Math.max(lastClickedIndex, dragSelect.startIndex);
            const value = !dragSelect.initialChecked;
            for (let i = lo; i <= hi; i++) setRowSelected(i, value);
        } else {
            setRowSelected(dragSelect.startIndex, !dragSelect.initialChecked);
        }
        lastClickedIndex = dragSelect.startIndex;
    } else {
        lastClickedIndex = dragSelect.startIndex;
    }
    dragSelect.active = false;
    updateTotalAmount();
    updateSelectAllState();
}

function updateSelectAllState() {
    const status = (filterStatusEl.value || '').trim();
    const norm = (s) => (s != null && String(s).trim() !== '' ? String(s).trim() : 'pending');
    const filtered = status ? allRequests.filter(r => norm(r.status) === status) : allRequests;
    if (filtered.length === 0) {
        document.getElementById('select-all').checked = false;
        document.getElementById('select-all').indeterminate = false;
        return;
    }
    const selectedVisible = filtered.filter(req => {
        const idx = allRequests.findIndex(r => r === req);
        return idx !== -1 && selectedIndices.has(idx);
    });
    const selectAllEl = document.getElementById('select-all');
    selectAllEl.checked = selectedVisible.length === filtered.length;
    selectAllEl.indeterminate = selectedVisible.length > 0 && selectedVisible.length < filtered.length;
}

function updateTotalAmount() {
    const toSum = selectedIndices.size > 0
        ? allRequests.filter((_, i) => selectedIndices.has(i))
        : allRequests;
    const total = toSum.reduce((acc, r) => acc + getAmountNum(r), 0);
    document.getElementById('total-amount').textContent = '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('total-amount-hint').textContent = selectedIndices.size > 0
        ? `(${selectedIndices.size} selected)`
        : (allRequests.length ? `(${allRequests.length} items)` : '(selected / visible)');
}

function updateStats(requests) {
    document.getElementById('stat-total').textContent = requests.length;
    document.getElementById('stat-pending').textContent = requests.filter(r => !r.status || r.status === 'pending').length;
    document.getElementById('stat-success').textContent = requests.filter(r => r.status === 'success').length;
    document.getElementById('stat-failed').textContent = requests.filter(r => r.status === 'failed').length;
    updateTotalAmount();
}

// --- Excel import ---
let excelSheetData = null; // { headers: string[], rows: any[][] }

function normalizeDate(val) {
    if (val == null || String(val).trim() === '') return '';
    const fmt = (m, d, y) => `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}-${y}`;

    if (val instanceof Date && !isNaN(val.getTime())) {
        return fmt(val.getMonth() + 1, val.getDate(), val.getFullYear());
    }

    const s = String(val).trim();

    // Excel serial number – use UTC to avoid timezone shifting the date
    const n = Number(val);
    if (Number.isFinite(n) && n > 0 && n < 2958466 && String(val) === String(n)) {
        const d = new Date((n - 25569) * 86400000);
        if (!Number.isNaN(d.getTime())) {
            return fmt(d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCFullYear());
        }
    }

    // Already MM-DD-YYYY
    const already = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (already) {
        const m = parseInt(already[1], 10), d = parseInt(already[2], 10);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return s;
    }

    // YYYY-MM-DD or YYYY/MM/DD — convert to MM-DD-YYYY, auto-swap if month > 12
    const ymd = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (ymd) {
        let y = parseInt(ymd[1], 10), a = parseInt(ymd[2], 10), b = parseInt(ymd[3], 10);
        if (a > 12 && b <= 12) return fmt(b, a, y);
        if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return fmt(a, b, y);
    }

    // D/M/YYYY, DD/MM/YYYY, M/D/YYYY — with 4-digit year
    const dmy4 = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (dmy4) {
        const aNum = parseInt(dmy4[1], 10), bNum = parseInt(dmy4[2], 10), y = parseInt(dmy4[3], 10);
        let day, month;
        if (aNum > 12 && bNum <= 12)      { day = aNum; month = bNum; }
        else if (bNum > 12 && aNum <= 12) { month = aNum; day = bNum; }
        else                               { day = aNum; month = bNum; }
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return fmt(month, day, y);
    }

    // D/M/YY, DD/MM/YY, M/D/YY — with 2-digit year
    const dmy2 = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
    if (dmy2) {
        const aNum = parseInt(dmy2[1], 10), bNum = parseInt(dmy2[2], 10);
        const y = 2000 + parseInt(dmy2[3], 10);
        let day, month;
        if (aNum > 12 && bNum <= 12)      { day = aNum; month = bNum; }
        else if (bNum > 12 && aNum <= 12) { month = aNum; day = bNum; }
        else                               { month = aNum; day = bNum; }
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return fmt(month, day, y);
    }

    return s;
}

function isEquipmentTrue(val) {
    if (val == null) return false;
    const s = String(val).trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === '1' || s === 'x') return true;
    return Number(val) === 1;
}

function buildRequestsFromExcel(mapping) {
    if (!excelSheetData || !window.XLSX) return [];
    const { headers, rows } = excelSheetData;
    const getCol = (key) => { const v = mapping[key]; return v === '' || v == null ? -1 : parseInt(v, 10); };
    const urlCol = getCol('url');
    const dateCol = getCol('date');
    const amountCol = getCol('amount');
    const proofCol = getCol('proofURL');
    const eqCol = getCol('equipment');
    const nameCol = getCol('name');
    // All required fields must be mapped (name is optional)
    if (urlCol < 0 || dateCol < 0 || amountCol < 0 || proofCol < 0 || eqCol < 0) return [];
    const requests = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let url = urlCol < row.length ? String(row[urlCol] ?? '').trim() : '';
        if (excelSheetData.hyperlinks) {
            const urlCellAddr = XLSX.utils.encode_cell({ r: i + 1, c: urlCol });
            if (excelSheetData.hyperlinks[urlCellAddr]) {
                url = excelSheetData.hyperlinks[urlCellAddr].trim();
            }
        }
        const dateRaw = dateCol < row.length ? row[dateCol] : '';
        const dateStr = dateRaw != null ? String(dateRaw).trim() : '';
        if (!url || (dateStr === '' && dateRaw !== 0)) continue;
        const amountVal = amountCol < row.length ? row[amountCol] : 0;
        const amount = typeof amountVal === 'number' ? amountVal : Number(String(amountVal).replace(/[^\d.-]/g, '')) || 0;
        let proofURL = proofCol < row.length ? String(row[proofCol] ?? '').trim() : '';
        // Prefer the hyperlink target over the display text (handles HYPERLINK() formulas)
        if (excelSheetData.hyperlinks) {
            const cellAddr = XLSX.utils.encode_cell({ r: i + 1, c: proofCol });
            if (excelSheetData.hyperlinks[cellAddr]) {
                proofURL = excelSheetData.hyperlinks[cellAddr].trim();
            }
        }
        const equipment = eqCol < row.length ? isEquipmentTrue(row[eqCol]) : false;
        const normalizedDate = normalizeDate(dateRaw);
        if (!normalizedDate) continue;
        const name = nameCol >= 0 && nameCol < row.length ? String(row[nameCol] ?? '').trim() : '';
        requests.push({
            name,
            url,
            date: normalizedDate,
            amount,
            proofURL,
            dependants: [],
            ...(equipment ? { equipment: 'true' } : {})
        });
    }
    return requests;
}

function getExcelMapping() {
    return {
        url: document.getElementById('map-url').value,
        date: document.getElementById('map-date').value,
        amount: document.getElementById('map-amount').value,
        proofURL: document.getElementById('map-proofURL').value,
        equipment: document.getElementById('map-equipment').value,
        name: document.getElementById('map-name').value
    };
}

function openExcelImportModal() {
    const modal = document.getElementById('excel-import-modal');
    const preview = document.getElementById('excel-preview');
    if (!excelSheetData) return;
    const { headers, rows } = excelSheetData;
    const opts = headers.map((h, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = (h != null && String(h).trim() !== '') ? String(h) : `Column ${i + 1}`;
        return o;
    });
    const requiredIds = ['map-url', 'map-date', 'map-amount', 'map-proofURL', 'map-equipment'];
    requiredIds.forEach(id => {
        const sel = document.getElementById(id);
        sel.innerHTML = '<option value="">-- Required --</option>';
        opts.forEach(o => sel.appendChild(o.cloneNode(true)));
    });
    document.getElementById('map-name').innerHTML = '<option value="">-- Skip --</option>';
    opts.forEach(o => document.getElementById('map-name').appendChild(o.cloneNode(true)));
    const idx = (re) => { const i = headers.findIndex(h => re.test(String(h))); return i >= 0 ? String(i) : ''; };
    document.getElementById('map-url').value = idx(/^(url|link|href)$/i) || idx(/url|link/);
    document.getElementById('map-date').value = idx(/^date$/i) || idx(/date/);
    document.getElementById('map-amount').value = idx(/^(amount|amt|total)$/i) || idx(/amount|total/);
    document.getElementById('map-proofURL').value = idx(/proof/i);
    document.getElementById('map-equipment').value = idx(/equipment|equtment/i);
    document.getElementById('map-name').value = idx(/^name$/i) || idx(/name/);
    preview.textContent = `Preview: ${rows.length} data row(s), ${headers.length} column(s). Map columns above and click Save or Download.`;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
}

function closeExcelImportModal() {
    const modal = document.getElementById('excel-import-modal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
}

document.getElementById('btn-import-excel').addEventListener('click', () => document.getElementById('excel-file-input').click());

/**
 * Export the currently filtered queue as PDF.
 */
function exportQueueAsPDF() {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
        log('PDF library not loaded.', 'error');
        return;
    }
    if (allRequests.length === 0) {
        log('No queue data to export. Load from file or server first.', 'error');
        return;
    }
    const status = (filterStatusEl.value || '').trim();
    const norm = (s) => (s != null && String(s).trim() !== '' ? String(s).trim() : 'pending');
    const exportList = status ? allRequests.filter(r => norm(r.status) === status) : allRequests;
    if (exportList.length === 0) {
        log('No items match the current filter.', 'error');
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const filterLabel = status ? ` (filter: ${status})` : '';
    const headers = ['Client', 'Orders', 'Amount', 'Dates', 'Equipment', 'Status', 'Message'];
    const rows = exportList.map(req => {
        const orderCount = getOrderCount(req);
        const amount = getAmountNum(req);
        const amountStr = amount > 0 ? '$' + amount.toFixed(2) : '-';
        const isEquipment = req.equipment === true || req.equipment === 'true' || req.equtment === true || req.equtment === 'true';
        const dates = req.start ? `${req.start} → ${req.end}` : (req.date || '-');
        return [
            String(req.name ?? ''),
            String(orderCount),
            amountStr,
            String(dates),
            isEquipment ? 'Yes' : '–',
            String(req.status ?? 'pending'),
            String(req.message ?? '')
        ];
    });
    doc.setFontSize(14);
    doc.text('Billing queue export' + filterLabel, 14, 16);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleString()} — ${exportList.length} item(s)`, 14, 22);
    doc.autoTable({
        head: [headers],
        body: rows,
        startY: 26,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [80, 80, 80] }
    });
    const blob = doc.output('blob');
    const defaultName = `billing-queue-${new Date().toISOString().slice(0, 10)}.pdf`;
    if (typeof window.electronApi !== 'undefined' && typeof window.electronApi.savePDF === 'function') {
        log('Exporting queue as PDF...', 'info');
        const reader = new FileReader();
        reader.onload = async () => {
            const base64 = reader.result.split(',')[1];
            const result = await window.electronApi.savePDF(base64, defaultName);
            if (result && result.ok) {
                log(`PDF saved: ${result.path}`, 'success');
            } else if (result && result.canceled) {
                log('Save canceled.', 'info');
            } else {
                log(result && result.error ? `PDF save failed: ${result.error}` : 'PDF save failed.', 'error');
            }
        };
        reader.readAsDataURL(blob);
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(url);
        log(`PDF downloaded: ${defaultName} (${exportList.length} items)`, 'success');
    }
}

document.getElementById('btn-print').addEventListener('click', function () {
    exportQueueAsPDF();
});

function exportQueueAsExcel() {
    if (typeof XLSX === 'undefined') {
        log('Excel library not loaded.', 'error');
        return;
    }
    if (allRequests.length === 0) {
        log('No queue data to export. Load from file or server first.', 'error');
        return;
    }
    const status = (filterStatusEl.value || '').trim();
    const norm = (s) => (s != null && String(s).trim() !== '' ? String(s).trim() : 'pending');
    const exportList = status ? allRequests.filter(r => norm(r.status) === status) : allRequests;
    if (exportList.length === 0) {
        log('No items match the current filter.', 'error');
        return;
    }

    const parseToExcelDate = (str) => {
        if (!str) return '';
        const parts = String(str).split(/[\/\-.]/).map(Number);
        if (parts.length !== 3) return str;
        let m, d, y;
        if (parts[2] >= 2000) { m = parts[0]; d = parts[1]; y = parts[2]; }
        else if (parts[0] >= 2000) { y = parts[0]; m = parts[1]; d = parts[2]; }
        else return str;
        if (m > 12 && d <= 12) { [m, d] = [d, m]; }
        const dt = new Date(y, m - 1, d);
        return isNaN(dt.getTime()) ? str : dt;
    };

    const rows = exportList.map(req => {
        const amount = getAmountNum(req);
        const isEquipment = req.equipment === true || req.equipment === 'true' || req.equtment === true || req.equtment === 'true';
        return {
            'Client': req.name || '',
            'URL': req.url || '',
            'Date': parseToExcelDate(req.date),
            'Start Date': parseToExcelDate(req.start),
            'End Date': parseToExcelDate(req.end),
            'Amount': amount,
            'Equipment': isEquipment ? 'Yes' : 'No',
            'Proof URL': Array.isArray(req.proofURL) ? req.proofURL.join(', ') : (req.proofURL || ''),
            'Status': req.status || 'pending',
            'Message': req.message || ''
        };
    });

    const ws = XLSX.utils.json_to_sheet(rows);

    const dateColIndices = [2, 3, 4];
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
        for (const C of dateColIndices) {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            const cell = ws[addr];
            if (cell && cell.v instanceof Date) {
                cell.t = 'd';
                cell.z = 'mm/dd/yyyy';
            }
        }
    }

    ws['!cols'] = [
        { wch: 20 }, { wch: 50 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 10 }, { wch: 10 }, { wch: 50 }, { wch: 10 }, { wch: 30 }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Billing Queue');
    const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    const defaultName = `billing-queue-${new Date().toISOString().slice(0, 10)}.xlsx`;
    if (typeof window.electronApi !== 'undefined' && typeof window.electronApi.saveExcel === 'function') {
        log('Exporting queue as Excel...', 'info');
        const reader = new FileReader();
        reader.onload = async () => {
            const base64 = reader.result.split(',')[1];
            const result = await window.electronApi.saveExcel(base64, defaultName);
            if (result && result.ok) {
                log(`Excel saved: ${result.path}`, 'success');
            } else if (result && result.canceled) {
                log('Save canceled.', 'info');
            } else {
                log('Save failed: ' + ((result && result.error) || 'unknown'), 'error');
            }
        };
        reader.readAsDataURL(blob);
    } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = defaultName;
        a.click();
        URL.revokeObjectURL(a.href);
        log(`Downloaded ${defaultName} (${exportList.length} items).`, 'success');
    }
}

document.getElementById('btn-export-excel').addEventListener('click', function () {
    exportQueueAsExcel();
});

document.getElementById('btn-save-log').addEventListener('click', async function () {
    try {
        const r = await fetch('/api/log-file');
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            log(err.error || 'Could not save log file.', 'error');
            return;
        }
        const blob = await r.blob();
        const name = r.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || 'server-log.log';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        log('Save log failed: ' + (e.message || String(e)), 'error');
    }
});

document.getElementById('excel-file-input').addEventListener('change', function () {
    const file = this.files && this.files[0];
    this.value = '';
    if (!file || typeof XLSX === 'undefined') {
        if (!file) return;
        log('Excel library not loaded.', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const name = wb.SheetNames[0];
            const ws = wb.Sheets[name];
            const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });
            if (!raw.length) {
                log('Excel sheet is empty.', 'error');
                return;
            }
            // Extract hyperlink targets from worksheet cells so we can
            // recover URLs that Excel stores as HYPERLINK() formulas.
            const hyperlinks = {};
            const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
            for (let R = range.s.r; R <= range.e.r; R++) {
                for (let C = range.s.c; C <= range.e.c; C++) {
                    const addr = XLSX.utils.encode_cell({ r: R, c: C });
                    const cell = ws[addr];
                    if (cell && cell.l && cell.l.Target) {
                        hyperlinks[addr] = cell.l.Target;
                    }
                }
            }
            const headers = raw[0].map((c, i) => (c != null && String(c).trim() !== '') ? String(c).trim() : `Column ${i + 1}`);
            const rows = raw.slice(1);
            excelSheetData = { headers, rows, hyperlinks };
            log(`Loaded Excel: ${rows.length} rows, columns: ${headers.join(', ')}`, 'info');
            openExcelImportModal();
        } catch (err) {
            log(`Excel error: ${err.message}`, 'error');
        }
    };
    reader.readAsArrayBuffer(file);
});

function getMissingRequiredMapping(mapping) {
    const labels = { url: 'URL', date: 'Date', amount: 'Amount', proofURL: 'Proof URL', equipment: 'Equipment' };
    return Object.keys(labels).filter(k => mapping[k] === '' || mapping[k] == null).map(k => labels[k]);
}

document.getElementById('excel-save-file').addEventListener('click', function () {
    const mapping = getExcelMapping();
    const missing = getMissingRequiredMapping(mapping);
    if (missing.length) {
        log('Map all required columns: ' + missing.join(', ') + '. Name is optional.', 'error');
        return;
    }
    const requests = buildRequestsFromExcel(mapping);
    if (requests.length === 0) {
        log('No rows with URL and Date. Map all required columns.', 'error');
        return;
    }
    fetch('/billing-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests })
    })
        .then(r => {
            if (r.status === 403) return parse403AndReject(r);
            return r.json();
        })
        .then(d => {
            if (d && d.error) throw new Error(d.error);
            log(d.message || `Saved ${requests.length} requests to billing file.`, 'success');
            closeExcelImportModal();
        })
        .catch(e => {
            log(`Save failed: ${e.message}`, 'error');
        });
});

document.getElementById('excel-download-json').addEventListener('click', function () {
    const mapping = getExcelMapping();
    const missing = getMissingRequiredMapping(mapping);
    if (missing.length) {
        log('Map all required columns: ' + missing.join(', ') + '. Name is optional.', 'error');
        return;
    }
    const requests = buildRequestsFromExcel(mapping);
    if (requests.length === 0) {
        log('No rows with URL and Date. Map all required columns.', 'error');
        return;
    }
    const blob = new Blob([JSON.stringify(requests, null, 4)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'billing_requests.json';
    a.click();
    URL.revokeObjectURL(a.href);
    log(`Downloaded billing_requests.json (${requests.length} items).`, 'success');
});

document.getElementById('excel-cancel').addEventListener('click', closeExcelImportModal);
document.getElementById('excel-import-modal').addEventListener('click', function (e) {
    if (e.target === this) closeExcelImportModal();
});
