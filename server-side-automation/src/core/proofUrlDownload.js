/**
 * Resolve proof document URLs to local files for billing upload.
 * Supports:
 * - Firebase Storage (firebasestorage.googleapis.com) – download with GET
 * - Google Drive (drive.google.com/file/d/ID/view) – convert to export URL and download
 * - Direct file URLs (e.g. ending in .jpg, .png, .pdf) – can be used as-is or downloaded
 *
 * When a URL is not a "direct" file URL (or is Firebase/Drive), we download it first
 * and then the billing flow uses the local file path for upload.
 *
 * TLS verification is disabled for proof downloads so requests work through corporate
 * filters/proxies that do SSL inspection. Verbose logging is enabled for debugging.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const LOG_PREFIX = '[proofUrlDownload]';

// HTTPS agent with TLS verification turned off so filters/proxies don't break downloads.
function makeProofDownloadAgent() {
    const agent = new https.Agent({ rejectUnauthorized: false });
    try {
        console.log(`${LOG_PREFIX} HTTPS agent created: TLS certificate verification DISABLED (rejectUnauthorized=false).`);
    } catch (_) { /* avoid crashing if stdout is unavailable (e.g. packaged app on some Windows) */ }
    return agent;
}

const proofDownloadHttpsAgent = makeProofDownloadAgent();

const DIRECT_FILE_EXTENSIONS = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.heic', '.heif'
];

/**
 * @param {string} url
 * @returns {boolean} True if URL is Firebase Storage (circuit-prod or similar).
 */
function isFirebaseStorageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.trim();
    return u.includes('firebasestorage.googleapis.com') && u.includes('/o/');
}

/**
 * @param {string} url
 * @returns {boolean} True if URL is a Google Drive file view link.
 */
function isGoogleDriveUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.trim();
    return /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/.test(u) || u.includes('drive.google.com/file/d/');
}

/**
 * @param {string} url
 * @returns {boolean} True if URL path looks like a direct file (has a known file extension).
 */
function isDirectFileUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url.trim());
        const pathname = (parsed.pathname || '').toLowerCase();
        const withoutQuery = pathname.split('?')[0];
        return DIRECT_FILE_EXTENSIONS.some(ext => withoutQuery.endsWith(ext));
    } catch (_) {
        return false;
    }
}

/**
 * True if URL is from Scanovator dashboard (cross-origin from Unite; browser fetch can fail due to CORS).
 * @param {string} url
 * @returns {boolean}
 */
function isScanovatorDashboardUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.trim().toLowerCase().includes('dashboard.scanovator.com');
}

/**
 * Whether this URL must be downloaded first before the browser uploads it.
 * We always download first for any proof URL: avoids CORS, auth, and redirect issues when the
 * page would otherwise fetch the URL cross-origin. Firebase and Google Drive still get their
 * specific handling inside resolveProofUrl(); this just means "use server-side download, then place."
 * @param {string} url
 * @returns {boolean}
 */
function needsDownloadFirst(url) {
    return !!(url && url.trim());
}

/**
 * Extract Google Drive file ID from share URL.
 * @param {string} url e.g. https://drive.google.com/file/d/1ngD7teAr-kJsBUjLZbS61s5KG9RxQbjS/view
 * @returns {string|null}
 */
function getGoogleDriveFileId(url) {
    const m = String(url).match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
}

/**
 * Get a direct download URL for a Google Drive file (public or "anyone with link").
 * @param {string} shareUrl
 * @returns {string|null} Download URL or null if ID could not be extracted.
 */
function getGoogleDriveDownloadUrl(shareUrl) {
    const id = getGoogleDriveFileId(shareUrl);
    if (!id) return null;
    // Prefer usercontent endpoint; fallback to uc?export=download
    return `https://drive.usercontent.google.com/download?id=${id}&confirm=t`;
}

/**
 * Suggest filename from URL or content-type.
 * @param {string} url
 * @param {string} [contentType]
 * @returns {string}
 */
const MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'application/pdf': '.pdf'
};

const KNOWN_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg',
    '.heic', '.heif', '.pdf', '.doc', '.docx', '.xls', '.xlsx'
]);

function mimeToExt(contentType) {
    const mime = (contentType || '').split(';')[0].trim().toLowerCase();
    return MIME_TO_EXT[mime] || null;
}

