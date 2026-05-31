// ════════════════════════════════════════════════════════════════════════════
//  QueryPad – renderer process
// ════════════════════════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  tabs: new Map(),        // tabId -> { id, name, content, dirty, connId }
  activeTabId: null,
  connections: [],        // saved configs
  activeConnId: null,
  connectedIds: new Set(),
  results: null,          // { columns, rows, rowData }
  nextTabNum: 1,
  pendingExport: null,    // { type, rows, columns }
};

let editor = null;     // Monaco instance
let gridApi = null;    // AG Grid instance
let saveTimer = null;  // debounce handle
let idSeq = 0;         // monotonic counter for unique tab IDs
let restoring = false; // true while rebuilding tabs from a saved session

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Wire events + resizers FIRST so buttons always work, even if a
  // library (AG Grid / Monaco) fails to load below.
  wireEvents();
  wireResizers();
  applyOSTheme();

  try { initGrid(); }
  catch (e) { console.error('AG Grid init failed:', e); showToast('Grid failed to load: ' + e.message, true); }

  loadConnections();

  try {
    initMonaco(() => restoreSession());
  } catch (e) {
    console.error('Monaco init failed:', e);
    showToast('Editor failed to load: ' + e.message, true);
  }
});

// ── Monaco ───────────────────────────────────────────────────────────────────

function initMonaco(onReady) {
  window.MonacoEnvironment = {
    getWorkerUrl: () =>
      'data:text/javascript;charset=utf-8,' + encodeURIComponent('self.onmessage = function(){}'),
  };

  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    editor = window.monaco.editor.create(document.getElementById('monaco-container'), {
      value: '',
      language: 'sql',
      theme: prefersDark ? 'vs-dark' : 'vs',
      fontFamily: "'Google Sans Code Monospace', 'JetBrains Mono', Consolas, monospace",
      fontSize: 14,
      lineHeight: 22,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      wordWrap: 'off',
      tabSize: 2,
      renderWhitespace: 'selection',
      folding: true,
      glyphMargin: false,
      lineDecorationsWidth: 8,
      lineNumbersMinChars: 3,
      padding: { top: 10, bottom: 10 },
    });

    editor.addAction({ id: 'run-all',  label: 'Run',           keybindings: [monaco.KeyCode.F5],                           run: () => runQuery(false) });
    editor.addAction({ id: 'run-sel',  label: 'Run Selection', keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F5],      run: () => runQuery(true)  });
    editor.addAction({ id: 'save-q',   label: 'Save Query',    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],  run: openSaveModal         });
    editor.addAction({ id: 'new-tab',  label: 'New Tab',       keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT],  run: () => createTab()     });

    editor.onDidChangeModelContent(() => {
      if (!state.activeTabId) return;
      const tab = state.tabs.get(state.activeTabId);
      if (tab) {
        tab.content = editor.getValue();
        tab.dirty   = true;
        renderTabBar();
        scheduleAutosave();
      }
    });

    onReady();
  });
}

// ── AG Grid ──────────────────────────────────────────────────────────────────

function initGrid() {
  const { createGrid } = agGrid;

  gridApi = createGrid(document.getElementById('results-grid'), {
    columnDefs: [],
    rowData: [],
    defaultColDef: {
      sortable:   true,
      resizable:  true,
      filter:     true,
      minWidth:   60,
      cellStyle:  { fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: '12px' },
    },
    // v32.2+ object form (replaces deprecated 'multiple' + suppressRowClickSelection)
    rowSelection: { mode: 'multiRow', enableClickSelection: true },
    animateRows: false,
    onSelectionChanged: () => {
      const n = gridApi.getSelectedRows().length;
      document.getElementById('btn-export-sel').disabled = n === 0;
    },
  });

  // Custom right-click menu (AG Grid's native getContextMenuItems is enterprise-only)
  const gridEl = document.getElementById('results-grid');
  gridEl.addEventListener('contextmenu', e => {
    if (!state.results) return;
    e.preventDefault();
    showGridContextMenu(e.clientX, e.clientY);
  });
}

// ── Custom context menu ───────────────────────────────────────────────────────

