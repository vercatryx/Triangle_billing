const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 3500;
let serverProcess = null;
let mainWindow = null;

/** Project root: when unpacked (dev) it's parent of electron/; when packaged it's resources/app (or app-server if using asar). */
function getServerRoot() {
    if (app.isPackaged) {
        const appDir = path.join(process.resourcesPath, 'app');
        if (fs.existsSync(path.join(appDir, 'src', 'server.js'))) return appDir;
        return path.join(process.resourcesPath, 'app-server');
    }
    return path.join(__dirname, '..');
}

/** Path to Node binary: in dev use system node; when packaged use embedded if present. */
function getNodePath() {
    if (app.isPackaged) {
        const nodeDir = path.join(process.resourcesPath, 'node');
        const nodePath = process.platform === 'win32'
            ? path.join(nodeDir, 'node.exe')
            : path.join(nodeDir, 'bin', 'node');
        if (fs.existsSync(nodePath)) return nodePath;
    }
    return 'node';
}

/** Path to server entry script. */
function getServerScriptPath() {
    return path.join(getServerRoot(), 'src', 'server.js');
}

/** Env for the server process (port, optional Playwright path and .env). */
function getServerEnv() {
    const env = { ...process.env, PORT: String(PORT) };
    env.DOTENV_CONFIG_PATH = getEnvPath();
    if (app.isPackaged) {
        const userData = app.getPath('userData');
        env.PLAYWRIGHT_BROWSERS_PATH = path.join(userData, 'playwright-browsers');
    }
    return env;
}

function startServer() {
    const serverRoot = getServerRoot();
    const nodePath = getNodePath();
    const serverScript = getServerScriptPath();
    const spawnEnv = getServerEnv();

    serverProcess = spawn(nodePath, [serverScript], {
        cwd: serverRoot,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', (data) => process.stdout.write(data));
    serverProcess.stderr.on('data', (data) => process.stderr.write(data));
    serverProcess.on('error', (err) => console.error('[Electron] Server spawn error:', err));
    serverProcess.on('exit', (code, signal) => {
        if (code !== null && code !== 0) console.error('[Electron] Server exited with code', code);
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
                if (Date.now() - start >= maxWaitMs) return reject(new Error('Server did not start in time'));
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

    // Open external links in system browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

ipcMain.handle('main:open-in-browser', () => {
    shell.openExternal(`http://127.0.0.1:${PORT}/`);
});

/** .env is shipped with the app (same folder as server). */
function getEnvPath() {
    return path.join(getServerRoot(), '.env');
}

/** When packaged, install Playwright Chromium to userData if not already present. */
function installPlaywrightIfNeeded() {
    if (!app.isPackaged) return Promise.resolve();
    const userData = app.getPath('userData');
    const browsersDir = path.join(userData, 'playwright-browsers');
    let hasChromium = false;
    try {
        if (fs.existsSync(browsersDir)) {
            hasChromium = fs.readdirSync(browsersDir).some(name => name.startsWith('chromium-'));
        }
    } catch (_) {}
    if (hasChromium) return Promise.resolve();
    const nodePath = getNodePath();
    const serverRoot = getServerRoot();
    const env = { ...getServerEnv(), PLAYWRIGHT_BROWSERS_PATH: browsersDir };
    const cliPath = path.join(serverRoot, 'node_modules', 'playwright', 'cli.js');
    if (!fs.existsSync(cliPath)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const child = spawn(nodePath, [cliPath, 'install', 'chromium'], {
            cwd: serverRoot,
            env,
            stdio: 'inherit'
        });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Playwright install failed'))));
    });
}

function startApp() {
    startServer();
    waitForServer().then(() => {
        createWindow();
    }).catch((err) => {
        console.error('[Electron] Failed to start server:', err.message);
        app.quit();
    });
}

app.whenReady().then(async () => {
    try {
        await installPlaywrightIfNeeded();
    } catch (e) {
        console.error('[Electron] Playwright install failed:', e.message);
    }
    startApp();
});

app.on('window-all-closed', () => {
    stopServer();
    app.quit();
});

app.on('before-quit', () => {
    stopServer();
});
