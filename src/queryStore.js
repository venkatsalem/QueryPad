const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

function encryptPassword(plain) {
  if (!plain) return plain;
  if (!safeStorage.isEncryptionAvailable()) return plain;
  return safeStorage.encryptString(plain).toString('base64');
}

function decryptPassword(stored) {
  if (!stored) return stored;
  if (!safeStorage.isEncryptionAvailable()) return stored;
  try {
    const buf = Buffer.from(stored, 'base64');
    return safeStorage.decryptString(buf);
  } catch (_) {
    return stored;
  }
}

function dataDir() {
  const d = path.join(app.getPath('userData'), 'QueryPad');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function safeWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function connectionsFile() { return path.join(dataDir(), 'connections.json'); }

function read(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('Failed to read', file, e); return []; }
}

// ── connections ───────────────────────────────────────────────────────────────

function loadConnections() {
  return read(connectionsFile()).map(c => ({ ...c, password: decryptPassword(c.password) }));
}

function saveConnection(cfg) {
  const raw = read(connectionsFile());
  if (!cfg.id) cfg.id = uuidv4();
  const toStore = { ...cfg, password: encryptPassword(cfg.password) };
  const idx = raw.findIndex(c => c.id === cfg.id);
  if (idx >= 0) raw[idx] = toStore; else raw.push(toStore);
  safeWrite(connectionsFile(), JSON.stringify(raw, null, 2));
  return cfg;
}

function deleteConnection(id) {
  const raw = read(connectionsFile()).filter(c => c.id !== id);
  safeWrite(connectionsFile(), JSON.stringify(raw, null, 2));
  return true;
}

// ── queries ───────────────────────────────────────────────────────────────────

function queriesDir(connectionId) {
  const d = path.join(dataDir(), 'queries', connectionId || '_unsaved');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function saveQuery(name, connectionId, content) {
  safeWrite(path.join(queriesDir(connectionId), `${name}.sql`), content);
  return true;
}

function loadQuery(name, connectionId) {
  const f = path.join(queriesDir(connectionId), `${name}.sql`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function listQueries(connectionId) {
  const d = queriesDir(connectionId);
  return fs.readdirSync(d).filter(f => f.endsWith('.sql')).map(f => f.replace('.sql', ''));
}

function deleteQuery(name, connectionId) {
  const f = path.join(queriesDir(connectionId), `${name}.sql`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return true;
}

// ── session (open tabs) ─────────────────────────────────────────────────────
// The whole editor session — all open tabs + the active tab — is persisted to a
// SINGLE file that is overwritten on each save. This replaces the old per-tab
// `<tabId>.sql` autosave scheme, which leaked a new file on every launch because
// tab IDs were regenerated each time and never cleaned up or restored.

function sessionFile() { return path.join(dataDir(), 'session.json'); }

function saveSession(session) {
  safeWrite(sessionFile(), JSON.stringify(session, null, 2));
  return true;
}

function loadSession() {
  const f = sessionFile();
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error('Failed to read session:', e); return null; }
}

// One-time migration: delete legacy per-tab autosave files left by older builds.
function cleanupLegacyAutosave() {
  try {
    const d = path.join(dataDir(), 'autosave');
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.sql')) fs.unlinkSync(path.join(d, f));
    }
    // Remove the now-empty directory if nothing else lives there.
    if (fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  } catch (e) { console.warn('Legacy autosave cleanup error:', e); }
}

// ── query history (per connection, last 50) ───────────────────────────────────

const HISTORY_MAX = 50;

function historyFile(connId) {
  const d = path.join(dataDir(), 'history');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${connId}.json`);
}

function loadHistory(connId) {
  const f = historyFile(connId);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return []; }
}

function appendHistory(connId, sql) {
  const list = loadHistory(connId);
  const existing = list.findIndex(e => e.sql === sql);
  if (existing >= 0) list.splice(existing, 1);
  list.unshift({ sql, ts: Date.now() });
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  safeWrite(historyFile(connId), JSON.stringify(list, null, 2));
}

function clearHistory(connId) {
  safeWrite(historyFile(connId), '[]');
}

module.exports = {
  loadConnections, saveConnection, deleteConnection,
  saveQuery, loadQuery, listQueries, deleteQuery,
  saveSession, loadSession, cleanupLegacyAutosave,
  loadHistory, appendHistory, clearHistory,
};