function showGridContextMenu(x, y) {
  hideGridContextMenu();
  const hasSel = gridApi.getSelectedRows().length > 0;
  const scope = hasSel ? 'selected' : 'all';
  const flag  = hasSel;

  const menu = document.createElement('div');
  menu.id = 'grid-ctx-menu';
  menu.className = 'ctx-menu';
  menu.innerHTML = `
    <div class="ctx-label">${hasSel ? 'Selected rows' : 'All rows'}</div>
    <button data-t="csv">Export ${scope} as CSV</button>
    <button data-t="insert">Export ${scope} as INSERT SQL</button>
    <button data-t="update">Export ${scope} as UPDATE SQL</button>
    <div class="ctx-sep"></div>
    <button data-t="copy">Copy ${scope}</button>
  `;
  menu.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const t = btn.dataset.t;
      if (t === 'copy') copyRows(flag);
      else triggerExport(t, flag);
      hideGridContextMenu();
    };
  });
  document.body.appendChild(menu);

  // Keep within viewport
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth  - r.width  - 8) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  setTimeout(() => document.addEventListener('click', hideGridContextMenu, { once: true }), 0);
}

function hideGridContextMenu() {
  const m = document.getElementById('grid-ctx-menu');
  if (m) m.remove();
}

function copyRows(selectedOnly) {
  if (!state.results) return;
  const cols = state.results.columns;
  const rows = selectedOnly
    ? gridApi.getSelectedRows().map(r => cols.map(c => r[c]))
    : state.results.rows;
  const tsv = [cols.join('\t'), ...rows.map(r => r.map(v => v ?? '').join('\t'))].join('\n');
  navigator.clipboard.writeText(tsv).then(() => showToast('Copied ' + rows.length + ' rows'));
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function newTabId() {
  return `tab-${Date.now()}-${idSeq++}`;
}

function createTab(name, content) {
  const id   = newTabId();
  const tnum = state.nextTabNum++;
  state.tabs.set(id, {
    id,
    name:    name  || `query-${tnum}.sql`,
    content: content || '',
    dirty:   false,
    connId:  state.activeConnId,
  });
  renderTabBar();
  switchTab(id);
  scheduleAutosave();
  return id;
}

function switchTab(id) {
  if (state.activeTabId && editor) {
    const cur = state.tabs.get(state.activeTabId);
    if (cur) cur.content = editor.getValue();
  }
  state.activeTabId = id;
  const tab = state.tabs.get(id);
  if (editor && tab) {
    editor.setValue(tab.content);
    editor.focus();
  }
  clearResults();
  renderTabBar();
  if (!restoring) scheduleAutosave();
}

function closeTab(id) {
  state.tabs.delete(id);
  if (state.activeTabId === id) {
    const ids = [...state.tabs.keys()];
    if (ids.length) switchTab(ids[ids.length - 1]);
    else createTab();
  } else {
    renderTabBar();
  }
  scheduleAutosave();
}

// ── Session restore ────────────────────────────────────────────────────────

function restoreTab(t) {
  const id = t.id || newTabId();
  state.tabs.set(id, {
    id,
    name:    t.name || `query-${state.nextTabNum}.sql`,
    content: t.content || '',
    dirty:   false,
    connId:  t.connId || null,
  });
  // Keep auto-numbered names from colliding after a restore.
  const m = /^query-(\d+)\.sql$/.exec(t.name || '');
  if (m) state.nextTabNum = Math.max(state.nextTabNum, parseInt(m[1], 10) + 1);
  return id;
}

async function restoreSession() {
  let session = null;
  try { session = await window.querypad.session.load(); } catch (_) {}

  restoring = true;
  if (session && Array.isArray(session.tabs) && session.tabs.length) {
    session.tabs.forEach(restoreTab);
    renderTabBar();
    const active = (session.activeTabId && state.tabs.has(session.activeTabId))
      ? session.activeTabId
      : [...state.tabs.keys()][0];
    switchTab(active);
  } else {
    createTab();
  }
  restoring = false;
}

function renderTabBar() {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  for (const [id, tab] of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (id === state.activeTabId ? ' active' : '') + (tab.dirty ? ' dirty' : '');
    el.dataset.id = id;

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = tab.name;
    name.onclick = () => switchTab(id);

    const x = document.createElement('button');
    x.className = 'tab-x';
    x.textContent = '×';
    x.onclick = (e) => { e.stopPropagation(); closeTab(id); };

    el.appendChild(name);
    el.appendChild(x);
    container.appendChild(el);
  }
}

// ── Connections ───────────────────────────────────────────────────────────────

async function loadConnections() {
  state.connections = await window.querypad.db.loadConnections();
  renderConnectionsList();
  renderQueriesList();
}

function renderConnectionsList() {
  const el = document.getElementById('connections-list');
  el.innerHTML = '';

  for (const conn of state.connections) {
    const row = document.createElement('div');
    row.className = 'conn-item' + (conn.id === state.activeConnId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'conn-dot' + (state.connectedIds.has(conn.id) ? ' connected' : '');

    const name = document.createElement('span');
    name.className = 'conn-name';
    name.textContent = conn.name;

    const badge = document.createElement('span');
    badge.className = 'conn-type-badge';
    badge.textContent = { oracle: 'ORA', postgres: 'PG', mysql: 'MY' }[conn.type] || '';

    const edit = document.createElement('button');
    edit.className = 'item-edit';
    edit.textContent = '✎';
    edit.title = 'Edit connection';
    edit.onclick = (e) => {
      e.stopPropagation();
      openEditConnModal(conn);
    };

    const del = document.createElement('button');
    del.className = 'item-del';
    del.textContent = '×';
    del.title = 'Remove connection';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete connection "${conn.name}"?`)) return;
      await window.querypad.db.deleteConnection(conn.id);
      if (state.activeConnId === conn.id) setActiveConnection(null);
      await loadConnections();
    };

    row.onclick = () => activateConnection(conn);
    row.ondblclick = () => openEditConnModal(conn);
    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(badge);
    row.appendChild(edit);
    row.appendChild(del);
    el.appendChild(row);
  }
}

async function activateConnection(conn) {
  setStatus('Connecting to ' + conn.name + '…');
  try {
    await window.querypad.db.connect(conn.id);
    state.connectedIds.add(conn.id);
    setActiveConnection(conn.id);
    await renderQueriesList();
    showToast('Connected to ' + conn.name);
  } catch (e) {
    showToast('Connection failed: ' + e.message, true);
  }
}

function setActiveConnection(id) {
  state.activeConnId = id;
  const conn = state.connections.find(c => c.id === id);
  document.getElementById('conn-label').textContent = conn
    ? `${conn.name} (${conn.type})`
    : 'No connection';
  document.getElementById('st-conn').textContent = conn
    ? `${conn.name} · ${conn.type}`
    : 'Not connected';
  renderConnectionsList();
}

// ── Saved queries sidebar ─────────────────────────────────────────────────────

async function renderQueriesList() {
  const el = document.getElementById('queries-list');
  el.innerHTML = '';
  if (!state.activeConnId) return;

  const names = await window.querypad.query.list(state.activeConnId);
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'query-item';

    const span = document.createElement('span');
    span.className = 'query-name';
    span.textContent = name;

    const rename = document.createElement('button');
    rename.className = 'item-edit';
    rename.textContent = '✎';
    rename.title = 'Rename saved query';
    rename.onclick = (e) => {
      e.stopPropagation();
      openRenameModal(name);
    };

    const del = document.createElement('button');
    del.className = 'item-del';
    del.textContent = '×';
    del.title = 'Delete saved query';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete saved query "${name}"?`)) return;
      await window.querypad.query.delete(name, state.activeConnId);
      await renderQueriesList();
    };

    row.onclick = async () => {
      const content = await window.querypad.query.load(name, state.activeConnId);
      if (content !== null) createTab(name + '.sql', content);
    };
    row.ondblclick = () => openRenameModal(name);

    row.appendChild(span);
    row.appendChild(rename);
    row.appendChild(del);
    el.appendChild(row);
  }
}

