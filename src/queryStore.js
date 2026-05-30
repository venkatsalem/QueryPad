const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

function dataDir() {
  const d = path.join(app.getPath('userData'), 'QueryPad');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function connectionsFile() { return path.join(dataDir(), 'connections.json'); }

function read(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
}

// ── connections ───────────────────────────────────────────────────────────────

function loadConnections() { return read(connectionsFile()); }

function saveConnection(cfg) {
  const list = loadConnections();
  if (!cfg.id) cfg.id = uuidv4();
  const idx = list.findIndex(c => c.id === cfg.id);
  if (idx >= 0) list[idx] = cfg; else list.push(cfg);
  fs.writeFileSync(connectionsFile(), JSON.stringify(list, null, 2));
  return cfg;
}

function deleteConnection(id) {
  const list = loadConnections().filter(c => c.id !== id);
  fs.writeFileSync(connectionsFile(), JSON.stringify(list, null, 2));
  return true;
}

// ── queries ───────────────────────────────────────────────────────────────────

function queriesDir(connectionId) {
  const d = path.join(dataDir(), 'queries', connectionId || '_unsaved');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function saveQuery(name, connectionId, content) {
  fs.writeFileSync(path.join(queriesDir(connectionId), `${name}.sql`), content, 'utf8');
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

// ── autosave ──────────────────────────────────────────────────────────────────

function autosaveDir() {
  const d = path.join(dataDir(), 'autosave');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function autosave(tabId, content) {
  fs.writeFileSync(path.join(autosaveDir(), `${tabId}.sql`), content, 'utf8');
  return true;
}

function loadAutosaved(tabId) {
  const f = path.join(autosaveDir(), `${tabId}.sql`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

module.exports = {
  loadConnections, saveConnection, deleteConnection,
  saveQuery, loadQuery, listQueries, deleteQuery,
  autosave, loadAutosaved,
};
