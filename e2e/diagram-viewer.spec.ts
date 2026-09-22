import { expect, test } from '@playwright/test'
import { createDoc, setSourceViaYjs } from './helpers'

const source =
  '= Diagrams\n\n.Flow\n[mermaid]\n----\nflowchart LR\nclient --> server[日本語]\n----\n\nAfter diagram.'

test('Mermaid and D2 diagrams share the viewer in the same document', async ({ page }) => {
  await createDoc(page)
  await setSourceViaYjs(page, source + '\n\n[d2]\n----\na -> b\n----')
  const preview = page.frameLocator('.preview-frame')
  await expect(preview.locator('.mermaid-diagram img')).toBeVisible({ timeout: 20_000 })
  await expect(preview.locator('.d2-diagram img')).toBeVisible()
  await expect(preview.locator('.paragraph')).toContainText('After diagram.')
  const viewer = page.getByRole('dialog', { name: 'Enlarged diagram' })
  for (const selector of ['.mermaid-diagram img', '.d2-diagram img', '.mermaid-diagram img']) {
    const diagram = preview.locator(selector)
    await diagram.click()
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('img')).toHaveAttribute('src', (await diagram.getAttribute('src'))!)
    await expect(viewer.locator('img')).toHaveAttribute('alt', (await diagram.getAttribute('alt'))!)
  }
  await viewer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(preview.locator('.mermaid-diagram img')).toBeFocused()
})