// ── Query execution ───────────────────────────────────────────────────────────

async function runQuery(selectionOnly) {
  if (!editor) return;

  let sql = selectionOnly
    ? editor.getModel().getValueInRange(editor.getSelection())
    : editor.getValue();

  sql = sql.trim();
  if (!sql) { showToast('Nothing to run'); return; }
  if (!state.activeConnId) { showToast('Select a connection first', true); return; }

  setStatus('Running…');
  hideError();
  clearResults();
  document.getElementById('btn-export-all').disabled = true;
  document.getElementById('btn-export-sel').disabled = true;

  try {
    const result = await window.querypad.db.execute(state.activeConnId, sql);
    if (result.type === 'select') {
      displayResults(result);
      document.getElementById('st-rows').textContent = `${result.rowCount} rows`;
      document.getElementById('st-sep2').style.display = '';
      document.getElementById('st-time').textContent = `${result.elapsed}ms`;
      document.getElementById('results-info').textContent =
        `${result.rowCount.toLocaleString()} row${result.rowCount !== 1 ? 's' : ''} · ${result.elapsed}ms`;
      document.getElementById('btn-export-all').disabled = false;
    } else {
      document.getElementById('results-info').textContent =
        `${result.rowsAffected ?? 0} row${(result.rowsAffected ?? 0) !== 1 ? 's' : ''} affected · ${result.elapsed}ms`;
      document.getElementById('st-rows').textContent = `${result.rowsAffected ?? 0} rows affected`;
    }
    setStatus('');
  } catch (e) {
    showError(e.message);
    document.getElementById('results-info').textContent = 'Error';
    setStatus('Error');
  }
}

