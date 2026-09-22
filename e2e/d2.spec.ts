import { expect, test } from '@playwright/test'
import { createDoc, getText, openPair, setSourceViaYjs } from './helpers'

const source = '= Diagrams\n\n.Flow\n[d2]\n----\nclient -> server: 日本語\n----\n\nAfter diagram.'

test('D2 diagrams open in the floating viewer with zoom and keyboard controls', async ({
  page,
}) => {
  await createDoc(page)
  await setSourceViaYjs(page, source)
  const diagram = page.frameLocator('.preview-frame').getByRole('button', { name: 'Enlarge Flow' })
  await expect(diagram).toBeVisible({ timeout: 20_000 })
  await diagram.click()
  const viewer = page.getByRole('dialog', { name: 'Enlarged diagram' })
  await expect(viewer).toBeVisible()
  const image = viewer.locator('img')
  await expect(image).toHaveAttribute('src', (await diagram.getAttribute('src'))!)
  await expect(image).toHaveAttribute('alt', 'Flow')
  const size = await image.evaluate((img: HTMLImageElement) => {
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(img.src.slice(img.src.indexOf(',') + 1)),
      'image/svg+xml',
    ).documentElement
    return svg
      .getAttribute('viewBox')!
      .trim()
      .split(/[\s,]+/)
      .map(Number)
  })
  expect((await image.boundingBox())!.width).toBeCloseTo(size[2]!, 0)
  expect((await image.boundingBox())!.height).toBeCloseTo(size[3]!, 0)
  await viewer.getByRole('button', { name: 'Zoom in' }).click()
  expect((await image.boundingBox())!.width).toBeCloseTo(size[2]! * 1.25, 0)
  const bounds = (await viewer.boundingBox())!
  await viewer.getByRole('button', { name: 'Move diagram viewer' }).press('ArrowRight')
  expect((await viewer.boundingBox())!.x).toBeCloseTo(bounds.x + 10, 0)
  await viewer.getByRole('button', { name: 'Resize diagram viewer' }).press('ArrowLeft')
  expect((await viewer.boundingBox())!.width).toBeCloseTo(bounds.width - 10, 0)
  await page.keyboard.press('Escape')
  await expect(viewer).not.toBeVisible()
  await expect(diagram).toBeFocused()
  for (const key of ['Enter', 'Space']) {
    await diagram.press(key)
    await expect(viewer).toBeVisible()
    await viewer.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(diagram).toBeFocused()
  }
})

test('D2 renders locally for collaborators and preserves source export', async ({
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
      const diagram = preview.locator('.d2-diagram img')
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
      expect(await preview.locator('.d2-diagram').getAttribute('id')).toBeTruthy()
      await expect(preview.locator('.paragraph')).toContainText('After diagram.')
      expect(await getText(page)).toBe(source)
    }
    const exported = await pair.pageA.request.get(
      `${new URL(pair.url).pathname.replace('/doc/', '/api/documents/')}/source`,
    )
    expect(await exported.text()).toBe(source)
    await setSourceViaYjs(
      pair.pageB,
      source.replace('client -> server: 日本語', 'browser -> database'),
    )
    for (const page of [pair.pageA, pair.pageB]) {
      await expect
        .poll(async () => {
          const src = await page
            .frameLocator('.preview-frame')
            .locator('.d2-diagram img')
            .getAttribute('src')
          return decodeURIComponent(src ?? '')
        })
        .toContain('database')
    }
  } finally {
    await pair.close()
  }
})

test('D2 errors stay local to a block and recover after editing', async ({ page }) => {
  await createDoc(page)
  await setSourceViaYjs(
    page,
    '[d2]\n----\na: {\n----\n\n' + source + '\n\n[source,d2]\n----\nx -> y\n----',
  )
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('.d2-error')).toContainText('D2 error:', { timeout: 20_000 })
  await expect(preview.locator('.d2-diagram img')).toHaveCount(1)
  await expect(preview.locator('code.language-d2')).toHaveText('x -> y')
  await setSourceViaYjs(page, source + '\n\n[d2]\n----\nx -> y\n----')
  await expect(preview.locator('.d2-diagram img')).toHaveCount(2)
  await expect(preview.locator('.d2-error')).toHaveCount(0)
  await expect(page.locator('.preview-frame')).toHaveAttribute('sandbox', 'allow-same-origin')
})

test('D2 images are ready in the print snapshot', async ({ page }) => {
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
  const diagram = page.frameLocator('.print-frame').locator('.d2-diagram img')
  await expect(page.frameLocator('.print-frame').locator('.diagram-enlarge')).toHaveCount(0)
  expect(
    await diagram.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  ).toBe(true)
  await frame.evaluate((iframe: HTMLIFrameElement) => {
    iframe.contentWindow!.dispatchEvent(new Event('afterprint'))
  })
  await expect(frame).toHaveCount(0)
})

test('a delayed D2 render cannot replace newer document content', async ({ page }) => {
  await createDoc(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requested!: () => void
  const request = new Promise<void>((resolve) => {
    requested = resolve
  })
  await page.route('**/assets/browser-*.js', async (route) => {
    requested()
    await gate
    await route.continue()
  })
  await setSourceViaYjs(page, source)
  await request
  await setSourceViaYjs(page, '= Latest\n\nOrdinary text.')
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('h1')).toHaveText('Latest')
  const loaded = page.waitForResponse('**/assets/browser-*.js')
  release()
  await (await loaded).finished()
  // Allow the older conversion to finish after the replacement has rendered.
  await page.waitForTimeout(2000)
  await expect(preview.locator('h1')).toHaveText('Latest')
  await expect(preview.locator('.d2-diagram')).toHaveCount(0)
  expect(page.workers()).toHaveLength(0)
})

test('a new edit cancels a stalled worker request and renders every current diagram', async ({
  page,
}) => {
  await createDoc(page)
  await page.evaluate(() => {
    const postMessage = Worker.prototype.postMessage
    let stalled = false
    Worker.prototype.postMessage = function (message: { type?: string }) {
      if (!stalled && message.type === 'compile') {
        stalled = true
        document.body.dataset.d2Stalled = 'true'
        return
      }
      postMessage.call(this, message)
    }
  })
  await setSourceViaYjs(page, source)
  await expect(page.locator('body')).toHaveAttribute('data-d2-stalled', 'true', { timeout: 10_000 })
  await setSourceViaYjs(page, '= Current\n\n[d2]\n----\na -> b\n----\n\n[d2]\n----\nc -> d\n----')
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('.d2-diagram img')).toHaveCount(2, { timeout: 5000 })
  await expect(preview.locator('h1')).toHaveText('Current')
  await expect(preview.locator('.d2-error')).toHaveCount(0)
})
