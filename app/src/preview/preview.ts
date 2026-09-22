import { createToc } from './toc'
import { load, type AbstractBlock, type Block } from '@asciidoctor/core'
import { createRenderScheduler, type RenderScheduler } from './scheduler'
import { sourceLineForPosition, sourceSpanForLine, type SourceAnchor } from './scroll-sync'
import { applyStyle, previewPage } from './page'
import { defaultStyle, type PreviewStyle } from './styles'
import { renderD2Blocks, type D2Block } from './d2'
import { renderMermaidBlocks, type MermaidBlock } from './mermaid'
import { createDiagramViewer } from './diagram-viewer'

interface RenderedPreview {
  html: string
  anchors: SourceAnchor[]
  headingIds: string[]
  language?: string
}

interface TableCell {
  getLineNumber(): number | null
}

interface TableBlock extends AbstractBlock {
  rows: {
    bySection(): Array<[string, TableCell[][]]>
  }
}

interface TableRowTargets {
  tableId: string
  rowIds: Array<string | undefined>
}

export interface Preview extends RenderScheduler {
  setStyle(style: PreviewStyle): void
  /** Follow the first visible source line in the rendered preview. */
  scrollToSourceLine(line: number, atEnd: boolean): void
}

let renderSequence = 0

// The parent needs same-origin DOM access to position the preview without
// fragment navigations. Scripts remain disabled by both the sandbox and CSP;
// nested frames, plugins, and form submissions are blocked as well.
export function createPreview(
  container: HTMLElement,
  initialStyle = defaultStyle,
  onScroll?: (line: number, atEnd: boolean) => void,
): Preview {
  const iframe = document.createElement('iframe')
  iframe.className = 'preview-frame'
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.title = 'AsciiDoc preview'
  container.appendChild(iframe)
  const diagramViewer = createDiagramViewer(() => iframe.focus())

  const toc = createToc(container, (id) => {
    const target = iframe.contentDocument?.getElementById(id)
    const scroller = iframe.contentDocument?.scrollingElement
    if (!target || !scroller) return
    if (followFrame !== undefined) cancelAnimationFrame(followFrame)
    followFrame = undefined
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame)
    previewFrame = undefined
    requestedLine = rendered?.anchors.find((anchor) => anchor.id === id)?.line ?? 1
    requestedEnd = false
    scroller.scrollTop += target.getBoundingClientRect().top
    followedTop = scroller.scrollTop
    onScroll?.(requestedLine, false)
    updateActiveHeading()
  })
  let headings: HTMLElement[] = []
  let headingPositions: { id: string; top: number }[] | undefined
  const updateActiveHeading = (): void => {
    const scroller = scrollDocument?.scrollingElement
    if (!scroller) return
    const top = scroller.scrollTop
    headingPositions ??= headings.map((heading) => ({
      id: heading.id,
      top: heading.getBoundingClientRect().top + top,
    }))
    // Short final sections cannot reach the viewport top.
    if (top > 0 && top + scroller.clientHeight >= scroller.scrollHeight - 1) {
      const last = headingPositions[headingPositions.length - 1]
      if (last) toc.setActive(last.id)
      return
    }
    let active = headingPositions[0]
    for (const heading of headingPositions) {
      if (heading.top > top + 8) break
      active = heading
    }
    if (active) toc.setActive(active.id)
  }

  let style = initialStyle

  let rendered: RenderedPreview | undefined
  let iframeLoaded = false
  let requestedLine = 1
  let requestedEnd = false
  let disposed = false
  let followFrame: number | undefined
  let pendingPageLoad: (() => void) | undefined
  let contentObserver: ResizeObserver | undefined
  let scrollDocument: Document | undefined
  let followedTop: number | undefined
  let previewFrame: number | undefined

  let positions: { line: number; top: number }[] | undefined

  const previewScrolled = (): void => {
    const top = scrollDocument?.scrollingElement?.scrollTop
    if (top === undefined || (followedTop !== undefined && Math.abs(top - followedTop) < 1)) return
    followedTop = undefined
    if (followFrame !== undefined) {
      cancelAnimationFrame(followFrame)
      followFrame = undefined
    }
    if (previewFrame !== undefined || disposed) return
    previewFrame = requestAnimationFrame(() => {
      previewFrame = undefined
      const frameDocument = scrollDocument
      const scroller = frameDocument?.scrollingElement
      if (!frameDocument || !scroller || !rendered || !iframeLoaded) return
      updateActiveHeading()
      positions ??= rendered.anchors.flatMap((anchor) => {
        const element = frameDocument.getElementById(anchor.id)
        return element
          ? [{ line: anchor.line, top: element.getBoundingClientRect().top + scroller.scrollTop }]
          : []
      })
      const line = sourceLineForPosition(positions, scroller.scrollTop)
      if (line === undefined) return
      requestedLine = line
      requestedEnd =
        scroller.scrollTop > 0 &&
        scroller.scrollTop + (iframe.contentWindow?.innerHeight ?? 0) >= scroller.scrollHeight - 1
      onScroll?.(line, requestedEnd)
    })
  }

  const followSource = (): void => {
    if (!rendered || !iframeLoaded) {
      return
    }

    const frameWindow = iframe.contentWindow
    const frameDocument = iframe.contentDocument
    const scrollingElement = frameDocument?.scrollingElement
    if (!frameWindow || !frameDocument || !scrollingElement) {
      return
    }

    const span = sourceSpanForLine(rendered.anchors, requestedLine, requestedEnd)
    const maximum = Math.max(0, scrollingElement.scrollHeight - frameWindow.innerHeight)
    let top = 0

    if (span.atEnd) {
      top = maximum
    } else if (span.before) {
      const before = frameDocument.getElementById(span.before.id)
      if (!before) {
        return
      }
      top = before.getBoundingClientRect().top + frameWindow.scrollY

      if (span.after) {
        const after = frameDocument.getElementById(span.after.id)
        if (after) {
          const afterTop = after.getBoundingClientRect().top + frameWindow.scrollY
          top += (afterTop - top) * span.progress
        }
      }
    }

    // Assigning scrollTop is synchronous and ignores CSS smooth-scrolling
    // behavior, so user-authored styles cannot leave animation work queued.
    scrollingElement.scrollTop = Math.min(Math.max(top, 0), maximum)
    followedTop = scrollingElement.scrollTop
    updateActiveHeading()
  }

  const scheduleFollowSource = (): void => {
    if (disposed || followFrame !== undefined) {
      return
    }

    // Mouse-wheel and scrollbar events can arrive faster than a paint. Apply
    // only the newest source position once per frame, without queued motion.
    followFrame = requestAnimationFrame(() => {
      followFrame = undefined
      followSource()
    })
  }

  const layoutChanged = (): void => {
    positions = undefined
    headingPositions = undefined
    scheduleFollowSource()
  }

  const loadPage = (preview: RenderedPreview): void => {
    diagramViewer.detach()
    if (pendingPageLoad) {
      iframe.removeEventListener('load', pendingPageLoad)
    }
    contentObserver?.disconnect()
    scrollDocument?.removeEventListener('scroll', previewScrolled)
    scrollDocument = undefined
    followedTop = undefined
    if (previewFrame !== undefined) {
      cancelAnimationFrame(previewFrame)
      previewFrame = undefined
    }

    positions = undefined
    headingPositions = undefined
    rendered = preview
    iframeLoaded = false
    pendingPageLoad = () => {
      pendingPageLoad = undefined
      iframeLoaded = true
      if (iframe.contentDocument) {
        scrollDocument = iframe.contentDocument
        diagramViewer.attach(scrollDocument, '.mermaid-diagram img')
        // Use only converter section headings and the document title. Raw
        // passthrough headings and inline TOC entries are not sections.
        headings = (rendered?.headingIds ?? []).flatMap((id) => {
          const heading = scrollDocument?.getElementById(id)
          return heading ? [heading] : []
        })
        toc.setHeadings(
          headings.map((heading) => ({
            id: heading.id,
            level: Number(heading.tagName.slice(1)),
            label: heading.textContent ?? '',
          })),
        )
        scrollDocument.addEventListener('scroll', previewScrolled)
        applyStyle(iframe.contentDocument, style, rendered?.language)
        void iframe.contentDocument.fonts.ready.then(layoutChanged)
      }
      followSource()

      const body = iframe.contentDocument?.body
      if (body) {
        contentObserver = new ResizeObserver(layoutChanged)
        contentObserver.observe(body)
      }
    }
    iframe.addEventListener('load', pendingPageLoad, { once: true })
    iframe.srcdoc = previewPage(preview.html, style, preview.language)
  }

  const iframeObserver = new ResizeObserver(layoutChanged)
  iframeObserver.observe(iframe)

  const scheduler = createRenderScheduler(renderPreview, loadPage, (error) => {
    const message = error instanceof Error ? error.message : String(error)
    const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    loadPage({
      html: `<div class="admonitionblock caution"><p>Preview error: ${escaped}</p></div>`,
      anchors: [],
      headingIds: [],
    })
  })

  return {
    ...scheduler,
    setStyle(nextStyle) {
      style = nextStyle
      if (iframeLoaded && iframe.contentDocument) {
        applyStyle(iframe.contentDocument, style, rendered?.language)
        void iframe.contentDocument.fonts.ready.then(layoutChanged)
      }
      layoutChanged()
    },
    scrollToSourceLine(line, atEnd) {
      if (previewFrame !== undefined) {
        cancelAnimationFrame(previewFrame)
        previewFrame = undefined
      }
      requestedLine = line
      requestedEnd = atEnd
      scheduleFollowSource()
    },
    dispose() {
      disposed = true
      scheduler.dispose()
      toc.dispose()
      diagramViewer.dispose()
      if (followFrame !== undefined) {
        cancelAnimationFrame(followFrame)
      }
      if (pendingPageLoad) {
        iframe.removeEventListener('load', pendingPageLoad)
      }
      iframeObserver.disconnect()
      contentObserver?.disconnect()
      scrollDocument?.removeEventListener('scroll', previewScrolled)
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame)
    },
  }
}

