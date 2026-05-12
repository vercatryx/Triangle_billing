/**
 * Convert PDF files to JPEG images using pdfjs-dist + node-canvas.
 * Each PDF page becomes a separate JPEG file.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PREFIX = '[pdfToImage]';

let _pdfjsLib = null;
let _createCanvas = null;
let _initError = null;

function ensureDeps() {
    if (_initError) throw _initError;
    if (_pdfjsLib && _createCanvas) return;
    try {
        _pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        _pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    } catch (e) {
        _initError = new Error(`pdfjs-dist not available: ${e.message}`);
        throw _initError;
    }
    try {
        _createCanvas = require('canvas').createCanvas;
    } catch (e) {
        _initError = new Error(`canvas not available: ${e.message}`);
        throw _initError;
    }
}

class NodeCanvasFactory {
    create(width, height) {
        const canvas = _createCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
    }
    reset(pair, width, height) {
        pair.canvas.width = width;
        pair.canvas.height = height;
    }
    destroy(pair) {
        pair.canvas.width = 0;
        pair.canvas.height = 0;
    }
}

/**
 * Render a single PDF page to a JPEG buffer.
 */
async function renderPage(doc, pageNum, scale, quality) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const factory = new NodeCanvasFactory();
    const { canvas, context } = factory.create(viewport.width, viewport.height);

    await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;
    const buf = canvas.toBuffer('image/jpeg', { quality });
    page.cleanup();
    return buf;
}

/**
 * Convert a PDF buffer to an array of JPEG buffers (one per page).
 * @param {Buffer} pdfBuffer
 * @param {{ scale?: number, quality?: number }} opts
 * @returns {Promise<Buffer[]>}
 */
async function convertPdfBufferToImages(pdfBuffer, { scale = 2.0, quality = 0.85 } = {}) {
    ensureDeps();
    const doc = await _pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer),
        verbosity: 0
    }).promise;

    console.log(`${LOG_PREFIX} PDF loaded: ${doc.numPages} page(s), ${pdfBuffer.length} bytes`);
    const images = [];
    for (let i = 1; i <= doc.numPages; i++) {
        images.push(await renderPage(doc, i, scale, quality));
    }
    doc.destroy();
    return images;
}

/**
 * Convert a PDF file on disk to JPEG image files.
 * @param {string} pdfPath - path to the PDF temp file
 * @param {string} [outputDir] - directory for output images
 * @returns {Promise<Array<{ path: string, filename: string, contentType: string }>>}
 */
async function convertPdfFileToImages(pdfPath, outputDir = os.tmpdir()) {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const baseName = path.basename(pdfPath, path.extname(pdfPath));

    console.log(`${LOG_PREFIX} Converting ${pdfPath} (${pdfBuffer.length} bytes)`);
    const imageBuffers = await convertPdfBufferToImages(pdfBuffer);

    const results = [];
    for (let i = 0; i < imageBuffers.length; i++) {
        const safeName = `${baseName}_p${i + 1}.jpg`.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(outputDir, safeName);
        fs.writeFileSync(filePath, imageBuffers[i]);
        console.log(`${LOG_PREFIX} Page ${i + 1}: ${filePath} (${imageBuffers[i].length} bytes)`);
        results.push({ path: filePath, filename: safeName, contentType: 'image/jpeg' });
    }
    return results;
}

/**
 * Check whether a downloaded proof looks like a PDF.
 */
function isPdfFile(meta) {
    if (!meta) return false;
    if (meta.contentType && meta.contentType.toLowerCase().includes('pdf')) return true;
    if (meta.filename && meta.filename.toLowerCase().endsWith('.pdf')) return true;
    if (meta.path && meta.path.toLowerCase().endsWith('.pdf')) return true;
    return false;
}

module.exports = { convertPdfBufferToImages, convertPdfFileToImages, isPdfFile };
