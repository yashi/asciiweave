import type { D2 } from '@d2lang/d2'

interface RenderJob {
  controller: AbortController
  result: Promise<string>
  consumers: number
}

let engine: D2 | undefined
let queue: Promise<unknown> = Promise.resolve()
const cache = new Map<string, string>()
const pending = new Map<string, RenderJob>()

async function compileD2(source: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  let current: D2 | undefined
  let expired = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await Promise.race([
      (async () => {
        const { D2 } = await import('@d2lang/d2')
        signal.throwIfAborted()
        if (expired) throw new Error('D2 rendering timed out')
        current = engine ??= new D2()
        const compiled = await current.compile(source)
        signal.throwIfAborted()
        if (expired) throw new Error('D2 rendering timed out')
        return current.render(compiled.diagram, compiled.renderOptions)
      })(),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
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
    signal.removeEventListener('abort', abort)
  }
}

export function renderD2(source: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const cached = cache.get(source)
  if (cached !== undefined) return Promise.resolve(cached)

  let job = pending.get(source)
  if (!job) {
    const controller = new AbortController()
    const result = queue.then(() => compileD2(source, controller.signal))
    job = { controller, result, consumers: 0 }
    pending.set(source, job)
    const created = job
    queue = result
      .then(
        (svg) => {
          if (!controller.signal.aborted) {
            cache.set(source, svg)
            if (cache.size > 32) cache.delete(cache.keys().next().value!)
          }
        },
        () => {},
      )
      .finally(() => {
        if (pending.get(source) === created) pending.delete(source)
      })
  }

  const shared = job
  shared.consumers++
  return new Promise<string>((resolve, reject) => {
    let finished = false
    const finish = () => {
      if (finished) return false
      finished = true
      signal?.removeEventListener('abort', abort)
      shared.consumers--
      return true
    }
    const abort = () => {
      if (!finish()) return
      reject(signal!.reason)
      if (shared.consumers === 0) {
        if (pending.get(source) === shared) pending.delete(source)
        shared.controller.abort()
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    shared.result.then(
      (svg) => {
        if (finish()) resolve(svg)
      },
      (error: unknown) => {
        if (finish()) reject(error)
      },
    )
  })
}

export interface D2Block {
  id: string
  source: string
}

export async function renderD2Blocks(
  html: string,
  blocks: D2Block[],
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
        const svg = await renderD2(source, signal)
        const image = document.createElement('img')
        image.alt = block.querySelector('.title')?.textContent || 'D2 diagram'
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
        content.replaceChildren(image)
        block.classList.replace('listingblock', 'imageblock')
        block.classList.add('d2-diagram')
      } catch (error) {
        signal?.throwIfAborted()
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
