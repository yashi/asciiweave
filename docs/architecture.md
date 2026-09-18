# asciiweave architecture

Decisions that are not obvious from the code alone.

## Core design principles

### AsciiDoc source is the document

The canonical user-authored content is plain AsciiDoc text held in a Yjs
`Y.Text` and persisted as Yjs state.

Do not introduce a rich-text JSON format, make an editable AST canonical, or
automatically rewrite or reformat the AsciiDoc source. A user must always be
able to obtain ordinary `.adoc` text suitable for committing to Git.

### Rendering is derived state

Rendered HTML is disposable derived state:

```text
AsciiDoc source
      |
      v
Asciidoctor.js
      |
      v
HTML preview
```

Each browser renders its synchronized source locally. Never persist or
synchronize rendered HTML, and never make it the canonical document.

### Collaboration operates on text

Synchronize the AsciiDoc source text. Do not make Yjs understand AsciiDoc
structure, synchronize the Asciidoctor AST, or implement a custom CRDT or OT
algorithm.

### A URL identifies one document

Each `/doc/<id>` URL identifies one independent AsciiDoc document and its Yjs
room. Document IDs must remain stable, random, non-sequential, and URL-safe.
Do not use a title or filename as the primary identity.

### Keep one authoritative store

Durable Yjs state is the authoritative document store, and the collaboration
path is its only writer. Plain AsciiDoc is derived from the live room or stored
CRDT state for display and export. The `documents.source` column is a legacy
fallback and derived cache, not a second source of truth.

Do not restore client-side HTTP autosave or another competing write path.

## Technology and compatibility

Use the established stack unless a requested change has a compelling reason
to alter it:

- TypeScript;
- CodeMirror 6;
- Asciidoctor.js 4 via `@asciidoctor/core`;
- Yjs v13;
- `y-codemirror.next`;
- the Yjs v13-compatible `y-websocket` generation;
- Vite;
- Hono;
- `node:sqlite` for the local/on-premises target;
- Cloudflare Workers, Durable Objects, and D1 for the hosted target.

Pin mutually compatible dependency versions in the lock file. Do not mix the
stable Yjs v13 packages with development packages from the Yjs v14 family,
such as `@y/y`, `@y/codemirror`, or `@y/websocket`.

The Node collaboration server and `y-websocket/bin/utils` must share one Yjs
module instance. Server code that manipulates room documents must load Yjs
through `createRequire`, as described under durable CRDT state below.

### Upstream references

- CodeMirror documentation: https://codemirror.net/docs/
- Asciidoctor.js documentation: https://docs.asciidoctor.org/asciidoctor.js/latest/
- Yjs CodeMirror 6 binding: https://github.com/yjs/y-codemirror.next
- Yjs WebSocket provider: https://github.com/yjs/y-websocket

Asciidoctor.js conversion is asynchronous. `y-codemirror.next` binds a Yjs
`Y.Text` to CodeMirror 6 and supports awareness-driven cursors, selections,
and Yjs-aware undo/redo. Check upstream compatibility guidance before changing
any of these packages.

## Server targets

The Node and Cloudflare targets share the application, persistence contract,
migrations, and CRDT codec:

| Target              | Runtime         | Rooms                          | Database      |
| ------------------- | --------------- | ------------------------------ | ------------- |
| Local / on-premises | Node.js >= 26   | In-process `y-websocket` rooms | `node:sqlite` |
| Cloudflare          | Workers runtime | Per-document Durable Objects   | D1            |

Keep runtime-specific dependencies at the composition roots. Shared modules
must not accidentally bundle `node:sqlite`, `createRequire`, or the wrong Yjs
build into the Worker.

Use one numbered, immutable SQL migration series from `migrations/` for both
SQLite and D1. Add migrations instead of editing files already applied to a
deployed database. See [`deployment-node.md`](deployment-node.md) for operating
the Node.js target and
[`deployment-cloudflare.md`](deployment-cloudflare.md) for the Space Cubics
Cloudflare environments, credentials, deployment, and rollback.

## Overall shape

