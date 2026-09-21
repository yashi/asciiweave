import { expect, test } from '@playwright/test'
import { createDoc, getText, openPair, setSourceViaYjs } from './helpers'

const source =
  '= Diagrams\n\n.Flow\n[mermaid]\n----\nflowchart LR\nclient --> server[日本語]\n----\n\nAfter diagram.'

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
