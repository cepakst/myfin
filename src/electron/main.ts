import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { join } from 'node:path';

const DEFAULT_PORT = 5174;

if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

function configurePaths() {
  if (app.isPackaged) {
    // Data live in the OS user-data dir (Windows: %APPDATA%\myfin, macOS: ~/Library/Application Support/myfin),
    // the web UI is bundled inside the app archive.
    const userDir = app.getPath('userData');
    process.env.MYFIN_ROOT ??= userDir;
    process.env.MYFIN_DATA ??= join(userDir, 'data');
    process.env.MYFIN_EXPORTS ??= join(userDir, 'exports');
    process.env.MYFIN_WEB_DIST ??= join(app.getAppPath(), 'dist', 'web');
  }
  // Unpackaged: paths.ts resolves the project root (data/ and exports/ shared with start.bat / start.sh).
}

async function startServer(): Promise<string> {
  // Imported lazily so that paths.ts sees the environment configured above.
  const { createServer } = await import('../server/app.js');
  try {
    return await (await createServer()).start(DEFAULT_PORT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    // Another instance (e.g. start.bat / start.sh) holds the default port – use a free one.
    return await (await createServer()).start(0);
  }
}

async function createWindow(url: string) {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    title: 'My finance',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const external = (target: string) => !target.startsWith(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (external(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, target) => {
    if (external(target)) {
      ev.preventDefault();
      void shell.openExternal(target);
    }
  });
  win.on('closed', () => (win = null));
  await win.loadURL(url);
}

app.on('second-instance', () => {
  if (!win) {
    if (serverUrl) void createWindow(serverUrl);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
});

const isMac = process.platform === 'darwin';
let serverUrl: string | null = null;

// macOS convention: the app keeps running without windows until Cmd+Q.
app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('activate', () => {
  if (!win && serverUrl) void createWindow(serverUrl);
});

app.whenReady().then(async () => {
  // macOS needs an application menu, otherwise Cmd+C/V/Q and other standard shortcuts do not work.
  Menu.setApplicationMenu(
    isMac
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
      : null,
  );
  configurePaths();
  try {
    serverUrl = await startServer();
    await createWindow(serverUrl);
  } catch (e) {
    dialog.showErrorBox('My finance', `Server se nepodařilo spustit:\n${(e as Error).stack ?? e}`);
    app.quit();
  }
});