// ── Results display ───────────────────────────────────────────────────────────

function displayResults(result) {
  const { columns, rows } = result;

  const colDefs = columns.map(c => ({ field: c, headerName: c }));
  const rowData = rows.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });

  gridApi.setGridOption('columnDefs', colDefs);
  gridApi.setGridOption('rowData', rowData);

  state.results = { columns, rows, rowData };
  document.getElementById('error-box').classList.add('hidden');
  document.getElementById('results-grid').style.display = '';
}

function clearResults() {
  state.results = null;
  if (gridApi) {
    gridApi.setGridOption('columnDefs', []);
    gridApi.setGridOption('rowData', []);
  }
  document.getElementById('results-info').textContent = 'Ready';
  document.getElementById('st-rows').textContent = '';
  document.getElementById('st-sep2').style.display = 'none';
  document.getElementById('st-time').textContent = '';
  document.getElementById('btn-export-all').disabled = true;
  document.getElementById('btn-export-sel').disabled = true;
}

function showError(msg) {
  const box = document.getElementById('error-box');
  box.textContent = msg;
  box.classList.remove('hidden');
  document.getElementById('results-grid').style.display = 'none';
}

function hideError() {
  document.getElementById('error-box').classList.add('hidden');
  document.getElementById('results-grid').style.display = '';
}

// ── Export ────────────────────────────────────────────────────────────────────

function triggerExport(type, selectedOnly) {
  if (!state.results) return;
  closeDropdowns();

  let rows, columns;
  columns = state.results.columns;

  if (selectedOnly) {
    const sel = gridApi.getSelectedRows();
    if (!sel.length) { showToast('Select rows first'); return; }
    rows = sel.map(r => columns.map(c => r[c]));
  } else {
    rows = state.results.rows;
  }

  if (type === 'csv') {
    const name = guessTableName();
    downloadContent(generateCSV(columns, rows), `${name}.csv`, 'text/csv');
    return;
  }

  // INSERT / UPDATE need modal
  state.pendingExport = { type, rows, columns };

  const titles = { insert: 'Export as INSERT SQL', update: 'Export as UPDATE SQL' };
  document.getElementById('export-modal-title').textContent = titles[type];
  document.getElementById('f-tbl').value = guessTableName();

  const keyRow = document.getElementById('row-key');
  if (type === 'update') {
    keyRow.style.display = 'flex';
    const sel = document.getElementById('f-key-col');
    sel.innerHTML = columns.map(c => `<option value="${c}">${c}</option>`).join('');
  } else {
    keyRow.style.display = 'none';
  }

  openModal('export-modal');
}

function confirmExport() {
  const { type, rows, columns } = state.pendingExport;
  const table  = document.getElementById('f-tbl').value.trim() || 'table_name';
  const keyCol = document.getElementById('f-key-col').value;

  let content, filename;
  if (type === 'insert') {
    content  = generateInsertSQL(table, columns, rows);
    filename = `${table}_insert.sql`;
  } else {
    content  = generateUpdateSQL(table, keyCol, columns, rows);
    filename = `${table}_update.sql`;
  }

  downloadContent(content, filename);
  closeModal('export-modal');
}

// ── SQL generators ────────────────────────────────────────────────────────────

