/**
 * The capability guards: what a driver does when its engine cannot do what the
 * step asked for.
 *
 * The rule under test is that a missing capability is a REFUSAL naming the user's
 * next action, not a silent drop. Dropping an image and sending the text alone
 * would look to the user like the engine read the picture.
 *
 * @module tests/driver-cli/capability
 */

import { describe, expect, it } from 'vitest'
import { stepImageCount, unsupportedImagesRefusal } from '../../src/driver-cli/capability.ts'
import { ENGINE_REGISTRY } from '../../src/engine-registry.ts'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** A user message carrying the given content blocks. */
const message = (...content: unknown[]): UserMessage => ({ content } as unknown as UserMessage)

describe('stepImageCount', () => {
  it('counts image blocks across the batch', () => {
    expect(stepImageCount([
      message({ type: 'text', text: 'hi' }, { type: 'image', source: {} }),
      message({ type: 'image', source: {} }),
    ])).toBe(2)
  })

  it('is zero for a batch with no images', () => {
    expect(stepImageCount([])).toBe(0)
    expect(stepImageCount([message({ type: 'text', text: 'hi' })])).toBe(0)
  })

  it('ignores a message whose content is not a list', () => {
    expect(stepImageCount([{ content: 'not a list' } as unknown as UserMessage])).toBe(0)
    expect(stepImageCount([{} as unknown as UserMessage])).toBe(0)
  })

  it('ignores a non-object block', () => {
    expect(stepImageCount([message('a string', null, 7)])).toBe(0)
  })
})

describe('unsupportedImagesRefusal', () => {
  it('permits a step with no images, whatever the engine can do', () => {
    expect(unsupportedImagesRefusal([], ENGINE_REGISTRY.qoderclicn)).toBeUndefined()
    expect(unsupportedImagesRefusal([message({ type: 'text', text: 'x' })], ENGINE_REGISTRY.qoderclicn)).toBeUndefined()
  })

  it('permits an image when the engine declares the capability', () => {
    expect(unsupportedImagesRefusal([message({ type: 'image' })], ENGINE_REGISTRY['claude-code'])).toBeUndefined()
  })

  it('refuses an image an engine declared it cannot take, naming the count and the next action', () => {
    const refusal = unsupportedImagesRefusal([message({ type: 'image' }), message({ type: 'image' })], ENGINE_REGISTRY.qoderclicn)
    expect(refusal).toContain('Qoder CN')
    expect(refusal).toContain('2')
    expect(refusal).toContain('switch this session to an engine that supports images')
  })

  it('refuses for every engine whose registry row declares no image support', () => {
    // Driven by the registry rather than a list, so a new engine is covered the
    // moment its row says `images: false`.
    for (const descriptor of Object.values(ENGINE_REGISTRY)) {
      const refusal = unsupportedImagesRefusal([message({ type: 'image' })], descriptor)
      if (descriptor.capabilities.images) expect(refusal, descriptor.id).toBeUndefined()
      else expect(refusal, descriptor.id).toBeTypeOf('string')
    }
  })
})
