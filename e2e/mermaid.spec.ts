import { expect, test } from '@playwright/test'
import { createDoc, getText, openPair, setSourceViaYjs } from './helpers'

const source =
  '= Diagrams\n\n.Flow\n[mermaid]\n----\nflowchart LR\nclient --> server[日本語]\n----\n\nAfter diagram.'

const tallDiagram = `[mermaid]
----
flowchart TD
  Start --> Read --> Validate --> Process --> Save --> Notify --> Finish
----`

test('clicking a Mermaid diagram opens a readable viewer with zoom controls', async ({ page }) => {
  await createDoc(page)
  const wideDiagram = tallDiagram.replace('flowchart TD', 'flowchart LR')
  await setSourceViaYjs(page, wideDiagram)
  const preview = page.frameLocator('.preview-frame')
  const thumbnail = preview.locator('.mermaid-diagram img')
  await expect(thumbnail).toBeVisible()
  const thumbnailWidth = (await thumbnail.boundingBox())!.width
  await thumbnail.click()
  const viewer = page.getByRole('dialog', { name: 'Enlarged diagram' })
  await expect(viewer).toBeVisible()
  const image = viewer.locator('img')
  await expect(image).toHaveAttribute('src', (await thumbnail.getAttribute('src'))!)
  expect((await image.boundingBox())!.width).toBeGreaterThan(thumbnailWidth * 1.5)
  await viewer.getByRole('button', { name: 'Fit', exact: true }).click()
  const fittedWidth = (await image.boundingBox())!.width
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  expect((await image.boundingBox())!.width).toBeCloseTo(fittedWidth * 1.25, 0)
  await viewer.getByRole('button', { name: 'Zoom out' }).click()
  expect((await image.boundingBox())!.width).toBeCloseTo(fittedWidth, 0)
  await viewer.getByRole('button', { name: 'Actual size' }).click()
  const naturalHeight = await image.evaluate((img: HTMLImageElement) => {
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(img.src.split(',').slice(1).join(',')),
      'image/svg+xml',
    )
    return Number(svg.documentElement.getAttribute('viewBox')!.split(/[\s,]+/)[3])
  })
  expect((await image.boundingBox())!.height).toBeCloseTo(naturalHeight, 0)
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  expect(
    await viewer
      .locator('.diagram-viewer-viewport')
      .evaluate((el) => el.scrollWidth > el.clientWidth),
  ).toBe(true)
  await viewer.getByRole('button', { name: 'Fit', exact: true }).click()
  expect((await image.boundingBox())!.width).toBeCloseTo(fittedWidth, 0)
  await page.keyboard.press('Escape')
  await expect(viewer).not.toBeVisible()
  await expect(preview.getByRole('button', { name: 'Enlarge Mermaid diagram' })).toBeFocused()
  expect(await getText(page)).toBe(wideDiagram)
})

test('the Mermaid viewer supports keyboard access, narrow screens, and preview replacement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await createDoc(page)
  await setSourceViaYjs(page, tallDiagram)
  const preview = page.frameLocator('.preview-frame')
  const enlarge = preview.getByRole('button', { name: 'Enlarge Mermaid diagram' })
  await enlarge.focus()
  await enlarge.press('Enter')
  const viewer = page.getByRole('dialog', { name: 'Enlarged diagram' })
  await expect(viewer).toBeVisible()
  const close = viewer.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeFocused()
  expect((await viewer.boundingBox())!.width).toBeLessThanOrEqual(390)
  const snapshot = await viewer.locator('img').getAttribute('src')
  await setSourceViaYjs(page, source)
  await expect(preview.locator('.mermaid-diagram img')).toHaveAttribute('alt', 'Flow')
  await expect(viewer.locator('img')).toHaveAttribute('src', snapshot!)
  await close.click()
  await expect(viewer).not.toBeVisible()
  const current = preview.getByRole('button', { name: 'Enlarge Flow' })
  await current.focus()
  await current.press('Space')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('img')).toHaveAttribute('alt', 'Flow')
  await page.mouse.click(1, 1)
  await expect(viewer).toBeVisible()
  await close.click()
  await expect(viewer).not.toBeVisible()
  await expect(current).toBeFocused()
})

