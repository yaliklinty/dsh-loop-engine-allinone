/**
 * Flatten one engine-reported tool result to the text a durable message stores.
 *
 * Its own module rather than a helper inside the sink, for one structural
 * reason: the protocol adapters need it (`stream-json.ts` calls it for every
 * `tool_result` block), and the sink imports the HOST plane
 * (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`). Keeping the flattener
 * here means an adapter can be exercised against a real CLI — as
 * `scripts/probe/smoke-driver.ts` does — without loading a Cordis context.
 *
 * The rules:
 *
 *  - a string is the answer;
 *  - `null`/`undefined` is empty, which the caller turns into a visible
 *    placeholder rather than an unrenderable empty block;
 *  - a list of blocks is joined, reading each block's own `text`;
 *  - a block that carries no text is JSON-encoded rather than dropped, so a
 *    structured result stays inspectable in the transcript;
 *  - an object with a `content` member is unwrapped, because that is the
 *    wrapper several CLIs put around their real payload.
 *
 * @module dsh-loop-engine/driver-cli/flatten
 */

/**
 * Flatten one engine tool result to the text dsh stores.
 *
 * Engines report a result as a string, as a list of content blocks, or as an
 * arbitrary JSON value; dsh's durable shape is text. Anything that is not text
 * is JSON-encoded rather than dropped, so a structured result stays inspectable
 * in the transcript instead of vanishing.
 * @param result - the engine's result payload.
 * @returns the text to store.
 */
export function flattenToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return ''
  if (Array.isArray(result)) {
    return result
      .map(block => {
        if (typeof block === 'string') return block
        const record = block as Record<string, unknown> | null
        if (record !== null && typeof record === 'object' && typeof record.text === 'string') return record.text
        return JSON.stringify(block)
      })
      .filter(segment => segment !== '')
      .join('\n\n')
  }
  const record = result as Record<string, unknown>
  if (typeof record.content === 'string') return record.content
  if (Array.isArray(record.content)) return flattenToolResult(record.content)
  return JSON.stringify(result)
}
