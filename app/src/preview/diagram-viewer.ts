export function createDiagramViewer(focusPreview: () => void) {
  const dialog = document.createElement('dialog')
  dialog.className = 'diagram-viewer'
  dialog.setAttribute('aria-label', 'Enlarged diagram')
  dialog.innerHTML = `
    <div class="diagram-viewer-titlebar">
      <button type="button" class="diagram-viewer-move" aria-label="Move diagram viewer"
        title="Drag to move, or use arrow keys"></button>
      <button type="button" data-action="close" autofocus>Close</button>
    </div>
    <div class="diagram-viewer-toolbar">
      <button type="button" aria-label="Zoom out">−</button>
      <output aria-live="polite"></output>
      <button type="button" aria-label="Zoom in">+</button>
      <button type="button" data-action="fit">Fit</button>
      <button type="button" data-action="actual">Actual size</button>
    </div>
    <div class="diagram-viewer-viewport" tabindex="0" aria-label="Diagram">
      <img alt="">
    </div>
    <button type="button" class="diagram-viewer-resize" aria-label="Resize diagram viewer"
      title="Drag to resize, or use arrow keys">↘</button>`
  document.body.appendChild(dialog)
  const title = dialog.querySelector<HTMLButtonElement>('.diagram-viewer-move')!
  const viewport = dialog.querySelector<HTMLElement>('.diagram-viewer-viewport')!
  const image = dialog.querySelector('img')!
  const output = dialog.querySelector('output')!
  const zoomOut = dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!
  const zoomIn = dialog.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!
  let origin: HTMLImageElement | undefined
  let width = 1
  let height = 1
  let scale = 1
  let detach = () => {}
  let fitting = false
  const bounds = {
    left: 16,
    top: 64,
    width: window.innerWidth <= 800 ? window.innerWidth - 32 : window.innerWidth * 0.48,
    height: Math.min(520, window.innerHeight * 0.65),
  }

  const layout = () => {
    const availableWidth = Math.max(1, window.innerWidth - 16)
    const availableHeight = Math.max(1, window.innerHeight - 16)
    bounds.width = Math.min(availableWidth, Math.max(300, bounds.width))
    bounds.height = Math.min(availableHeight, Math.max(180, bounds.height))
    bounds.left = Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8))
    bounds.top = Math.max(8, Math.min(bounds.top, window.innerHeight - bounds.height - 8))
    Object.assign(dialog.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    })
  }
  layout()
  window.addEventListener('resize', layout)

  for (const [handle, resizing] of [
    [title, false],
    [dialog.querySelector<HTMLButtonElement>('.diagram-viewer-resize')!, true],
  ] as const) {
    let start: { x: number; y: number; bounds: typeof bounds } | undefined
    const adjust = (initial: typeof bounds, dx: number, dy: number) => {
      if (resizing) {
        bounds.width = Math.min(initial.width + dx, window.innerWidth - bounds.left - 8)
        bounds.height = Math.min(initial.height + dy, window.innerHeight - bounds.top - 8)
      } else {
        bounds.left = initial.left + dx
        bounds.top = initial.top + dy
      }
      layout()
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      handle.focus()
      start = { x: event.clientX, y: event.clientY, bounds: { ...bounds } }
      handle.setPointerCapture(event.pointerId)
    })
    handle.addEventListener('pointermove', (event) => {
      if (!start || !handle.hasPointerCapture(event.pointerId)) return
      adjust(start.bounds, event.clientX - start.x, event.clientY - start.y)
    })
    const release = (event: PointerEvent) => {
      start = undefined
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    }
    handle.addEventListener('pointerup', release)
    handle.addEventListener('pointercancel', release)
    handle.addEventListener('lostpointercapture', () => (start = undefined))
    handle.addEventListener('keydown', (event) => {
      const dx = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      const dy = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
      if (!dx && !dy) return
      event.preventDefault()
      const step = event.shiftKey ? 40 : 10
      adjust({ ...bounds }, dx * step, dy * step)
    })
  }

  const zoom = (value: number) => {
    fitting = false
    scale = Math.min(8, Math.max(0.05, value))
    image.style.width = `${width * scale}px`
    image.style.height = `${height * scale}px`
    output.value = `${Math.round(scale * 100)}%`
    zoomOut.disabled = scale <= 0.05
    zoomIn.disabled = scale >= 8
  }
  const fit = () => {
    zoom(Math.min(1, viewport.clientWidth / width, viewport.clientHeight / height))
    fitting = true
    viewport.scrollTo(0, 0)
  }
  const observer = new ResizeObserver(() => {
    if (dialog.open && fitting) fit()
  })
  observer.observe(viewport)
  zoomOut.addEventListener('click', () => zoom(scale / 1.25))
  zoomIn.addEventListener('click', () => zoom(scale * 1.25))
  dialog.querySelector('[data-action="fit"]')!.addEventListener('click', fit)
  dialog.querySelector('[data-action="actual"]')!.addEventListener('click', () => zoom(1))
  dialog.querySelector('[data-action="close"]')!.addEventListener('click', () => dialog.close())
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    dialog.close()
  })
  dialog.addEventListener('close', () => {
    image.removeAttribute('src')
    if (origin?.isConnected) origin.focus({ preventScroll: true })
    else focusPreview()
    origin = undefined
  })

  return {
    attach(doc: Document, selector: string) {
      detach()
      const listeners = new AbortController()
      detach = () => listeners.abort()
      const style = doc.createElement('style')
      style.textContent = `
        .diagram-enlarge { cursor: zoom-in; }
        .diagram-enlarge:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
      `
      doc.head.appendChild(style)
      for (const source of doc.querySelectorAll<HTMLImageElement>(selector)) {
        source.classList.add('diagram-enlarge')
        source.setAttribute('role', 'button')
        source.tabIndex = 0
        source.setAttribute('aria-label', `Enlarge ${source.alt || 'diagram'}`)
        source.title = 'Click to enlarge'
        const open = () => {
          // Read dimensions in an inert document. SVG markup stays inside
          // an image, including while the dialog displays it at full size.
          const prefix = 'data:image/svg+xml;charset=utf-8,'
          if (!source.src.startsWith(prefix)) return
          const svg = new DOMParser().parseFromString(
            decodeURIComponent(source.src.slice(prefix.length)),
            'image/svg+xml',
          ).documentElement
          const box = svg
            .getAttribute('viewBox')
            ?.trim()
            .split(/[\s,]+/)
            .map(Number)
          width = box?.[2] || source.naturalWidth
          height = box?.[3] || source.naturalHeight
          if (![width, height].every((size) => Number.isFinite(size) && size > 0)) return
          origin = source
          title.textContent = source.alt
          image.alt = source.alt
          image.src = source.src
          dialog.show()
          zoom(1)
          viewport.scrollTo(0, 0)
          dialog.querySelector<HTMLButtonElement>('[data-action="close"]')!.focus()
        }
        source.addEventListener('click', open, { signal: listeners.signal })
        source.addEventListener(
          'keydown',
          (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            open()
          },
          { signal: listeners.signal },
        )
      }
    },
    detach() {
      detach()
    },
    dispose() {
      detach()
      observer.disconnect()
      window.removeEventListener('resize', layout)
      dialog.remove()
    },
  }
}
