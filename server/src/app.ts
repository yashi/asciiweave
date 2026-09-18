import { Hono } from 'hono'
import type { StateCodec } from './collaboration/codec'
import { generateDocumentId } from './documents/ids'
import type { DocumentStore } from './persistence/store'

export const INITIAL_SOURCE = '= Untitled Document\n\nStart writing AsciiDoc here.\n'

export interface AppOptions {
  // Current text of a live collaboration room, if one is open for this
  // document — fresher than the debounced persisted state. The Node
  // server reads its in-memory rooms; the Worker asks the Durable
  // Object.
  liveSource?: (id: string) => string | undefined | Promise<string | undefined>
  // Build identity reported by /api/health (git commit SHA in
  // deployments, 'dev' otherwise).
  commit?: string
}

// The durable Yjs state is the one authoritative document store; the
// collaboration path (WebSocket + server-side persistence) is the only
// writer. Plain AsciiDoc source is derived data: current room text if a
// room is live, else decoded CRDT state, else the legacy plain-text row
// for documents that predate CRDT persistence.
export function createApp(store: DocumentStore, codec: StateCodec, options: AppOptions = {}) {
  const app = new Hono()

  const deriveSource = async (id: string, legacy: string): Promise<string> => {
    const live = await options.liveSource?.(id)
    if (live !== undefined) {
      return live
    }
    const state = await store.getYjsState(id)
    return state ? codec.decodeStateToSource(state) : legacy
  }

  // Deployment probe: reports the running build and proves database
  // connectivity with a real (empty) query. Never exposes secrets.
  app.get('/api/health', async (c) => {
    try {
      await store.get('health-probe')
    } catch {
      return c.json({ ok: false, commit: options.commit ?? 'dev' }, 503)
    }
    return c.json({ ok: true, commit: options.commit ?? 'dev' })
  })

  app.post('/api/documents', async (c) => {
    const doc = await store.createSnapshot(generateDocumentId(), {
      source: INITIAL_SOURCE,
      state: codec.encodeSourceAsState(INITIAL_SOURCE),
    })
    return c.json({ id: doc.id }, 201)
  })

  app.get('/api/documents/:id', async (c) => {
    const doc = await store.get(c.req.param('id'))
    if (!doc) {
      return c.json({ error: 'document not found' }, 404)
    }
    return c.json({ ...doc, source: await deriveSource(doc.id, doc.source) })
  })

  // Plain .adoc export for committing to Git — derived from the
  // collaborative state, never a separate store.
  app.get('/api/documents/:id/source', async (c) => {
    const doc = await store.get(c.req.param('id'))
    if (!doc) {
      return c.json({ error: 'document not found' }, 404)
    }
    c.header('content-type', 'text/plain; charset=utf-8')
    c.header('content-disposition', `attachment; filename="${doc.id}.adoc"`)
    return c.body(await deriveSource(doc.id, doc.source))
  })

  return app
}
