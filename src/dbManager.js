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
      const opts = { host: cfg.host, port: cfg.port || 5432, database: cfg.database, user: cfg.username, password: cfg.password, connectionTimeoutMillis: 8000 };
      if (cfg.ssl) opts.ssl = { rejectUnauthorized: false };
      const c = new Client(opts);
      await c.connect();
      await c.end();

    } else if (cfg.type === 'mysql') {
      const m = require('mysql2/promise');
      const opts = { host: cfg.host, port: cfg.port || 3306, database: cfg.database, user: cfg.username, password: cfg.password, connectTimeout: 8000 };
      if (cfg.ssl) opts.ssl = { rejectUnauthorized: false };
      const c = await m.createConnection(opts);
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
    const pool = await db.createPool({ user: cfg.username, password: cfg.password, connectString: oraConnStr(cfg), poolMin: 1, poolMax: 5, poolIncrement: 1 });
    active.set(id, { type: 'oracle', conn: pool });

  } else if (cfg.type === 'postgres') {
    const { Pool } = require('pg');
    const opts = { host: cfg.host, port: cfg.port || 5432, database: cfg.database, user: cfg.username, password: cfg.password, max: 5, idleTimeoutMillis: 30000 };
    if (cfg.ssl) opts.ssl = { rejectUnauthorized: false };
    const pool = new Pool(opts);
    active.set(id, { type: 'postgres', conn: pool });

  } else if (cfg.type === 'mysql') {
    const m = require('mysql2/promise');
    const opts = { host: cfg.host, port: cfg.port || 3306, database: cfg.database, user: cfg.username, password: cfg.password, waitForConnections: true, connectionLimit: 5 };
    if (cfg.ssl) opts.ssl = { rejectUnauthorized: false };
    const pool = m.createPool(opts);
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
    if (entry.type === 'oracle') await entry.conn.close(0);
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
    const conn = await entry.conn.getConnection();
    try {
      const r = await conn.execute(stmt, [], {
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
    } finally {
      await conn.close();
    }

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

// ── getSchema (for autocomplete) ────────────────────────────────────────────
// Returns { tables: [name...], columns: { tableName: [col...] } } for the
// current schema/database. Used to power editor table/column completion.

async function getSchema(id) {
  const entry = active.get(id);
  if (!entry) return { tables: [], columns: {} };

  const columns = {};
  let tables = [];

  if (entry.type === 'oracle') {
    const db = require('oracledb');
    const opt = { outFormat: db.OUT_FORMAT_OBJECT };
    const conn = await entry.conn.getConnection();
    try {
      const t = await conn.execute('SELECT table_name FROM user_tables ORDER BY table_name', [], opt);
      const c = await conn.execute(
        'SELECT table_name, column_name FROM user_tab_columns ORDER BY table_name, column_id', [], opt);
      tables = t.rows.map(r => r.TABLE_NAME);
      for (const r of c.rows) (columns[r.TABLE_NAME] ||= []).push(r.COLUMN_NAME);
    } finally {
      await conn.close();
    }

  } else if (entry.type === 'postgres') {
    const t = await entry.conn.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY table_name`);
    const c = await entry.conn.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY table_name, ordinal_position`);
    tables = t.rows.map(r => r.table_name);
    for (const r of c.rows) (columns[r.table_name] ||= []).push(r.column_name);

  } else if (entry.type === 'mysql') {
    // Alias columns to fixed lowercase names — MySQL's info_schema casing varies.
    const [tr] = await entry.conn.query(
      `SELECT table_name AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() ORDER BY table_name`);
    const [cr] = await entry.conn.query(
      `SELECT table_name AS t, column_name AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`);
    tables = tr.map(r => r.t);
    for (const r of cr) (columns[r.t] ||= []).push(r.c);
  }

  return { tables, columns };
}

// ── closeAll ──────────────────────────────────────────────────────────────────

async function closeAll() {
  for (const [id] of active) await disconnect(id);
}

module.exports = { testConnection, connect, disconnect, execute, getSchema, closeAll };