function suggestFilename(url, contentType) {
    let base = '';
    try {
        const parsed = new URL(url);
        const pathname = (parsed.pathname || '').split('?')[0];
        base = path.basename(decodeURIComponent(pathname));
    } catch (_) {}

    const ctExt = mimeToExt(contentType);

    if (base) {
        const ext = path.extname(base).toLowerCase();
        if (KNOWN_EXTENSIONS.has(ext)) return base;
        // Name exists but has no/wrong extension — append the correct one from content-type
        if (ctExt) {
            const stem = ext ? base.slice(0, -ext.length) : base;
            return stem + ctExt;
        }
    }

    return `proof${ctExt || '.bin'}`;
}

/**
 * Build a clear error message for failed HTTP responses.
 * @param {string} url
 * @param {number} status
 * @param {object} [headers]
 * @param {Buffer|string} [body]
 * @returns {string}
 */
function downloadErrorReason(url, status, headers = {}, body) {
    const host = (() => { try { return new URL(url).host; } catch (_) { return url; } })();
    if (status === 401) return `401 Unauthorized — ${host} requires login. The link works in your browser because you're logged in; the server is not.`;
    if (status === 403) return `403 Forbidden — ${host} is blocking the server (no cookies/session). Open the link in your browser to confirm it works.`;
    if (status === 404) return `404 Not Found — file no longer exists at ${host}.`;
    if (status >= 500) return `${status} Server Error — ${host} is having issues; try again later.`;
    if (status >= 300 && status < 400) {
        const loc = headers['location'] || headers['Location'];
        const toLogin = loc && (/login|signin|auth|session/i.test(loc) || /dashboard\.scanovator\.com/.test(String(loc)));
        if (toLogin) return `${status} Redirect to login — ${host} requires an active session (works in browser, not from server).`;
        return `${status} Redirect — ${host} sent redirect; server cannot follow (link may require login).`;
    }
    return `${status} — ${host} returned an error (link may require login or be restricted).`;
}

/**
 * Download from Firebase Storage URL (public with ?alt=media).
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType?: string }>}
 */
async function downloadFirebase(url) {
    console.log(`${LOG_PREFIX} Firebase download starting: ${url.slice(0, 80)}${url.length > 80 ? '...' : ''}`);
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        maxRedirects: 5,
        timeout: 60000,
        validateStatus: () => true,
        httpsAgent: proofDownloadHttpsAgent
    });
    console.log(`${LOG_PREFIX} Firebase response: status=${res.status}, content-length=${res.headers['content-length'] || '(none)'}, content-type=${res.headers['content-type'] || '(none)'}`);
    if (res.status !== 200) {
        const body = Buffer.isBuffer(res.data) ? res.data.slice(0, 500).toString('utf8') : String(res.data).slice(0, 500);
        console.error(`${LOG_PREFIX} Firebase download failed: status=${res.status}, body snippet: ${body.slice(0, 200)}`);
        throw new Error(downloadErrorReason(url, res.status, res.headers, body));
    }
    const buffer = Buffer.from(res.data);
    const contentType = res.headers['content-type'];
    const filename = suggestFilename(url, contentType);
    console.log(`${LOG_PREFIX} Firebase download OK: filename=${filename}, size=${buffer.length} bytes`);
    return { buffer, filename, contentType };
}

/**
 * Download from Google Drive (public or "anyone with link").
 * @param {string} shareUrl
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType?: string }>}
 */