```
POST /api/documents  ->  random ID  ->  /doc/<id>
                                          |
   browser A                       room owner                    browser B
     Y.Doc  <---- ws://…/collab/<id> ----+---- ws://…/collab/<id> ----> Y.Doc
       |                                 |                               |
     Y.Text                         server Y.Doc                       Y.Text
     /    \                              |                            /    \
CodeMirror  Asciidoctor.js         debounced snapshot       Asciidoctor.js  CodeMirror
                 |                       |                         |
          sandboxed iframe          SQLite or D1          sandboxed iframe
```

## Yjs document model

The live source in the browser is a `Y.Text` (`ydoc.getText('source')`),
bound to CodeMirror 6 with `y-codemirror.next`'s `yCollab` — there is no
second canonical copy in any store or editor model. The preview subscribes to
the `Y.Text` observer, so it reacts identically to keystrokes, programmatic
transactions, and remote collaborators' edits.

The `Y.UndoManager` does not track the provider's transaction origin, so
undo reverts only this user's own edits — never remote edits or the
content loaded from the server.

## Collaboration transport

The asciiweave document ID is the Yjs room name: `/doc/<id>` collaborates
through `ws://…/collab/<id>`. There is no second collaboration ID.

Both ends use `y-websocket 1.5.4`, pinned exactly: it is the stable Yjs
v13-compatible generation that ships the client provider and the proven
server (`y-websocket/bin/utils`) in one mutually compatible package. The
newer client-only y-websocket releases pair with `@y/websocket-server`,
which is built on the Yjs v14 development line that the project
instructions say not to mix in. Two traps in `bin/utils` worth knowing:
the persistence hooks must return promises (it chains `.then()` on
`writeState`, and a synchronous function crashes the process on
disconnect), and rooms are destroyed when their last client leaves.

The collaboration server (`server/src/collaboration/rooms.ts`) is
AsciiDoc-agnostic: it relays Yjs updates and awareness per room. Its only
contact with document content is as opaque text, in two places:

- **Seeding**: when a room is created, `bindState` inserts the persisted
  source into the room's `Y.Text` (guarded by an emptiness check).
  Seeding on the server instead of in each client means two browsers
  opening the same document cannot both insert the initial content — the
  client never bootstraps text itself. A seed is persisted as CRDT state
  right away, before any client syncs it. A room can be rebuilt from
  storage while browsers that received the first seed stay connected (a
  hibernated Durable Object wakes with empty memory), and a second seed
  would invent new item identities that those browsers' later edits could
  never attach to: the server would park them as pending forever, so a
  newly opened tab would show the old text.
- **Flush**: when the last client leaves, `writeState` persists the room.

## Durable CRDT state

The canonical Yjs document state is persisted in SQLite (`yjs_state`
table) as an opaque encoded update, alongside — not replaced by — the
plain-text `documents` table, which remains the user-facing
representation. When y-websocket creates a room, `bindRoomState` restores
it from the stored CRDT state; the plain-source seed is only the
migration path for documents that predate CRDT persistence, and the
stored CRDT state wins when both exist.

Every room update re-persists the full encoded state, debounced by ~1s
(documents are small; snapshotting beats an update log at this scale).
That means durability does not depend on a graceful shutdown or on the
last client leaving.

**One yjs module instance, ever.** `y-websocket/bin/utils` is CommonJS
and `require`s the CJS build of yjs; server code that manipulates room
docs must load yjs through `createRequire` so it gets that same instance
(`server/src/collaboration/state.ts` exports it). Importing the ESM
build alongside it puts structs from two class hierarchies into one
document (the "Yjs was already imported" warning) and corrupts sync
encoding — the symptom was clients silently diverging after a server
restart, with one client applying a remote delete but losing the
accompanying insert.

Persistence is hardened against faults: a corrupt or truncated state
blob falls back to the plain-text representation and is healed by the
next persist, and failures inside the persistence hooks or the debounce
timer are contained (a rejected `writeState` promise inside y-websocket
would otherwise crash the whole process as an unhandled rejection).

## Source resolution and export

Plain AsciiDoc is derived data, resolved in freshness order: live room
text (if a room is open), else decoded `yjs_state`, else the legacy
`documents.source` row. `GET /api/documents/:id` returns it, and
`GET /api/documents/:id/source` serves it as a `text/plain` `.adoc`
download for committing to Git. The `documents.source` column survives
only as a derived cache written by `persistRoom` — same write, same
content, no second truth.

## Connection state and offline editing

