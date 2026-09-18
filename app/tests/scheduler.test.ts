import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderScheduler } from '../src/preview/scheduler'

interface Deferred {
  resolve(html: string): void
  reject(error: unknown): void
}

describe('render scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(debounceMs = 200) {
    const conversions: Deferred[] = []
    const applied: string[] = []
    const errors: unknown[] = []
    const scheduler = createRenderScheduler(
      () =>
        new Promise<string>((resolve, reject) => {
          conversions.push({ resolve, reject })
        }),
      (html) => applied.push(html),
      (error) => errors.push(error),
      { debounceMs },
    )
    return { scheduler, conversions, applied, errors }
  }

  it('debounces rapid updates into one conversion', async () => {
    const { scheduler, conversions, applied } = setup()
    scheduler.update('a')
    scheduler.update('ab')
    scheduler.update('abc')
    expect(conversions).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(200)
    expect(conversions).toHaveLength(1)

    conversions[0]?.resolve('<p>abc</p>')
    await vi.runAllTimersAsync()
    expect(applied).toEqual(['<p>abc</p>'])
  })

  it('discards stale conversions that finish after newer ones', async () => {
    const { scheduler, conversions, applied } = setup()

    scheduler.update('edit 17')
    await vi.advanceTimersByTimeAsync(200)
    scheduler.update('edit 18')
    await vi.advanceTimersByTimeAsync(200)
    expect(conversions).toHaveLength(2)

    // Conversion 18 finishes first, then the stale 17 completes.
    conversions[1]?.resolve('<p>18</p>')
    await vi.runAllTimersAsync()
    conversions[0]?.resolve('<p>17</p>')
    await vi.runAllTimersAsync()

    expect(applied).toEqual(['<p>18</p>'])
  })

  it('reports conversion errors only for the latest generation', async () => {
    const { scheduler, conversions, applied, errors } = setup()

    scheduler.update('bad')
    await vi.advanceTimersByTimeAsync(200)
    scheduler.update('good')
    await vi.advanceTimersByTimeAsync(200)

    conversions[1]?.resolve('<p>good</p>')
    await vi.runAllTimersAsync()
    conversions[0]?.reject(new Error('stale failure'))
    await vi.runAllTimersAsync()

    expect(applied).toEqual(['<p>good</p>'])
    expect(errors).toHaveLength(0)

    scheduler.update('still bad')
    await vi.advanceTimersByTimeAsync(200)
    conversions[2]?.reject(new Error('current failure'))
    await vi.runAllTimersAsync()
    expect(errors).toHaveLength(1)
  })

  it('renderNow converts without waiting for the debounce', () => {
    const { scheduler, conversions } = setup()
    scheduler.renderNow('initial')
    expect(conversions).toHaveLength(1)
  })

  it('applies nothing after dispose', async () => {
    const { scheduler, conversions, applied } = setup()
    scheduler.renderNow('content')
    scheduler.dispose()
    conversions[0]?.resolve('<p>late</p>')
    await vi.runAllTimersAsync()
    expect(applied).toEqual([])
  })

  it('cancels obsolete work immediately and cancels the latest work on disposal', async () => {
    const signals: AbortSignal[] = []
    const errors: unknown[] = []
    const scheduler = createRenderScheduler(
      (_source, signal) => {
        signals.push(signal)
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      () => {},
      (error) => errors.push(error),
    )
    scheduler.renderNow('first')
    scheduler.update('second')
    expect(signals[0]?.aborted).toBe(true)
    expect(signals).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(signals[1]?.aborted).toBe(false)
    scheduler.renderNow('third')
    expect(signals[1]?.aborted).toBe(true)
    scheduler.dispose()
    expect(signals[2]?.aborted).toBe(true)
    await vi.runAllTimersAsync()
    expect(errors).toEqual([])
  })
})
