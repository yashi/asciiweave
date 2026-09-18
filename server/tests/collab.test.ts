import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as YTypes from 'yjs'
import { bindRoomState, persistRoom, seedRoom } from '../src/collaboration/rooms'
import { openStore } from '../src/persistence/sqlite'
import type { DocumentStore } from '../src/persistence/store'

// Use the same CJS yjs module instance as the room code (see rooms.ts):
// documents must never mix structs from the ESM and CJS builds.
const Y = createRequire(import.meta.url)('yjs') as typeof YTypes

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('collaboration rooms', () => {
  let store: DocumentStore

  beforeEach(() => {
    store = openStore(':memory:')
  })

  afterEach(() => {
    store.close()
  })

  it('seeds a new room from the persisted source exactly once', async () => {
    await store.create('abc', '= Persisted\n')
    const ydoc = new Y.Doc()

    await seedRoom(store, 'abc', ydoc)
    expect(ydoc.getText('source').toString()).toBe('= Persisted\n')

    // A second bind (e.g. after reconnect races) must not duplicate.
    await seedRoom(store, 'abc', ydoc)
    expect(ydoc.getText('source').toString()).toBe('= Persisted\n')
  })

  it('makes a legacy seed durable so a rebuilt room shares its history', async () => {
    await store.create('abc', '= Legacy\n')
    const first = new Y.Doc()
    await bindRoomState(store, 'abc', first)
    // A browser that synced from the first room holds the seed's items.
    const browser = new Y.Doc()
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(first))

    // The seed invents client IDs, so it must be persisted before any
    // edit: a room rebuilt from storage (a Durable Object cold wake)
    // has to restore exactly those items rather than seed new ones.
    expect(await store.getYjsState('abc')).toBeDefined()
    const rebuilt = new Y.Doc()
    await bindRoomState(store, 'abc', rebuilt)
    expect(Y.encodeStateVector(rebuilt)).toEqual(Y.encodeStateVector(first))

    // Otherwise the browser's next edit references unknown items and the
    // rebuilt room parks it as pending forever.
    browser.getText('source').insert(browser.getText('source').length, 'edited')
    Y.applyUpdate(rebuilt, Y.encodeStateAsUpdate(browser, Y.encodeStateVector(rebuilt)))
    expect(rebuilt.getText('source').toString()).toBe('= Legacy\nedited')
  })

  it('leaves rooms for unknown documents empty', async () => {
    const ydoc = new Y.Doc()
    await seedRoom(store, 'missing', ydoc)
    expect(ydoc.getText('source').toString()).toBe('')
  })

  it('persists CRDT state and plain text together', async () => {
    await store.create('abc', 'old content')
    const ydoc = new Y.Doc()
    ydoc.getText('source').insert(0, 'collaborative result')

    await persistRoom(store, 'abc', ydoc)
    expect((await store.get('abc'))?.source).toBe('collaborative result')

    const restored = new Y.Doc()
    Y.applyUpdate(restored, (await store.getYjsState('abc'))!)
    expect(restored.getText('source').toString()).toBe('collaborative result')
  })

  it('never persists rooms without a document', async () => {
    const ydoc = new Y.Doc()
    ydoc.getText('source').insert(0, 'stray')
    await expect(persistRoom(store, 'unknown', ydoc)).resolves.toBeUndefined()
    expect(await store.get('unknown')).toBeUndefined()
    expect(await store.getYjsState('unknown')).toBeUndefined()
  })

  it('captures matching snapshots and serializes overlapping writes per document', async () => {
    await store.create('abc', '')
    await store.create('other', '')
    const room = new Y.Doc()
    const other = new Y.Doc()
    const started = deferred()
    const release = deferred()
    const saved: string[] = []
    const delayed: DocumentStore = {
      ...store,
      async saveSnapshot(id, snapshot) {
        if (id === 'abc' && saved.length === 0) {
          started.resolve()
          await release.promise
        }
        const restored = new Y.Doc()
        Y.applyUpdate(restored, snapshot.state)
        expect(restored.getText('source').toString()).toBe(snapshot.source)
        restored.destroy()
        saved.push(snapshot.source)
        return store.saveSnapshot(id, snapshot)
      },
    }
    room.getText('source').insert(0, 'first')
    const first = persistRoom(delayed, 'abc', room)
    await started.promise
    room.getText('source').insert(5, ' second')
    const second = persistRoom(delayed, 'abc', room)
    other.getText('source').insert(0, 'independent')
    await persistRoom(delayed, 'other', other)
    expect(saved).toEqual(['independent'])
    release.resolve()
    await Promise.all([first, second])
    expect(saved).toEqual(['independent', 'first', 'first second'])
    expect(await store.get('abc')).toMatchObject({ source: 'first second', revision: 3 })
    const restored = new Y.Doc()
    Y.applyUpdate(restored, (await store.getYjsState('abc'))!)
    expect(restored.getText('source').toString()).toBe('first second')
    room.destroy()
    other.destroy()
    restored.destroy()
  })

  it('continues queued persists after a failed write', async () => {
    await store.create('abc', '')
    const room = new Y.Doc()
    const started = deferred()
    const release = deferred()
    let calls = 0
    const failing: DocumentStore = {
      ...store,
      async saveSnapshot(id, snapshot) {
        if (++calls === 1) {
          started.resolve()
          await release.promise
          throw new Error('disk full')
        }
        return store.saveSnapshot(id, snapshot)
      },
    }
    room.getText('source').insert(0, 'first')
    const failed = expect(persistRoom(failing, 'abc', room)).rejects.toThrow('disk full')
    await started.promise
    room.getText('source').insert(5, ' recovered')
    const next = persistRoom(failing, 'abc', room)
    release.resolve()
    await failed
    await next
    expect(await store.get('abc')).toMatchObject({ source: 'first recovered', revision: 2 })
    room.destroy()
  })

  it('queues a disconnect flush behind an in-flight debounced persist', async () => {
    vi.useFakeTimers()
    const room = new Y.Doc()
    const started = deferred()
    const release = deferred()
    try {
      await store.create('abc', '')
      let calls = 0
      const delayed: DocumentStore = {
        ...store,
        async saveSnapshot(id, snapshot) {
          if (++calls === 1) {
            started.resolve()
            await release.promise
          }
          return store.saveSnapshot(id, snapshot)
        },
      }
      await bindRoomState(delayed, 'abc', room, 100)
      room.getText('source').insert(0, 'debounced')
      await vi.advanceTimersByTimeAsync(100)
      await started.promise
      room.getText('source').insert(9, ' flushed')
      const flush = persistRoom(delayed, 'abc', room)
      room.destroy()
      expect(calls).toBe(1)
      release.resolve()
      await flush
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(2)
      expect(await store.get('abc')).toMatchObject({ source: 'debounced flushed', revision: 3 })
    } finally {
      release.resolve()
      room.destroy()
      vi.useRealTimers()
    }
  })

  it('restores a room from durable CRDT state, which wins over plain text', async () => {
    await store.create('abc', 'stale plain text')
    const original = new Y.Doc()
    original.getText('source').insert(0, 'crdt content')
    await store.setYjsState('abc', Y.encodeStateAsUpdate(original))

    const room = new Y.Doc()
    await bindRoomState(store, 'abc', room)
    expect(room.getText('source').toString()).toBe('crdt content')
  })

  it('falls back to plain-text seeding for documents without CRDT state', async () => {
    await store.create('abc', '= Legacy Document\n')
    const room = new Y.Doc()
    await bindRoomState(store, 'abc', room)
    expect(room.getText('source').toString()).toBe('= Legacy Document\n')
  })

  it('re-persists the room state on every update, debounced', async () => {
    vi.useFakeTimers()
    try {
      await store.create('abc', '')
      const room = new Y.Doc()
      await bindRoomState(store, 'abc', room, 1000)

      room.getText('source').insert(0, 'first ')
      room.getText('source').insert(6, 'second')
      expect(await store.getYjsState('abc')).toBeUndefined()

      await vi.advanceTimersByTimeAsync(1000)
      const restored = new Y.Doc()
      Y.applyUpdate(restored, (await store.getYjsState('abc'))!)
      expect(restored.getText('source').toString()).toBe('first second')

      // Destroying the room (last client left) cancels the pending timer.
      room.getText('source').insert(0, 'late ')
      room.destroy()
      await vi.advanceTimersByTimeAsync(5000)
      const after = new Y.Doc()
      Y.applyUpdate(after, (await store.getYjsState('abc'))!)
      expect(after.getText('source').toString()).toBe('first second')
    } finally {
      vi.useRealTimers()
    }
  })

  it('round-trips concurrent edit history through persistence', async () => {
    // Two peers diverge, merge, and the merged CRDT state survives a
    // persist/restore cycle byte-exactly.
    await store.create('abc', '')
    const peerA = new Y.Doc()
    peerA.getText('source').insert(0, 'shared base')
    const peerB = new Y.Doc()
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA))
    peerA.getText('source').insert(0, '[A] ')
    peerB.getText('source').insert(peerB.getText('source').length, ' [B]')
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(peerB))
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA))
    const merged = peerA.getText('source').toString()

    await persistRoom(store, 'abc', peerA)
    const room = new Y.Doc()
    await bindRoomState(store, 'abc', room)
    expect(room.getText('source').toString()).toBe(merged)
  })
})