The topbar indicator now reflects the collaboration connection
(`Synced / Connecting… / Offline`) instead of HTTP save state: while
synced, edits reach the server in real time and the server persists
them. The accepted trade-off is that edits made while offline live only
in the open tab until reconnect (a local persistence layer such as
y-indexeddb would close that gap and can come later).

## Presence

Names, colors, cursors, selections, and online status live exclusively in
Yjs Awareness (`app/src/collaboration/presence.ts`). Awareness is
ephemeral by design: it travels over the same WebSocket but never becomes
part of the document, never reaches SQLite, and the server removes a
client's state the moment its socket closes — which is what makes the
connected-user indicator drop departed users immediately.

Each browser keeps one identity (generated adjective-animal name plus a
palette color) in `localStorage`, so a person keeps their name and color
across documents and visits; the topbar input renames it. The identity is
published as the awareness `user` field, exactly the shape
`y-codemirror.next` reads to draw remote carets (`.cm-ySelectionCaret`,
labeled with the name) and selections. The presence list rendering is a
pure function over the raw awareness states, unit-tested without any
networking.

The editor assembles its extensions by hand instead of using CodeMirror's
`basicSetup`, because `basicSetup` bundles CodeMirror's own history and
there must be exactly one undo system — the Yjs-aware one
(`yUndoManagerKeymap`).

## Document IDs

`server/src/documents/ids.ts` generates 80 random bits (`node:crypto`)
encoded as 14 base64url characters. IDs are stable, non-sequential, and
URL-safe, as the project instructions require. The ID is the document's only
identity; titles/filenames are not identities.

## Persistence

The storage boundary is `DocumentStore`
(`server/src/persistence/store.ts`): an asynchronous, domain-level
interface (documents + opaque Yjs state), never a generic SQL wrapper.
Two implementations exist and pass one shared behavioral contract suite
(`server/tests/store-contract.ts`):

- `server/src/persistence/sqlite.ts` — the built-in `node:sqlite`
  (`DatabaseSync`, WAL mode) for the Node target. Synchronous under the
  async interface; every direct `node:sqlite` use lives in this one
  module.
- `server/src/persistence/d1.ts` — Cloudflare D1 for the Worker
  target, tested against a real local D1 in workerd
  (`npm run test:workers`).

The schema comes from one numbered, immutable migration series in
`migrations/`, shared verbatim by both engines and applied by the local
runner (startup or `npm run db:migrate`) and by
`wrangler d1 migrations apply`. Both track applied files in the same
`d1_migrations` table. The database path comes from `ASCIIWEAVE_DB`;
tests use temp files and prove restart survival by closing and
reopening the store.

### Retain D1 while reducing duplication

Keep D1 as the Cloudflare target's document database for now. Durable
Objects own live collaboration and write durable Yjs snapshots, document
metadata, and the derived source cache to D1. Although `CollabRoom` is
configured as a SQLite-backed Durable Object, it does not currently use
its own storage for document persistence.

This decision preserves the existing deployment, migration, and backup
arrangements while maintenance work consolidates duplicated tests, SQL,
and workflow steps. Moving persistence into Durable Objects would require
a data migration; a cost benefit has not been established.

Both Cloudflare and on-premises deployments remain required. Retain the
current Node.js/SQLite on-premises target during this cleanup. Removing
D1, replacing the Node.js runtime with standalone workerd, or unifying the
collaboration implementations are separate architectural decisions, not
prerequisites for reducing duplication.

## Cloudflare Worker target

`server/src/worker/index.ts` is a second composition root over the same
`createApp` and codec. Two runtime-specific rules shape it:

- **One yjs build per runtime.** The Node server must use the CJS yjs
  instance y-websocket requires; the Worker bundles the ESM build. The
  shared code (`collaboration/codec.ts`, `collaboration/room-binding.ts`)
  therefore takes the yjs module as a parameter instead of importing it,
  and the Worker bundle never contains `node:sqlite` or `createRequire`.