test('the floating viewer leaves the document scrollable and supports moving and resizing', async ({
  page,
}) => {
  await createDoc(page)
  await setSourceViaYjs(
    page,
    tallDiagram.replace('flowchart TD', 'flowchart LR') +
      '\n\n' +
      Array.from(
        { length: 40 },
        (_, i) => `== Section ${i}\n\nText to read beside the diagram.\n`,
      ).join('\n'),
  )
  const preview = page.frameLocator('.preview-frame')
  await preview.getByRole('button', { name: 'Enlarge Mermaid diagram' }).click()
  const viewer = page.getByRole('dialog', { name: 'Enlarged diagram' })
  await expect(viewer).toBeVisible()
  await expect(viewer).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  expect(await viewer.evaluate((el) => el.matches(':modal'))).toBe(false)
  const original = (await viewer.boundingBox())!
  const frame = (await page.locator('.preview-frame').boundingBox())!
  expect(original.x + original.width).toBeLessThan(frame.x)
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2)
  await page.mouse.wheel(0, 600)
  await expect
    .poll(() => preview.locator('html').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100)
  await expect(viewer).toBeVisible()

  const move = viewer.getByRole('button', { name: 'Move diagram viewer' })
  const handle = (await move.boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 240, handle.y + handle.height / 2 + 80, {
    steps: 8,
  })
  await page.mouse.up()
  const moved = (await viewer.boundingBox())!
  expect(moved.x).toBeCloseTo(original.x + 240, 0)
  expect(moved.y).toBeCloseTo(original.y + 80, 0)
  await move.press('ArrowLeft')
  expect((await viewer.boundingBox())!.x).toBeCloseTo(moved.x - 10, 0)

  await viewer.getByRole('button', { name: 'Fit', exact: true }).click()
  const fittedWidth = (await viewer.locator('img').boundingBox())!.width
  const resize = viewer.getByRole('button', { name: 'Resize diagram viewer' })
  const corner = (await resize.boundingBox())!
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
  await page.mouse.down()
  await page.mouse.move(corner.x + corner.width / 2 + 160, corner.y + corner.height / 2 + 60, {
    steps: 8,
  })
  await page.mouse.up()
  const resized = (await viewer.boundingBox())!
  expect(resized.width).toBeCloseTo(moved.width + 160, 0)
  expect(resized.height).toBeCloseTo(moved.height + 60, 0)
  await expect
    .poll(async () => (await viewer.locator('img').boundingBox())!.width)
    .toBeGreaterThan(fittedWidth)
  await resize.press('ArrowLeft')
  await resize.press('ArrowUp')
  const smaller = (await viewer.boundingBox())!
  expect(smaller.width).toBeCloseTo(resized.width - 10, 0)
  expect(smaller.height).toBeCloseTo(resized.height - 10, 0)

  await page.setViewportSize({ width: 390, height: 600 })
  await expect
    .poll(async () => {
      const box = (await viewer.boundingBox())!
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 600
    })
    .toBe(true)
  await expect(viewer.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
  await resize.press('Escape')
  await expect(viewer).not.toBeVisible()
})

test('Mermaid renders locally for collaborators and preserves source export', async ({
  browser,
  baseURL,
}) => {
  const pair = await openPair(browser, baseURL!)
  try {
    for (const page of [pair.pageA, pair.pageB]) {
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== new URL(baseURL!).origin) return route.abort()
        return route.continue()
      })
    }
    await setSourceViaYjs(pair.pageA, source)
    for (const page of [pair.pageA, pair.pageB]) {
      const preview = page.frameLocator('.preview-frame')
      const diagram = preview.locator('.mermaid-diagram img')
      await expect(diagram).toHaveAttribute('alt', 'Flow', { timeout: 20_000 })
      expect(
        await diagram.evaluate(async (img: HTMLImageElement) => {
          await img.decode()
          return img.naturalWidth
        }),
      ).toBeGreaterThan(0)
      const svg = decodeURIComponent(
        (await diagram.getAttribute('src'))!.split(',').slice(1).join(','),
      )
      expect(svg).toContain('日本語')
      expect(await preview.locator('.mermaid-diagram').getAttribute('id')).toBeTruthy()
      await expect(preview.locator('.paragraph')).toContainText('After diagram.')
      expect(await getText(page)).toBe(source)
    }
    const exported = await pair.pageA.request.get(
      `${new URL(pair.url).pathname.replace('/doc/', '/api/documents/')}/source`,
    )
    expect(await exported.text()).toBe(source)
    await setSourceViaYjs(
      pair.pageB,
      source.replace(
        'flowchart LR\nclient --> server[日本語]',
        'flowchart LR; browser --> database',
      ),
    )
    for (const page of [pair.pageA, pair.pageB]) {
      await expect
        .poll(async () => {
          const src = await page
            .frameLocator('.preview-frame')
            .locator('.mermaid-diagram img')
            .getAttribute('src')
          return decodeURIComponent(src ?? '')
        })
        .toContain('database')
    }
  } finally {
    await pair.close()
  }
})

