const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---- Where notebooks live -------------------------------------------------
// Pinned explicitly rather than left to Electron's default. The default is
// derived from the app's name, which differs between a dev run ("inknote")
// and a packaged build ("InkNote") — that would quietly give you two separate
// sets of notes depending on how you launched. One fixed path, always.
app.setName('InkNote');
app.setPath('userData', path.join(app.getPath('appData'), 'inknote'));

// On Windows this is: C:\Users\<you>\AppData\Roaming\inknote\
const DATA_DIR = path.join(app.getPath('userData'), 'notebooks');
const DATA_FILE = path.join(DATA_DIR, 'notebook.json');
const IMG_DIR = path.join(app.getPath('userData'), 'images');

function ensureDirs() {
  for (const d of [DATA_DIR, IMG_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// Images are written to disk and referenced by URL rather than inlined as
// data: URIs — a handful of pasted screenshots would otherwise turn
// notebook.json into a multi-megabyte file that has to be re-parsed and
// re-serialised on every autosave.
protocol.registerSchemesAsPrivileged([{
  scheme: 'inknote-img',
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

let win = null;

// Groups the window under its own taskbar icon on Windows instead of
// inheriting Electron's default identity.
if (process.platform === 'win32') app.setAppUserModelId('com.inknote.desktop');

// Two copies of the app would autosave over each other's notebook, so a
// second launch just focuses the window that's already open.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#faf9f7',
    title: 'InkNote',
    icon: path.join(__dirname, 'build', 'icon.ico'),
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
  ensureDirs();

  // inknote-img://local/<file>  ->  <userData>/images/<file>
  protocol.handle('inknote-img', (req) => {
    try {
      const name = path.basename(new URL(req.url).pathname);
      const file = path.join(IMG_DIR, name);
      // basename() above already strips traversal, but re-check the resolved
      // path so a crafted name can never escape the images directory.
      if (!file.startsWith(IMG_DIR)) return new Response('', { status: 403 });
      if (!fs.existsSync(file)) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch (err) {
      return new Response('', { status: 400 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: notebook storage ------------------------------------------------

ipcMain.handle('store:load', async () => {
  try {
    ensureDirs();
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
    ensureDirs();
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

// ---- IPC: images ----------------------------------------------------------

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
};

ipcMain.handle('image:save', async (_evt, dataUrl) => {
  try {
    ensureDirs();
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) return { ok: false, error: 'Not a base64 data URL' };
    const ext = MIME_EXT[m[1].toLowerCase()];
    if (!ext) return { ok: false, error: 'Unsupported image type: ' + m[1] };

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 25 * 1024 * 1024) return { ok: false, error: 'Image too large' };

    const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(IMG_DIR, name), buf);
    return { ok: true, url: `inknote-img://local/${name}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Called when an image item is deleted. Best-effort: a failure here just
// leaves an orphaned file, which is harmless.
ipcMain.handle('image:delete', async (_evt, url) => {
  try {
    const name = path.basename(new URL(url).pathname);
    const file = path.join(IMG_DIR, name);
    if (file.startsWith(IMG_DIR) && fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
});

// Drag-and-drop gives us a real path; read it here so the renderer never
// needs filesystem access.
ipcMain.handle('image:readFile', async (_evt, filePath) => {
  try {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = Object.keys(MIME_EXT).find(k => MIME_EXT[k] === (ext === 'jpeg' ? 'jpg' : ext));
    if (!mime) return { ok: false, error: 'Unsupported image type' };
    const buf = fs.readFileSync(filePath);
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