- **One writer per document.** Where the Node target owns rooms in
  process memory, the Worker gives each document a `CollabRoom` Durable
  Object (`server/src/worker/room.ts`) speaking the y-websocket wire
  protocol (sync + awareness) over `WebSocketPair`. Sockets use the
  Durable Objects WebSocket Hibernation API, with the document name and
  complete per-connection awareness state in socket attachments. A cold
  wake restores D1 state and then attachment-backed presence behind
  `blockConcurrencyWhile` before queued events run. A close event can omit
  its already-closing socket from `getWebSockets()`, so close cleanup also
  reads that socket's attachment directly. The Object persists debounced
  snapshots to D1 — never every keystroke — and cancels that debounce
  before flushing when the last client leaves. The API's freshness rule
  (live room text over persisted state) holds because the Worker asks the
  document's Object for its current text.

Static assets are served by Workers Assets with SPA fallback; only
`/api/*` and `/collab/*` reach the Worker (`run_worker_first`).
Deployment, environments, and rollback:
[`deployment-cloudflare.md`](deployment-cloudflare.md).

## D2 diagrams

The browser renders `[d2]` listing blocks with `@d2lang/d2`.
The preview collects these blocks from the Asciidoctor AST before HTML
conversion. Each block retains its title and source anchor.

The browser loads the renderer on demand. The renderer compiles diagrams in
the package's Web Worker. Both server targets serve the renderer and its
bundled WASM as browser assets. Diagram rendering requires no remote service.

The compiler receives each block's literal source. asciiweave supplies no
filesystem for D2 imports. The preview embeds SVG output as images with data
URLs to isolate SVG markup and styles. These images disable diagram links
and external icons.

The renderer processes one diagram at a time, with a 15-second timeout for
each diagram. A cache holds up to 32 entries for completed or pending renders.
The cache avoids repeated compilation of unchanged diagrams during edits and
printing.

If a diagram fails to render, the preview keeps the block's source visible
and shows a text error. The render scheduler rejects stale results after
diagram rendering completes. Printing uses the same conversion path as the
preview.

## Stale-render prevention

Asciidoctor.js v4 conversion is asynchronous, and completions are not
guaranteed to arrive in submission order. `app/src/preview/scheduler.ts`
gives every started conversion a generation number and applies a result only
if no newer conversion has started since. Combined with a ~200 ms debounce,
rapid typing can never leave stale output on screen. The scheduler takes the
convert/apply functions as parameters so the ordering logic is unit-tested
without a real converter.

## Preview isolation

Document content is user-authored and treated as untrusted relative to the
application shell. The rendered HTML goes into an `<iframe sandbox srcdoc>`
with `allow-same-origin` but not `allow-scripts`. Same-origin access lets the
parent read source anchors and set an immediate scroll position without
fragment navigation or queued smooth scrolling. A restrictive content
security policy independently disables scripts and blocks nested frames,
plugins, and form submission. The Asciidoctor default stylesheet (vendored at
`app/src/preview/asciidoctor.css`, from `@asciidoctor/core`) is inlined into
the iframe document; application UI CSS is kept separate. Conversion runs
with Asciidoctor's default `secure` safe mode, so `include::` does not read
files.

Asciidoctor source maps provide line numbers for rendered blocks and table
rows. Source scrolling finds the surrounding anchors and interpolates their
document positions. Events are coalesced to one update per animation frame,
and each update reads the latest requested line, so a rapid direction change
cannot leave an older movement queued. Preview content and iframe resize
events reapply the current source position after layout changes.

The parent also observes preview document scroll events with scripts still
disabled. It maps rendered block positions back to source lines, interpolating
between blocks, and follows those lines in CodeMirror without moving selection
or focus. Rendered positions are cached so scrolling does not repeat DOM
lookups and geometry reads for every anchor. The existing mapping function
still sorts and scans those positions on each scroll. Rendering, content or
iframe resizing, font readiness, and style changes invalidate this snapshot;
the next preview scroll rebuilds it. At the preview bottom, the source follows to its own bottom.
Both directions remember the actual scroll position they set and ignore its
scroll-event echo. A different position takes over immediately and cancels any
pending movement in the opposite direction. Preview events are coalesced per
animation frame, and listeners are replaced on render and removed on disposal.

## Resizable pane layout

The editor layout uses three CSS Grid tracks: source, separator, and preview.
The separator adjusts fractional shares between 20% and 80%, keeping both panes
available while the viewport changes size. At the existing 800 px responsive
breakpoint, the same shares switch from columns to rows and the separator's
pointer and keyboard axis changes with them.

## Serving model

