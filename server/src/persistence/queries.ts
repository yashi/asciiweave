// Shared SQL for SQLite and D1. Preparing statements, binding parameters,
// and converting results stay in the runtime-specific adapters.
export const INSERT_DOCUMENT =
  'INSERT INTO documents (id, source, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)'

export const SELECT_DOCUMENT =
  'SELECT id, source, revision, created_at, updated_at FROM documents WHERE id = ?'

export const UPDATE_DOCUMENT_SOURCE =
  'UPDATE documents SET source = ?, revision = revision + 1, updated_at = ? WHERE id = ?'

export const SELECT_YJS_STATE = 'SELECT state FROM yjs_state WHERE id = ?'

export const UPSERT_YJS_STATE = `
  INSERT INTO yjs_state (id, state, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
`

export const UPSERT_DOCUMENT_YJS_STATE = `
  INSERT INTO yjs_state (id, state, updated_at)
  SELECT id, ?, ? FROM documents WHERE id = ?
  ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at
`
