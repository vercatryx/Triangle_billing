const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

let PORT = 3500;
let serverProcess = null;
let mainWindow = null;
let serverStderr = '';

function getServerRoot() {
    if (app.isPackaged) {
        const appDir = path.join(process.resourcesPath, 'app');
        if (fs.existsSync(path.join(appDir, 'src', 'server.js'))) return appDir;
        return path.join(process.resourcesPath, 'app-server');
    }
    return path.join(__dirname, '..');
}

function getConfigDir() {
    if (app.isPackaged) return app.getPath('userData');
    return getServerRoot();
}

function getEnvPath() {
    return path.join(getConfigDir(), '.env');
}

function ensureUserEnvFile() {
    if (!app.isPackaged) return;
    const userEnvPath = getEnvPath();
    if (fs.existsSync(userEnvPath)) return;
    const configDir = getConfigDir();
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const bundledPath = path.join(getServerRoot(), '.env');
    const fallbackPath = path.join(getServerRoot(), '.env.example');
    const src = fs.existsSync(bundledPath) ? bundledPath : fallbackPath;
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, userEnvPath);
        console.log('[Electron] Created editable config at:', userEnvPath);
    }
}

function getNodePath() {
    if (app.isPackaged) {
        const nodeDir = path.join(process.resourcesPath, 'node');
        const nodePath = process.platform === 'win32'
            ? path.join(nodeDir, 'node.exe')
            : path.join(nodeDir, 'bin', 'node');
        if (fs.existsSync(nodePath)) return nodePath;
    }
    return process.execPath;
}

function getServerScriptPath() {
    return path.join(getServerRoot(), 'src', 'server.js');
}

function getServerEnv() {
    const env = { ...process.env, PORT: String(PORT) };
    env.DOTENV_CONFIG_PATH = getEnvPath();
    env.ELECTRON_RUN_AS_NODE = '1';
    if (app.isPackaged) {
        env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'playwright-browsers');
    }
    return env;
}

function startServer() {
    const serverRoot = getServerRoot();
    const nodePath = getNodePath();
    const serverScript = getServerScriptPath();
    const spawnEnv = getServerEnv();

    serverStderr = '';

    serverProcess = spawn(nodePath, [serverScript], {
        cwd: serverRoot,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', (data) => process.stdout.write(data));
    serverProcess.stderr.on('data', (data) => {
        process.stderr.write(data);
        serverStderr += data.toString();
        if (serverStderr.length > 4000) serverStderr = serverStderr.slice(-4000);
    });
    serverProcess.on('error', (err) => {
        console.error('[Electron] Server spawn error:', err);
        serverStderr += '\nSpawn error: ' + err.message;
    });
    serverProcess.on('exit', (code, signal) => {
        if (code !== null && code !== 0) {
            console.error('[Electron] Server exited with code', code);
            serverStderr += '\nServer exited with code ' + code;
        }
        serverProcess = null;
    });
}

function stopServer() {
    if (serverProcess && serverProcess.kill) {
        serverProcess.kill('SIGTERM');
        serverProcess = null;
    }
}

function waitForServer(maxWaitMs = 15000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        function tryOnce() {
            const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
                res.resume();
                resolve();
            });
            req.on('error', () => {
                if (Date.now() - start >= maxWaitMs) return reject(new Error('Server did not respond in time'));
                setTimeout(tryOnce, 300);
            });
        }
        tryOnce();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Billing Automation',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-main.js')
        }
    });

    mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
    mainWindow.on('closed', () => { mainWindow = null; });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    const appOrigin = `http://127.0.0.1:${PORT}`;
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(appOrigin)) {
            e.preventDefault();
            shell.openExternal(url);
        }
    });
}

function createErrorWindow(message) {
    const errWin = new BrowserWindow({
        width: 600,
        height: 460,
        title: 'Billing Automation - Error',
        show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    errWin.setMenuBarVisibility(false);
    const safe = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:sans-serif;padding:16px;background:#1e1e1e;color:#eee;font-size:13px;}
h2{margin:0 0 8px;} pre{background:#333;padding:10px;border-radius:6px;overflow:auto;font-size:11px;margin:8px 0;max-height:250px;white-space:pre-wrap;word-break:break-all;}</style></head>
<body><h2>Could not start</h2>
<pre>${safe(message)}</pre>
<p>If this keeps happening, check:</p>
<ul style="font-size:12px;line-height:1.5;">
<li>Is port ${PORT} already in use? Change PORT in .env and restart.</li>
<li>Is a firewall or antivirus blocking Node?</li>
<li>Run the app from a terminal to see the full error:<br><code style="background:#333;padding:2px 6px;border-radius:3px;">node src/server.js</code></li>
</ul></body></html>`;
    errWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    errWin.on('closed', () => app.quit());
}

ipcMain.handle('main:open-in-browser', () => {
    shell.openExternal(`http://127.0.0.1:${PORT}/`);
});

ipcMain.handle('main:open-config-folder', () => {
    const dir = getConfigDir();
    shell.openPath(dir).then((err) => {
        if (err) console.error('[Electron] openPath failed:', err);
    });
});

ipcMain.handle('main:open-env-file', () => {
    const envPath = getEnvPath();
    if (fs.existsSync(envPath)) {
        return shell.openPath(envPath).then((err) => {
            if (err) {
                console.error('[Electron] openPath .env failed:', err);
                shell.openPath(getConfigDir());
            }
            return { opened: !err };
        });
    }
    shell.openPath(getConfigDir());
    return Promise.resolve({ opened: false, folderOnly: true });
});

ipcMain.handle('main:print', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && win.webContents) win.webContents.print({ silent: false });
});

ipcMain.handle('main:print-to-pdf', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || !win.webContents) return { ok: false, error: 'No window' };
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: 'Save as PDF',
        defaultPath: `billing-${new Date().toISOString().slice(0, 10)}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        const data = await win.webContents.printToPDF({
            printBackground: true,
            margins: { marginType: 'default' }
        });
        fs.writeFileSync(filePath, data);
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('main:save-pdf', async (event, base64, defaultFileName) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { ok: false, error: 'No window' };
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: 'Export queue as PDF',
        defaultPath: defaultFileName || `billing-queue-${new Date().toISOString().slice(0, 10)}.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        const buf = Buffer.from(base64, 'base64');
        fs.writeFileSync(filePath, buf);
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('main:save-excel', async (event, base64, defaultFileName) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { ok: false, error: 'No window' };
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: 'Export queue as Excel',
        defaultPath: defaultFileName || `billing-queue-${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        const buf = Buffer.from(base64, 'base64');
        fs.writeFileSync(filePath, buf);
        return { ok: true, path: filePath };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

function startApp() {
    startServer();
    waitForServer(15000)
        .then(() => createWindow())
        .catch((err) => {
            console.error('[Electron] Failed to start server:', err.message);
            let detail = err.message || 'Server did not start in time.';
            if (serverStderr && serverStderr.trim()) {
                detail += '\n\nServer output:\n' + serverStderr.trim().slice(-2000);
            }
            createErrorWindow(detail);
        });
}

app.whenReady().then(() => {
    ensureUserEnvFile();
    const envPath = getEnvPath();
    require('dotenv').config({ path: envPath });
    PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3500;
    if (!Number.isFinite(PORT) || PORT <= 0) PORT = 3500;
    startApp();
});

app.on('window-all-closed', () => {
    stopServer();
    app.quit();
});

app.on('before-quit', () => {
    stopServer();
});