async function downloadGoogleDrive(shareUrl) {
    const downloadUrl = getGoogleDriveDownloadUrl(shareUrl);
    if (!downloadUrl) {
        console.error(`${LOG_PREFIX} Google Drive: could not extract file ID from ${shareUrl.slice(0, 60)}...`);
        throw new Error('Invalid Google Drive URL: could not extract file ID');
    }
    console.log(`${LOG_PREFIX} Google Drive download starting: shareUrl=${shareUrl.slice(0, 60)}..., downloadUrl=${downloadUrl.slice(0, 60)}...`);

    const res = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 10,
        timeout: 90000,
        validateStatus: () => true,
        httpsAgent: proofDownloadHttpsAgent,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    console.log(`${LOG_PREFIX} Google Drive response: status=${res.status}, content-type=${res.headers['content-type'] || '(none)'}, body length=${res.data ? res.data.length : 0}`);

    if (res.status !== 200) {
        console.error(`${LOG_PREFIX} Google Drive download failed: status=${res.status}`);
        throw new Error(downloadErrorReason(shareUrl, res.status, res.headers));
    }

    const buffer = Buffer.from(res.data);
    const contentType = res.headers['content-type'] || '';
    let filename = suggestFilename(shareUrl, contentType);

    // If response is HTML, Drive may have returned a virus-scan warning page
    if (contentType.includes('text/html') && buffer.length < 100000) {
        console.log(`${LOG_PREFIX} Google Drive returned HTML (virus-scan page?); attempting confirm URL...`);
        const html = buffer.toString('utf8');
        const confirmMatch = html.match(/confirm=([^&"\s]+)/);
        if (confirmMatch) {
            const id = getGoogleDriveFileId(shareUrl);
            const confirmUrl = `https://drive.usercontent.google.com/download?id=${id}&confirm=${confirmMatch[1]}`;
            const res2 = await axios.get(confirmUrl, {
                responseType: 'arraybuffer',
                maxRedirects: 10,
                timeout: 90000,
                httpsAgent: proofDownloadHttpsAgent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            console.log(`${LOG_PREFIX} Google Drive confirm response: status=${res2.status}, content-type=${res2.headers['content-type'] || '(none)'}`);
            const buf2 = Buffer.from(res2.data);
            if (!res2.headers['content-type']?.includes('text/html')) {
                console.log(`${LOG_PREFIX} Google Drive download OK (after confirm): size=${buf2.length} bytes`);
                return {
                    buffer: buf2,
                    filename: suggestFilename(shareUrl, res2.headers['content-type']),
                    contentType: res2.headers['content-type']
                };
            }
        }
        console.error(`${LOG_PREFIX} Google Drive: still got HTML after confirm; link may require login.`);
        throw new Error('Google Drive returned an HTML page instead of file (link may require login or be restricted)');
    }

    const contentDisp = res.headers['content-disposition'];
    if (contentDisp && /filename\*?=(?:UTF-8'')?([^;\s]+)/i.test(contentDisp)) {
        const m = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^"'\s;]+)["']?/i);
        if (m && m[1]) filename = decodeURIComponent(m[1].trim());
    }

    console.log(`${LOG_PREFIX} Google Drive download OK: filename=${filename}, size=${buffer.length} bytes`);
    return { buffer, filename, contentType };
}

/**
 * Download a generic URL (direct file).
 * For Scanovator dashboard we send browser-like headers to reduce 403 blocks.
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType?: string }>}
 */
async function downloadDirect(url) {
    const isScanovator = isScanovatorDashboardUrl(url);
    console.log(`${LOG_PREFIX} Direct download starting: url=${url.slice(0, 80)}..., isScanovator=${isScanovator}`);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': isScanovator ? 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' : '*/*'
    };
    if (isScanovator) {
        headers['Referer'] = 'https://dashboard.scanovator.com/';
        headers['Origin'] = 'https://dashboard.scanovator.com';
    }
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        maxRedirects: 10,
        timeout: 60000,
        validateStatus: () => true,
        httpsAgent: proofDownloadHttpsAgent,
        headers
    });
    console.log(`${LOG_PREFIX} Direct response: status=${res.status}, content-type=${res.headers['content-type'] || '(none)'}, body length=${res.data ? res.data.length : 0}`);
    if (res.status !== 200) {
        console.error(`${LOG_PREFIX} Direct download failed: status=${res.status}`);
        throw new Error(downloadErrorReason(url, res.status, res.headers));
    }
    const buffer = Buffer.from(res.data);
    const contentType = res.headers['content-type'];
    const filename = suggestFilename(url, contentType);
    console.log(`${LOG_PREFIX} Direct download OK: filename=${filename}, size=${buffer.length} bytes`);
    return { buffer, filename, contentType };
}

/**
 * Resolve a proof URL to a buffer and filename (downloads if needed).
 * @param {string} url – Firebase, Google Drive, or direct file URL
 * @returns {Promise<{ buffer: Buffer, filename: string, contentType?: string }>}
 */
async function resolveProofUrl(url) {
    const u = (url || '').trim();
    console.log(`${LOG_PREFIX} resolveProofUrl called: url=${u.slice(0, 100)}${u.length > 100 ? '...' : ''}`);
    if (!u) {
        console.error(`${LOG_PREFIX} resolveProofUrl: empty URL`);
        throw new Error('Empty proof URL');
    }

    const isFirebase = isFirebaseStorageUrl(u);
    const isDrive = isGoogleDriveUrl(u);
    console.log(`${LOG_PREFIX} URL type: isFirebase=${isFirebase}, isGoogleDrive=${isDrive}, will use ${isFirebase ? 'Firebase' : isDrive ? 'Google Drive' : 'direct'} handler`);

    try {
        if (isFirebase) {
            const out = await downloadFirebase(u);
            console.log(`${LOG_PREFIX} resolveProofUrl done (Firebase): filename=${out.filename}, size=${out.buffer.length}`);
            return out;
        }
        if (isDrive) {
            const out = await downloadGoogleDrive(u);
            console.log(`${LOG_PREFIX} resolveProofUrl done (Google Drive): filename=${out.filename}, size=${out.buffer.length}`);
            return out;
        }
        const out = await downloadDirect(u);
        console.log(`${LOG_PREFIX} resolveProofUrl done (direct): filename=${out.filename}, size=${out.buffer.length}`);
        return out;
    } catch (e) {
        console.error(`${LOG_PREFIX} resolveProofUrl error: code=${e.code || '(none)'}, message=${e.message}`);
        if (e.response !== undefined) {
            if (!e.message || e.message === 'Request failed with status code ' + e.response.status) {
                throw new Error(downloadErrorReason(u, e.response.status, e.response.headers));
            }
        }
        if (e.code === 'ECONNABORTED' || (e.message && e.message.includes('timeout'))) {
            throw new Error('Request timed out — the server took too long to respond (link may be slow or require login).');
        }
        if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED') {
            throw new Error(`Network error (${e.code}) — could not reach the server. Check the URL and your connection.`);
        }
        const certErr = e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || e.code === 'CERT_HAS_EXPIRED' || (e.message && /certificate|self.signed|unable to verify/i.test(e.message));
        if (certErr) {
            console.error(`${LOG_PREFIX} Certificate-related error (TLS verification is already disabled; check proxy/filter): ${e.message}`);
            throw new Error(`Certificate error: ${e.message}`);
        }
        throw e;
    }
}

/**
 * Detect the real file type from the first bytes of the file (magic bytes).
 * Returns { mime, ext } or null if unrecognized.
 */
function detectContentType(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
        return { mime: 'image/jpeg', ext: '.jpg' };
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
        return { mime: 'image/png', ext: '.png' };
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
        return { mime: 'image/gif', ext: '.gif' };
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
        return { mime: 'application/pdf', ext: '.pdf' };
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
        return { mime: 'image/webp', ext: '.webp' };
    if (buf[0] === 0x42 && buf[1] === 0x4D)
        return { mime: 'image/bmp', ext: '.bmp' };
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
        (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A))
        return { mime: 'image/tiff', ext: '.tiff' };
    return null;
}

