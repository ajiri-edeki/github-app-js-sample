import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { config } from './config.js'

let database

const schema = `
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE,
  permission_summary TEXT NOT NULL DEFAULT '{}',
  authorization_status TEXT NOT NULL DEFAULT 'Authorized',
  account_login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  provenance TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  repository_selection TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES grants(id),
  status TEXT NOT NULL CHECK(status IN ('Active','Reauth required','Disabled')),
  failure_cause TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_provider_success_at TEXT
);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  github_user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  reach_status TEXT NOT NULL DEFAULT 'Reachable',
  freshness_status TEXT NOT NULL DEFAULT 'Current',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(github_user_id, connection_id)
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  repository_id INTEGER NOT NULL UNIQUE,
  repository_node_id TEXT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  selection_state TEXT NOT NULL DEFAULT 'Selected',
  reach_status TEXT NOT NULL DEFAULT 'Reachable',
  status TEXT NOT NULL CHECK(status IN ('Working','Broken','Disabled','Reauth required')),
  failure_cause TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_received_event_at TEXT,
  last_successful_processing_at TEXT,
  removed_at TEXT
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  action TEXT,
  installation_id INTEGER,
  repository_id INTEGER,
  connection_id TEXT,
  source_id TEXT,
  status TEXT NOT NULL,
  failure_cause TEXT,
  correlation_id TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY(connection_id) REFERENCES connections(id),
  FOREIGN KEY(source_id) REFERENCES sources(id)
);
CREATE TABLE IF NOT EXISTS processing_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  failure_cause TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS health_transitions (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  cause TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS diagnostic_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_connection ON sources(connection_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, received_at);
`

export function initializeDatabase () {
  if (database) return database
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
  database = new Database(config.databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.exec(schema)
  const insert = database.prepare('INSERT OR IGNORE INTO diagnostic_state (key, value, updated_at) VALUES (?, ?, ?)')
  insert.run('worker_paused', 'false', new Date().toISOString())
  insert.run('processing_delay_ms', '0', new Date().toISOString())
  insert.run('fail_next_delivery', 'false', new Date().toISOString())
  insert.run('clock_offset_ms', '0', new Date().toISOString())
  return database
}

export function db () {
  return initializeDatabase()
}

export function closeDatabase () {
  database?.close()
  database = undefined
}

export function id (prefix) {
  return `${prefix}_${randomUUID()}`
}

export function now () {
  const row = db().prepare("SELECT value FROM diagnostic_state WHERE key = 'clock_offset_ms'").get()
  return new Date(Date.now() + Number(row?.value || 0)).toISOString()
}

export function diagnostic (key, fallback = '') {
  return db().prepare('SELECT value FROM diagnostic_state WHERE key = ?').get(key)?.value ?? fallback
}

export function setDiagnostic (key, value) {
  db().prepare(`INSERT INTO diagnostic_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), now())
}

export function transition (entityType, entityId, fromStatus, toStatus, cause, actor = 'system') {
  db().prepare(`INSERT INTO health_transitions
    (id, entity_type, entity_id, from_status, to_status, cause, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id('ht'), entityType, entityId, fromStatus, toStatus, cause || null, actor, now())
}

export function resetDatabase () {
  const tables = ['processing_attempts', 'deliveries', 'identities', 'sources', 'health_transitions', 'connections', 'grants']
  db().transaction(() => tables.forEach(table => db().prepare(`DELETE FROM ${table}`).run()))()
  setDiagnostic('worker_paused', 'false')
  setDiagnostic('processing_delay_ms', '0')
  setDiagnostic('fail_next_delivery', 'false')
  setDiagnostic('clock_offset_ms', '0')
}