export async function renderPreview(
  source: string,
  signal?: AbortSignal,
): Promise<RenderedPreview> {
  const document = await load(source, {
    attributes: { showtitle: true },
    sourcemap: true,
  })
  signal?.throwIfAborted()
  const prefix = `asciiweave-source-${++renderSequence}`
  const anchors: SourceAnchor[] = []
  const titleId = `${prefix}-title`
  const headingIds: string[] = document.hasHeader() ? [titleId] : []
  const tableRowTargets: TableRowTargets[] = []
  const diagrams: D2Block[] = []
  const mermaidDiagrams: MermaidBlock[] = []
  let generatedId = 0
  const assignedIds = new Set([titleId])
  const nextId = (): string => {
    let id: string
    do {
      id = `${prefix}-${++generatedId}`
    } while (assignedIds.has(id))
    assignedIds.add(id)
    return id
  }

  const visit = (blocks: AbstractBlock[]): void => {
    for (const block of blocks) {
      const context = block.getContext()
      const line = block.getLineNumber()
      let blockId: string | undefined

      // Preambles have a fixed converter ID, and list items share their first
      // line with the containing list. Their child blocks are still visited.
      if (line !== undefined && context !== 'preamble' && context !== 'list_item') {
        blockId = block.getId()
        // Preserve the first occurrence for authored fragment links. Later
        // duplicate IDs need distinct targets for TOC and scroll mapping.
        if (!blockId || assignedIds.has(blockId)) {
          blockId = nextId()
          block.setId(blockId)
        }
        assignedIds.add(blockId)
        anchors.push({ line, id: blockId })
        if (context === 'section') headingIds.push(blockId)
      }

      if (context === 'listing' && block.getStyle() === 'd2' && blockId) {
        diagrams.push({ id: blockId, source: (block as Block).getSource() })
      }
      if (context === 'listing' && block.getStyle() === 'mermaid' && blockId) {
        mermaidDiagrams.push({ id: blockId, source: (block as Block).getSource() })
      }

      if (context === 'table' && blockId) {
        const rowIds: Array<string | undefined> = []
        for (const [, rows] of (block as TableBlock).rows.bySection()) {
          for (const row of rows) {
            const lines = new Set(
              row
                .map((cell) => cell.getLineNumber())
                .filter((cellLine): cellLine is number => cellLine !== null),
            )
            if (lines.size === 0) {
              rowIds.push(undefined)
              continue
            }

            const rowId = nextId()
            rowIds.push(rowId)
            for (const cellLine of lines) {
              anchors.push({ line: cellLine, id: rowId })
            }
          }
        }
        tableRowTargets.push({ tableId: blockId, rowIds })
      }
      // Description lists return [[terms], description] entries, with null
      // for an absent description, rather than a flat array of blocks.
      const children = block.getBlocks()
      visit(context === 'dlist' ? children.flat(2).filter(Boolean) : children)
    }
  }
  visit(document.getBlocks())
  anchors.sort((left, right) => left.line - right.line)

  return {
    html: await renderMermaidBlocks(
      await renderD2Blocks(
        addTableRowAnchors(
          (await document.convert({ standalone: false })).replace(/^<h1>/, `<h1 id="${titleId}">`),
          tableRowTargets,
        ),
        diagrams,
        signal,
      ),
      mermaidDiagrams,
      signal,
    ),
    anchors,
    headingIds,
    language: String(document.getAttribute('lang', '')),
  }
}

function addTableRowAnchors(html: string, targets: TableRowTargets[]): string {
  if (targets.length === 0) {
    return html
  }

  // Template contents are inert, so user-authored markup is not executed in
  // the application while row IDs are added for the script-disabled preview.
  const template = document.createElement('template')
  template.innerHTML = html
  const tables = Array.from(template.content.querySelectorAll('table'))

  for (const target of targets) {
    const table = tables.find((element) => element.id === target.tableId)
    if (!table) {
      continue
    }

    const rows = Array.from(table.children).flatMap((section) =>
      ['THEAD', 'TBODY', 'TFOOT'].includes(section.tagName)
        ? Array.from(section.children).filter((element) => element.tagName === 'TR')
        : [],
    )
    target.rowIds.forEach((rowId, index) => {
      if (rowId && rows[index]) {
        rows[index].id = rowId
      }
    })
  }

  return template.innerHTML
}