function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (/^-?\d+(\.\d+)?$/.test(String(v))) return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Quote an identifier for the active DB. MySQL uses backticks; Oracle/Postgres
// (and ANSI SQL) use double quotes.
function quoteId(name) {
  const conn = state.connections.find(c => c.id === state.activeConnId);
  if (conn && conn.type === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function generateCSV(columns, rows) {
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map(r => r.map(escape).join(','))].join('\r\n');
}

function generateInsertSQL(table, columns, rows) {
  const cols = columns.map(quoteId).join(', ');
  return rows.map(row =>
    `INSERT INTO ${table} (${cols}) VALUES (${row.map(sqlVal).join(', ')});`
  ).join('\n');
}

function generateUpdateSQL(table, keyCol, columns, rows) {
  const keyIdx = columns.indexOf(keyCol);
  return rows.map(row => {
    const sets = columns
      .filter((_, i) => i !== keyIdx)
      .map((c, i) => `${quoteId(c)} = ${sqlVal(row[i < keyIdx ? i : i + 1])}`)
      .join(', ');
    const where = `${quoteId(keyCol)} = ${sqlVal(row[keyIdx])}`;
    return `UPDATE ${table} SET ${sets} WHERE ${where};`;
  }).join('\n');
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadContent(content, filename, mime) {
  const saved = await window.querypad.dialog.save(filename, content);
  if (saved) showToast('Saved to ' + saved.split(/[\\/]/).pop());
}

// ── Auto-save (whole session) ──────────────────────────────────────────────

// Serialize every open tab + the active tab to disk. Called debounced on edits
// and immediately-ish on structural changes (new/close/switch/rename).
async function persistSession() {
  if (state.activeTabId && editor) {
    const cur = state.tabs.get(state.activeTabId);
    if (cur) cur.content = editor.getValue();
  }
  const tabs = [...state.tabs.values()].map(t => ({
    id: t.id, name: t.name, content: t.content, connId: t.connId,
  }));
  await window.querypad.session.save({ tabs, activeTabId: state.activeTabId });
}

function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await persistSession();
    const tab = state.tabs.get(state.activeTabId);
    if (tab) tab.dirty = false;
    renderTabBar();
    document.getElementById('st-save').textContent = 'Autosaved ' + new Date().toLocaleTimeString();
  }, 600);
}

// ── Connection modal ──────────────────────────────────────────────────────────

let editingConnId = null;

