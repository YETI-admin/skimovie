const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'thermometer.db'));
  // /home on App Service is network storage, where WAL mode is unsafe.
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS charges (
      id TEXT PRIMARY KEY,
      created INTEGER NOT NULL,
      source TEXT NOT NULL,
      in_campaign INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      method TEXT,
      charge_cents INTEGER NOT NULL,
      tip_cents INTEGER NOT NULL,
      base_cents INTEGER NOT NULL,
      refunded_cents INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_cents INTEGER NOT NULL,
      kind TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      entered_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      at TEXT PRIMARY KEY,
      total_cents INTEGER NOT NULL,
      givelively_cents INTEGER NOT NULL,
      stripe_cents INTEGER NOT NULL,
      cash_cents INTEGER NOT NULL,
      adjust_cents INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      who TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    );
  `);
  return db;
}

module.exports = { openDb };
