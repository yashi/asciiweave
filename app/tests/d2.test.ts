import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  render: vi.fn(),
  dispose: vi.fn(),
  load: vi.fn(),
  construct: vi.fn(),
}))

describe('D2 rendering', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.compile.mockReset().mockResolvedValue({ diagram: {}, renderOptions: { themeID: 4 } })
    mocks.render.mockReset().mockResolvedValue('<svg/>')
    mocks.dispose.mockReset().mockResolvedValue(undefined)
    mocks.load.mockReset().mockResolvedValue(undefined)
    mocks.construct.mockReset()
    vi.doMock('@d2lang/d2', async () => {
      await mocks.load()
      return {
        D2: class {
          constructor() {
            mocks.construct()
          }
          compile = mocks.compile
          render = mocks.render
          dispose = mocks.dispose
        },
      }
    })
  })
  afterEach(() => vi.useRealTimers())

  it('reuses identical diagrams and passes source configuration to the renderer', async () => {
    const { renderD2 } = await import('../src/preview/d2')
    const first = renderD2('a -> b')
    const second = renderD2('a -> b')
    expect(await second).toBe('<svg/>')
    expect(await first).toBe('<svg/>')
    expect(mocks.compile).toHaveBeenCalledTimes(1)
    expect(mocks.render).toHaveBeenCalledWith({}, { themeID: 4 })
  })

  it('retries failed diagrams without blocking later work', async () => {
    const { renderD2 } = await import('../src/preview/d2')
    mocks.compile.mockRejectedValueOnce(new Error('invalid diagram'))
    await expect(renderD2('broken')).rejects.toThrow('invalid diagram')
    await expect(renderD2('a -> b')).resolves.toBe('<svg/>')
    await expect(renderD2('broken')).resolves.toBe('<svg/>')
    expect(mocks.compile).toHaveBeenCalledTimes(3)
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })

  it('terminates timed-out work and allows subsequent diagrams', async () => {
    vi.useFakeTimers()
    const { renderD2 } = await import('../src/preview/d2')
    mocks.compile.mockImplementationOnce(() => new Promise(() => {}))
    const pending = expect(renderD2('slow')).rejects.toThrow('D2 rendering timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await pending
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    await expect(renderD2('a -> b')).resolves.toBe('<svg/>')
  })

  it('times out a stalled import, releases the queue, and ignores its late completion', async () => {
    vi.useFakeTimers()
    let release!: () => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const { renderD2 } = await import('../src/preview/d2')
    const first = expect(renderD2('first')).rejects.toThrow('D2 rendering timed out')
    const second = expect(renderD2('second')).rejects.toThrow('D2 rendering timed out')
    await vi.advanceTimersByTimeAsync(15_000)
    await first
    await vi.advanceTimersByTimeAsync(15_000)
    await second
    release()
    await vi.dynamicImportSettled()
    expect(mocks.construct).not.toHaveBeenCalled()
    expect(mocks.compile).not.toHaveBeenCalled()
    expect(mocks.dispose).not.toHaveBeenCalled()
    await expect(renderD2('first')).resolves.toBe('<svg/>')
    expect(mocks.compile).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('cancels active and queued obsolete diagrams without waiting for their timeouts', async () => {
    vi.useFakeTimers()
    const { renderD2 } = await import('../src/preview/d2')
    const obsolete = new AbortController()
    let finishCompile!: (value: unknown) => void
    mocks.compile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCompile = resolve
        }),
    )
    const first = expect(renderD2('active', obsolete.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    const second = expect(renderD2('queued', obsolete.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.compile).toHaveBeenCalledExactlyOnceWith('active')
    obsolete.abort()
    await Promise.all([first, second])
    await expect(renderD2('latest')).resolves.toBe('<svg/>')
    expect(mocks.compile.mock.calls.map(([source]) => source)).toEqual(['active', 'latest'])
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
    finishCompile({ diagram: {}, renderOptions: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.render).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves shared print work and every diagram in the latest preview', async () => {
    vi.useFakeTimers()
    const { renderD2 } = await import('../src/preview/d2')
    const obsolete = new AbortController()
    const latest = new AbortController()
    let finishCompile!: (value: unknown) => void
    mocks.compile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCompile = resolve
        }),
    )
    const oldPreview = expect(renderD2('shared', obsolete.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    const print = renderD2('shared')
    const previewA = renderD2('shared', latest.signal)
    const previewB = renderD2('other diagram', latest.signal)
    await vi.advanceTimersByTimeAsync(0)
    obsolete.abort()
    await oldPreview
    expect(mocks.dispose).not.toHaveBeenCalled()
    finishCompile({ diagram: {}, renderOptions: {} })
    await expect(Promise.all([print, previewA, previewB])).resolves.toEqual([
      '<svg/>',
      '<svg/>',
      '<svg/>',
    ])
    expect(mocks.compile.mock.calls.map(([source]) => source)).toEqual(['shared', 'other diagram'])
    await expect(renderD2('shared')).resolves.toBe('<svg/>')
    expect(mocks.compile).toHaveBeenCalledTimes(2)
  })

  it('cancels during module loading and only starts the replacement after loading', async () => {
    vi.useFakeTimers()
    const { renderD2 } = await import('../src/preview/d2')
    let release!: () => void
    mocks.load.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const obsolete = new AbortController()
    const oldPreview = expect(renderD2('old', obsolete.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.advanceTimersByTimeAsync(0)
    obsolete.abort()
    await oldPreview
    const latest = renderD2('latest')
    release()
    await expect(latest).resolves.toBe('<svg/>')
    expect(mocks.construct).toHaveBeenCalledTimes(1)
    expect(mocks.compile).toHaveBeenCalledExactlyOnceWith('latest')
  })
})
