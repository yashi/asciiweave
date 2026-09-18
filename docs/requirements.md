# Requirements

This document defines the behavior asciiweave must preserve. Implementation
decisions belong in [`architecture.md`](architecture.md); verification strategy
and commands belong in [`testing.md`](testing.md).

## Documents and editing

- `POST /api/documents` creates a document with a random ID and authoritative
  CRDT state containing the initial template.
- `GET /api/documents/<id>` returns the current source together with the
  document ID, revision, and timestamps.
- `/doc/<id>` opens the document, and different IDs never share state.
- CodeMirror supports ordinary editing, line numbers, search, Yjs-aware
  undo/redo, line wrapping, resizing, Unicode, and Japanese text.
- Source text is preserved exactly.
- The split source/preview layout remains usable on desktop and narrow screens.
- The separator resizes the source and preview with pointer or keyboard input,
  preserves a usable minimum for both panes, and adapts to the layout direction.
- `GET /api/documents/<id>/source` exports current source as a `.adoc` file.
- Document read and source-export requests for unknown IDs return `404`.

## Collaboration and persistence

- Browsers on the same document URL converge in real time over WebSockets.
- Browsers on different document URLs never receive each other's updates.
- Each document room has one writer: the Node process locally or a Durable
  Object on Cloudflare.
- Durable state does not depend on a graceful shutdown or an open browser.
- Reconnecting clients converge after disconnection and server restart.
- Stored CRDT state wins over the legacy plain-text fallback.
- Persistence errors and corrupt stored updates must not crash the service.

## Presence

- Display names, colors, remote cursors, selections, and connected-user state
  use Yjs Awareness.
- Awareness is ephemeral and must never be stored as document content.
- A disconnected user's presence disappears promptly.

## Preview

- Preview rendering follows every `Y.Text` change, regardless of whether the
  transaction is local, programmatic, or remote.
- Stale asynchronous conversions must never replace newer output.
- Scrolling the source pane moves the preview to the corresponding rendered
  block without smooth or queued motion. The latest source position wins when
  scroll events arrive rapidly or reverse direction.
- Scrolling the preview moves the source to the corresponding block or
  interpolated line without changing selection or focus. Synchronization must
  not feed scroll events back into the pane being scrolled.
- Treat rendered document content as untrusted. Keep it in a sandboxed iframe
  with `allow-same-origin` only so the parent can synchronize its scroll
  position. Keep scripts disabled by both the sandbox and a restrictive
  content security policy.
- Do not allow arbitrary server-side `include::` access to the filesystem.
- Render `[d2]` listing blocks locally in the browser, including in print
  snapshots. Preserve block titles and source anchors. Preserve the original
  D2 text in source exports.
- Show D2 errors alongside the affected block's source without hiding other
  document content.
- Keep `[source,d2]` blocks as code listings.

## Preview styles and printing

- The visible Preview style selector includes Asciidoctor, Space Cubics, Git Docs,
  and CSS files added by the site owner before building/deploying.
- Asciidoctor remains the default. Invalid or removed saved style IDs fall back to
  Asciidoctor. Storage failures do not prevent editing or style selection.
- Selection is a browser-local preference, separate from source and Awareness.
- Switching styles preserves the content, source anchors, source scroll
  correspondence, undo history, and plain-source export.
- Print / Save as PDF prepares the latest source and selected style as a fixed
  snapshot and opens the browser print dialog. Assets must be ready; preparation
  failures appear in an alert region. Cancellation cleans up the print document.
  Printing waits for the first synchronization, then remains available offline.
- The print iframe permits modals for printing but keeps scripts disabled. The
  editing preview retains its existing sandbox restrictions.
- Cover pages and exact Ruby PDF pagination are outside the implemented scope.

## Operations

- `GET /api/health` reports the running commit and verifies database access.
- It returns `200` with `ok: true` when database access succeeds and `503` with
  `ok: false` when database access fails.

## Table of contents navigation

- The closed layout is source, splitter, TOC rail, preview. The outline
  contains the document title and parsed sections, even without `:toc:`.
- Clicking the hamburger button opens a separate TOC column, giving source,
  splitter, TOC rail, TOC, preview order. Closing restores the preview width.
  The button supports keyboard and touch; hover does not open or close it.
- Pinning keeps the TOC open when focus moves outside it. Unpinning closes it;
  Escape unpins and dismisses it. The split slider stays usable in each state.
- On narrow screens, source stays above the rail/TOC/preview row, which keeps
  the same left-to-right order and remains within the viewport.
- Clicking a compact rail mark or selecting an outline heading scrolls the
  preview and source without editing the document. The active heading follows
  scrolling in either pane.
- The outline updates with rendered local and remote changes and remains
  usable on narrow screens. Heading labels remain plain text in the shell.
