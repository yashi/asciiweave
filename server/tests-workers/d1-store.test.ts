import { env } from 'cloudflare:test'
import { createD1Store } from '../src/persistence/d1'
import { describeStoreContract } from '../tests/store-contract'
import { describeSnapshotContract } from '../tests/snapshot-contract'

// The shared behavioral contract, against a real local D1 database in
// the Workers runtime. Isolated storage gives every test a database
// freshly created from the migration series (see apply-migrations.ts).
describeStoreContract(() => createD1Store(env.DB))

describeSnapshotContract(() => ({
  store: createD1Store(env.DB),
  exec: (sql) => env.DB.prepare(sql).run(),
  close() {},
}))
