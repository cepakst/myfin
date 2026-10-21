import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { join } from 'node:path';

const DEFAULT_PORT = 5174;

if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;

function configurePaths() {
  if (app.isPackaged) {
    // Data live in %APPDATA%\My finance, the web UI is bundled inside the app archive.
    const userDir = app.getPath('userData');
    process.env.MYFIN_ROOT ??= userDir;
    process.env.MYFIN_DATA ??= join(userDir, 'data');
    process.env.MYFIN_EXPORTS ??= join(userDir, 'exports');
    process.env.MYFIN_WEB_DIST ??= join(app.getAppPath(), 'dist', 'web');
  }
  // Unpackaged: paths.ts resolves the project root (data/ and exports/ shared with start.bat).
}

async function startServer(): Promise<string> {
  // Imported lazily so that paths.ts sees the environment configured above.
  const { createServer } = await import('../server/app.js');
  try {
    return await (await createServer()).start(DEFAULT_PORT);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    // Another instance (e.g. start.bat) holds the default port – use a free one.
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
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  configurePaths();
  try {
    await createWindow(await startServer());
  } catch (e) {
    dialog.showErrorBox('My finance', `Server se nepodařilo spustit:\n${(e as Error).stack ?? e}`);
    app.quit();
  }
});
