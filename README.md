# asciiweave

A HackMD-like collaborative web editor for AsciiDoc. Create a document, get a
stable shareable URL, edit AsciiDoc source in CodeMirror 6 on the left, and see
the live Asciidoctor.js preview on the right. When the document is ready, copy
the plain `.adoc` source into your own Git repository — Git integration is
intentionally not part of asciiweave.

Everyone who opens the same `/doc/<id>` URL edits the same document in real
time, with named, colored remote cursors and selections and a connected-user
indicator. The live document is a Yjs `Y.Text` synchronized over WebSockets
(`y-websocket`); the durably persisted CRDT state on the server is the one
authoritative store, and each browser renders its own preview locally. Plain
`.adoc` source is derived data, available from
`GET /api/documents/<id>/source` for committing to Git. See
`AGENTS.md` for implementation constraints.

asciiweave has two server targets sharing the same application code:

| Target              | Runtime         | Persistent database |
| ------------------- | --------------- | ------------------- |
| Local / on-premises | Node.js >= 26   | `node:sqlite` file  |
| Cloudflare          | Workers runtime | D1 binding          |

## Using asciiweave

After starting either server target, open its base URL and:

1. Select **New document** to create a document with a stable random URL.
2. Edit AsciiDoc in the left pane and check the rendered preview on the right.
3. Drag the separator, or focus it and use the arrow keys, to resize the panes.
4. Set a display name to make your cursor identifiable to collaborators.
5. Share the complete `/doc/<id>` URL with another person who can access the
   same deployment. Everyone at that URL edits the same document.

The topbar reports `Synced`, `Connecting…`, or `Offline`. Do not close an
offline tab with unshared edits: offline changes live only in that tab until it
reconnects.

Choose **Preview style** to switch between Asciidoctor, Space Cubics, Git Docs,
and styles added by your site owner. **Print / Save as PDF** opens the browser
print dialog for the current document and style. See [styles and PDF output](docs/preview-styles.md)
for print settings and how to add a CSS file before deployment.

There is not yet a visible source download control. To download the current AsciiDoc
source, open `/api/documents/<id>/source` on the same deployment.

## D2 diagrams

Use a `[d2]` block to render a diagram in the preview and printed output:

```asciidoc
.Request flow
[d2]
----
browser -> server: request
server -> database: query
----
```

asciiweave loads the D2 renderer when you first preview or print a D2 block.
The renderer compiles diagrams in your browser. If a diagram fails to render,
the preview shows the error above that block's source.
The `.adoc` download preserves the original D2 text.

Use `[source,d2]` to display D2 as code instead of a diagram.

The preview embeds SVG output as images. Diagram links are not clickable.
asciiweave does not support external file imports or external icons in D2 blocks.

## Security and access

asciiweave does not currently implement application-level authentication,
authorization, document ownership, or read-only sharing. Anyone who can reach
a deployment can create documents, and anyone who knows a document URL can
view, edit, and export it. Random document IDs are not an access-control
mechanism.

Before exposing asciiweave beyond a trusted network, put the entire application
behind an access-control gateway or authenticating reverse proxy. The Space
Cubics deployment at <https://asciiweave.spacecubics.org> is protected by
Cloudflare Access and is available only to Space Cubics employees.

## Documentation

- [Behavioral requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Testing](docs/testing.md)
- [Preview styles and PDF output](docs/preview-styles.md)
- [Node.js deployment](docs/deployment-node.md)
- [Space Cubics Cloudflare deployment](docs/deployment-cloudflare.md)
- [Durable Objects duration: incident and fix plan](docs/durable-objects-duration.md)

## Development

```sh
npm install
npm run dev
```

`npm run dev` starts the API server on <http://localhost:8787> and the Vite
dev server on <http://localhost:5173> (open the Vite URL; it proxies `/api` and
`/collab`).

## Production build

```sh
npm run build
npm start
```

`npm start` serves the built app and the API on <http://localhost:8787>.
See the [Node.js deployment guide](docs/deployment-node.md) before exposing it
as a service.

Configuration via environment variables:

| Variable        | Default              | Meaning                   |
| --------------- | -------------------- | ------------------------- |
| `PORT`          | `8787`               | HTTP port                 |
| `ASCIIWEAVE_DB` | `data/asciiweave.db` | SQLite database location  |
| `GIT_COMMIT`    | `dev`                | Reported by `/api/health` |

The npm scripts read these variables from their process environment;
`.env.example` lists the names but is not loaded automatically. The server
applies pending SQL migrations from `migrations/` at startup; `npm run
db:status` and `npm run db:migrate` run them by hand against
`ASCIIWEAVE_DB`.

## Tests and checks

```sh
npm test              # Vitest: API, persistence, render scheduler, CRDT durability
npm run test:workers  # same storage contract against local D1 in workerd
npm run test:e2e      # Playwright: real-browser end-to-end tests
npm run typecheck     # tsc: Node/browser project + Workers project
npm run lint          # ESLint
npm run format:check  # Prettier validation without modifying files
```

Run `npm run format` to rewrite supported files with Prettier.

## Layout

```
app/         browser application (CodeMirror editor, Asciidoctor preview)
server/      HTTP API, collaboration, and persistence (Node + Worker)
migrations/  numbered SQL migrations shared by SQLite and D1
e2e/         Playwright end-to-end tests
docs/        requirements, architecture, testing, and deployment notes
```

## Potential productization work

Possible future improvements include:

- authentication;
- read/write permissions;
- document ownership;
- document lists and recent documents;
- document titles;
- public/private sharing;
- revision history and named snapshots;
- comments;
- visible copy and `.adoc` download controls;
- better AsciiDoc syntax highlighting;
- a document outline;
- keyboard configuration and expanded Emacs-style CodeMirror bindings;
- images and attachments;
- secure `include::` support;
- `xref` navigation;
- Antora-aware preview;
- Teamtype integration;
- native Emacs or VS Code collaboration;
- operational monitoring, backups, and scaling.

These are candidates, not instructions to implement them all. Each substantial
feature should be requested and reviewed separately. Includes and attachments
need an explicit resource and path security model before implementation.

## Current non-goals

Unless explicitly requested as future work, asciiweave does not include:

- Git, GitHub, or GitLab integration;
- automatic commits or repository checkout;
- Antora site generation;
- Markdown or WYSIWYG editing;
- custom CRDT or OT algorithms;
- AsciiDoc-aware CRDT operations;
- AI writing features;
- organizations or billing.