function openNewConnModal() {
  editingConnId = null;
  document.getElementById('conn-modal-title').textContent = 'New Connection';
  document.getElementById('btn-save-conn').textContent = 'Save';
  ['f-name','f-host','f-port','f-service','f-db','f-user','f-pass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('f-type').value = 'oracle';
  document.getElementById('test-result').textContent = '';
  document.getElementById('test-result').className = 'dim';
  updateConnModalFields();
  openModal('conn-modal');
  setTimeout(() => document.getElementById('f-name').focus(), 50);
}

function openEditConnModal(conn) {
  editingConnId = conn.id;
  document.getElementById('conn-modal-title').textContent = 'Edit Connection';
  document.getElementById('btn-save-conn').textContent = 'Update';
  document.getElementById('f-name').value    = conn.name || '';
  document.getElementById('f-type').value    = conn.type || 'oracle';
  document.getElementById('f-host').value    = conn.host || '';
  document.getElementById('f-port').value    = conn.port || '';
  document.getElementById('f-service').value = conn.service || '';
  document.getElementById('f-db').value      = conn.database || '';
  document.getElementById('f-user').value    = conn.username || '';
  document.getElementById('f-pass').value    = conn.password || '';
  document.getElementById('test-result').textContent = '';
  document.getElementById('test-result').className = 'dim';
  updateConnModalFields();
  openModal('conn-modal');
  setTimeout(() => document.getElementById('f-name').focus(), 50);
}

const PORT_DEFAULTS = { oracle: '1521', postgres: '5432', mysql: '3306' };

function updateConnModalFields() {
  const type = document.getElementById('f-type').value;
  const port = document.getElementById('f-port');

  // Update the port whenever it's empty OR still holds another DB's default,
  // so switching the Type always reflects the right port. A port the user
  // typed themselves (not a known default) is left untouched.
  const defaults = Object.values(PORT_DEFAULTS);
  if (!port.value || defaults.includes(String(port.value))) {
    port.value = PORT_DEFAULTS[type] || '';
  }
  port.placeholder = PORT_DEFAULTS[type] || '';

  const isOracle = type === 'oracle';
  document.getElementById('row-service').classList.toggle('hidden', !isOracle);
  document.getElementById('row-db').classList.toggle('hidden',  isOracle);
}

async function testConnection() {
  const cfg = readConnForm();
  document.getElementById('test-result').textContent = 'Testing…';
  document.getElementById('test-result').className = 'dim';
  const r = await window.querypad.db.testConnection(cfg);
  const el = document.getElementById('test-result');
  if (r.success) {
    el.textContent = '✓ Connected';
    el.className = 'ok';
  } else {
    el.textContent = '✗ ' + r.error;
    el.className = 'err';
  }
}

async function saveConnection() {
  const cfg = readConnForm();
  if (!cfg.name) { showToast('Connection name is required', true); return; }

  const isEdit = !!editingConnId;
  if (isEdit) cfg.id = editingConnId;

  await window.querypad.db.saveConnection(cfg);

  if (isEdit) {
    // Drop any live pool/handle so the next activate uses the new settings.
    try { await window.querypad.db.disconnect(cfg.id); } catch (_) {}
    state.connectedIds.delete(cfg.id);
  }

  await loadConnections();

  // Refresh the label/status (reads the freshly-loaded connection) in case the
  // active connection was renamed.
  if (isEdit && state.activeConnId === cfg.id) setActiveConnection(cfg.id);

  closeModal('conn-modal');
  showToast(isEdit ? 'Connection updated' : 'Connection saved');
}

function readConnForm() {
  const type = document.getElementById('f-type').value;
  return {
    name:     document.getElementById('f-name').value.trim(),
    type,
    host:     document.getElementById('f-host').value.trim(),
    port:     parseInt(document.getElementById('f-port').value) || undefined,
    service:  document.getElementById('f-service').value.trim() || undefined,
    database: document.getElementById('f-db').value.trim() || undefined,
    username: document.getElementById('f-user').value.trim(),
    password: document.getElementById('f-pass').value,
  };
}

// ── Save query modal ──────────────────────────────────────────────────────────

function openSaveModal() {
  if (!state.activeTabId) return;
  const tab = state.tabs.get(state.activeTabId);
  document.getElementById('f-qname').value = tab.name.replace(/\.sql$/, '');
  openModal('save-modal');
  setTimeout(() => document.getElementById('f-qname').select(), 50);
}

async function confirmSaveQuery() {
  const name = document.getElementById('f-qname').value.trim();
  if (!name) { showToast('Name is required', true); return; }
  if (!state.activeConnId) { showToast('No active connection', true); return; }

  const tab = state.tabs.get(state.activeTabId);
  const content = editor ? editor.getValue() : (tab ? tab.content : '');

  await window.querypad.query.save(name, state.activeConnId, content);
  await renderQueriesList();

  if (tab) { tab.name = name + '.sql'; renderTabBar(); }
  scheduleAutosave();
  closeModal('save-modal');
  showToast('Saved as ' + name + '.sql');
}

// ── Rename saved query modal ───────────────────────────────────────────────────

let renamingQuery = null;

function openRenameModal(name) {
  renamingQuery = name;
  const input = document.getElementById('f-rename');
  input.value = name;
  openModal('rename-modal');
  setTimeout(() => input.select(), 50);
}

async function confirmRenameQuery() {
  const oldName = renamingQuery;
  const newName = document.getElementById('f-rename').value.trim();
  if (!oldName) return;
  if (!newName) { showToast('Name is required', true); return; }
  if (newName === oldName) { closeModal('rename-modal'); return; }

  const existing = await window.querypad.query.list(state.activeConnId);
  if (existing.includes(newName)) { showToast('A query with that name already exists', true); return; }

  // No backend rename — compose from load + save-under-new-name + delete-old.
  const content = await window.querypad.query.load(oldName, state.activeConnId);
  await window.querypad.query.save(newName, state.activeConnId, content ?? '');
  await window.querypad.query.delete(oldName, state.activeConnId);

  // Keep any open tab that pointed at the old saved query in sync.
  for (const tab of state.tabs.values()) {
    if (tab.name === oldName + '.sql') { tab.name = newName + '.sql'; }
  }
  renderTabBar();
  scheduleAutosave();

  await renderQueriesList();
  closeModal('rename-modal');
  showToast(`Renamed to ${newName}.sql`);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal(id)  { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ── Resizers ──────────────────────────────────────────────────────────────────

function wireResizers() {
  // Sidebar ↔ main
  const sideHandle = document.getElementById('sidebar-handle');
  let sideResizing = false, sideStart = 0, sideWidth = 0;

  sideHandle.addEventListener('mousedown', e => {
    sideResizing = true;
    sideStart = e.clientX;
    sideWidth = parseInt(getComputedStyle(document.body).gridTemplateColumns.split(' ')[0]);
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  // Editor ↔ results
  const splitHandle = document.getElementById('split-handle');
  let splitResizing = false, splitStart = 0, splitH = 0;

  splitHandle.addEventListener('mousedown', e => {
    splitResizing = true;
    splitStart = e.clientY;
    splitH = document.getElementById('editor-wrap').offsetHeight;
    splitHandle.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (sideResizing) {
      const delta = e.clientX - sideStart;
      const newW = Math.max(160, Math.min(500, sideWidth + delta));
      document.body.style.gridTemplateColumns = `${newW}px 4px 1fr`;
    }
    if (splitResizing) {
      const delta = e.clientY - splitStart;
      const newH = Math.max(80, splitH + delta);
      document.getElementById('editor-wrap').style.height = newH + 'px';
      editor?.layout();
    }
  });

  document.addEventListener('mouseup', () => {
    sideResizing = false;
    splitResizing = false;
    splitHandle.classList.remove('dragging');
    document.body.style.cursor = '';
  });
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // Toolbar buttons
  document.getElementById('btn-new-tab').onclick   = () => createTab();
  document.getElementById('btn-run').onclick        = () => runQuery(false);
  document.getElementById('btn-run-sel').onclick    = () => runQuery(true);
  document.getElementById('btn-save-q').onclick     = openSaveModal;
  document.getElementById('btn-new-conn').onclick   = openNewConnModal;

  // Connection modal
  document.getElementById('f-type').onchange        = updateConnModalFields;
  document.getElementById('btn-test-conn').onclick  = testConnection;
  document.getElementById('btn-save-conn').onclick  = saveConnection;
  document.getElementById('btn-cancel-conn').onclick= () => closeModal('conn-modal');

  // Save query modal
  document.getElementById('btn-confirm-save').onclick = confirmSaveQuery;
  document.getElementById('f-qname').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSaveQuery();
  });

  // Rename query modal
  document.getElementById('btn-confirm-rename').onclick = confirmRenameQuery;
  document.getElementById('f-rename').addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmRenameQuery();
  });

  // Export modal
  document.getElementById('btn-confirm-export').onclick = confirmExport;

  // Modal close buttons (data-close attribute). Modals deliberately do NOT
  // close on backdrop click or Escape — they stay open until the user clicks
  // an explicit button (Cancel / Save / Download / ✕).
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  // Export dropdown toggles
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const dd = btn.closest('.dropdown');
      const wasOpen = dd.classList.contains('open');
      closeDropdowns();
      if (!wasOpen) dd.classList.add('open');
    });
  });

  document.addEventListener('click', closeDropdowns);

  // Export dropdown actions
  document.querySelectorAll('.dropdown-menu button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.action;
      const [scope, type] = a.split('-');
      triggerExport(type, scope === 'sel');
    });
  });

  // Keyboard — Escape closes transient popovers only, never the modals
  // (those require an explicit button click).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeDropdowns();
      hideGridContextMenu();
    }
  });

  // Flush the session synchronously-ish before the window goes away, so the
  // last few hundred ms of edits (inside the debounce window) aren't lost.
  window.addEventListener('beforeunload', () => { persistSession(); });
}

// ── OS theme ──────────────────────────────────────────────────────────────────

function applyOSTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(isDark) {
    // AG Grid theme class
    const grid = document.getElementById('results-grid');
    if (grid) grid.className = isDark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz';
    // Monaco theme (if loaded)
    if (window.monaco) window.monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
    // Body background hint for Electron flash prevention
    document.body.style.background = isDark ? '#1e1e1e' : '#ffffff';
  }

  apply(mq.matches);
  mq.addEventListener('change', e => apply(e.matches));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function guessTableName() {
  const sql = editor ? editor.getValue() : '';
  const m = sql.match(/\bfrom\s+([\w."[\]`]+)/i);
  return m ? m[1].replace(/["[\]`]/g, '').split('.').pop() : 'table_name';
}

function closeDropdowns() {
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
}

function setStatus(msg) {
  // reflected in status bar implicitly via st-conn / st-rows
}

function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? '#f44747' : '#454545';
  el.style.color = isError ? '#f44747' : '#cccccc';
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2800);
}
