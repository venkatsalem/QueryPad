const active = new Map(); // id -> { type, conn }

// ── helpers ───────────────────────────────────────────────────────────────────

function oraConnStr(cfg) {
  return `${cfg.host}:${cfg.port || 1521}/${cfg.service || cfg.database}`;
}

function formatValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  if (Buffer.isBuffer(val)) return val.toString('hex');
  return String(val);
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(cfg) {
  try {
    if (cfg.type === 'oracle') {
      const db = require('oracledb');
      db.outFormat = db.OUT_FORMAT_OBJECT;
      const c = await db.getConnection({ user: cfg.username, password: cfg.password, connectString: oraConnStr(cfg) });
      await c.close();

    } else if (cfg.type === 'postgres') {
      const { Client } = require('pg');
      const c = new Client({ host: cfg.host, port: cfg.port || 5432, database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 8000 });
      await c.connect();
      await c.end();

    } else if (cfg.type === 'mysql') {
      const m = require('mysql2/promise');
      const c = await m.createConnection({ host: cfg.host, port: cfg.port || 3306, database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 8000 });
      await c.end();

    } else {
      throw new Error('Unknown type: ' + cfg.type);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── connect ───────────────────────────────────────────────────────────────────

async function connect(id, cfg) {
  if (active.has(id)) await disconnect(id);

  if (cfg.type === 'oracle') {
    const db = require('oracledb');
    db.outFormat = db.OUT_FORMAT_OBJECT;
    const conn = await db.getConnection({ user: cfg.username, password: cfg.password, connectString: oraConnStr(cfg) });
    active.set(id, { type: 'oracle', conn });

  } else if (cfg.type === 'postgres') {
    const { Pool } = require('pg');
    const pool = new Pool({ host: cfg.host, port: cfg.port || 5432, database: cfg.database, user: cfg.username, password: cfg.password, max: 5, idleTimeoutMillis: 30000 });
    active.set(id, { type: 'postgres', conn: pool });

  } else if (cfg.type === 'mysql') {
    const m = require('mysql2/promise');
    const pool = m.createPool({ host: cfg.host, port: cfg.port || 3306, database: cfg.database, user: cfg.username, password: cfg.password, waitForConnections: true, connectionLimit: 5 });
    active.set(id, { type: 'mysql', conn: pool });

  } else {
    throw new Error('Unknown type: ' + cfg.type);
  }
  return { success: true };
}

// ── disconnect ────────────────────────────────────────────────────────────────

async function disconnect(id) {
  const entry = active.get(id);
  if (!entry) return;
  try {
    if (entry.type === 'oracle') await entry.conn.close();
    else await entry.conn.end();
  } catch (_) {}
  active.delete(id);
}

// ── execute ───────────────────────────────────────────────────────────────────

async function execute(id, sql) {
  const entry = active.get(id);
  if (!entry) throw new Error('Not connected. Click a connection in the sidebar first.');

  const stmt = sql.trim().replace(/;+$/, '');
  const t0 = Date.now();

  if (entry.type === 'oracle') {
    const db = require('oracledb');
    const r = await entry.conn.execute(stmt, [], {
      outFormat: db.OUT_FORMAT_OBJECT,
      fetchArraySize: 2000,
    });
    const elapsed = Date.now() - t0;
    if (r.rows !== undefined) {
      const columns = r.metaData.map(m => m.name);
      return {
        type: 'select',
        columns,
        rows: r.rows.map(row => columns.map(c => formatValue(row[c]))),
        rowCount: r.rows.length,
        elapsed,
      };
    }
    return { type: 'dml', rowsAffected: r.rowsAffected, elapsed };

  } else if (entry.type === 'postgres') {
    const r = await entry.conn.query(stmt);
    const elapsed = Date.now() - t0;
    if (r.fields && r.fields.length > 0) {
      const columns = r.fields.map(f => f.name);
      return {
        type: 'select',
        columns,
        rows: r.rows.map(row => columns.map(c => formatValue(row[c]))),
        rowCount: r.rows.length,
        elapsed,
      };
    }
    return { type: 'dml', rowsAffected: r.rowCount, elapsed };

  } else if (entry.type === 'mysql') {
    const [rows, fields] = await entry.conn.execute(stmt);
    const elapsed = Date.now() - t0;
    if (Array.isArray(fields) && fields.length > 0) {
      const columns = fields.map(f => f.name);
      return {
        type: 'select',
        columns,
        rows: rows.map(row => columns.map(c => formatValue(row[c]))),
        rowCount: rows.length,
        elapsed,
      };
    }
    return { type: 'dml', rowsAffected: rows.affectedRows, elapsed };
  }
}

// ── closeAll ──────────────────────────────────────────────────────────────────

async function closeAll() {
  for (const [id] of active) await disconnect(id);
}

module.exports = { testConnection, connect, disconnect, execute, closeAll };
