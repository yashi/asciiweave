import type * as YTypes from 'yjs'
import type { DocumentStore } from '../persistence/store'

// Restore/seed/persist logic for a collaboration room, shared by the
// Node y-websocket server (rooms.ts, CJS yjs) and the Cloudflare
// Durable Object (worker/room.ts, ESM yjs). The yjs module instance is
// injected because the two runtimes must each use exactly one build —
// see codec.ts.

type YModule = typeof YTypes
type YDoc = YTypes.Doc

export const PERSIST_DEBOUNCE_MS = 1000

export interface RoomBindingControl {
  cancelPendingPersist(): void
}

// Seed a freshly created room with the persisted source, exactly once.
// Seeding on the server instead of in each client means two browsers
// opening the same document cannot both insert the initial content.
// Returns whether text was inserted.
export async function seedRoom(
  store: DocumentStore,
  docName: string,
  ydoc: YDoc,
): Promise<boolean> {
  const doc = await store.get(docName)
  if (!doc) {
    return false
  }
  const ytext = ydoc.getText('source')
  if (ytext.length === 0 && doc.source.length > 0) {
    ytext.insert(0, doc.source)
    return true
  }
  return false
}

const pendingPersists = new WeakMap<DocumentStore, Map<string, Promise<void>>>()

// Persist the room's canonical CRDT state and the derived plain-text
// representation alongside it. Rooms for IDs that are not documents are
// never persisted.
export async function persistRoom(
  Y: YModule,
  store: DocumentStore,
  docName: string,
  ydoc: YDoc,
): Promise<void> {
  // Capture both representations before yielding to another room update.
  const snapshot = {
    state: Y.encodeStateAsUpdate(ydoc),
    source: ydoc.getText('source').toString(),
  }
  let queue = pendingPersists.get(store)
  if (!queue) {
    queue = new Map()
    pendingPersists.set(store, queue)
  }
  const previous = queue.get(docName) ?? Promise.resolve()
  const write = previous.then(async () => {
    await store.saveSnapshot(docName, snapshot)
  })
  // Keep failures visible to callers while allowing the next write to run.
  const settled = write.then(
    () => {},
    () => {},
  )
  queue.set(docName, settled)
  void settled.then(() => {
    if (queue.get(docName) === settled) {
      queue.delete(docName)
    }
  })
  return write
}

// Restore a room when the collaboration server creates it. The durable
// Yjs state is canonical; the plain-source seed is only the migration
// path for documents that predate CRDT persistence. Afterwards, every
// room update re-persists the state (debounced), so durability does not
// depend on a graceful shutdown or on the last client leaving.
export async function bindRoomStateWithControl(
  Y: YModule,
  store: DocumentStore,
  docName: string,
  ydoc: YDoc,
  debounceMs: number = PERSIST_DEBOUNCE_MS,
): Promise<RoomBindingControl> {
  const stored = await store.getYjsState(docName)
  let restored = false
  if (stored) {
    try {
      Y.applyUpdate(ydoc, stored)
      restored = true
    } catch (error) {
      // A corrupt blob must never take the document down with it: fall
      // back to the plain-text representation and re-persist from there.
      console.error(`corrupt Yjs state for ${docName}, falling back to plain source:`, error)
    }
  }
  if (!restored && (await seedRoom(store, docName, ydoc))) {
    // A seed invents the item identities that every synced browser then
    // builds on. Persist it before any client sees it: a room rebuilt
    // from storage (a Durable Object cold wake, a server restart) must
    // restore those same items, not seed new ones that connected
    // browsers' later edits could never attach to.
    try {
      await persistRoom(Y, store, docName, ydoc)
    } catch (error) {
      console.error(`failed to persist seed for ${docName}:`, error)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  ydoc.on('update', () => {
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      // A failed write (disk full, closed store) must not crash the
      // process from inside a timer; the next update retries anyway.
      persistRoom(Y, store, docName, ydoc).catch((error: unknown) => {
        console.error(`failed to persist room ${docName}:`, error)
      })
    }, debounceMs)
  })
  ydoc.on('destroy', cancel)
  return { cancelPendingPersist: cancel }
}

// Most room users only need restore plus debounced persistence. Keep the
// original void-returning API for the Node target; the Worker uses the
// controlled variant so a last-client flush can cancel its pending timer.
export async function bindRoomState(
  Y: YModule,
  store: DocumentStore,
  docName: string,
  ydoc: YDoc,
  debounceMs: number = PERSIST_DEBOUNCE_MS,
): Promise<void> {
  await bindRoomStateWithControl(Y, store, docName, ydoc, debounceMs)
}
