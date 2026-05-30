const { app, BrowserWindow, ipcMain, dialog, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Build a simple programmatic icon from the SVG (avoids binary .ico/.png requirement)
function buildIcon() {
  try {
    const svgPath = path.join(__dirname, 'assets', 'icon.svg');
    if (fs.existsSync(svgPath)) {
      return nativeImage.createFromPath(svgPath);
    }
  } catch (_) {}
  return undefined;
}

let mainWindow;

function createWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: isDark ? '#1e1e1e' : '#ffffff',
    icon: buildIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
    show: false,
    titleBarStyle: 'default',
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';  // follow OS dark/light setting
  try { require('./src/queryStore').cleanupLegacyAutosave(); } catch (_) {}
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try { require('./src/dbManager').closeAll(); } catch (_) {}
  if (process.platform !== 'darwin') app.quit();
});

// ── DB handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('db:save-connection', (_, config) =>
  require('./src/queryStore').saveConnection(config));

ipcMain.handle('db:load-connections', () =>
  require('./src/queryStore').loadConnections());

ipcMain.handle('db:delete-connection', (_, id) =>
  require('./src/queryStore').deleteConnection(id));

ipcMain.handle('db:test-connection', (_, config) =>
  require('./src/dbManager').testConnection(config));

ipcMain.handle('db:connect', async (_, id) => {
  const conns = require('./src/queryStore').loadConnections();
  const cfg = conns.find(c => c.id === id);
  if (!cfg) throw new Error('Connection not found');
  return require('./src/dbManager').connect(id, cfg);
});

ipcMain.handle('db:disconnect', (_, id) =>
  require('./src/dbManager').disconnect(id));

ipcMain.handle('db:execute', (_, connectionId, sql) =>
  require('./src/dbManager').execute(connectionId, sql));

// ── Query store handlers ──────────────────────────────────────────────────────

ipcMain.handle('query:save', (_, name, connectionId, content) =>
  require('./src/queryStore').saveQuery(name, connectionId, content));

ipcMain.handle('query:load', (_, name, connectionId) =>
  require('./src/queryStore').loadQuery(name, connectionId));

ipcMain.handle('query:list', (_, connectionId) =>
  require('./src/queryStore').listQueries(connectionId));

ipcMain.handle('query:delete', (_, name, connectionId) =>
  require('./src/queryStore').deleteQuery(name, connectionId));

ipcMain.handle('session:save', (_, session) =>
  require('./src/queryStore').saveSession(session));

ipcMain.handle('session:load', () =>
  require('./src/queryStore').loadSession());

// ── File dialog handler ───────────────────────────────────────────────────────

ipcMain.handle('dialog:save', async (_, defaultName, content) => {
  const ext = path.extname(defaultName).slice(1) || 'txt';
  const filterMap = {
    sql: { name: 'SQL Files', extensions: ['sql'] },
    csv: { name: 'CSV Files', extensions: ['csv'] },
  };
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [filterMap[ext] || { name: 'All Files', extensions: ['*'] }],
  });
  if (filePath) {
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }
  return null;
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:is-dark',  () => nativeTheme.shouldUseDarkColors);
