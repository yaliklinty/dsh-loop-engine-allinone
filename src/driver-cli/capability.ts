/**
 * Capability guards: what a driver does when its engine cannot do what the step
 * asked for.
 *
 * The plugin's rule is that an engine which cannot honour something says so,
 * rather than accepting it and quietly doing something else ("能力不足的引擎如实
 * 降级，不假装支持"). The registry declares each engine's capabilities
 * (`EngineCapabilities`), and this module turns a declaration into the check a
 * driver runs before it spends a child process on a request the engine will
 * mistranslate.
 *
 * The distinction that matters: a capability the engine LACKS is a refusal with
 * the user's next action named, not a silent drop. Dropping an image and sending
 * the text alone would look to the user like the engine read the picture.
 *
 * @module dsh-loop-engine-allinone/driver-cli/capability
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { EngineDescriptor } from '../engine-registry.ts'

/**
 * Count the image blocks this step delivers.
 *
 * Only THIS step's own messages, not the whole transcript: an older image in the
 * history is already a text placeholder in the serialized prompt (that is what
 * `serializeHistory` does), so only a fresh attachment can be lost by an engine
 * with no image channel.
 * @param messages - the step's message batch.
 * @returns how many image blocks they carry.
 */
export function stepImageCount(messages: readonly UserMessage[]): number {
  let count = 0
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'image') count += 1
    }
  }
  return count
}

/**
 * The refusal to report when a step delivers images to an engine that declared
 * it cannot take them, or undefined when the step is fine.
 *
 * The message names the engine, the count, and what the user can do — which is
 * the difference between a refusal and a puzzle.
 * @param messages - the step's message batch.
 * @param descriptor - the engine's registry row.
 * @returns the refusal message, or undefined.
 */
export function unsupportedImagesRefusal(
  messages: readonly UserMessage[],
  descriptor: EngineDescriptor,
): string | undefined {
  if (descriptor.capabilities.images) return undefined
  const count = stepImageCount(messages)
  if (count === 0) return undefined
  return `${descriptor.label} cannot receive images (${count} attached to this message).`
    + ` Remove the attachment, or switch this session to an engine that supports images.`
}
