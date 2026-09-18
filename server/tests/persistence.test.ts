import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeStoreContract } from './store-contract'
import { describeSnapshotContract } from './snapshot-contract'
import {
  applyMigrations,
  migrationStatus,
  openDatabase,
  openStore,
} from '../src/persistence/sqlite'

// The shared behavioral contract, against in-memory node:sqlite.
describeStoreContract(() => openStore(':memory:'))

describeSnapshotContract(() => {
  const dir = mkdtempSync(join(tmpdir(), 'asciiweave-snapshot-'))
  const path = join(dir, 'snapshot.db')
  const store = openStore(path)
  const db = openDatabase(path)
  return {
    store,
    exec: (sql) => db.exec(sql),
    close() {
      db.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})

describe('sqlite store', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'asciiweave-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('survives a close and reopen (server restart)', async () => {
    const path = join(dir, 'restart.db')
    const first = openStore(path)
    await first.create('abc', '= Persisted\n')
    await first.updateSource('abc', '= Persisted v2\n')
    const state = new Uint8Array([9, 8, 7])
    await first.setYjsState('abc', state)
    first.close()

    const second = openStore(path)
    const doc = await second.get('abc')
    expect(doc?.source).toBe('= Persisted v2\n')
    expect(doc?.revision).toBe(2)
    expect(await second.getYjsState('abc')).toEqual(state)
    second.close()
  })

  it('creates a fresh database entirely from migrations', () => {
    const db = openDatabase(join(dir, 'fresh.db'))
    const applied = applyMigrations(db)
    expect(applied).toEqual(['0001_initial_schema.sql'])

    const status = migrationStatus(db)
    expect(status.applied).toEqual(['0001_initial_schema.sql'])
    expect(status.pending).toEqual([])

    // Applying again is a no-op, not an error.
    expect(applyMigrations(db)).toEqual([])
    db.close()
  })

  it('reports pending migrations for an unmigrated database', () => {
    const db = openDatabase(join(dir, 'unmigrated.db'))
    const status = migrationStatus(db)
    expect(status.applied).toEqual([])
    expect(status.pending).toContain('0001_initial_schema.sql')
    db.close()
  })

  it('adopts a pre-migration legacy database without losing data', async () => {
    // Databases from before the migration series: created with
    // CREATE TABLE IF NOT EXISTS at startup, no revision column, no
    // migration tracking.
    const path = join(dir, 'legacy.db')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE yjs_state (
        id TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    legacy
      .prepare('INSERT INTO documents (id, source, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('old-doc', '= Legacy\n', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    legacy.close()

    const store = openStore(path)
    const doc = await store.get('old-doc')
    expect(doc?.source).toBe('= Legacy\n')
    expect(doc?.revision).toBe(1)
    expect(await store.updateSource('old-doc', '= Legacy v2\n')).toBe(true)
    expect((await store.get('old-doc'))?.revision).toBe(2)
    store.close()

    const db = openDatabase(path)
    expect(migrationStatus(db).pending).toEqual([])
    db.close()
  })
})
