let queue: Promise<unknown> = Promise.resolve()
let sequence = 0
const cache = new Map<string, string>()

export function renderMermaid(source: string, signal?: AbortSignal): Promise<string> {
  const result = queue.then(async () => {
    signal?.throwIfAborted()
    const cached = cache.get(source)
    if (cached !== undefined) return cached

    const { default: mermaid } = await import('mermaid')
    signal?.throwIfAborted()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      fontFamily: 'sans-serif',
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'dompurifyConfig',
        'htmlLabels',
        'flowchart',
        'themeCSS',
      ],
    })

    // Mermaid measures text in the DOM. Keep the temporary diagram offscreen
    // and remove it even when parsing or rendering fails.
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none'
    document.body.appendChild(container)
    try {
      const { svg } = await mermaid.render(`asciiweave-mermaid-${++sequence}`, source, container)
      cache.set(source, svg)
      if (cache.size > 32) cache.delete(cache.keys().next().value!)
      signal?.throwIfAborted()
      return svg
    } finally {
      container.remove()
    }
  })
  // Mermaid has shared configuration and DOM state. Let active work finish
  // before starting another diagram, including a concurrent print snapshot.
  queue = result.catch(() => {})
  return result
}

export interface MermaidBlock {
  id: string
  source: string
}

export async function renderMermaidBlocks(
  html: string,
  blocks: MermaidBlock[],
  signal?: AbortSignal,
): Promise<string> {
  if (blocks.length === 0) return html
  const template = document.createElement('template')
  template.innerHTML = html
  await Promise.all(
    blocks.map(async ({ id, source }) => {
      const block = template.content.getElementById(id)
      const content = block?.querySelector('.content')
      if (!block || !content) return
      try {
        const svg = await renderMermaid(source, signal)
        const image = document.createElement('img')
        image.alt = block.querySelector('.title')?.textContent || 'Mermaid diagram'
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        content.replaceChildren(image)
        block.classList.replace('listingblock', 'imageblock')
        block.classList.add('mermaid-diagram')
      } catch (error) {
        signal?.throwIfAborted()
        const message = document.createElement('pre')
        message.className = 'mermaid-error'
        message.setAttribute('role', 'alert')
        message.textContent = `Mermaid error: ${error instanceof Error ? error.message : String(error)}`
        content.prepend(message)
      }
    }),
  )
  return template.innerHTML
}
