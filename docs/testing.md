# Testing

Automated tests should cover behavior, not just component existence. The test
suite spans the browser application, Node server, Cloudflare Worker, SQLite,
D1, and real multi-browser collaboration.

## Test layers

| Command                | Coverage                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Browser-independent application logic, API behavior, SQLite persistence, collaboration rooms, and CRDT durability |
| `npm run test:workers` | The shared storage contract against local D1 and Worker API behavior in workerd                                   |
| `npm run test:e2e`     | Real-browser editing, preview, collaboration, presence, room isolation, and restart durability                    |
| `npm run typecheck`    | Node/browser and Worker TypeScript projects                                                                       |
| `npm run lint`         | ESLint checks across the repository                                                                               |
| `npm run format:check` | Prettier formatting without modifying files                                                                       |
| `npm run build`        | Production browser bundle                                                                                         |

The storage layer has one behavioral contract suite
(`server/tests/store-contract.ts`) that runs against both databases:
`npm test` covers `node:sqlite`, and `npm run test:workers` covers D1.

The shared API contract (`server/tests/api-contract.ts`) runs the same
document creation, read, health, source resolution, and export scenarios
against both stores, using each runtime's Yjs codec. These tests exercise
`createApp` directly; they do not cover Worker entry-point routing or Durable
Object integration.

## Continuous integration

Node.js checks and deployment workflows share
`.github/actions/setup-node/action.yml`. Callers must check out the repository
before using this local composite action. It selects Node.js from `.nvmrc`,
caches npm downloads, and runs `npm ci` separately in every job.

Deployment callers share `.github/workflows/deploy.yml` for validation, build,
migration, deployment, and health checks. They retain separate triggers and
concurrency groups; the production runner job retains its GitHub environment.
See [the deployment runbook](deployment-cloudflare.md) for target and secret
handling.

`server/tests/deployment-smoke.test.ts` exercises the deployment health-check
script with simulated HTTP responses, including a previous commit followed by
the deployed commit and exhausted retries. It runs under `npm test` and needs
Bash and `jq` (both are preinstalled on the deployment's Ubuntu runner):

```sh
npm test -- server/tests/deployment-smoke.test.ts
```

## Coverage expectations

Preserve coverage for:

- unique stable document IDs and room isolation;
- SQLite and D1 storage through their shared contract suite;
- Unicode and Japanese round trips;
- CodeMirror/`Y.Text` synchronization and Yjs-aware undo/redo;
- local and remote preview updates and stale-render rejection;
- scrolling in both directions, including rapid reversals, layout changes,
  fragment navigation, and suppression of synchronization feedback;
- concurrent edits, disconnection, reconnection, and convergence;
- awareness rendering and cleanup;
- pointer, keyboard, and responsive pane resizing;
- CRDT restoration, corrupt-state fallback, and restart durability;
- plain `.adoc` export;
- both Node and Cloudflare implementations.

Add or update tests whenever behavior changes. Prefer assertions on observable
behavior over checks that a component, function, or file merely exists.

## Collaboration tests

Shared browser helpers in `e2e/helpers.ts` handle document creation,
independent editor pairs, and source reads. Keyboard editing and direct Yjs
transactions remain separate operations. Document creation accepts a custom
base URL so durability tests can keep using their private server.

At least one collaboration test must use independent real browser clients;
mocked WebSocket unit tests alone are insufficient. Exercise actual concurrent
operations, temporary disconnection, reconnection, convergence, and isolation
between different document IDs.

`main.ts` exposes `window.__asciiweave` as an integration-test hook so tests
can apply Yjs transactions outside CodeMirror, control the connection,
verify convergence, and read selection anchor/head offsets independently of
CodeMirror viewport virtualization.

Durability coverage has two complementary layers:

- `server/tests/durability.test.ts` fuzzes persistence with seeded random
  mixed-script edits, restore chains, and multi-peer divergence.
- `e2e/durability.spec.ts` manages its own server and database so it can
  SIGKILL the server mid-session, restart it, and verify restoration and client
  reconvergence, including for a pre-CRDT legacy database.

The Playwright suite builds the app and starts the Node.js server on a temporary
database automatically. Install its browser once before the first run:

```sh
npx playwright install chromium
```

## Validation sequence

Run the checks appropriate to the scope of a change. The complete sequence is:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:workers
npm run build
npm run test:e2e
```

## Preview styles

`app/tests/preferences.test.ts` covers unavailable storage and rejected
operations. `app/tests/styles.test.ts` covers discovery, invalid/removed
selections, language context, and CSS serialization.
`e2e/description-lists.spec.ts` covers term/description traversal, including
missing descriptions.

`e2e/style-selection.spec.ts` covers preferences, collaboration, scrolling,
language context, keyboard access, and script isolation. It uses two test
styles created by `e2e/build.ts` and removed after building. Normal production
builds do not include these styles.

`e2e/styles.spec.ts` covers sample appearance, actual Japanese glyph fonts in
screen and print modes, and print snapshot isolation and cleanup. Its fixture
is `e2e/fixtures/styles.adoc`. Print-dialog interception checks prepared
content without saving to the user's filesystem; actual browser PDF output
and page breaks additionally need visual review with the settings in
[preview-styles.md](preview-styles.md).

## TOC navigation

`e2e/toc.spec.ts` covers heading hierarchy, formatted Japanese labels, explicit
and duplicate IDs, literal code-block headings, navigation in both panes,
active-section tracking, clickable rail marks, click-only menu toggling, pinning,
keyboard dismissal, live outline replacement, and narrow-screen access. It also checks that the
layout follows source, splitter, rail, TOC, preview order when open, restores
preview space on close, unpin, or Escape, and leaves the splitter accessible.
Additional regressions cover duplicate authored IDs with distinct navigation
and one active entry, wheel access to the last rail mark on a narrow viewport,
and cached heading geometry with deferred scroll-event processing and layout
invalidation. Run it with the scroll regression tests:

```sh
npm run test:e2e -- e2e/toc.spec.ts e2e/preview-scroll.spec.ts
```