test('Mermaid errors stay local to a block and recover after editing', async ({ page }) => {
  await createDoc(page)
  await setSourceViaYjs(
    page,
    '[mermaid]\n----\nflowchart LR; a[\n----\n\n' +
      source +
      '\n\n[source,mermaid]\n----\nsequenceDiagram\nx->>y: hello\n----',
  )
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('.mermaid-error')).toContainText('Mermaid error:', {
    timeout: 20_000,
  })
  await expect(preview.locator('.mermaid-diagram img')).toHaveCount(1)
  await expect(preview.locator('code.language-mermaid')).toHaveText('sequenceDiagram\nx->>y: hello')
  await setSourceViaYjs(page, source + '\n\n[mermaid]\n----\nsequenceDiagram\nx->>y: hello\n----')
  await expect(preview.locator('.mermaid-diagram img')).toHaveCount(2)
  await expect(preview.locator('.mermaid-error')).toHaveCount(0)
  await expect(page.locator('.preview-frame')).toHaveAttribute('sandbox', 'allow-same-origin')
})

test('Mermaid images are ready in the print snapshot', async ({ page }) => {
  await createDoc(page)
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const iframe = document.querySelector<HTMLIFrameElement>('.print-frame')
      if (!iframe) return
      observer.disconnect()
      iframe.addEventListener(
        'load',
        () => {
          iframe.contentWindow!.print = () => {
            iframe.dataset.printCalled = 'true'
          }
        },
        { once: true },
      )
    })
    observer.observe(document.body, { childList: true })
  })
  await setSourceViaYjs(page, source)
  await page.getByRole('button', { name: 'Print / Save as PDF' }).click()
  const frame = page.locator('.print-frame')
  await expect(frame).toHaveAttribute('data-print-called', 'true', { timeout: 20_000 })
  const diagram = page.frameLocator('.print-frame').locator('.mermaid-diagram img')
  await expect(page.frameLocator('.print-frame').locator('.diagram-enlarge')).toHaveCount(0)
  expect(
    await diagram.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  ).toBe(true)
  await frame.evaluate((iframe: HTMLIFrameElement) => {
    iframe.contentWindow!.dispatchEvent(new Event('afterprint'))
  })
  await expect(frame).toHaveCount(0)
})

test('Mermaid directives cannot enable HTML labels or scripts', async ({ page }) => {
  await createDoc(page)
  await setSourceViaYjs(
    page,
    `[mermaid]
----
%%{init: {"securityLevel":"loose","htmlLabels":true,"flowchart":{"htmlLabels":true},"dompurifyConfig":{"ADD_TAGS":["script"]}}}%%
flowchart LR
  a["<img src=x onerror=window.mermaidInjected=true>"] --> b[Safe]
  click b "javascript:window.mermaidInjected=true"
----`,
  )
  const preview = page.frameLocator('.preview-frame')
  const image = preview.locator('.mermaid-diagram img')
  await expect(image).toBeVisible()
  const svg = decodeURIComponent((await image.getAttribute('src'))!.split(',').slice(1).join(','))
  expect(svg).not.toContain('<foreignObject')
  expect(svg).not.toContain('<script')
  expect(svg).not.toContain('href="javascript:')
  await image.click()
  const viewer = page.getByRole('dialog', { name: 'Enlarged diagram' })
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('img')).toHaveAttribute('src', (await image.getAttribute('src'))!)
  await expect(viewer.locator('svg')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, 'mermaidInjected'))).toBeUndefined()
  await expect(page.locator('[id^=asciiweave-mermaid-]')).toHaveCount(0)
})

test('Mermaid and D2 diagrams render in the same document', async ({ page }) => {
  await createDoc(page)
  await setSourceViaYjs(page, source + '\n\n[d2]\n----\na -> b\n----')
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('.mermaid-diagram img')).toBeVisible({ timeout: 20_000 })
  await expect(preview.locator('.d2-diagram img')).toBeVisible()
  await expect(preview.locator('.paragraph')).toContainText('After diagram.')
})

test('a delayed Mermaid render cannot replace newer document content', async ({ page }) => {
  await createDoc(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested!: () => void
  const request = new Promise<void>((resolve) => {
    requested = resolve
  })
  await page.route('**/assets/mermaid.core-*.js', async (route) => {
    requested()
    await gate
    await route.continue()
  })
  await setSourceViaYjs(page, source)
  await request
  await setSourceViaYjs(page, '= Latest\n\nOrdinary text.')
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('h1')).toHaveText('Latest')
  const loaded = page.waitForResponse('**/assets/mermaid.core-*.js')
  release()
  await (await loaded).finished()
  // Allow the older conversion to finish after the replacement has rendered.
  await page.waitForTimeout(2000)
  await expect(preview.locator('h1')).toHaveText('Latest')
  await expect(preview.locator('.mermaid-diagram')).toHaveCount(0)
  await expect(page.locator('[id^=asciiweave-mermaid-]')).toHaveCount(0)
})
