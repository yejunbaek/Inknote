const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ---- Where notebooks live -------------------------------------------------
// Kept in the OS "userData" dir so it survives reinstalls and is per-user.
// On Windows this is roughly: C:\Users\<you>\AppData\Roaming\inknote\
const DATA_DIR = path.join(app.getPath('userData'), 'notebooks');
const DATA_FILE = path.join(DATA_DIR, 'notebook.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#faf9f7',
    title: 'InkNote',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  ensureDataDir();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: storage ---------------------------------------------------------

ipcMain.handle('store:load', async () => {
  try {
    ensureDataDir();
    if (!fs.existsSync(DATA_FILE)) return null;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load notebook:', err);
    return null;
  }
});

ipcMain.handle('store:save', async (_evt, data) => {
  try {
    ensureDataDir();
    // Atomic-ish write: write to temp then rename, so a crash mid-write
    // can never leave a truncated notebook.json behind.
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
    return { ok: true, path: DATA_FILE };
  } catch (err) {
    console.error('Failed to save notebook:', err);
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('store:path', async () => DATA_FILE);

ipcMain.handle('store:export', async (_evt, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export notebook',
    defaultPath: 'inknote-backup.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return { ok: true, path: filePath };
});

ipcMain.handle('store:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import notebook',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  try {
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
