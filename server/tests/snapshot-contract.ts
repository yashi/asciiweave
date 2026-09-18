import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocumentStore } from '../src/persistence/store'

interface SnapshotHarness {
  store: DocumentStore
  exec(sql: string): Promise<unknown> | unknown
  close(): void
}

export function describeSnapshotContract(makeHarness: () => SnapshotHarness) {
  describe('atomic snapshot contract', () => {
    let harness: SnapshotHarness
    let store: DocumentStore
    let id: string
    const original = { source: 'original', state: new Uint8Array([1, 2, 3]) }
    const edited = { source: 'edited 日本語', state: new Uint8Array([4, 5, 6]) }

    beforeEach(() => {
      harness = makeHarness()
      store = harness.store
      id = crypto.randomUUID()
    })

    afterEach(() => harness.close())

    it('creates and replaces both representations with one revision per snapshot', async () => {
      const created = await store.createSnapshot(id, original)
      expect(created.revision).toBe(1)
      expect(await store.get(id)).toEqual(created)
      expect(await store.getYjsState(id)).toEqual(original.state)
      expect(await store.saveSnapshot(id, edited)).toBe(true)
      expect(await store.get(id)).toMatchObject({
        source: edited.source,
        revision: 2,
        created_at: created.created_at,
      })
      expect(await store.getYjsState(id)).toEqual(edited.state)
    })

    it('does not write either representation for a missing document', async () => {
      expect(await store.saveSnapshot(id, edited)).toBe(false)
      expect(await store.get(id)).toBeUndefined()
      expect(await store.getYjsState(id)).toBeUndefined()
    })

    it('preserves both representations when creation uses a duplicate id', async () => {
      const created = await store.createSnapshot(id, original)
      await expect(store.createSnapshot(id, edited)).rejects.toThrow()
      expect(await store.get(id)).toEqual(created)
      expect(await store.getYjsState(id)).toEqual(original.state)
    })

    it('rolls back creation if the Yjs write fails after inserting the document', async () => {
      await harness.exec(`CREATE TRIGGER fail_create BEFORE INSERT ON yjs_state
        WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
      try {
        await expect(store.createSnapshot(id, original)).rejects.toThrow('injected failure')
        expect(await store.get(id)).toBeUndefined()
        expect(await store.getYjsState(id)).toBeUndefined()
      } finally {
        await harness.exec('DROP TRIGGER fail_create')
      }
      await store.createSnapshot(id, original)
      expect(await store.getYjsState(id)).toEqual(original.state)
    })

    it('rolls back Yjs state when the source update fails and allows a retry', async () => {
      const created = await store.createSnapshot(id, original)
      await harness.exec(`CREATE TRIGGER fail_source BEFORE UPDATE ON documents
        WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`)
      try {
        await expect(store.saveSnapshot(id, edited)).rejects.toThrow('injected failure')
        expect(await store.get(id)).toEqual(created)
        expect(await store.getYjsState(id)).toEqual(original.state)
      } finally {
        await harness.exec('DROP TRIGGER fail_source')
      }
      expect(await store.saveSnapshot(id, edited)).toBe(true)
      expect((await store.get(id))?.revision).toBe(2)
      expect(await store.getYjsState(id)).toEqual(edited.state)
    })

    it('leaves a legacy document unchanged if its first snapshot fails', async () => {
      const created = await store.create(id, original.source)
      await expect(
        store.saveSnapshot(id, { ...edited, source: null as unknown as string }),
      ).rejects.toThrow()
      expect(await store.get(id)).toEqual(created)
      expect(await store.getYjsState(id)).toBeUndefined()
    })
  })
}
