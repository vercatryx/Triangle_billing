/**
 * Test script: download proof files from Firebase Storage and Google Drive URLs.
 * Run from server-side-automation: node scripts/test-download-proof-urls.js
 *
 * Usage:
 *   node scripts/test-download-proof-urls.js
 *   node scripts/test-download-proof-urls.js "https://your-firebase-url.jpg?alt=media"
 *   node scripts/test-download-proof-urls.js "https://drive.google.com/file/d/ID/view"
 */

const path = require('path');
const fs = require('fs');

// Load module from src/core (run from server-side-automation)
const proofUrlDownload = require(path.join(__dirname, '..', 'src', 'core', 'proofUrlDownload.js'));

const TEST_URLS = {
    firebase: 'https://firebasestorage.googleapis.com/v0/b/circuit-prod.appspot.com/o/teams%2FVHEQrJE8OoL2ypU7PbjW%2Froutes%2FzAdqrqcuwlSrNEn4RdQx%2Fstops%2F7xFGEJNRnypoKeg2skUb%2Fproof_0-2026_03_04_12_5758_6c24.jpg?alt=media',
    drive: 'https://drive.google.com/file/d/1ngD7teAr-kJsBUjLZbS61s5KG9RxQbjS/view'
};

async function main() {
    const outDir = path.join(__dirname, '..', 'test-output');
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    console.log('Output directory:', outDir);

    const urlsToTest = process.argv.slice(2).length
        ? process.argv.slice(2)
        : [TEST_URLS.firebase, TEST_URLS.drive];

    for (const url of urlsToTest) {
        console.log('\n--- Testing URL ---');
        console.log(url);
        console.log('  isFirebaseStorageUrl:', proofUrlDownload.isFirebaseStorageUrl(url));
        console.log('  isGoogleDriveUrl:', proofUrlDownload.isGoogleDriveUrl(url));
        console.log('  isDirectFileUrl:', proofUrlDownload.isDirectFileUrl(url));
        console.log('  needsDownloadFirst:', proofUrlDownload.needsDownloadFirst(url));

        try {
            const { buffer, filename, contentType } = await proofUrlDownload.resolveProofUrl(url);
            console.log('  Downloaded:', buffer.length, 'bytes, filename:', filename, 'type:', contentType || 'unknown');
            const outPath = path.join(outDir, filename);
            fs.writeFileSync(outPath, buffer, 'binary');
            console.log('  Saved to:', outPath);
        } catch (err) {
            console.error('  ERROR:', err.message);
        }
    }

    console.log('\nDone.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
