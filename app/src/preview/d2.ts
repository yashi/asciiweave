import type { D2 } from '@d2lang/d2'

let engine: D2 | undefined
let queue: Promise<unknown> = Promise.resolve()
const cache = new Map<string, Promise<string>>()

export function renderD2(source: string): Promise<string> {
  const cached = cache.get(source)
  if (cached) return cached

  const result = queue.then(async () => {
    let current: D2 | undefined
    let expired = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const { D2 } = await import('@d2lang/d2')
          if (expired) throw new Error('D2 rendering timed out')
          current = engine ??= new D2()
          const compiled = await current.compile(source)
          if (expired) throw new Error('D2 rendering timed out')
          return current.render(compiled.diagram, compiled.renderOptions)
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            expired = true
            reject(new Error('D2 rendering timed out'))
          }, 15_000)
        }),
      ])
    } catch (error) {
      if (current) {
        engine = undefined
        void current.dispose().catch(() => {})
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })
  queue = result.catch(() => {})
  cache.set(source, result)
  if (cache.size > 32) cache.delete(cache.keys().next().value!)
  void result.catch(() => {
    if (cache.get(source) === result) cache.delete(source)
  })
  return result
}

export interface D2Block {
  id: string
  source: string
}

export async function renderD2Blocks(html: string, blocks: D2Block[]): Promise<string> {
  if (blocks.length === 0) return html
  const template = document.createElement('template')
  template.innerHTML = html
  await Promise.all(
    blocks.map(async ({ id, source }) => {
      const block = template.content.getElementById(id)
      const content = block?.querySelector('.content')
      if (!block || !content) return
      try {
        const svg = await renderD2(source)
        const image = document.createElement('img')
        image.alt = block.querySelector('.title')?.textContent || 'D2 diagram'
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        content.replaceChildren(image)
        block.classList.replace('listingblock', 'imageblock')
        block.classList.add('d2-diagram')
      } catch (error) {
        const message = document.createElement('pre')
        message.className = 'd2-error'
        message.setAttribute('role', 'alert')
        message.textContent = `D2 error: ${error instanceof Error ? error.message : String(error)}`
        content.prepend(message)
      }
    }),
  )
  return template.innerHTML
}