/**
 * Download a proof URL to a temp file and return the path.
 * Caller should unlink the file when done if desired.
 * @param {string} url
 * @param {string} [tempDir] – optional dir for temp file; default os.tmpdir()
 * @returns {Promise<{ path: string, filename: string, contentType?: string }>}
 */
async function downloadProofUrlToTemp(url, tempDir = os.tmpdir()) {
    console.log(`${LOG_PREFIX} downloadProofUrlToTemp: url=${url.slice(0, 80)}..., tempDir=${tempDir}`);
    const { buffer, filename, contentType } = await resolveProofUrl(url);

    // Trust magic bytes over the HTTP Content-Type header — servers frequently
    // lie (e.g. application/octet-stream for a JPEG, or image/jpeg for a PDF).
    const detected = detectContentType(buffer);
    const realMime = detected ? detected.mime : contentType;
    if (detected && detected.mime !== (contentType || '').split(';')[0].trim().toLowerCase()) {
        console.log(`${LOG_PREFIX} Content-type mismatch: HTTP says "${contentType}", magic bytes say "${detected.mime}" — using magic bytes`);
    }

    // Re-derive filename with the correct extension from real content type
    const realFilename = suggestFilename(url, realMime);
    const safeName = (realFilename || 'proof').replace(/[^a-zA-Z0-9._-]/g, '_');
    const prefix = 'billing_proof_';
    const filePath = path.join(tempDir, prefix + Date.now() + '_' + safeName);
    fs.writeFileSync(filePath, buffer, 'binary');
    console.log(`${LOG_PREFIX} downloadProofUrlToTemp: wrote file path=${filePath}, size=${buffer.length} bytes, type=${realMime}`);
    return { path: filePath, filename: safeName, contentType: realMime };
}

module.exports = {
    isFirebaseStorageUrl,
    isGoogleDriveUrl,
    isScanovatorDashboardUrl,
    isDirectFileUrl,
    needsDownloadFirst,
    getGoogleDriveFileId,
    getGoogleDriveDownloadUrl,
    resolveProofUrl,
    downloadProofUrlToTemp,
    suggestFilename
};