During browser-app development, users open the app through Vite (whose SPA
fallback makes `/doc/<id>` load `index.html`), and Vite proxies `/api` and
`/collab` to the Node.js server. When `app/dist/index.html` exists, the Node.js
target serves the built assets itself and returns `index.html` for `/` and
`/doc/:id`. The Cloudflare target serves the same built assets through Workers
Assets. On either target, the client fetches the document and shows a
not-found page if the API returns 404.

## Preview styles and print snapshots

`app/src/preview/styles.ts` discovers site-owner CSS files through Vite's
eager raw glob import. Filenames supply IDs and labels, avoiding an extra
registration file. CSS is document presentation, confined to the iframe; it
never enters Yjs or the shell's CSS. The browser stores only the selected
ID. The baseline stylesheet remains unchanged and one extra stylesheet is
replaced when a user selects another style. A pending iframe load reapplies
the latest selection. Resize and font readiness events reapply the source
position after reflow. Additional styles propagate source language to preview
and print HTML. Asciidoctor preserves the original untagged HTML language
context to retain the browser’s original font fallback behavior. Shared font
rules for additional styles explicitly name Japanese sans-serif fallbacks
before generic families. Asciidoctor uses its original font rules without
these overrides; Space Cubics keeps the baseline Latin families, while Git
Docs retains its reference site's Latin families. Style selection updates CSS
and the corresponding language context.

Printing separately converts a source/style snapshot captured at click time;
it does not reuse a possibly stale debounced preview or keep following source
updates. The dedicated offscreen iframe uses the same page builder and CSS,
with `allow-same-origin allow-modals` for the parent's print call and no
`allow-scripts`. The editing iframe remains `allow-same-origin` only. Print
assets have a readiness deadline, and `afterprint` removes the document on
completion/cancellation. Printing uses the browser dialog, not a PDF service.

The render traversal flattens description-list term/description pairs
(including missing descriptions) before visiting child blocks; these are not
ordinary flat block arrays in Asciidoctor. This preserves preview conversion
for option lists such as those used in Git manuals.

See [preview styles](preview-styles.md) for style authoring and print limitations.

## TOC navigation

The compact heading rail sits immediately after the source/preview separator.
Its hamburger button opens a TOC column between the rail and preview, giving
source, separator, rail, TOC, preview order without overlapping content or
covering the separator. Closing the outline restores the preview's width.
Pointer hover does not open or close the outline.

The preview container's grid reserves at most 45% of its width for the open
TOC and rail (capped at 308 px), keeping preview usable when the split is narrow.
The source/preview separator resizes source against the rail/TOC/preview area.
On narrow screens source remains above that area, whose left-to-right order
stays rail, TOC, preview. The DOM follows the same order for keyboard navigation.
Existing iframe resize observation restores scroll correspondence after opening
or closing the outline.

Pinning keeps the outline open when focus moves to editing. Unpinning closes
it and returns focus to the hamburger button. Escape also unpins and dismisses
it. Pinning lasts for the current editor session. The toggle and links support
keyboard and touch input.

Section IDs come from the same Asciidoctor AST traversal as source anchors.
The first occurrence of an authored ID is preserved; later duplicate block
IDs receive distinct generated targets so navigation and active highlighting
can distinguish them. This changes rendered targets without editing source.
After the winning preview render loads, the shell reads the corresponding
heading text as plain text. This preserves converter IDs and formatted titles
without inserting user-authored HTML into the shell. The document title is also
included. The outline works without `:toc:` and does not alter the source or
print output. Navigation uses the existing preview-to-source scroll path;
current-section highlighting follows both directions of scroll synchronization.
Heading offsets are cached until rendering, resizing, font readiness, or style
changes invalidate them. Preview scroll events update the active heading in
the scheduled animation callback, using a linear scan of cached offsets.
The compact rail scrolls vertically so pointer users can reach every heading.
CodeMirror receives follow requests through its scroll effect and scroll handler,
so virtual line heights are measured before recording the scroll position used
to suppress feedback.

Prior art: [HackMD note directory documentation](https://hackmd.io/@docs/view-en)
and `ai-context/Screencast From 2026-09-10 11-54-16.mp4`. The recording shows a
heading rail, an indented outline, a pin control, and active-section tracking;
the documentation depicts an older menu layout.
