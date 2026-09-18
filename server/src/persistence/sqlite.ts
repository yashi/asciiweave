import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  INSERT_DOCUMENT,
  SELECT_DOCUMENT,
  SELECT_YJS_STATE,
  UPDATE_DOCUMENT_SOURCE,
  UPSERT_DOCUMENT_YJS_STATE,
  UPSERT_YJS_STATE,
} from './queries'
import type { DocumentRecord, DocumentStore } from './store'

// node:sqlite is still marked experimental; keep all direct usage inside
// this module so the driver can be swapped without touching callers.
// This module is Node-only and must never be imported by Worker code —
// the Cloudflare target uses persistence/d1.ts against the same
// migration files.

// The same numbered SQL files that Wrangler applies to D1. Resolved
// relative to this source file so the runner works from any cwd.
export const MIGRATIONS_DIR = join(fileURLToPath(import.meta.url), '../../../../migrations')

// Same tracking table Wrangler uses for D1, so local and D1 databases
// report migration status identically.
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS d1_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )
`

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
  return row !== undefined
}

function appliedMigrations(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

// Databases created before the migration series (CREATE TABLE IF NOT
// EXISTS at startup, no revision column) are adopted exactly once:
// bring the schema up to what 0001 creates, then record 0001 as
// applied. This is deliberate, local-only compatibility code — the
// shared migration files stay immutable.
function adoptLegacyDatabase(db: DatabaseSync): void {
  if (!tableExists(db, 'documents') || tableExists(db, 'd1_migrations')) {
    return
  }
  const columns = db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]
  db.exec('BEGIN')
  try {
    if (!columns.some((column) => column.name === 'revision')) {
      db.exec('ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
    }
    db.exec(MIGRATIONS_TABLE)
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run('0001_initial_schema.sql')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export interface MigrationStatus {
  applied: string[]
  pending: string[]
}

export function migrationStatus(db: DatabaseSync, dir: string = MIGRATIONS_DIR): MigrationStatus {
  const applied = tableExists(db, 'd1_migrations') ? appliedMigrations(db) : new Set<string>()
  const files = listMigrationFiles(dir)
  return {
    applied: files.filter((name) => applied.has(name)),
    pending: files.filter((name) => !applied.has(name)),
  }
}

// Applies pending migrations in order, each in its own transaction, and
// returns the names applied. Migrations are forward-only; a failure
// rolls back the failing file and aborts with the original error.
export function applyMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  adoptLegacyDatabase(db)
  db.exec(MIGRATIONS_TABLE)
  const applied = appliedMigrations(db)
  const newlyApplied: string[] = []
  for (const name of listMigrationFiles(dir)) {
    if (applied.has(name)) {
      continue
    }
    const sql = readFileSync(join(dir, name), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${name} failed: ${String(error)}`, { cause: error })
    }
    newlyApplied.push(name)
  }
  return newlyApplied
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new DatabaseSync(path)
  // Connection-local setup stays out of the shared migrations: D1 does
  // not support these PRAGMAs.
  db.exec('PRAGMA journal_mode = WAL')
  return db
}

export function openStore(path: string, migrationsDir: string = MIGRATIONS_DIR): DocumentStore {
  const db = openDatabase(path)
  applyMigrations(db, migrationsDir)

  const insert = db.prepare(INSERT_DOCUMENT)
  const select = db.prepare(SELECT_DOCUMENT)
  const update = db.prepare(UPDATE_DOCUMENT_SOURCE)
  const selectY = db.prepare(SELECT_YJS_STATE)
  const upsertY = db.prepare(UPSERT_YJS_STATE)
  const upsertSnapshotY = db.prepare(UPSERT_DOCUMENT_YJS_STATE)

  function transaction<T>(write: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = write()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    async createSnapshot(id, { source, state }) {
      const now = new Date().toISOString()
      return transaction(() => {
        insert.run(id, source, now, now)
        upsertY.run(id, state, now)
        return { id, source, revision: 1, created_at: now, updated_at: now }
      })
    },
    async saveSnapshot(id, { source, state }) {
      const now = new Date().toISOString()
      return transaction(() => {
        upsertSnapshotY.run(state, now, id)
        return update.run(source, now, id).changes === 1
      })
    },
    async create(id, source) {
      const now = new Date().toISOString()
      insert.run(id, source, now, now)
      return { id, source, revision: 1, created_at: now, updated_at: now }
    },
    async get(id) {
      return select.get(id) as DocumentRecord | undefined
    },
    async updateSource(id, source) {
      const now = new Date().toISOString()
      return update.run(source, now, id).changes === 1
    },
    async getYjsState(id) {
      const row = selectY.get(id) as { state: Uint8Array } | undefined
      return row?.state
    },
    async setYjsState(id, state) {
      upsertY.run(id, state, new Date().toISOString())
    },
    close() {
      db.close()
    },
  }
}
