import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn(), load: vi.fn() }))

describe('Mermaid rendering', () => {
  const remove = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    mocks.render.mockReset().mockResolvedValue({ svg: '<svg/>' })
    mocks.initialize.mockReset()
    mocks.load.mockReset().mockResolvedValue(undefined)
    remove.mockReset()
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: vi.fn(), style: {}, remove }),
      body: { appendChild: vi.fn() },
    })
    vi.doMock('mermaid', async () => {
      await mocks.load()
      return { default: { initialize: mocks.initialize, render: mocks.render } }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reuses diagrams for concurrent preview and print requests', async () => {
    const { renderMermaid } = await import('../src/preview/mermaid')
    await expect(Promise.all([renderMermaid('graph'), renderMermaid('graph')])).resolves.toEqual([
      '<svg/>',
      '<svg/>',
    ])
    expect(mocks.render).toHaveBeenCalledTimes(1)
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
        htmlLabels: false,
        secure: expect.arrayContaining(['securityLevel', 'dompurifyConfig', 'htmlLabels']),
      }),
    )
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('cleans up failed diagrams and retries without blocking later work', async () => {
    const { renderMermaid } = await import('../src/preview/mermaid')
    mocks.render.mockRejectedValueOnce(new Error('invalid diagram'))
    await expect(renderMermaid('broken')).rejects.toThrow('invalid diagram')
    await expect(renderMermaid('valid')).resolves.toBe('<svg/>')
    await expect(renderMermaid('broken')).resolves.toBe('<svg/>')
    expect(mocks.render).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenCalledTimes(3)
  })

  it('skips obsolete queued work while preserving a print snapshot', async () => {
    const { renderMermaid } = await import('../src/preview/mermaid')
    let finish!: (value: { svg: string }) => void
    mocks.render.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const controller = new AbortController()
    const active = expect(renderMermaid('active', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    const queued = expect(renderMermaid('obsolete', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    const print = renderMermaid('active')
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1))
    controller.abort()
    finish({ svg: '<svg/>' })
    await Promise.all([active, queued])
    await expect(print).resolves.toBe('<svg/>')
    expect(mocks.render).toHaveBeenCalledTimes(1)
    await expect(renderMermaid('latest')).resolves.toBe('<svg/>')
  })

  it('skips rendering if canceled while the module loads', async () => {
    const { renderMermaid } = await import('../src/preview/mermaid')
    let release!: () => void
    mocks.load.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const controller = new AbortController()
    const old = expect(renderMermaid('old', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1))
    controller.abort()
    release()
    await old
    expect(mocks.render).not.toHaveBeenCalled()
    await expect(renderMermaid('latest')).resolves.toBe('<svg/>')
  })

  it('bounds the completed diagram cache', async () => {
    const { renderMermaid } = await import('../src/preview/mermaid')
    for (let index = 0; index < 33; index++) await renderMermaid(String(index))
    await renderMermaid('32')
    expect(mocks.render).toHaveBeenCalledTimes(33)
    await renderMermaid('0')
    expect(mocks.render).toHaveBeenCalledTimes(34)
  })
})
